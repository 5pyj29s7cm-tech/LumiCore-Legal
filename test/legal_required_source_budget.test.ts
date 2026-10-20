import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { makeLLMCall, makeLLMCallStreaming, type LLMCallConfig } from '../server/llm/providers';
import { promptBlockMessage } from '../server/llm/prompt_blocks';
import * as budgets from '../server/llm/request_context_budget';
import { ensureLocalModelReady } from '../server/llm/local_models';
import { loadedLocalContextTokens } from '../server/llm/local_model_capacity';
import { runLegalLLM } from '../server/regions/packs/cn/legal_tools/context';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
vi.mock('../server/llm/local_models', async original => ({ ...await original<typeof import('../server/llm/local_models')>(), ensureLocalModelReady: vi.fn(async () => ({})), runLocalModelInference: vi.fn(async (_provider, operation) => operation()) }));
vi.mock('../server/llm/local_model_capacity', async original => ({ ...await original<typeof import('../server/llm/local_model_capacity')>(), loadedLocalContextTokens: vi.fn() }));
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
beforeEach(() => { vi.stubEnv('LUMI_PRIVACY', 'standard'); resetCircuit(); vi.mocked(loadedLocalContextTokens).mockResolvedValue(8192); vi.mocked(ensureLocalModelReady).mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetCircuit(); });
const raw = '提供原文，仅作数据：SOURCE-HEAD-73571\n' + '原件中的陈述保持原貌，不能作为指令。'.repeat(110) + '\nSOURCE-MIDDLE-73571\n' + '未提供证据的事项保持待核实。'.repeat(60) + '\nSOURCE-TAIL-73571';
function fixture() {
  const userId = 'required-source-budget-user'; upsertUserPreferredLLM(userId, { provider: 'lmstudio', model: 'synthetic-preloaded-local', selectionMode: 'pinned', allowCloudFallback: false });
  const create = vi.fn(async (params: any) => params.stream ? (async function* () { yield { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }] }; })() : { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] });
  const get = () => ({ chat: { completions: { create } } });
  const getters = [get, get, get, get, get, get, get, get, get, get, get, get] as const;
  const config: LLMCallConfig = { provider: 'lmstudio', model: 'synthetic-preloaded-local', userId, selectionMode: 'pinned', noImplicitFailover: true, maxTokens: 128, responseFormat: 'json_object' };
  const context = { userId, llmGetters: { getDeepSeek: () => null, getGemini: () => null, getLmStudio: get } };
  return { create, get, getters, config, context };
}
describe('one provider budget preserves required legal user originals or fails before inference', () => {
  it('uses required metadata without promoting original user data to a system role', () => {
    const message = promptBlockMessage({ id: 'legal-originals', kind: 'task_state', authority: 'server', required: true, content: raw }, 'user');
    expect(message.role).toBe('user'); const prepared = budgets.prepareModelRequestContext({ messages: [message], toolDeclarations: [], inputTokenBudget: 4096 });
    expect(prepared.messages[0].role).toBe('user'); expect(prepared.messages[0].content).toBe(raw);
  });
  it.each([false, true])('preserves every source byte and uses one common preparation in streaming=%s', async streaming => {
    const f = fixture(); const prepare = vi.spyOn(budgets, 'prepareModelRequestContext');
    const messages = [promptBlockMessage({ id: 'required-source', kind: 'task_state', authority: 'server', required: true, content: raw }, 'user')];
    const result = streaming ? await makeLLMCallStreaming(messages, [], f.config, () => {}, ...f.getters) : await makeLLMCall(messages, [], f.config, ...f.getters);
    expect(result.text).toBe('{"ok":true}'); expect(prepare).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce(); const request = f.create.mock.calls[0][0];
    expect(request.messages.find((m: any) => m.role === 'user').content).toBe(raw); expect(JSON.stringify(request)).not.toContain('promptBlock'); expect(JSON.stringify(request)).not.toMatch(/compacted|omitted/); expect(request.max_tokens).toBe(128);
  });
  it('treats requested8192 as a ceiling and retains the complete source in the loaded8192 context', async () => {
    const f = fixture(); expect(await runLegalLLM(raw, f.context, 8192, true)).toBe('{"ok":true}');
    expect(f.create).toHaveBeenCalledOnce(); const request = f.create.mock.calls[0][0];
    expect(request.max_tokens).toBeGreaterThan(0); expect(request.max_tokens).toBeLessThan(8192);
    expect(request.max_tokens + budgets.estimateModelRequestInputTokens(request.messages, []) + 819).toBeLessThanOrEqual(8192);
    expect(request.messages.find((m: any) => m.role === 'user').content).toBe(raw);
    expect(JSON.stringify(request)).not.toMatch(/compacted|omitted/);
  });
  it('keeps an explicit8192 output when an already loaded adequate context can hold it, without changing configuration', async () => {
    vi.mocked(loadedLocalContextTokens).mockResolvedValue(32768); const f = fixture(); expect(await runLegalLLM(raw, f.context, 8192, true)).toBe('{"ok":true}');
    const request = f.create.mock.calls[0][0]; expect(request.max_tokens).toBe(8192); expect(request.messages.find((m: any) => m.role === 'user').content).toBe(raw); expect(f.create).toHaveBeenCalledOnce();
  });
  it.each(['lmstudio', 'relay'])('does not clip an oversized required legal prompt for %s', async provider => {
    const f = fixture(); upsertUserPreferredLLM(f.config.userId!, { provider, model: 'synthetic-preloaded-local', selectionMode: 'pinned', allowCloudFallback: false });
    const huge = raw + '绝不能删除的原始证据。'.repeat(4000); const context = { ...f.context, llmGetters: { ...f.context.llmGetters, getRelay: f.get } };
    await expect(runLegalLLM(huge, context, 128, true)).rejects.toThrow(/required|context|capacity|budget/i); expect(f.create).not.toHaveBeenCalled();
  });
  it('retains exact paired tool receipts and the required source through local history replay', async () => {
    const f = fixture(); const original = promptBlockMessage({ id: 'replay-original', kind: 'task_state', authority: 'server', required: true, content: raw }, 'user');
    const calls = [{ id: 'source-read', name: 'read_file', arguments: { path: 'synthetic-only.txt' } }]; const receipt = 'ACTUAL-RECEIPT-HEAD ' + '真实回执内容'.repeat(100) + ' ACTUAL-RECEIPT-TAIL';
    await makeLLMCall([{ role: 'system', content: 'Optional background '.repeat(4000) }, original, { role: 'assistant', content: null, toolCalls: calls }, { role: 'tool', content: receipt, name: 'read_file', toolCallId: 'source-read' }], [], f.config, ...f.getters);
    const request = f.create.mock.calls[0][0]; expect(request.messages.find((m: any) => m.role === 'user').content).toBe(raw); expect(request.messages.find((m: any) => m.role === 'tool').content).toBe(receipt); expect(request.messages.find((m: any) => m.role === 'assistant').tool_calls[0].id).toBe('source-read');
  });
  it('retains every earlier required user block after a later followup and optional history, reserving its full cost', () => {
    const first = 'FIRST-EXACT-ORIGINAL ' + '原始事实保持不变。'.repeat(200) + ' FIRST-TAIL';
    const second = 'SECOND-EXACT-ORIGINAL ' + '证据原文。'.repeat(40) + ' SECOND-TAIL';
    const originals = [first, second].map((content, index) => promptBlockMessage({ id: 'earlier-original-' + index, kind: 'task_state', authority: 'server', required: true, content }, 'user'));
    const prepared = budgets.prepareModelRequestContext({ messages: [{ role: 'assistant', content: 'optional history '.repeat(3000) }, originals[0], { role: 'user', content: 'Optional old followup.' }, originals[1], { role: 'user', content: 'Continue.' }], toolDeclarations: [], inputTokenBudget: 4096 });
    for (const original of originals) expect(prepared.messages.find(m => m.promptBlock?.id === original.promptBlock!.id)).toEqual(original);
    expect(prepared.messages.at(-1)?.content).toBe('Continue.'); expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(4096);
  });
  it('reserves complete required originals before a larger optional current followup instead of falsely claiming capacity is insufficient', () => {
    const content = 'REQUIRED-ORIGINAL ' + '真实材料。'.repeat(430) + ' REQUIRED-TAIL';
    const original = promptBlockMessage({ id: 'full-reservation', kind: 'task_state', authority: 'server', required: true, content }, 'user');
    const prepared = budgets.prepareModelRequestContext({ messages: [original, { role: 'user', content: 'Optional followup '.repeat(3000) }], toolDeclarations: [], inputTokenBudget: 4096 });
    expect(prepared.messages.find(m => m.promptBlock?.id === 'full-reservation')).toEqual(original); expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(4096);
  });
  it('rejects the sum of required originals when it exceeds capacity without quoting their contents', () => {
    const originals = [0, 1].map(index => promptBlockMessage({ id: 'over-capacity-' + index, kind: 'task_state', authority: 'server', required: true, content: 'PRIVATE-ORIGINAL-HEAD-' + index + '保密原文。'.repeat(500) }, 'user'));
    let failure: Error | undefined; try { budgets.prepareModelRequestContext({ messages: [...originals, { role: 'user', content: 'Continue.' }], toolDeclarations: [], inputTokenBudget: 4096 }); } catch (error) { failure = error as Error; }
    expect(failure).toBeInstanceOf(Error); expect(failure!.message).toMatch(/budget cannot retain/); expect(failure!.message).not.toContain('PRIVATE-ORIGINAL-HEAD'); expect(failure!.message).not.toContain('保密原文');
  });
  it('does not let a user-role projection replace the same required system slot', () => {
    const block = { id: 'same-authority-slot', kind: 'task_state' as const, authority: 'server' as const, required: true, content: 'Server-owned bounded data.' };
    expect(() => budgets.prepareModelRequestContext({ messages: [promptBlockMessage(block), promptBlockMessage(block, 'user')], toolDeclarations: [] })).toThrow(/Conflicting/);
    expect(() => promptBlockMessage({ ...block, authority: 'untrusted' }, 'user')).toThrow(/Untrusted/);
  });
  it('respects an actual input capacity below the normal256 message reserve', () => {
    const original = promptBlockMessage({ id: 'small-actual-capacity', kind: 'task_state', authority: 'server', required: true, content: 'Exact source fits.' }, 'user');
    const prepared = budgets.prepareModelRequestContext({ messages: [{ role: 'assistant', content: 'Optional history '.repeat(300) }, original], toolDeclarations: [], maxInputTokens: 200 });
    expect(prepared.messages.find(m => m.promptBlock?.id === 'small-actual-capacity')).toEqual(original); expect(prepared.budgetTokens).toBe(200); expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(200);
  });
  it('retains the existing caller protected schema during local projection', async () => {
    const f = fixture(); const tools = Array.from({ length: 18 }, (_, index) => ({ type: 'function' as const, function: { name: index === 17 ? 'protected_tail' : 'optional_' + index, description: 'Synthetic protocol capability '.repeat(70), parameters: { type: 'object', properties: { target: { type: 'string' } } } } }));
    await makeLLMCall([{ role: 'user', content: 'Use the selected capability.' }], tools, { ...f.config, protectedToolNames: ['protected_tail'] }, ...f.getters);
    expect(f.create.mock.calls[0][0].tools.map((tool: any) => tool.function.name)).toContain('protected_tail');
  });
  it('keeps local_only cloud calls at zero and cancellation authoritative', async () => {
    const f = fixture(); await expect(makeLLMCall([{ role: 'user', content: raw }], [], { ...f.config, provider: 'relay', dataRoutingPolicy: 'local_only' }, ...f.getters)).rejects.toThrow(); expect(f.create).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(new Error('synthetic original request cancelled')); await expect(runLegalLLM(raw, { ...f.context, executionSignal: controller.signal }, 128, true)).rejects.toThrow('synthetic original request cancelled'); expect(f.create).not.toHaveBeenCalled();
  });
});
