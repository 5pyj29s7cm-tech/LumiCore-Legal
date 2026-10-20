import './helpers';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { FeishuAdapter } from '../server/messaging/feishu';
import { WeComAdapter } from '../server/messaging/wecom';
import { parseWeComLongConnectionMessage } from '../server/messaging/connections';
import { evaluateMessagingIngress, resetMessagingIngressPolicyForTest } from '../server/messaging/ingress_policy';
import { resetDeliveryLedgerForTest, reloadDeliveryLedgerForTest, acceptMessageOnce, completeMessageDelivery } from '../server/messaging/delivery_ledger';
import { getMessagingJournalEntry, listQueuedMessagingInputs, recordMessagingIngress, resetMessagingJournalForTest, updateMessagingJournal } from '../server/messaging/message_journal';
import type { IncomingMessage } from '../server/messaging/types';

const model = vi.hoisted(() => ({ run: vi.fn(), direct: vi.fn(), stream: vi.fn() }));
vi.mock('../server/llm/adapter', async original => ({ ...(await original<typeof import('../server/llm/adapter')>()), runWithTools: model.run }));
vi.mock('../server/llm/providers', async original => ({ ...(await original<typeof import('../server/llm/providers')>()), makeLLMCall: model.direct, makeLLMCallStreaming: model.stream }));
let routes: typeof import('../server/messaging/routes');
let toolEngine: typeof import('../server/tools/execution_engine');
const adapter = new FeishuAdapter({ appId: 'cli_freshness_test', appSecret: 'synthetic-secret' });
let sequence = 0;
const input = (createdAt: number): IncomingMessage => adapter.parseEvent({
  sender: { sender_id: { open_id: 'ou-freshness-user' } },
  message: { message_id: 'om-freshness-' + (++sequence), chat_id: 'oc-freshness-chat', chat_type: 'private', message_type: 'text', content: JSON.stringify({ text: '你好' }), create_time: String(createdAt) },
})!;
const modelCalls = () => model.run.mock.calls.length + model.direct.mock.calls.length + model.stream.mock.calls.length;
const options = { llmGetters: { getDeepSeek: () => ({}), getGemini: () => ({}), getOpenAI: () => ({}), getAnthropic: () => ({}), getQwen: () => ({}), getRelay: () => ({}) } as any };

