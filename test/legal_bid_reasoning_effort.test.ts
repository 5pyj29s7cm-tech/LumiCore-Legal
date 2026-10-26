import './helpers';
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkCompletion } from './legal_bid_fixture';
import { getDataDirectory } from '../server/config/data_path';
import { generateBidHandler } from '../server/regions/packs/cn/legal_tools/contracts';
import { runLegalLLM } from '../server/regions/packs/cn/legal_tools/context';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getUserPreferredLLM, upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import * as cases from '../server/org/legal_cases';
vi.mock('../server/llm/local_models', async original => ({ ...await original<typeof import('../server/llm/local_models')>(), ensureLocalModelReady: vi.fn(async () => ({})), runLocalModelInference: vi.fn(async (_provider, operation) => operation()) }));
vi.mock('../server/llm/local_model_capacity', async original => ({ ...await original<typeof import('../server/llm/local_model_capacity')>(), loadedLocalContextTokens: vi.fn(async () => 32768) }));
const original = 'R01【范围】仅为虚构验收，服务条款、主体资格与原件真实性均待核实；不得生成提交或签章证明。';
const proposed = '本节为虚构材料的条件响应，引用完整原句，不认定资格、事实、法律或投标已核准；未提供证明仍待补，不作新付款和期限承诺。';
const promptOf = (request: any) => String(request.messages.find((message: any) => message.role === 'user')?.content || '');
const ledgerSnapshot = () => { const file = path.join(getDataDirectory('org'), 'legal_cases.json'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; };
beforeAll(async () => { await (await import('../db_layer')).initDatabase(); });
beforeEach(() => { vi.stubEnv('LUMI_PRIVACY', 'standard'); resetCircuit(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetCircuit(); });
function setup(localOnly = false, delayMs = 0) {
  const userId = 'bid-effort-' + crypto.randomUUID();
  upsertUserPreferredLLM(userId, { provider: localOnly ? 'lmstudio' : 'relay', model: localOnly ? 'synthetic-loaded-local' : 'aliyun/deepseek-v4-flash', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
  const create = vi.fn((request: any, options: any) => sdkCompletion(request, { choices: [{ message: { content: proposed }, finish_reason: 'stop' }] }, delayMs, options.signal));
  const cloud = vi.fn(() => ({ chat: { completions: { create } } }));
  const local = vi.fn(() => ({ chat: { completions: { create } } }));
  const context = { userId, domain: 'personal', source: 'legal-direct-tool', ...(localOnly ? { dataRoutingPolicy: 'local_only' as const } : {}),
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, ...(localOnly ? { getRelay: cloud, getLmStudio: local } : { getRelay: cloud }) } };
  const args = { projectName: '虚构标书低推理传递-' + userId, requirements: original, persistCase: false, useModel: true };
  return { userId, create, cloud, local, context, args };
}
function wireFixture() {
  const wire: any[] = [];
  const fetch = vi.fn(async (_url: any, init: any) => {
    const request = JSON.parse(init.body); wire.push(request);
    const chunk = (content: string | null, finish: string | null) => ({ id: 'synthetic-budget-wire', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }] });
    return new Response('data: ' + JSON.stringify(chunk(proposed, null)) + '\n\ndata: ' + JSON.stringify(chunk(null, 'stop')) + '\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const sdk = new OpenAI({ apiKey: 'synthetic-offline-only', baseURL: 'https://synthetic.invalid/v1', maxRetries: 0, fetch: fetch as any });
  return { wire, fetch, sdk };
}
describe('normal bid generation retains the configured model and effort', () => {
  it('uses the configured user model and authorized low effort for one streamed Markdown generation', async () => {
    const f = setup(), before = JSON.stringify(getUserPreferredLLM(f.userId)), ledger = ledgerSnapshot();
    const result = decodeToolResult(await generateBidHandler(f.args, f.context));
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(f.create).toHaveBeenCalledOnce();
    const requests = f.create.mock.calls.map(([request]) => request);
    for (const request of requests) {
      expect(request).toMatchObject({ model: 'aliyun/deepseek-v4-flash', reasoning_effort: 'low', stream: true });
      expect(request).not.toHaveProperty('max_tokens');
      expect(request).not.toHaveProperty('response_format');
      expect(request.thinking?.type).not.toBe('disabled');
      expect(promptOf(request)).toContain(original);
    }
    expect(JSON.stringify(getUserPreferredLLM(f.userId))).toBe(before);
    expect(ledgerSnapshot()).toBe(ledger);
  });
  it.each(['aliyun/deepseek-v4-flash', 'aliyun/kimi-k3'])('leaves the service output budget unset for a real SDK bid request to %s', async model => {
    const f = setup(), transport = wireFixture();
    upsertUserPreferredLLM(f.userId, { provider: 'relay', model, selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
    const preference = JSON.stringify(getUserPreferredLLM(f.userId));
    const result = decodeToolResult(await generateBidHandler(f.args, { ...f.context, llmGetters: { ...f.context.llmGetters, getRelay: () => transport.sdk } }));
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(transport.fetch).toHaveBeenCalledOnce();
    expect(transport.wire[0]).toMatchObject({ model, stream: true });
    expect(transport.wire[0]).not.toHaveProperty('max_tokens'); expect(transport.wire[0]).not.toHaveProperty('max_completion_tokens');
    expect(transport.wire[0]).not.toHaveProperty('response_format'); expect(promptOf(transport.wire[0])).toContain(original);
    expect(result.content).toContain(proposed); expect(JSON.stringify(getUserPreferredLLM(f.userId))).toBe(preference);
  });
  it.each([undefined, null])('distinguishes the existing default from explicit service budget=%s on the installed SDK wire', async maxTokens => {
    const f = setup(), transport = wireFixture();
    const result = await runLegalLLM('Synthetic budget compatibility call; no legal conclusion requested.', { ...f.context, llmGetters: { ...f.context.llmGetters, getRelay: () => transport.sdk } }, maxTokens);
    expect(result).toBe(proposed); expect(transport.fetch).toHaveBeenCalledOnce();
    if (maxTokens === null) expect(transport.wire[0]).not.toHaveProperty('max_tokens');
    else expect(transport.wire[0]).toMatchObject({ max_tokens: 2048 });
    expect(transport.wire[0]).not.toHaveProperty('max_completion_tokens');
  });
  it('passes six complete material texts in one request and preserves the original file bytes', async () => {
    const f = setup();
    const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/legal_bid_six_materials_164.json'), 'utf8'));
    const directory = getDataDirectory(path.join('synthetic-bid-six-sources', f.userId));
    const files = fixture.materials.map((material: any, index: number) => {
      const filename = path.join(directory, String(index + 1).padStart(2, '0') + '-synthetic-original.txt');
      fs.writeFileSync(filename, material.content, 'utf8');
      return { filename, bytes: fs.readFileSync(filename), content: material.content };
    });
    expect(files).toHaveLength(6);
    const result = decodeToolResult(await generateBidHandler({ ...f.args, requirements: undefined, filePaths: files.map((file: any) => file.filename), maxChars: 60_000 }, f.context));
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(f.create).toHaveBeenCalledOnce();
    const prompt = promptOf(f.create.mock.calls[0][0]);
    for (const file of files) {
      expect(prompt).toContain(file.content);
      expect(fs.readFileSync(file.filename)).toEqual(file.bytes);
    }
    expect(result.content).toContain(proposed);
  });
  it.each([undefined, 'high'] as const)('keeps the existing default/explicit helper effort=%s on the real installed SDK wire', async effort => {
    const f = setup(); const wire: any[] = [];
    const fetch = vi.fn(async (_url: any, init: any) => { const body=JSON.parse(init.body); wire.push(body); const chunk=(content: string | null, finish: string | null)=>({id:'synthetic-sdk',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:content===null?{}:{content},finish_reason:finish}]}); return new Response('data: '+JSON.stringify(chunk('模拟正文：仅为工具传输测试。',null))+'\n\ndata: '+JSON.stringify(chunk(null,'stop'))+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}}); });
    const sdk = new OpenAI({apiKey:'synthetic-offline-only',baseURL:'https://synthetic.invalid/v1',maxRetries:0,fetch:fetch as any});
    const result = await runLegalLLM('只作默认法律调用参数回归，不生成真实法律结论。', { ...f.context, llmGetters: { ...f.context.llmGetters, getRelay: () => sdk } }, 128, false, 180_000, effort);
    expect(result).toBe('模拟正文：仅为工具传输测试。'); expect(fetch).toHaveBeenCalledOnce(); expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({model:'aliyun/deepseek-v4-flash',max_tokens:128,stream:true});
    if(effort)expect(wire[0].reasoning_effort).toBe(effort);else expect(wire[0]).not.toHaveProperty('reasoning_effort');
    expect(wire[0]).not.toHaveProperty('response_format');
    expect(wire[0]).not.toHaveProperty('thinking');
  });
  it('keeps local_only on the local adapter without a cloud request or unsupported effort parameter', async () => {
    const f = setup(true), before = JSON.stringify(getUserPreferredLLM(f.userId));
    const result = decodeToolResult(await generateBidHandler(f.args, f.context));
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(f.create).toHaveBeenCalledOnce(); expect(f.cloud).not.toHaveBeenCalled(); expect(f.local).toHaveBeenCalled();
    for (const [request] of f.create.mock.calls) { expect(request.model).toBe('synthetic-loaded-local'); expect(request).not.toHaveProperty('reasoning_effort'); expect(promptOf(request)).toContain(original); }
    expect(JSON.stringify(getUserPreferredLLM(f.userId))).toBe(before);
  });
  it.each(['empty', 'output-limit'] as const)('keeps a %s model result partial and out of case materials', async failure => {
    const f = setup(), orgId = cases.legalWorkspaceNamespace(f.userId);
    const item = cases.createCase(orgId, f.userId, { title: '虚构未完成标书' });
    f.create.mockImplementation((request: any) => sdkCompletion(request, { choices: [{ message: { content: failure === 'empty' ? '' : '被截断的标书片段' }, finish_reason: failure === 'empty' ? 'stop' : 'length' }] }));
    const result = decodeToolResult(await generateBidHandler({ ...f.args, caseId: item.id, persistCase: true }, f.context));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(f.create).toHaveBeenCalledOnce();
    expect(result.content).toContain(original);
    expect(cases.getCase(orgId, item.id, f.userId)!.materials.filter(material => material.source === 'tool')).toHaveLength(0);
  });
  it('keeps missing model access partial and out of the case', async () => {
    const f = setup(), orgId = cases.legalWorkspaceNamespace(f.userId);
    const item = cases.createCase(orgId, f.userId, { title: '虚构未接通模型' });
    const result = decodeToolResult(await generateBidHandler({ ...f.args, caseId: item.id, persistCase: true }, { ...f.context, llmGetters: undefined }));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(f.create).not.toHaveBeenCalled();
    expect(result.content).toContain('未接通模型'); expect(result.content).toContain(original);
    expect(cases.getCase(orgId, item.id, f.userId)!.materials.filter(material => material.source === 'tool')).toHaveLength(0);
  });
  it('keeps a generation timeout partial without retry or case archive', async () => {
    const f = setup(false, 1_000_000), orgId = cases.legalWorkspaceNamespace(f.userId);
    const item = cases.createCase(orgId, f.userId, { title: '虚构标书请求超时' }); vi.useFakeTimers();
    const pending = generateBidHandler({ ...f.args, caseId: item.id, persistCase: true }, f.context);
    await vi.advanceTimersByTimeAsync(1_000_001);
    const result = decodeToolResult(await pending);
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(f.create).toHaveBeenCalledOnce();
    expect(result.content).toContain(original);
    expect(cases.getCase(orgId, item.id, f.userId)!.materials.filter(material => material.source === 'tool')).toHaveLength(0);
  });
  it('honors the original caller cancellation with no retry, completed DOCX or case archive', async () => {
    const f = setup(false, 70_000), controller = new AbortController(), orgId = cases.legalWorkspaceNamespace(f.userId);
    const item = cases.createCase(orgId, f.userId, { title: '虚构取消预算验收' }); vi.useFakeTimers();
    const pending = generateBidHandler({ ...f.args, caseId: item.id, persistCase: true }, { ...f.context, executionSignal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1_000); controller.abort(new Error('Synthetic bid owner cancellation')); await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeInstanceOf(Error); expect(f.create).toHaveBeenCalledOnce();
    expect(f.create.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
    expect(cases.getCase(orgId, item.id, f.userId)!.materials.filter(material => material.source === 'tool')).toHaveLength(0);
  });
});
