import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { mcpManager } from '../server/mcp/client';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { withLegalExecution } from '../server/legal/execution';
import { searchSubjectCasesHandler } from '../server/regions/packs/cn/legal_tools/subject_cases';
import * as KB from '../server/legal/kb';
import * as Cases from '../server/org/legal_cases';
import * as LegalContext from '../server/regions/packs/cn/legal_tools/context';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const registry = new ToolRegistry();
const context = { userId: 'synthetic-subject-query-owner', domain: 'personal', authenticated: true, authRole: 'user' } as any;
let app: Awaited<ReturnType<typeof makeApp>>;
let similarity: ReturnType<typeof vi.spyOn>;
let model: ReturnType<typeof vi.spyOn>;
let archive: ReturnType<typeof vi.spyOn>;
let create: ReturnType<typeof vi.spyOn>;
const source = JSON.stringify({ items: [{ subject: 'Original provider subject', caseNo: 'SYNTHETIC-RAW', excerpt: 'Provider text retained verbatim. SOURCE-END' }] });
const run = (args: Record<string, unknown>, ctx = context) => executeToolCall({ registry, name: 'legal_search_subject_cases', arguments: args, context: ctx });
beforeAll(async () => { app = await makeApp(); registerLegalTools(registry); });
afterAll(() => app.cleanup());
beforeEach(() => {
  vi.stubEnv('QICHACHA_API_KEY', 'offline-subject-fixture'); vi.stubEnv('LUMI_PRIVACY', 'standard');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected HTTP fallback'); }));
  vi.spyOn(mcpManager, 'callToolForServer').mockResolvedValue(source);
  similarity = vi.spyOn(KB, 'searchSimilarCases').mockImplementation(async () => { throw new Error('Unexpected similarity fallback'); });
  model = vi.spyOn(LegalContext, 'runLegalLLM').mockImplementation(async () => { throw new Error('Unexpected generated case'); });
  archive = vi.spyOn(Cases, 'addMaterial').mockImplementation(() => { throw new Error('Unexpected archive'); });
  create = vi.spyOn(Cases, 'createCase').mockImplementation(() => { throw new Error('Unexpected case creation'); });
});
afterEach(() => {
  expect(similarity).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
describe('subject-case source lookup uses the requested provider scope without local similarity', () => {
  it.each([
    { name: '虚构松林精密配件有限公司', subjectType: 'enterprise', scope: 'cases', lane: 'case', tool: 'get_judicial_case_search', argument: 'party' },
    { name: '虚构自然人林晓', subjectType: 'individual', scope: 'enforcement', lane: 'risk', tool: 'get_judgment_debtor_info', argument: 'searchKey' },
  ])('queries $scope once and preserves the full raw receipt', async input => {
    const before = Date.now();
    const result = await run({ ...input, name: '  ' + input.name + '  ', persistCase: true, configuration: { url: 'https://wrong.invalid' } });
    expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
    expect(mcpManager.callToolForServer).toHaveBeenCalledWith('qcc-' + input.lane, input.tool, { [input.argument]: input.name }, expect.objectContaining({ configuration: expect.objectContaining({ url: 'https://agent.qcc.com/mcp/' + input.lane + '/stream' }) }));
    if (input.scope === 'cases') expect(vi.mocked(mcpManager.callToolForServer).mock.calls[0][2]).not.toHaveProperty('keyword');
    expect(result.receipt).toMatchObject({ ok: true, status: 'observed', persisted: false, changedCaseIds: [], articleIds: [], artifacts: [] });
    const metadata = (result.receipt as any).sourceResults[0];
    expect(metadata).toMatchObject({ sourceTool: input.tool, sourceEndpoint: 'https://agent.qcc.com/mcp/' + input.lane + '/stream', subject: input.name, queryScope: input.scope, sourceTextSha256: sha(source) });
    expect(Date.parse(metadata.queriedAt)).toBeGreaterThanOrEqual(before); expect(Date.parse(metadata.queriedAt)).toBeLessThanOrEqual(Date.now());
    expect(result.result).toContain(source); expect(result.result).toContain(metadata.queriedAt); expect(result.result).toContain(sha(source));
    expect(result.result).toContain('授权来源原始结果'); expect(result.result).not.toContain('官方来源原始结果');
  });
  it.each(['cases', 'enforcement'])('keeps local-only %s partial before dispatch', async scope => {
    const result = await run({ name: '虚构仅本地主体', scope }, { ...context, dataRoutingPolicy: 'local_only' });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false }); expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
  });
  it('uses the active local-only execution context even without a separate handler context', async () => {
    const result = decodeToolResult(await withLegalExecution({ ...context, dataRoutingPolicy: 'local_only' }, () => searchSubjectCasesHandler({ name: '虚构隐式上下文' })));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', sourceResults: [] }); expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
  });
  it.each(['cases', 'enforcement'])('keeps an unavailable %s provider partial without claiming no cases', async scope => {
    vi.stubEnv('QICHACHA_API_KEY', '');
    const result = await run({ name: '虚构未配置主体', scope });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false }); expect(result.result).toContain('不能据此认定该主体无案件或无执行记录'); expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
  });
  it.each([{}, [], { code: 403, message: 'denied' }, { code: 0, result: [] }, { error: { message: 'failed' } }])('retains invalid provider payload as partial: %j', async payload => {
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(JSON.stringify(payload));
    const result = await run({ name: '虚构缺失来源主体', scope: 'cases' });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false }); expect((result.receipt as any).sourceResults).toEqual([]); expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
  });
  it('does not expose transport credentials or replace a failure with a KB result', async () => {
    vi.mocked(mcpManager.callToolForServer).mockRejectedValueOnce(new Error('401 bearer confidential-synthetic-credential'));
    const result = await run({ name: '虚构拒绝主体', scope: 'cases' });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false }); expect(result.result).not.toContain('confidential-synthetic-credential'); expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
  });
  it('blocks an empty name without querying the provider', async () => {
    const result = await run({ name: '  ', scope: 'cases' });
    expect((result.receipt as any)?.ok).toBe(false); expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
  });
  it('propagates cancellation before a query and rejects late results', async () => {
    const pre = new AbortController(); pre.abort();
    await expect(searchSubjectCasesHandler({ name: '虚构取消主体' }, { ...context, executionSignal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
    const live = new AbortController();
    vi.mocked(mcpManager.callToolForServer).mockImplementationOnce(async () => { live.abort(); return source; });
    await expect(searchSubjectCasesHandler({ name: '虚构迟到主体' }, { ...context, executionSignal: live.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
  });
});