beforeAll(async () => { await initDatabase(); routes = await import('../server/messaging/routes'); toolEngine = await import('../server/tools/execution_engine'); });
beforeEach(() => {
  resetMessagingJournalForTest(); resetDeliveryLedgerForTest(); resetMessagingIngressPolicyForTest();
  for (const mock of Object.values(model)) mock.mockReset().mockResolvedValue({ text: '收到。', toolCalls: [], usageRecords: [] });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No external requests in isolated freshness regression')));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('platform-created messaging ingress freshness', () => {
  it.each([
    { age: 65 * 60_000, allowed: false },
    { age: 10 * 60_000 + 1, allowed: false },
    { age: 10 * 60_000, allowed: true },
    { age: -3_348, allowed: true },
  ])('checks platform creation age=$age, allowed=$allowed', ({ age, allowed }) => {
    const now = Date.now();
    const message = { ...input(now - age), receivedAt: new Date(now).toISOString() };
    expect(evaluateMessagingIngress(message, now)).toMatchObject(allowed ? { allowed: true } : { allowed: false, reason: 'message_expired' });
  });

  it('records a first-seen65-minute-late Feishu event as skipped before enrichment, model, tools or reply', async () => {
    const message = { ...input(Date.now() - 65 * 60_000), receivedAt: new Date().toISOString() };
    const enrich = vi.fn(async (value: IncomingMessage) => value);
    const reply = vi.fn(async () => 'never-sent');
    const tools = vi.spyOn(toolEngine, 'executeToolCall');
    expect(routes.dispatchIncomingMessage(message, { enrich, reply }, options)).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(getMessagingJournalEntry(message)).toMatchObject({ messageId: message.messageId, status: 'ignored', error: 'message_expired', externalTimestamp: message.timestamp });
    expect(modelCalls()).toBe(0); expect(tools).not.toHaveBeenCalled(); expect(enrich).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(listQueuedMessagingInputs('feishu')).toEqual([]);
  });

  it('closes an old durable queued input and still rejects it after runtime-ledger reload without replay', async () => {
    const message = input(Date.now() - 65 * 60_000);
    recordMessagingIngress(message);
    expect(listQueuedMessagingInputs('feishu')).toHaveLength(1);
    const reply = vi.fn(async () => 'never-sent');
    const transport = { enrich: async (value: IncomingMessage) => value, reply };
    expect(routes.dispatchIncomingMessage(message, transport, options)).toBe(false);
    reloadDeliveryLedgerForTest(); resetMessagingIngressPolicyForTest();
    expect(routes.dispatchIncomingMessage(message, transport, options)).toBe(false);
    expect(getMessagingJournalEntry(message)?.status).toBe('ignored'); expect(listQueuedMessagingInputs('feishu')).toEqual([]);
    expect(modelCalls()).toBe(0); expect(reply).not.toHaveBeenCalled();
  });

  it('does not downgrade an earlier completed reply when its old platform event is redelivered', () => {
    const message = input(Date.now() - 65 * 60_000);
    recordMessagingIngress(message);
    updateMessagingJournal(message, { status: 'completed', replyMessageId: 'om-existing-verified-reply', replyText: '先前已回复', replyRetryable: false });
    expect(acceptMessageOnce('feishu', message.messageId)).toBe(true); completeMessageDelivery('feishu', message.messageId);
    const before = getMessagingJournalEntry(message);
    expect(routes.dispatchIncomingMessage(message, { enrich: async value => value, reply: vi.fn() }, options)).toBe(false);
    expect(getMessagingJournalEntry(message)).toEqual(before); expect(modelCalls()).toBe(0);
  });

  it('accepts a current event with3.3-second platform clock skew exactly once and retains messageId dedup after reload', async () => {
    const message = input(Date.now() + 3_348);
    const reply = vi.fn(async () => 'om-one-platform-reply');
    const transport = { enrich: async (value: IncomingMessage) => value, reply };
    expect(routes.dispatchIncomingMessage(message, transport, options)).toBe(true);
    await vi.waitFor(() => expect(getMessagingJournalEntry(message)?.status).toBe('completed'));
    expect(modelCalls()).toBe(1); expect(reply).toHaveBeenCalledOnce();
    expect(getMessagingJournalEntry(message)).toMatchObject({ replyMessageId: 'om-one-platform-reply', replyRetryable: false });
    expect(routes.dispatchIncomingMessage(message, transport, options)).toBe(false);
    reloadDeliveryLedgerForTest(); resetMessagingIngressPolicyForTest();
    expect(routes.dispatchIncomingMessage(message, transport, options)).toBe(false);
    expect(modelCalls()).toBe(1); expect(reply).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 'not-a-platform-time', '0'])('does not replace missing or invalid Feishu create_time=%s with local receipt time', async createdAt => {
    const message = adapter.parseEvent({ sender: { sender_id: { open_id: 'ou-freshness-user' } }, message: { message_id: 'om-invalid-' + (++sequence), chat_id: 'oc-freshness-chat', chat_type: 'private', message_type: 'text', content: JSON.stringify({ text: '你好' }), create_time: createdAt } })!;
    const reply = vi.fn(async () => 'never-sent');
    expect(routes.dispatchIncomingMessage(message, { enrich: async value => value, reply }, options)).toBe(false);
    expect(getMessagingJournalEntry(message)).toMatchObject({ status: 'ignored', error: 'invalid_message_timestamp' });
    await new Promise(resolve => setImmediate(resolve)); expect(modelCalls()).toBe(0); expect(reply).not.toHaveBeenCalled();
  });

  it('rejects implausible future creation time but retains the small observed platform clock skew', () => {
    const now = Date.now();
    expect(evaluateMessagingIngress(input(now + 60_001), now)).toMatchObject({ allowed: false, reason: 'invalid_message_timestamp' });
    expect(evaluateMessagingIngress(input(now + 3_348), now)).toMatchObject({ allowed: true });
  });

  it.each(['replied', 'processing', 'delivery_unknown'] as const)('retains an existing%s receipt when an old event is redelivered', status => {
    const message = input(Date.now() - 65 * 60_000); recordMessagingIngress(message);
    updateMessagingJournal(message, { status, replyMessageId: 'om-preserved-receipt', replyText: '已有记录', replyRetryable: false });
    const before = getMessagingJournalEntry(message);
    expect(routes.dispatchIncomingMessage(message, { enrich: async value => value, reply: vi.fn() }, options)).toBe(false);
    expect(getMessagingJournalEntry(message)).toEqual(before); expect(modelCalls()).toBe(0);
  });


  it('uses the existing WeCom webhook seconds-to-ISO conversion without rescaling the ingress timestamp', () => {
    const now = Date.now(); const seconds = Math.floor(now / 1000);
    const wecom = new WeComAdapter({} as any);
    const parse = (time: number) => wecom.parseEvent('<xml><FromUserName>fresh-user</FromUserName><MsgType>text</MsgType><Content>你好</Content><CreateTime>' + time + '</CreateTime><MsgId>fresh-wecom-' + time + '</MsgId></xml>')!;
    expect(Date.parse(parse(seconds).timestamp)).toBe(seconds * 1000);
    expect(evaluateMessagingIngress(parse(seconds), now)).toMatchObject({ allowed: true });
    expect(evaluateMessagingIngress(parse(seconds - 3900), now)).toMatchObject({ allowed: false, reason: 'message_expired' });
  });

  it.each(['seconds', 'milliseconds'] as const)('retains the existing WeCom long-connection%s timestamp normalization', unit => {
    const now = Date.now(); const createdAt = unit === 'seconds' ? Math.floor(now / 1000) : now;
    const message = parseWeComLongConnectionMessage({ body: { msgid: 'fresh-ws-' + unit, from: { userid: 'ws-user' }, msgtype: 'text', text: { content: '你好' }, create_time: createdAt } } as any)!;
    expect(evaluateMessagingIngress(message, now)).toMatchObject({ allowed: true });
  });

  it('consumes the declared Telegram ISO timestamp contract without inventing a second seconds parser', () => {
    const now = Date.now(); const message = { ...input(now), platform: 'telegram' as const };
    expect(evaluateMessagingIngress(message, now)).toMatchObject({ allowed: true });
    expect(evaluateMessagingIngress({ ...message, timestamp: String(Math.floor(now / 1000)) }, now)).toMatchObject({ allowed: false, reason: 'invalid_message_timestamp' });
  });

});
