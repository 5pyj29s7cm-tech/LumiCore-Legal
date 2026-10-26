import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { sdkCompletion } from './legal_bid_fixture';
import { generateBidHandler } from '../server/regions/packs/cn/legal_tools/contracts';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getToolExecutionTimeoutMs } from '../server/tools/registry';
import { LEGAL_BID_TOOL_TIMEOUT_MS } from '../server/legal/budgets';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import * as cases from '../server/org/legal_cases';
let app: Awaited<ReturnType<typeof makeApp>>;
const userId = 'bid-sdk-wait-test-owner';
const source = '虚构验收材料：报价254400元，专项资质与履约证据尚未核实。SDK-BID-SOURCE-TAIL';
const body = '按给定材料形成内部响应工作稿，报价、专项资质和履约证明仍需责任人核对，不冒充已经投标或取得外部确认。';
const promptOf = (params: any) => String(params.messages.find((m: any) => m.role === 'user')?.content || '');
const completion = (params: any) => ({ choices: [{ message: { content: body }, finish_reason: 'stop' }] });
const fixture = (create: any, original = source, parent?: AbortSignal) => {
  const orgId = cases.legalWorkspaceNamespace(userId), item = cases.createCase(orgId, userId, { title: '虚构标书预算-' + crypto.randomUUID() });
  return { orgId, item, args: { projectName: item.title, requirements: original, persistCase: true, caseId: item.id }, context: { userId, domain: 'personal', source: 'legal-direct-tool', executionSignal: parent, llmGetters: { getRelay: () => ({ chat: { completions: { create } } }) } } };
};
const run = async (f: ReturnType<typeof fixture>) => decodeToolResult(await generateBidHandler(f.args, f.context));
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
beforeEach(() => { vi.stubEnv('LUMI_PRIVACY', 'standard'); resetCircuit(); upsertUserPreferredLLM(userId, { provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetCircuit(); });
describe('one Markdown bid request honors existing total time and cancellation budgets', () => {
  it('allows a 190-second streamed Markdown document beyond the removed per-unit limit with the configured model', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const create = vi.fn((params: any, options: any) => sdkCompletion(params, completion(params), 190_000, options.signal));
    const pending = run(fixture(create)); await vi.advanceTimersByTimeAsync(180_001); expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); const result = await pending;
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(create).toHaveBeenCalledTimes(1);
    for (const [params] of create.mock.calls) { expect(params).toMatchObject({ model: 'aliyun/deepseek-v4-flash', reasoning_effort: 'low', stream: true }); expect(params).not.toHaveProperty('max_tokens'); }
    expect(result.content).toContain(source); expect(getToolExecutionTimeoutMs('legal_generate_bid')).toBe(LEGAL_BID_TOOL_TIMEOUT_MS);
  });
  it('times out an unresponsive full-document call without retrying or archiving the partial result', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); const create = vi.fn(() => new Promise(() => {})); const f = fixture(create);
    const pending = run(f); await vi.advanceTimersByTimeAsync(720_002); const result = await pending;
    expect(create).toHaveBeenCalledTimes(1); expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).toContain('标书生成未完成'); expect(result.content).toContain(source);
    expect(cases.getCase(f.orgId, f.item.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
  });
  it('honors caller cancellation without another model request, a success artifact or case archive', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); const controller = new AbortController();
    const create = vi.fn((params: any, options: any) => sdkCompletion(params, completion(params), 70_000, options.signal)), f = fixture(create, source, controller.signal);
    const cancelled = expect(run(f)).rejects.toThrow('virtual caller cancelled'); await vi.advanceTimersByTimeAsync(10_000); expect(create).toHaveBeenCalledTimes(1);
    controller.abort(new Error('virtual caller cancelled')); await cancelled; await vi.advanceTimersByTimeAsync(70_000); expect(create).toHaveBeenCalledTimes(1);
    expect(cases.getCase(f.orgId, f.item.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
  });
});
