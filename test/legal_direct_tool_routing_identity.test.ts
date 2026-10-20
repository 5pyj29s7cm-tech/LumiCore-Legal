import { sdkCompletion } from './legal_bid_fixture';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { toolRegistry } from '../server/tools/registry';
import { encodeToolResult } from '../server/tools/result_envelope';
import { runLegalLLM } from '../server/regions/packs/cn/legal_tools/context';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { listModelRoutingReceipts } from '../server/llm/model_routing_receipts';
import { addMember, createOrg } from '../server/org/db';
import { resetCircuit } from '../server/cloud/circuit_breaker';

const userId = 'legal-http-routing-owner', memberId = 'legal-http-routing-member';
const token = (uid: string, orgId?: string) => jwt.sign({ uid, username: uid, role: 'user', ...(orgId ? { orgId } : {}) }, JWT_SECRET);
const bearer = (value: string) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + value });
let app: Awaited<ReturnType<typeof makeApp>>, orgId: string;
let mode: 'ok' | 'fail' | 'wait' = 'ok';
let sdkSignal: AbortSignal | undefined, sdkStarted: (() => void) | undefined;
const contexts: any[] = [];
const create = vi.fn(async (_payload: any, options?: { signal?: AbortSignal }) => {
  sdkSignal = options?.signal;
  if (mode === 'fail') throw new Error('controlled provider failure');
  if (mode === 'wait') return new Promise<never>((_resolve, reject) => {
    sdkStarted?.();
    sdkSignal!.addEventListener('abort', () => reject(sdkSignal!.reason), { once: true });
  });
  return sdkCompletion(_payload, { choices: [{ message: { content: 'Only an isolated SDK fixture response.' }, finish_reason: 'stop' }] });
});
const unavailable = () => null;
const getters = { getDeepSeek: () => ({ chat: { completions: { create } } }), getGemini: unavailable,
  getOpenAI: unavailable, getAnthropic: unavailable, getQwen: unavailable };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const post = (body: any = {}, headers: Record<string, string> = bearer(token(userId)), path = 'legal/tool/legal_review_contract', signal?: AbortSignal) =>
  fetch(app.url + '/api/' + path, { method: 'POST', headers, body: JSON.stringify(body), signal });

beforeAll(async () => {
  app = await makeApp();
  orgId = createOrg('Isolated HTTP routing identity', 'legal-http-routing', 'legal-http-routing-admin').id;
  addMember(orgId, memberId, 'member');
  for (const uid of [userId, memberId]) upsertUserPreferredLLM(uid, { provider: 'deepseek', model: 'deepseek-v4-flash', selectionMode: 'pinned' });
  mountChatRoutes(app.apiRouter, JWT_SECRET, getters as any);
  expect(toolRegistry.register({ name: 'legal_review_contract', description: 'Isolated routing identity probe',
    parameters: { type: 'object', properties: { contract: { type: 'string' }, calls: { type: 'number' } } },
    permission: 'user', securityLevel: 'safe', handler: async (args, context) => {
      contexts.push(context);
      let text = '';
      for (let i = 0; i < (args.calls === 2 ? 2 : 1); i++) text = await runLegalLLM('Isolated source paragraph.', context, 256) || '';
      return encodeToolResult(text, { ok: true, status: 'reviewed' });
    } })).toBe(true);
});
afterAll(() => { toolRegistry.unregister('legal_review_contract'); app.cleanup(); });
beforeEach(() => { mode = 'ok'; sdkSignal = undefined; sdkStarted = undefined; contexts.length = 0; create.mockClear(); resetCircuit(); });

