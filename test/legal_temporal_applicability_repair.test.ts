import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeApp } from './helpers';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import { createStatuteTextSnapshot } from '../server/regions/packs/cn/statute_provisions';
import { loadStatuteAuthorityRefreshState, saveStatuteAuthorityRefreshState, type StatuteAuthorityCheck } from '../server/legal/statute_authority_store';
import { listStatuteVerificationCatalog, verifyCitation, type LegalTemporalReview } from '../server/legal/kb';
import * as LegalCases from '../server/org/legal_cases';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { evaluateCurrentLawGate, formatCitationReportMarkdown } from '../server/regions/packs/cn/legal_tools/citations';
import { resolveLegalCaseArguments } from '../server/regions/packs/cn/legal_tools/context';

let app: Awaited<ReturnType<typeof makeApp>>;
const uid = 'temporal-repair-owner', orgId = LegalCases.legalWorkspaceNamespace(uid);
const context = { userId: uid, domain: 'personal', authenticated: true, authRole: 'user' } as any;
const oldCitation = '《合同法》第107条';
const oldQuote = '受控测试历史条文，仅检查来源核验接线，不得用于法律事务。';
const ruleCitation = '《受控时间效力测试规则》第1条';
const ruleQuote = '受控测试时间效力条文，事实与程序时间分别检查，具体适用必须复核。';
const applicability = '这是受控接线测试的适用说明，不是已经认证的案件法律结论。';
// Deliberately synthetic fixture. No historical law is acquired or installed in production.
function controlledAuthority(title: string, id: string, versionDate: string, effectiveDate: string, max: number, selected: number, quote: string): StatuteAuthorityCheck {
  const sourceUrl = 'https://flk.npc.gov.cn/detail?id=' + id + '&title=' + encodeURIComponent(title);
  const text = Array.from({ length: max }, (_, index) => '第' + (index + 1) + '条  ' + (index + 1 === selected ? quote : '受控测试占位条文，禁止用作法律依据。')).join('\n\n');
  return { title, status: 'verified', checkedAt: new Date().toISOString(), expectedVersionDate: versionDate,
    expectedEffectiveDate: effectiveDate, expectedArticleMax: max, expectedRecordId: id,
    lastVerifiedAt: new Date().toISOString(), reviewAfter: '2099-01-01', reasons: [], consecutiveFailures: 0,
    observed: { title, recordId: id, versionDate, effectiveDate, effectivenessCode: 3, category: '受控测试',
      issuingAuthority: '受控测试', articleMax: max, sourceUrl },
    originalText: createStatuteTextSnapshot(text, max, { recordId: id, versionDate, sourceUrl, fetchedAt: new Date().toISOString() }) };
}
function fixtures() {
  installCivilCodeFixture();
  const state = loadStatuteAuthorityRefreshState();
  state.checks['中华人民共和国合同法'] = controlledAuthority('中华人民共和国合同法', 'controlled-historical-fixture', '1999-03-15', '1999-10-01', 428, 107, oldQuote);
  state.checks['受控时间效力测试规则'] = controlledAuthority('受控时间效力测试规则', 'controlled-temporal-fixture', '2025-01-01', '2025-01-01', 1, 1, ruleQuote);
  const procedure = listStatuteVerificationCatalog().find(entry => entry.key === '民事诉讼法')!;
  state.checks[procedure.sourceTitle] = controlledAuthority(procedure.sourceTitle, procedure.recordId!, procedure.verification.versionDate,
    procedure.verification.effectiveDate, procedure.verification.articleMax!, 1, '受控测试程序法条文，不得用于法律事务。');
  saveStatuteAuthorityRefreshState(state);
}
const review = (citation = oldCitation, scope: 'fact' | 'procedure' = 'fact', referenceDate = '2019-01-01'): LegalTemporalReview =>
  ({ citation, scope, referenceDate, authorityCitation: ruleCitation, authorityQuote: ruleQuote, applicability });
beforeAll(async () => { app = await makeApp(); });
beforeEach(fixtures);
afterAll(() => app.cleanup());

