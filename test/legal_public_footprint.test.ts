import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerWebOpsTools } from '../server/tools/definitions/web_tools';
import { decodeToolResult, encodeToolResult } from '../server/tools/result_envelope';
import { withLegalExecution } from '../server/legal/execution';
import { external_researchTools } from '../server/regions/packs/cn/legal_tools/definitions_external_research';
import { withLegalReceipt } from '../server/regions/packs/cn/legal_tools/tool_contracts';
import { searchPublicFootprintHandler } from '../server/regions/packs/cn/legal_tools/public_footprint';
import * as Cases from '../server/org/legal_cases';
import * as LegalContext from '../server/regions/packs/cn/legal_tools/context';
import type { ToolContext } from '../server/tools/types';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const userId = 'synthetic-public-footprint-owner';
let registry: ToolRegistry;
let context: ToolContext;
let createCase: ReturnType<typeof vi.spyOn>;
let addMaterial: ReturnType<typeof vi.spyOn>;
let runModel: ReturnType<typeof vi.spyOn>;
let runModelWithin: ReturnType<typeof vi.spyOn>;
const decoded = (value: string) => decodeToolResult(value) as { content: string; receipt: Record<string, any> };
const bing = (title: string, snippet: string, url = 'https://source.example/entry') => '<li class="b_algo"><h2><a href="' + url + '">' + title + '</a></h2><p>' + snippet + '</p></li>';