describe('direct legal HTTP execution identity reaches the existing SDK routing ledger', () => {
  it('binds both model stages to the actual execution ID without promoting client IDs', async () => {
    const clientId = 'client-forged-request-id';
    const response = await post({ requestId: clientId, args: { contract: 'Synthetic contract.', calls: 2, requestId: 'forged-tool-argument' } },
      { ...bearer(token(userId)), 'X-Request-Id': 'forged-header-id' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.requestId).toMatch(uuid);
    expect(body.requestId).not.toBe(clientId);
    expect(body.requestId).not.toBe('forged-header-id');
    expect(body.requestId).not.toBe('forged-tool-argument');
    expect(contexts[0].requestId).toBe(body.requestId);
    expect(create).toHaveBeenCalledTimes(2);
    const routes = listModelRoutingReceipts(userId, 100, { requestId: body.requestId });
    expect(routes).toHaveLength(2);
    for (const route of routes) expect(route).toMatchObject({ requestId: body.requestId, userId, domain: 'personal', orgId: '',
      conversationId: '', source: 'legal-direct-tool', status: 'succeeded' });
    expect(listModelRoutingReceipts(userId, 100, { requestId: clientId })).toHaveLength(0);
  });

  it('allocates distinct server IDs for independent HTTP requests with no client identity', async () => {
    const first = await (await post({ args: { contract: 'First virtual source.' } })).json();
    const second = await (await post({ args: { contract: 'Second virtual source.' } })).json();
    expect(first.requestId).toMatch(uuid);
    expect(second.requestId).toMatch(uuid);
    expect(first.requestId).not.toBe(second.requestId);
    expect(listModelRoutingReceipts(userId, 100, { requestId: first.requestId })).toHaveLength(1);
    expect(listModelRoutingReceipts(userId, 100, { requestId: second.requestId })).toHaveLength(1);
  });

  it('keeps authenticated organization scope instead of trusting argument scope', async () => {
    const response = await post({ args: { contract: 'Virtual organization source.', userId, orgId: 'forged-org', domain: 'personal',
      source: 'forged-source', conversationId: 'forged-conversation' } }, bearer(token(memberId, orgId)));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(contexts[0]).toMatchObject({ userId: memberId, domain: 'work', orgId, source: 'legal-direct-tool' });
    expect(listModelRoutingReceipts(memberId, 100, { requestId: body.requestId })).toEqual([
      expect.objectContaining({ requestId: body.requestId, userId: memberId, domain: 'work', orgId, source: 'legal-direct-tool', conversationId: '' }),
    ]);
    expect(listModelRoutingReceipts(userId, 100, { requestId: body.requestId })).toHaveLength(0);
  });

  it('preserves the identity on the existing contract-review alias', async () => {
    const response = await post({ contract: 'Alias virtual source.', requestId: 'forged-alias-request' }, bearer(token(userId)), 'legal/contract-review');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.requestId).toMatch(uuid);
    expect(listModelRoutingReceipts(userId, 100, { requestId: body.requestId })).toHaveLength(1);
  });

  it('returns only the real execution record ID when the provider fails', async () => {
    mode = 'fail';
    const response = await post({ requestId: 'forged-failed-request', args: { contract: 'Failing virtual source.' } });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'LEGAL_TOOL_EXECUTION_FAILED', requestId: contexts[0].requestId });
    expect(body.requestId).toMatch(uuid);
    const routes = listModelRoutingReceipts(userId, 100, { requestId: body.requestId });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ status: 'failed', source: 'legal-direct-tool' });
  });

  it('keeps HTTP disconnect cancellation connected to the SDK and the same failed trace', async () => {
    mode = 'wait';
    const started = new Promise<void>(resolve => { sdkStarted = resolve; });
    const controller = new AbortController();
    const pending = post({ args: { contract: 'Cancelled virtual source.' } }, bearer(token(userId)), undefined, controller.signal)
      .then(() => false, () => true);
    await started;
    const requestId = contexts[0].requestId;
    controller.abort();
    expect(await pending).toBe(true);
    await expect.poll(() => sdkSignal?.aborted).toBe(true);
    expect(requestId).toMatch(uuid);
    await expect.poll(() => listModelRoutingReceipts(userId, 100, { requestId })[0]?.status).toBe('failed');
    expect(create).toHaveBeenCalledOnce();
  });

  it('keeps an existing chat context request, source and conversation ID on nested legal model calls', async () => {
    const requestId = 'existing-server-chat-request', conversationId = 'existing-server-conversation';
    await runLegalLLM('Virtual source within an admitted chat.', { userId, domain: 'personal', orgId: '', requestId,
      conversationId, source: 'native_text', llmGetters: getters }, 256);
    expect(listModelRoutingReceipts(userId, 100, { requestId, conversationId })).toEqual([
      expect.objectContaining({ requestId, conversationId, source: 'native_text', userId, domain: 'personal', orgId: '' }),
    ]);
  });
});
