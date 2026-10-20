import { reasoningFixtureReply } from './legal_reasoning_fixture';
import { sdkCompletionFixture } from './legal_contract_fixture';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { makeApp } from './helpers';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
import * as kb from '../server/legal/kb';
import { legalCaseSourceFingerprint } from '../shared/legal_workflow_receipts';
import { inspectLegalReasoningLinks } from '../server/regions/packs/cn/legal_reasoning_links';
import type { ToolContext } from '../server/tools/types';
const original = '原告主张尚欠九万元，被告称七万元款项待核对；未取得完整合同不等于合同未约定。STRATEGY-ORIGINAL-END';
const application = '应先核对完整合同和银行原件，当前陈述不足以确认付款期限和欠款金额。';
const conclusion = '在原件和交易对应关系核实前，不认定九万元、七万元或两万元为已确认余额。';
let app: Awaited<ReturnType<typeof makeApp>>, mode: 'ok' | 'review-invalid' | 'request-failed' = 'ok';
const registry = new ToolRegistry(), userId = 'strategy-archive-owner', orgId = cases.legalWorkspaceNamespace(userId);
const create = vi.fn(async (params: any) => {
  if (mode === 'request-failed') throw new Error('Controlled synthetic request failure');
  const prompt = String(params.messages.find((message: any) => message.role === 'user')?.content || '');
  const data = prompt.includes('你是法律适用复核者')
    ? { reviews: mode === 'review-invalid' ? [] : [{ index: 1, status: 'conditional', application, conclusion, reason: '双方陈述尚待核实，不能直接作为付款事实。', missingPremises: ['完整合同、银行原件和交易关联'] }], uncoveredIssues: [] }
    : { entries: [{ issue: '付款及交易关联', ruleId: 'R1', sourceIds: ['F1'], application, conclusion, limitations: '完整合同、银行原件及交易对应关系尚待律师核实。' }] };
  return sdkCompletionFixture(reasoningFixtureReply(prompt, data), 'stop', params.stream);
});
const context: ToolContext = { userId, authenticated: true, authRole: 'user', domain: 'personal', localExecution: true, executionBoundary: 'trusted_local', source: 'legal-direct-tool', llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
function fixture() { const item = cases.createCase(orgId, userId, { title: '虚构策略归档承接-' + crypto.randomUUID(), cause: '买卖合同纠纷', factDate: '2026-09-01' }); const material = cases.addMaterial(orgId, userId, item.id, { type: 'evidence', source: 'manual', title: '双方未经核实的原始陈述', content: original })!; return { item, material }; }
const run = (caseId: string, args = {}, overrides = {}) => registry.execute('legal_case_strategy', { caseId, facts: original, legalAuthorities: '《民法典》第626条', persistCase: true, ...args }, { ...context, requestId: crypto.randomUUID(), ...overrides }).then(decodeToolResult);
const delivery = (caseId: string, content: string) => registry.execute('legal_finalize_delivery_package', { caseId, content, documentType: '法律意见书', includeDocx: false, includePdf: false }, { ...context, requestId: crypto.randomUUID() }).then(decodeToolResult);
beforeAll(async () => { app = await makeApp(); installCivilCodeFixture(); registerLegalTools(registry); upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-strategy-archive', selectionMode: 'pinned', allowCloudFallback: false }); });
afterAll(() => app.cleanup());
beforeEach(() => { mode = 'ok'; create.mockClear(); vi.spyOn(kb, 'searchStatutes').mockResolvedValue([]); vi.spyOn(kb, 'searchSimilarCases').mockResolvedValue([]); });
afterEach(() => vi.restoreAllMocks());
describe('reviewed strategy is the existing formal-delivery reasoning basis', () => {
  it('archives the already reviewed links and directly finalizes without running a matrix or another model', async () => {
    const { item, material } = fixture(); const basis = legalCaseSourceFingerprint(cases.getCase(orgId, item.id, userId)!);
    const result = await run(item.id, { reasoningBasis: 'caller-forged-basis' }); expect(result.receipt).toMatchObject({ ok: true, reasoningLinked: true, reasoningReviewed: true }); expect(create).toHaveBeenCalledTimes(2);
    const saved = cases.getCase(orgId, item.id, userId)!, strategy = saved.materials.find(m => m.title.endsWith('应对策略草稿'))!;
    expect(strategy).toMatchObject({ source: 'tool', type: 'note', reasoningBasis: basis }); expect(strategy.reasoningLinks).toHaveLength(1);
    expect(strategy.reasoningLinks![0].evidence[0]).toMatchObject({ materialId: material.id, quote: original }); expect(strategy.reasoningLinks![0].application).toContain(application); expect(strategy.reasoningLinks![0].application).toContain('以下为条件分析，尚未确认适用前提');
    expect(inspectLegalReasoningLinks(strategy.reasoningLinks, saved, orgId, { actorUserId: userId, factDate: '2026-09-01' }).passed).toBe(true);
    expect(legalCaseSourceFingerprint(saved)).toBe(basis); expect(saved.workflowRuns?.some(run => run.tool === 'legal_case_reasoning_matrix')).toBe(false);
    const finalized = await delivery(item.id, strategy.content); expect(finalized.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(create).toHaveBeenCalledTimes(2);
    expect(finalized.content).toContain('来源登记表'); expect(cases.getCase(orgId, item.id, userId)!.workflowRuns![0].tool).toBe('legal_finalize_delivery_package');
  });
  it('keeps successive strategy results and binds each to the same unchanged original basis', async () => {
    const { item } = fixture(); await run(item.id); await run(item.id);
    const saved = cases.getCase(orgId, item.id, userId)!, strategies = saved.materials.filter(m => m.title.endsWith('应对策略草稿'));
    expect(strategies).toHaveLength(2); for (const strategy of strategies) { expect(strategy.reasoningLinks).toHaveLength(1); expect(strategy.reasoningBasis).toBe(legalCaseSourceFingerprint(saved)); }
    expect(saved.materials.filter(m => m.source === 'manual')).toHaveLength(1); expect(create).toHaveBeenCalledTimes(4);
  });
  it.each(['review-invalid', 'request-failed'] as const)('does not persist reusable links on %s partial', async failure => {
    const { item } = fixture(); mode = failure; const result = await run(item.id);
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reasoningReviewed: false });
    const saved = cases.getCase(orgId, item.id, userId)!; expect(saved.materials.some(m => m.reasoningLinks?.length || m.reasoningBasis)).toBe(false);
    expect(saved.materials.filter(m => m.source === 'tool')).toHaveLength(0); expect(saved.workflowRuns![0]).toMatchObject({ ok: false, status: 'partial' });
  });
  it('keeps failed archive persistence out of the reusable basis through the existing receipt guard', async () => {
    const { item } = fixture(); vi.spyOn(cases, 'addMaterial').mockReturnValueOnce(null);
    await expect(run(item.id)).rejects.toThrow('not persisted'); expect(create).toHaveBeenCalledTimes(2);
    expect(cases.getCase(orgId, item.id, userId)!.materials).toHaveLength(1);
  });
  it('does not archive when persistence is explicitly disabled', async () => {
    const { item } = fixture(); const result = await run(item.id, { persistCase: false }); expect(result.receipt).toMatchObject({ ok: true, persisted: false });
    expect(cases.getCase(orgId, item.id, userId)!.materials).toHaveLength(1); expect(create).toHaveBeenCalledTimes(2);
  });
  it('does not accept caller-supplied links as a completed review or archived strategy', async () => {
    const { item, material } = fixture(); const link = { issue: '付款与原件核对', ruleCitation: '《民法典》第626条', ruleQuote: kb.verifyCitation('《民法典》第626条').sourceText!, fact: original, evidence: [{ materialId: material.id, quote: original, locator: '正文第1行' }], application, conclusion, limitations: '完整合同及银行原件尚待核验。' };
    const result = await run(item.id, { reasoningLinks: [link] }); expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reasoningLinked: true, reasoningReviewed: false });
    expect(cases.getCase(orgId, item.id, userId)!.materials).toHaveLength(1); expect(create).not.toHaveBeenCalled();
  });
  it('rejects the archived strategy basis after originals change instead of silently reusing it for formal delivery', async () => {
    const { item } = fixture(); await run(item.id); const strategy = cases.getCase(orgId, item.id, userId)!.materials.find(m => m.reasoningLinks?.length)!; expect(strategy).toBeDefined();
    cases.addMaterial(orgId, userId, item.id, { source: 'manual', type: 'evidence', title: '新增待核实材料', content: '新增原始陈述改变了本案来源集合，原分析需要重新核对。' });
    expect(strategy.reasoningBasis).not.toBe(legalCaseSourceFingerprint(cases.getCase(orgId, item.id, userId)!));
    const result = await delivery(item.id, strategy.content); expect(result.receipt).toMatchObject({ ok: false, status: 'blocked' }); expect(create).toHaveBeenCalledTimes(2);
  });
  it('does not write another actor personal workspace or promote supplied metadata', async () => {
    const { item } = fixture(); const before = JSON.stringify(cases.getCase(orgId, item.id, userId));
    await expect(run(item.id, { reasoningBasis: 'forged-basis' }, { userId: 'unrelated-strategy-actor' })).rejects.toThrow('authorized case');
    expect(create).not.toHaveBeenCalled(); expect(JSON.stringify(cases.getCase(orgId, item.id, userId))).toBe(before);
  });
});