describe('temporal applicability repair through existing authority and delivery gates', () => {
  it('does not mistake the Civil Code snapshot for a historical Contract Law original', () => {
    const state = loadStatuteAuthorityRefreshState(); delete state.checks['中华人民共和国合同法']; saveStatuteAuthorityRefreshState(state);
    const result = verifyCitation(oldCitation, orgId, { factDate: '2019-01-01', temporalReviews: [review()] });
    expect(result).toMatchObject({ isEffective: null, applicabilityStatus: 'historical_review_required' });
    expect(result.sourceText).toBeUndefined();
  });
  it('requires original historical text, sourced interval and an independent quoted temporal basis', () => {
    expect(verifyCitation(oldCitation, orgId, { factDate: '2019-01-01' }).isEffective).toBeNull();
    expect(verifyCitation(oldCitation, orgId, { factDate: '2019-01-01', temporalReviews: [review()] }))
      .toMatchObject({ isEffective: true, applicabilityStatus: 'historical_version_verified', sourceText: oldQuote });
    expect(verifyCitation(oldCitation, orgId, { factDate: '2021-01-01', temporalReviews: [review(oldCitation, 'fact', '2021-01-01')] }).isEffective).toBe(false);
  });
  it('accepts a missing official outline only with the same reviewed bound and a complete stored original', () => {
    const state = loadStatuteAuthorityRefreshState();
    state.checks['中华人民共和国合同法'].observed!.articleMax = null;
    state.checks['受控时间效力测试规则'].observed!.articleMax = null;
    saveStatuteAuthorityRefreshState(state);
    expect(verifyCitation(oldCitation, orgId, { factDate: '2019-01-01', temporalReviews: [review()] }))
      .toMatchObject({ isEffective: true, applicabilityStatus: 'historical_version_verified', sourceText: oldQuote });
  });
  it.each(['missing_bound', 'larger_bound', 'smaller_bound', 'missing_tail', 'outline_conflict'])('rejects inconsistent fallback provenance: %s', failure => {
    const state = loadStatuteAuthorityRefreshState(), check = state.checks['中华人民共和国合同法'];
    check.observed!.articleMax = null;
    if (failure === 'missing_bound') check.expectedArticleMax = null;
    if (failure === 'larger_bound') check.expectedArticleMax = 429;
    if (failure === 'smaller_bound') check.expectedArticleMax = 427;
    if (failure === 'missing_tail') delete check.originalText!.provisions['428'];
    if (failure === 'outline_conflict') check.observed!.articleMax = 427;
    saveStatuteAuthorityRefreshState(state);
    expect(verifyCitation(oldCitation, orgId, { factDate: '2019-01-01', temporalReviews: [review()] }).isEffective).toBeNull();
  });
  it('rejects invented temporal quotations and repeal-only explanations', () => {
    for (const item of [{ ...review(), authorityQuote: '模型自行编写的适用依据，权威原文中不存在。' },
      { ...review(), authorityCitation: '《民法典》第1260条', authorityQuote: verifyCitation('《民法典》第1260条').sourceText! },
      { ...review(), referenceDate: '2020-01-01' }]) {
      expect(verifyCitation(oldCitation, orgId, { factDate: '2019-01-01', temporalReviews: [item] }).isEffective).toBeNull();
    }
  });
  it.each(['wrong_record', 'wrong_source', 'expired', 'missing_interval'])('rejects invalid historical provenance: %s', failure => {
    const state = loadStatuteAuthorityRefreshState(), check = state.checks['中华人民共和国合同法'];
    if (failure === 'wrong_record') check.originalText!.recordId = 'other-law';
    if (failure === 'wrong_source') check.observed!.sourceUrl = 'https://example.test/detail?id=controlled-historical-fixture';
    if (failure === 'expired') check.reviewAfter = '2000-01-01';
    if (failure === 'missing_interval') delete state.checks['中华人民共和国民法典'];
    saveStatuteAuthorityRefreshState(state);
    expect(verifyCitation(oldCitation, orgId, { factDate: '2019-01-01', temporalReviews: [review()] }).isEffective).toBeNull();
  });
  it('uses procedure time and temporal authority, never the substantive fact date', () => {
    const citation = '《民事诉讼法》第1条';
    expect(verifyCitation(citation, orgId, { factDate: '2019-01-01' })).toMatchObject({ isEffective: true, temporalScope: 'procedure', temporalApplicabilityVerified: false });
    expect(verifyCitation(citation, orgId, { factDate: '2019-01-01', procedureDate: '2026-09-01' }).temporalApplicabilityVerified).toBe(false);
    const options = { procedureDate: '2026-09-01', temporalReviews: [review(citation, 'procedure', '2026-09-01')] };
    expect(evaluateCurrentLawGate(citation, orgId, [], undefined, options)).toMatchObject({ passed: true, missingFactDate: false, missingProcedureDate: false });
    expect(evaluateCurrentLawGate(citation + '；《民法典》第585条', orgId, [], undefined, options)).toMatchObject({ passed: false, missingFactDate: true });
  });
  it('prevents follow-up tools from overriding the saved fact date while allowing an explicit workspace edit', async () => {
    const record = LegalCases.createCase(orgId, uid, { title: '受控日期变更测试', factDate: '2019-01-01' });
    const resolved = resolveLegalCaseArguments('legal_finalize_delivery_package', { caseId: record.id, factDate: '2026-09-01' }, context);
    expect(resolved).toMatchObject({ factDate: '2019-01-01', factDateConflict: true });
    const registry = new ToolRegistry(); registerLegalTools(registry);
    const blocked = decodeToolResult(await registry.execute('legal_finalize_delivery_package', { caseId: record.id, factDate: '2026-09-01', content: '《民法典》第585条' }, context));
    expect(blocked.receipt).toMatchObject({ ok: false, status: 'blocked' });
    expect(LegalCases.getCase(orgId, record.id, uid)?.factDate).toBe('2019-01-01');
    await registry.execute('legal_case_workspace', { caseId: record.id, factDate: '2026-09-01' }, context);
    expect(LegalCases.getCase(orgId, record.id, uid)?.factDate).toBe('2026-09-01');
  });
  it.each(['history', 'procedure'] as const)('passes %s provenance through report, reasoning links and formal delivery tools', async mode => {
    const fact = '受控事实材料：2019年1月1日双方已签署约定内容。';
    const record = LegalCases.createCase(orgId, uid, { title: '受控历史交付接线测试', factDate: '2019-01-01',
      materials: [{ id: 'controlled-original', source: 'manual', type: 'evidence', title: '受控原始材料', content: fact, createdBy: uid, createdAt: new Date().toISOString() }] });
    const registry = new ToolRegistry(); registerLegalTools(registry);
    const lawCitation = mode === 'history' ? oldCitation : '《民事诉讼法》第1条';
    const lawQuote = mode === 'history' ? oldQuote : '受控测试程序法条文，不得用于法律事务。';
    const temporal = mode === 'history' ? review() : review(lawCitation, 'procedure', '2026-09-01');
    const options = { caseId: record.id, procedureDate: mode === 'procedure' ? '2026-09-01' : undefined, temporalReviews: [temporal] };
    const report = decodeToolResult(await registry.execute('legal_generate_citation_verification_report', { ...options, text: lawCitation }, context));
    const reportPath = ((report.receipt as any)?.artifacts as string[]).find(p => p.endsWith('.md'))!;
    expect(fs.readFileSync(reportPath, 'utf8')).toContain(mode === 'history' ? '历史版本及时间效力来源已核验' : '程序：2026-09-01');
    const conclusion = '受控接线结论：来源与时间效力摘录已关联，具体案件结论仍需律师复核。';
    const reasoningLinks = [{ issue: '受控时间效力接线', ruleCitation: lawCitation, ruleQuote: lawQuote, fact,
      evidence: [{ materialId: 'controlled-original', quote: fact, locator: '提供材料正文第1行' }],
      application: applicability, conclusion, limitations: '这是受控测试，未认证事实真实性或法律结论正确性。' }];
    const delivery = decodeToolResult(await registry.execute('legal_finalize_delivery_package', { ...options,
      content: lawCitation + '\n' + conclusion, reasoningLinks, includeDocx: false }, context));
    expect(delivery.receipt, JSON.stringify(delivery)).toMatchObject({ ok: true, status: 'generated' });
    const registerPath = ((delivery.receipt as any)?.artifacts as string[]).find(p => p.endsWith('03_source-register.md'))!;
    expect(fs.readFileSync(registerPath, 'utf8')).toContain(ruleQuote);
    expect(formatCitationReportMarkdown({ factDate: '2019-01-01', temporalReviews: [review()] }, oldCitation, 'controlled')).toContain('具体案件适用结论的律师复核分别进行');
  }, 30000);
  it.each(['history', 'procedure'] as const)('uses %s dates and sourced temporal review in remote message case status', async mode => {
    const record = LegalCases.createCase(orgId, uid, { title: '受控远程入案时间测试', factDate: '2019-01-01' });
    const lawCitation = mode === 'history' ? oldCitation : '《民事诉讼法》第1条';
    const temporal = mode === 'history' ? review() : review(lawCitation, 'procedure', '2026-09-01');
    const registry = new ToolRegistry(); registerLegalTools(registry);
    const workflow = vi.spyOn(LegalCases, 'evaluateCaseWorkflow');
    try {
      const args = { caseId: record.id, platform: 'sms', message: '受控原始消息：' + lawCitation, processLinks: false,
        procedureDate: mode === 'procedure' ? '2026-09-01' : undefined, temporalReviews: [temporal] };
      await registry.execute('legal_message_intake_to_case', args, context);
      expect(workflow.mock.calls.at(-1)?.[1]).toMatchObject({ currentLawGate: 'passed' });
      await registry.execute('legal_message_intake_to_case', { ...args, temporalReviews: [] }, context);
      expect(workflow.mock.calls.at(-1)?.[1]).toMatchObject({ currentLawGate: 'blocked' });
      expect(LegalCases.getCase(orgId, record.id, uid)?.factDate).toBe('2019-01-01');
    } finally { workflow.mockRestore(); }
  });
  it('persists only an explicitly supplied fact date when a remote message creates a new case', async () => {
    const registry = new ToolRegistry(); registerLegalTools(registry);
    await registry.execute('legal_message_intake_to_case', { caseName: '显式事实日期远程案件', factDate: '2019-01-01',
      message: '虚构合同材料尚待核实；2026年10月20日开庭。', processLinks: false }, context);
    const record = LegalCases.listCases(orgId, '显式事实日期远程案件', 1, uid)[0];
    expect(record.factDate).toBe('2019-01-01');
    expect(record.hearingDate).not.toBe(record.factDate);
    await registry.execute('legal_message_intake_to_case', { caseName: '仅开庭日期远程案件',
      message: '虚构材料通知2026年10月20日开庭。', processLinks: false }, context);
    const withoutFact = LegalCases.listCases(orgId, '仅开庭日期远程案件', 1, uid)[0];
    expect(withoutFact.factDate).toBeUndefined();
  });

  it('uses existing procedural provenance in archived verification and keeps missing or invented temporal basis blocked', async () => {
    const record = LegalCases.createCase(orgId, uid, { title: '受控归档程序时间测试', factDate: '2019-01-01' });
    const material = LegalCases.addMaterial(orgId, uid, record.id, { type: 'contract', source: 'tool', title: '受控已归档程序文书', content: '《民事诉讼法》第1条' })!;
    const registry = new ToolRegistry(); registerLegalTools(registry);
    const args = { caseId: record.id, materialTitle: material.title };
    const missing = await registry.execute('legal_verify_archived_delivery', args, context);
    expect(missing).toContain('### 引用与法源状态\n- 阻断：程序行为日期缺失或无效');
    const valid = { procedureDate: '2026-09-01', temporalReviews: [review('《民事诉讼法》第1条', 'procedure', '2026-09-01')] };
    const passed = await registry.execute('legal_verify_archived_delivery', { ...args, ...valid }, context);
    expect(passed).toContain('### 引用与法源状态\n- 通过：');
    expect(passed).toContain('### 律师复核边界\n- 待确认：');
    expect(passed).toContain('不可正式交付');
    const invented = await registry.execute('legal_verify_archived_delivery', { ...args, procedureDate: valid.procedureDate,
      temporalReviews: [{ ...valid.temporalReviews[0], authorityQuote: '虚构时间效力条文，不在原始来源中。' }] }, context);
    expect(invented).toContain('### 引用与法源状态\n- 阻断：');
  });

});
