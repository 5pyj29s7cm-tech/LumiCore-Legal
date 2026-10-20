import jwt from 'jsonwebtoken';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { makeLLMCall } from '../server/llm/providers';
import * as preferences from '../server/llm/user_preferences';
import { addMember, createOrg } from '../server/org/db';
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn() }));
let app: Awaited<ReturnType<typeof makeApp>>;
const uid = 'synthetic-meeting-request-owner';
const preferred = { provider: 'relay' as const, model: 'synthetic-meeting-model', userId: uid, selectionMode: 'pinned' as const,
  fallbackCandidates: [{ provider: 'openai' as const, model: 'synthetic-fallback' }], allowCloudFallback: false, maxTokens: 4096 };
const notes = [{ id: 'source-note', time: 1000, text: '虚构会议原句，金额与期限仍需核实。SOURCE-END' }];
const headers = (orgId?: string) => ({ Authorization: 'Bearer ' + jwt.sign({ uid, role: 'user', ...(orgId ? { orgId } : {}) }, JWT_SECRET), 'Content-Type': 'application/json', 'X-Request-Id': 'forged-header-request' });
const post = (body: unknown, orgId?: string) => fetch(app.url + '/api/meeting/analyze', { method: 'POST', headers: headers(orgId), body: JSON.stringify(body) });
beforeAll(async () => { app = await makeApp(); const absent = () => null; mountChatRoutes(app.apiRouter, JWT_SECRET, { getDeepSeek: absent, getGemini: absent, getOpenAI: absent, getAnthropic: absent, getQwen: absent }); });
afterAll(() => app.cleanup());
beforeEach(() => { vi.spyOn(preferences, 'getUserPreferredLLMConfig').mockImplementation((_uid, options) => ({ ...preferred, ...options })); vi.mocked(makeLLMCall).mockResolvedValue({ text: '虚构完整总结，不构成法律核准。', finishReason: 'stop', toolCalls: [] } as any); });
afterEach(() => { vi.restoreAllMocks(); vi.mocked(makeLLMCall).mockReset(); });
describe('meeting analysis retains the one request scope and cancellation owner', () => {
  it('passes authenticated organization, existing fallback settings and server identity to the one model call', async () => {
    const org = createOrg('虚构会议请求组织', 'synthetic-meeting-request-org', uid); addMember(org.id, uid, 'owner');
    const response = await post({ notes, domain: 'personal', orgId: 'forged-org', requestId: 'forged-body-request', provider: 'relay' }, org.id);
    expect(response.status).toBe(200); const body = await response.json() as any; expect(makeLLMCall).toHaveBeenCalledTimes(1);
    const config = vi.mocked(makeLLMCall).mock.calls[0][2];
    expect(config).toMatchObject({ ...preferred, domain: 'work', orgId: org.id, source: 'meeting-analyze' });
    expect(config.signal).toBeInstanceOf(AbortSignal); expect(config.signal!.aborted).toBe(false);
    expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/); expect(config.requestId).toBe(body.requestId);
    expect(config.requestId).not.toBe('forged-body-request'); expect(config.requestId).not.toBe('forged-header-request');
    expect(JSON.stringify(vi.mocked(makeLLMCall).mock.calls[0][0])).toContain('SOURCE-END');
  });
  it('keeps a personal request personal despite body and header scope claims', async () => {
    const response = await post({ notes, domain: 'work', orgId: 'forged-organization' }); expect(response.status).toBe(200);
    const body = await response.json() as any, config = vi.mocked(makeLLMCall).mock.calls[0][2];
    expect(config).toMatchObject({ domain: 'personal', orgId: '', source: 'meeting-analyze', requestId: body.requestId });
    expect(config.signal).toBeInstanceOf(AbortSignal); expect(config.signal!.aborted).toBe(false);
  });
  it('aborts only the disconnected HTTP request and does not dispatch another model call', async () => {
    let captured: any, finish!: (value: any) => void;
    vi.mocked(makeLLMCall).mockImplementationOnce(async (_messages, _tools, config) => { captured = config; return new Promise(resolve => { finish = resolve; }); });
    const request = http.request(new URL('/api/meeting/analyze', app.url), { method: 'POST', headers: headers() }); request.on('error', () => {}); request.end(JSON.stringify({ notes }));
    try {
      await vi.waitFor(() => expect(captured).toBeTruthy()); request.destroy();
      await vi.waitFor(() => expect(captured.signal?.aborted).toBe(true), { timeout: 1000 }); expect(makeLLMCall).toHaveBeenCalledTimes(1);
    } finally { request.destroy(); finish?.({ text: 'LATE-IGNORED-REPORT', finishReason: 'stop', toolCalls: [] }); }
  });
  it('rejects empty originals without dispatching a model', async () => {
    const response = await post({ notes: [] }); expect(response.status).toBe(400); expect(makeLLMCall).not.toHaveBeenCalled();
  });
});
