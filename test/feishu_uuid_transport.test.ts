import './helpers';
import crypto from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuAdapter, MessagingDeliveryUnknownError } from '../server/messaging/feishu';
import { claimExternalCommitAttempt, configureExternalCommitJournal, inspectExternalCommitAttempt, resetVolatileExternalCommitJournalForTests } from '../server/tools/external_commit_journal';
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const operation = (kind: string, adapter: FeishuAdapter) => kind === 'reply'
  ? adapter.replyMessage('om-uuid-parent', 'immutable reply')
  : kind === 'send' ? adapter.sendMessage('oc-uuid-chat', { platform: 'feishu', text: 'immutable send', idempotencyKey: 'fixed-send-operation' })
  : adapter.sendCard('oc-uuid-chat', { title: 'Title', body: 'immutable card' }, 'fixed-card-operation');
const seed = (kind: string) => kind === 'reply' ? 'reply:om-uuid-parent:' + sha('immutable reply') : kind === 'send' ? 'fixed-send-operation' : 'fixed-card-operation';
beforeEach(() => { configureExternalCommitJournal(null); resetVolatileExternalCommitJournalForTests(); });
afterEach(() => { vi.restoreAllMocks(); configureExternalCommitJournal(null); resetVolatileExternalCommitJournalForTests(); });
const authResponse = () => new Response(JSON.stringify({ code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 }), { status: 200 });

describe('Feishu official body.uuid transport contract', () => {
  it.each(['reply', 'send', 'card'])('sends%s with the existing uuid in JSON body and reuses its verified delivery once', async kind => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: 'om-one-' + kind } }), { status: 200 }));
    const adapter = new FeishuAdapter({ appId: 'cli_uuid_contract', appSecret: 'synthetic-secret' });
    expect(await operation(kind, adapter)).toBe('om-one-' + kind);
    expect(await operation(kind, adapter)).toBe('om-one-' + kind);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(String(init?.body));
    expect(new URL(String(url)).searchParams.has('uuid')).toBe(false);
    expect(body.uuid).toBe(sha(seed(kind)).slice(0, 32));
    expect(new URL(String(url)).pathname).toBe(kind === 'reply' ? '/open-apis/im/v1/messages/om-uuid-parent/reply' : '/open-apis/im/v1/messages');
    if (kind !== 'reply') expect(new URL(String(url)).searchParams.get('receive_id_type')).toBe('chat_id');
    const { uuid, ...semanticPayload } = body;
    const prefix = kind === 'reply' ? 'reply' : kind === 'send' ? 'send' : 'card';
    const stored = await inspectExternalCommitAttempt('feishu:' + prefix + ':' + uuid);
    expect(stored.entry).toMatchObject({ state: 'verified', inputDigest: sha(JSON.stringify({ target: kind === 'reply' ? 'om-uuid-parent' : 'oc-uuid-chat', payload: semanticPayload })) });
  });

  it.each(['reply', 'send', 'card'])('does not automatically resend%s after an unknown platform outcome', async kind => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(authResponse()).mockRejectedValueOnce(new TypeError('socket closed after write'));
    const adapter = new FeishuAdapter({ appId: 'cli_uuid_contract', appSecret: 'synthetic-secret' });
    await expect(operation(kind, adapter)).rejects.toBeInstanceOf(MessagingDeliveryUnknownError);
    await expect(operation(kind, adapter)).rejects.toThrow(/automatic resend was stopped/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('replays an older verified semantic payload receipt without changing its identity or sending again', async () => {
    const body = { content: JSON.stringify({ text: 'immutable reply' }), msg_type: 'text' };
    const key = 'feishu:reply:' + sha(seed('reply')).slice(0, 32);
    await claimExternalCommitAttempt({ idempotencyKey: key, taskId: key, userId: 'messaging-runtime', toolName: 'feishu_reply_message', inputDigest: sha(JSON.stringify({ target: 'om-uuid-parent', payload: body })), state: 'verified', replayResult: JSON.stringify({ messageId: 'om-prior-verified' }), claimToken: 'synthetic-prior-claim', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(authResponse());
    const adapter = new FeishuAdapter({ appId: 'cli_uuid_contract', appSecret: 'synthetic-secret' });
    expect(await operation('reply', adapter)).toBe('om-prior-verified'); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