beforeEach(() => {
  registry = new ToolRegistry();
  registerWebOpsTools(registry);
  context = { userId, authenticated: true, authRole: 'user', toolRegistry: registry };
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external request'); }));
  createCase = vi.spyOn(Cases, 'createCase').mockImplementation(() => { throw new Error('Unexpected case creation'); });
  addMaterial = vi.spyOn(Cases, 'addMaterial').mockImplementation(() => { throw new Error('Unexpected material archive'); });
  runModel = vi.spyOn(LegalContext, 'runLegalLLM').mockImplementation(async () => { throw new Error('Unexpected model call'); });
  runModelWithin = vi.spyOn(LegalContext, 'runLegalLLMWithin').mockImplementation(async () => { throw new Error('Unexpected model call'); });
});
afterEach(() => {
  expect(createCase).not.toHaveBeenCalled();
  expect(addMaterial).not.toHaveBeenCalled();
  expect(runModel).not.toHaveBeenCalled();
  expect(runModelWithin).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('public-footprint source search through the existing web_search tool', () => {
  it.each([
    { name: '虚构星河零部件有限公司', subjectType: 'enterprise', title: '星河零部件的公开产品页', snippet: '这是搜索引擎返回的产品摘要。' },
    { name: '虚构自然人张研', subjectType: 'individual', title: '张研的公开讲座页面', snippet: '同名讲者的活动摘要，身份尚未确认。' },
  ])('queries the exact original name once and retains real source bytes for $subjectType', async input => {
    vi.mocked(fetch).mockResolvedValue(new Response(bing(input.title, input.snippet), { status: 200 }));
    const execute = vi.spyOn(registry, 'execute');
    const before = Date.now();
    const result = decoded(await searchPublicFootprintHandler({ ...input, persistCase: true, caseId: 'must-not-write', confirmedForKb: true }, context));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('web_search', { query: JSON.stringify(input.name), maxResults: 5 }, context);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).searchParams.get('q')).toBe(JSON.stringify(input.name));
    expect(result.receipt).toMatchObject({ ok: true, status: 'observed', persisted: false, changedCaseIds: [], articleIds: [], artifacts: [] });
    const source = result.receipt.sourceResults[0];
    const original = input.title + '\n' + input.snippet + '\nhttps://source.example/entry';
    expect(source).toMatchObject({ sourceTool: 'web_search', subject: input.name, subjectType: input.subjectType, query: JSON.stringify(input.name), sourceText: original, sourceTextSha256: sha(original), provider: 'Bing', resultCount: 1 });
    expect(Date.parse(source.queriedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(source.queriedAt)).toBeLessThanOrEqual(Date.now());
    expect(result.content).toContain(original);
    expect(result.content).toContain('搜索引擎返回的标题、摘要及原始页面链接');
    expect(result.content).toContain('未读取链接页面全文');
    expect(result.content).toContain('不确认同名主体身份、关联关系、资产归属或可供执行财产');
  });

  it('returns partial for explicit zero results without inventing a no-footprint conclusion', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<div class="b_no">No results</div>')).mockResolvedValueOnce(new Response('<div class="no-results">No results</div>'));
    const result = decoded(await searchPublicFootprintHandler({ name: '虚构无结果主体', subjectType: 'enterprise', persistCase: true }, context));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(result.receipt.sourceResults[0]).toMatchObject({ status: 'partial', resultCount: 0 });
    expect(result.content).toContain('不能据此认定查询主体没有网络足迹');
    expect(result.content).not.toContain('https://source.example/entry');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retains unavailable-search failures as partial rather than generating rows', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Synthetic offline search failure'));
    const result = decoded(await searchPublicFootprintHandler({ name: '虚构不可用主体' }, context));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(result.receipt.sourceResults[0].sourceText).toContain('Synthetic offline search failure');
    expect(result.receipt.sourceResults[0].sourceTextSha256).toBe(sha(result.receipt.sourceResults[0].sourceText));
    expect(result.content).not.toContain('https://source.example/entry');
  });

  it('does not dispatch under local_only', async () => {
    const execute = vi.spyOn(registry, 'execute');
    const result = decoded(await searchPublicFootprintHandler({ name: '虚构仅本地主体' }, { ...context, dataRoutingPolicy: 'local_only' }));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', sourceResults: [] });
    expect(result.content).toContain('未向外部搜索引擎发送主体名称');
    expect(execute).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('reports missing registered search without substituting a plan or source', async () => {
    registry.unregister('web_search');
    const result = decoded(await searchPublicFootprintHandler({ name: '虚构缺工具主体' }, context));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', sourceResults: [] });
    expect(result.content).toContain('搜索工具当前不可用'); expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a registry policy rejection partial and does not bypass the registry handler', async () => {
    const result = decoded(await searchPublicFootprintHandler({ name: '虚构策略主体' }, { ...context, toolPolicy: { allowedTools: [], forbiddenTools: ['web_search'], requireConfirmation: [], maxIterations: 1 } }));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', sourceResults: [] });
    expect(result.content).toContain('forbidden'); expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the actual lower-tool observation receipt instead of upgrading arbitrary output', async () => {
    vi.spyOn(registry, 'execute').mockResolvedValue('This is an unreceipted search response, not a verified source.');
    const result = decoded(await searchPublicFootprintHandler({ name: '虚构无回执主体' }, context));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.receipt.sourceResults[0].sourceText).toBe('This is an unreceipted search response, not a verified source.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects cancellation before any dispatch', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(searchPublicFootprintHandler({ name: '虚构已取消主体' }, { ...context, executionSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes the same abort signal to the existing search and propagates cancellation during it', async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      expect(init?.signal).toBeDefined();
      controller.abort(new DOMException('Synthetic cancelled search', 'AbortError'));
      throw controller.signal.reason;
    });
    await expect(searchPublicFootprintHandler({ name: '虚构中途取消主体' }, { ...context, executionSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the active legal execution context when called without a separate context', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(withLegalExecution({ ...context, executionSignal: controller.signal }, () => searchPublicFootprintHandler({ name: '虚构执行上下文主体' }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps lower-source status and source provenance through withLegalReceipt: %s', async ok => {
    const original = ok ? 'Synthetic retrieved title\nSynthetic search snippet\nhttps://source.example/exact' : 'Synthetic unavailable source';
    vi.spyOn(registry, 'execute').mockResolvedValue(encodeToolResult(original, { ok, status: ok ? 'observed' : 'partial', resultCount: ok ? 1 : 0 }));
    const handler = withLegalReceipt(searchPublicFootprintHandler, { status: 'observed' });
    const result = decoded(await withLegalExecution(context, () => handler({ name: '虚构回执主体', persistCase: true }, context)));
    expect(result.receipt).toMatchObject({ ok, status: ok ? 'observed' : 'partial', persisted: false, changedCaseIds: [], articleIds: [], artifacts: [] });
    expect(result.receipt.sourceResults[0]).toMatchObject({ sourceText: original, sourceTextSha256: sha(original), subject: '虚构回执主体' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not send a missing subject as an external search', async () => {
    const result = decoded(await searchPublicFootprintHandler({ name: '   ' }, context));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', sourceResults: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([true, false])('executes the registered legal definition through the full registry and preserves source status: %s', async ok => {
    const definition = external_researchTools().find(tool => tool.name === 'legal_search_public_footprint');
    expect(definition).toBeDefined();
    registry.register(definition!);
    const original = ok ? 'Synthetic public page\nActual mocked search snippet\nhttps://source.example/registered' : 'Search unavailable in this offline fixture';
    const lower = vi.spyOn(registry.get('web_search')!, 'handler').mockResolvedValue(encodeToolResult(original, { ok, status: ok ? 'observed' : 'partial', resultCount: ok ? 1 : 0 }));
    const result = decoded(await registry.execute('legal_search_public_footprint', { name: '虚构完整注册主体', subjectType: 'individual', persistCase: true }, context));
    expect(lower).toHaveBeenCalledTimes(1);
    expect(lower.mock.calls[0][0]).toEqual({ query: JSON.stringify('虚构完整注册主体'), maxResults: 5 });
    expect(lower.mock.calls[0][1]?.toolRegistry).toBe(registry);
    expect(lower.mock.calls[0][1]?.executionSignal).toBeDefined();
    expect(result.receipt).toMatchObject({ ok, status: ok ? 'observed' : 'partial', persisted: false, changedCaseIds: [], articleIds: [], artifacts: [] });
    expect(result.receipt.sourceResults[0]).toMatchObject({ sourceTool: 'web_search', subject: '虚构完整注册主体', subjectType: 'individual', sourceText: original, sourceTextSha256: sha(original) });
    expect(result.content).toContain(original);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps local-only partial through the registered definition without invoking the nested adapter', async () => {
    registry.register(external_researchTools().find(tool => tool.name === 'legal_search_public_footprint')!);
    const lower = vi.spyOn(registry.get('web_search')!, 'handler');
    const result = decoded(await registry.execute('legal_search_public_footprint', { name: '虚构完整本地主体', subjectType: 'enterprise', persistCase: true }, { ...context, dataRoutingPolicy: 'local_only' }));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false, changedCaseIds: [], articleIds: [], artifacts: [], sourceResults: [] });
    expect(lower).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

});
