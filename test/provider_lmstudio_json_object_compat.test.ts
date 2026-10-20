import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { makeLLMCall, makeLLMCallStreaming, type LLMCallConfig, type LLMResponseFormat } from '../server/llm/providers';
import type { ProviderArguments } from '../server/llm/provider_getters';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
vi.mock('../server/llm/local_models', async original => ({ ...await original<typeof import('../server/llm/local_models')>(), ensureLocalModelReady: vi.fn(async () => ({})), runLocalModelInference: vi.fn(async (_provider, operation) => operation()) }));
vi.mock('../server/llm/local_model_capacity', async original => ({ ...await original<typeof import('../server/llm/local_model_capacity')>(), loadedLocalContextTokens: vi.fn(async () => 8192) }));
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetCircuit(); });
const messages = [{ role: 'user' as const, content: 'Synthetic protocol test: return a JSON object with ok true.' }];
const objectSchema = { type: 'json_schema', json_schema: { name: 'json_response', schema: { type: 'object', additionalProperties: true } } };
function fixture(provider: string, responseFormat?: LLMResponseFormat) {
  vi.stubEnv('LUMI_PRIVACY', 'standard'); resetCircuit();
  upsertUserPreferredLLM('synthetic-lmstudio-protocol', { provider, model: 'qwen2.5-7b-instruct', selectionMode: 'pinned', allowCloudFallback: false });
  const create = vi.fn(async (params: any) => {
    if (provider === 'lmstudio' && params.response_format?.type === 'json_object') throw Object.assign(new Error("'response_format.type' must be 'json_schema' or 'text'"), { status: 400 });
    if (params.stream) return (async function* () { yield { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }] }; })();
    return { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] };
  });
  const get = () => ({ chat: { completions: { create } } });
  const getters: ProviderArguments = [get, get, get, get, get, get, get, get, get, get, get, get];
  const config: LLMCallConfig = { provider, model: 'qwen2.5-7b-instruct', userId: 'synthetic-lmstudio-protocol', selectionMode: 'pinned', noImplicitFailover: true, maxTokens: 128, responseFormat };
  return { create, config, getters };
}
describe('LM Studio JSON-object compatibility uses the existing provider preparation', () => {
  it.each([false, true])('maps generic JSON object intent only for LM Studio in streaming=%s through the real SDK boundary', async streaming => {
    const f = fixture('lmstudio', 'json_object'); const chunks: string[] = [];
    const response = streaming ? await makeLLMCallStreaming(messages, [], f.config, text => chunks.push(text), ...f.getters) : await makeLLMCall(messages, [], f.config, ...f.getters);
    expect(JSON.parse(response.text!)).toEqual({ ok: true }); expect(f.create).toHaveBeenCalledOnce();
    expect(f.create.mock.calls[0][0]).toMatchObject({ model: 'qwen2.5-7b-instruct', response_format: objectSchema });
    expect(f.create.mock.calls[0][0].max_tokens).toBeLessThanOrEqual(128); if (streaming) expect(chunks.join('')).toBe('{"ok":true}');
  });
  it.each(['relay', 'deepseek', 'qwen', 'openai', 'ollama'])('leaves %s generic JSON mode unchanged', async provider => {
    const f = fixture(provider, 'json_object'); expect((await makeLLMCall(messages, [], f.config, ...f.getters)).text).toBe('{"ok":true}');
    expect(f.create.mock.calls[0][0].response_format).toEqual({ type: 'json_object' }); expect(f.create).toHaveBeenCalledOnce();
  });
  it('preserves an explicit caller schema including its required properties', async () => {
    const schema: LLMResponseFormat = { type: 'json_schema', json_schema: { name: 'explicit_contract', strict: false, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } };
    const f = fixture('lmstudio', schema); await makeLLMCall(messages, [], f.config, ...f.getters); expect(f.create.mock.calls[0][0].response_format).toEqual(schema);
  });
  it('does not add a schema to ordinary unstructured text requests', async () => {
    const f = fixture('lmstudio'); await makeLLMCall(messages, [], f.config, ...f.getters); expect(f.create.mock.calls[0][0]).not.toHaveProperty('response_format');
  });
  it('does not retry or outlive a caller cancellation while the SDK request is pending', async () => {
    const f = fixture('lmstudio', 'json_object'); const controller = new AbortController(); let started: () => void; const began = new Promise<void>(resolve => { started = resolve; });
    f.create.mockImplementation((_params: any, options?: any) => new Promise<any>((_resolve, reject) => { started(); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }));
    const pending = expect(makeLLMCall(messages, [], { ...f.config, signal: controller.signal }, ...f.getters)).rejects.toThrow('synthetic caller cancellation'); await began; controller.abort(new Error('synthetic caller cancellation')); await pending;
    expect(f.create).toHaveBeenCalledOnce(); expect(f.create.mock.calls[0][0].response_format).toEqual(objectSchema);
  });
});
