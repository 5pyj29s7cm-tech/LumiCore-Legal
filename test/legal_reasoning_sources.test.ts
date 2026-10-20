import { reasoningFixtureReply } from './legal_reasoning_fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import { createCase, addMaterial, getCase } from '../server/org/legal_cases';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import { buildMaterialSources, resolveMaterialOutline, buildReasoningSources, resolveReasoningEntries, applyReasoningReview, reasoningGenerationPrompt, reasoningReviewPrompt } from '../server/regions/packs/cn/legal_reasoning_generation';
import { compileLegalApplicationChecks, inspectLegalReasoningLinks, formatLegalReasoningLinks } from '../server/regions/packs/cn/legal_reasoning_links';
import { buildCaseContext } from '../server/regions/packs/cn/legal_tools/context';
import { buildEvidenceReviewRows } from '../server/regions/packs/cn/legal_tools/case_workflow';
import { legalCaseSourceFingerprint } from '../shared/legal_workflow_receipts';

let app: Awaited<ReturnType<typeof makeApp>>;
const orgId = 'reasoning-sources', userId = 'owner';
beforeAll(async () => { app = await makeApp(); installCivilCodeFixture(); });
afterAll(() => app.cleanup());
function fixture() {
  const file = createCase(orgId, userId, { title: '引用编号虚构案' });
  const source = addMaterial(orgId, userId, file.id, { source: 'manual', type: 'evidence', title: '合同及凭据',
    content: '合同第2条：总价九万元；付款凭据第1段：已支付七万元。\n合同第3条：付款截止2027年1月1日。' })!;
  addMaterial(orgId, userId, file.id, { source: 'tool', type: 'note', title: '旧意见稿', content: '已在2026年到期，这段生成文字不得成为证据。' });
  const current = getCase(orgId, file.id, userId)!;
  const refs = buildReasoningSources(current, '《民法典》第626条；《民法典》第628条', orgId, { actorUserId: userId });
  const entry = { issue: '欠款金额及付款期限', ruleId: 'R1', sourceIds: ['F1'], application: '九万元减已付七万元，账面差额为二万元，是否到期需结合合同付款期限。', conclusion: '账面剩余二万元，不能推定已经逾期。', limitations: '银行凭据的原件及付款对应关系仍须核实。' };
  const links = resolveFixture({ entries: [entry] }, refs).links;
  return { current, refs, source, entry, links };
}
function resolveFixture(value: unknown, refs: ReturnType<typeof buildReasoningSources>) { return resolveReasoningEntries(JSON.parse(reasoningFixtureReply(reasoningGenerationPrompt(refs, 'fixture'), value)), refs); }
function reviewFixture(value: unknown, links: ReturnType<typeof resolveReasoningEntries>['links'], refs: ReturnType<typeof buildReasoningSources>) { return applyReasoningReview(JSON.parse(reasoningFixtureReply(reasoningReviewPrompt(links, 'fixture', refs), value)), links, refs); }
describe('deterministic legal references and bounded applicability review', () => {
  it('keeps neutral pleading, complete legal sources and separate date roles in the shared generation context', () => {
    const neutral = '原始诉状。'.repeat(180) + 'NEUTRAL-TAIL';
    const authority = '完整法律原文。'.repeat(90) + 'LAW-SOURCE-TAIL';
    const context = buildCaseContext({ materials: neutral, legalAuthorities: authority, factDate: '2019-01-01', procedureDate: '2026-10-13' });
    expect(context).toContain('案件材料（未指定当事人角色）: ' + neutral);
    expect(context).toContain(authority);
    expect(context).toContain('实体法律适用时间基准（仅案件级，不代表各事件日期）: 2019-01-01');
    expect(context).toContain('程序法律适用时间基准（仅案件级，不代表具体程序已发生）: 2026-10-13');
    expect(context).not.toContain('对方材料: ' + neutral);
  });
  it('does not infer a proof purpose or established fact from filenames', () => {
    const rows = buildEvidenceReviewRows({ evidence: '付款截图\n合同原件\n质量检验报告' });
    expect(rows).toHaveLength(1);
    expect(rows[0].pendingCompilation).toBe(true);
    expect(rows[0].sources.map(source => source.quote)).toEqual(['付款截图', '合同原件', '质量检验报告']);
    for (const row of rows) {
      expect(row.fact).toBe('付款截图\n合同原件\n质量检验报告');
      expect(row.proofPurpose).toContain('待律师确认证明目的，不根据文件名称推定');
      expect(row.proofPurpose).not.toContain('欠款金额');
    }
  });
  it('preserves reviewer observations and payment linkage verbatim in material selection', () => {
    const originals = buildMaterialSources([{ id: 'fictional', title: '虚构案件原文', content:
      '原告陈述尚未用合同或交货原件核实。\n\n被告主张已付七万元，截图是否对应本案尚待核实。' }]);
    expect(originals[1].locator).toBe('提供材料正文第3行');
    const entries = resolveMaterialOutline({ entries: [{ issue: '付款截图与本案的对应关系如何核实？', sourceIds: ['F1', 'F2', 'F1'] }] }, originals);
    expect(entries[0].sources).toEqual(originals);
    expect(entries[0].sources[0].quote).toBe('原告陈述尚未用合同或交货原件核实。');
    expect(JSON.stringify(entries)).not.toContain('原告自认');
    expect(JSON.stringify(entries)).not.toContain('二万元');
  });
  it.each([
    { entries: [{ issue: '付款如何核实？', sourceIds: ['F999'] }] },
    { entries: [{ issue: '付款如何核实？', sourceIds: ['F1'], fact: '被告承认欠款二万元' }] },
    { entries: [{ issue: '付款如何核实？', sourceIds: [] }] },
    { entries: [] },
  ])('rejects a material outline that replaces originals with invented fields or references', value => {
    const originals = buildMaterialSources([{ id: 'fixture', title: '原文', content: '付款截图真实性及对应交易尚未确认。' }]);
    expect(() => resolveMaterialOutline(value, originals)).toThrow();
  });
  it('passes both disputed allegations intact while forbidding role substitution in the existing generation and review', () => {
    const { refs, links } = fixture();
    const summary = '被告称已支付七万元并提出质量异议，原告对此没有已提供的回应。';
    const generation = reasoningGenerationPrompt(refs, summary);
    const review = reasoningReviewPrompt(links, summary, refs);
    expect(generation).toContain(summary);
    expect(review).toContain(summary);
    expect(generation).toContain('保持原文的主张提出方');
    expect(review).toContain('保持原文主张方和付款方向');
    expect(generation).toContain('未提供、未回应或未证明前提满足，不能推出其相反状态或前提不成立');
    expect(generation).toContain('application/conclusion正文须保留未知');
    expect(review).toContain('主张不等于已证事实；未提供、未回应或未证明前提满足，不能推出其相反状态或前提不成立');
    for (const prompt of [generation, review]) expect(prompt).toContain('missingPremises或页脚待核不能抵销正文的相反断言');
    expect(JSON.parse(generation.split('\n材料：')[1])).toEqual(refs.sources);
  });
  it('preserves all original lines and fills exact quotations without trusting invented model text', () => {
    const { refs, current, entry } = fixture();
    expect(refs.sources).toHaveLength(2);
    expect(refs.sources[1]).toMatchObject({ quote: '合同第3条：付款截止2027年1月1日。', locator: '提供材料正文第2行' });
    const result = resolveFixture({ entries: [{ ...entry, fact: '2026年已经到期', ruleQuote: '编造条文' }] }, refs);
    expect(result.links[0].fact).toBe(refs.sources[0].quote);
    expect(result.links[0].ruleQuote).toBe(refs.rules[0].quote);
    expect(inspectLegalReasoningLinks(result.links, current, orgId).passed).toBe(true);
    expect(JSON.stringify(refs)).not.toContain('2026年到期');
  });
  it.each([{ ruleId: 'R999' }, { sourceIds: ['another-case-id'] }, { sourceIds: [] }, { application: {} }])('rejects missing or forged source references', invalid => {
    const { refs, entry } = fixture();
    expect(resolveFixture({ entries: [{ ...entry, ...invalid }] }, refs).errors.length).toBeGreaterThan(0);
  });
  it('accepts a factual sentence covered by adjacent snippets from the same original', () => {
    const { current, source, links } = fixture();
    const link = { ...links[0], applicationChecks: undefined, fact: source.content.split('\n')[0], evidence: [
      { materialId: source.id, locator: '正文第1行', quote: '合同第2条：总价九万元' },
      { materialId: source.id, locator: '正文第1行', quote: '付款凭据第1段：已支付七万元。' },
    ] };
    expect(inspectLegalReasoningLinks([link], current, orgId).passed).toBe(true);
    expect(inspectLegalReasoningLinks([{ ...link, fact: link.fact + '因此债务已全部到期。' }], current, orgId).passed).toBe(false);
  });
  it('rejects malformed nested applicability evidence without throwing or certifying unsupported analysis', () => {
    const { current, links } = fixture();
    for (const patch of [{ evidence: [null] }, { status: 'unsupported' }]) {
      const malformed = [{ ...links[0], applicationChecks: links[0].applicationChecks!.map(check => ({ ...check, ...patch })) }];
      expect(() => inspectLegalReasoningLinks(malformed, current, orgId)).not.toThrow();
      expect(inspectLegalReasoningLinks(malformed, current, orgId).passed).toBe(false);
    }
  });
  it('keeps missing prerequisites explicit and never lets review rewrite source evidence', () => {
    const { links, refs } = fixture();
    const review = { index: 1, status: 'conditional', application: '应先核实到期时间，不能直接推定逾期。', conclusion: '期限届满且无延期约定时才考虑迟延履行责任。', reason: '没有到期证据，草稿过早认定违约。', missingPremises: ['付款期限及变更约定'], evidence: [{ materialId: 'forged', quote: '虚构' }] };
    const result = reviewFixture({ reviews: [review], uncoveredIssues: [] }, links, refs);
    expect(result.errors).toEqual([]);
    expect(result.links[0].evidence).toEqual(links[0].evidence);
    expect(result.links[0].conclusion).toContain('现有材料不足以作确定结论');
  });
  it.each([
    { index: 1, status: 'supported', missingPremises: ['前提尚缺'] },
    { index: 1, status: 'conditional', missingPremises: [] },
    { index: 2, status: 'supported', missingPremises: [] },
    { index: 1, status: 'unsupported', missingPremises: [] },
  ])('blocks inconsistent or unsupported review verdicts', invalid => {
    const { links, refs } = fixture();
    const review = { application: '该项需依据完整材料另行核实。', conclusion: '暂不能确定具体履行责任。', reason: '提供的资料不能支持该结论。', ...invalid };
    const result = reviewFixture({ reviews: [review], uncoveredIssues: [] }, links, refs);
    expect(result.errors.length).toBeGreaterThan(0);
    if (review.status === 'unsupported') expect(result.errors).toContain('第1项适用分析缺少相关依据。');
  });
  it('does not report completion when the review finds a missing core issue', () => {
    const { links, refs } = fixture();
    const review = { index: 1, status: 'supported', application: links[0].application, conclusion: links[0].conclusion, reason: '本项只完成差额计算。', missingPremises: [] };
    expect(reviewFixture({ reviews: [review], uncoveredIssues: ['是否已经到期尚未分析'] }, links, refs).errors).toContain('核心争议尚未分析：是否已经到期尚未分析');
    expect(reviewFixture({ reviews: [review], uncoveredIssues: [{ issue: '是否已经到期尚未分析', ruleId: 'R2' }] }, links, refs).errors).toContain('核心争议尚未分析：是否已经到期尚未分析');
  });
  it('lets review correct the selected rule and add an omitted original without inventing source text', () => {
    const { links, refs } = fixture();
    const review = { index: 1, status: 'conditional', ruleId: 'R2', sourceIds: ['F1', 'F2'], application: '应按付款日期核实到期条件。', conclusion: '在约定到期日前不能仅因未付款认定逾期。', reason: '初稿只选金额规则，漏选了付款期限材料。', missingPremises: ['是否有期限变更约定'], ruleQuote: '不得接受的虚构文本' };
    const result = reviewFixture({ reviews: [review], uncoveredIssues: [] }, links, refs);
    expect(result.errors).toEqual([]);
    expect(result.links[0].ruleQuote).toBe(refs.rules[1].quote);
    expect(result.links[0].fact).toContain('付款截止2027年1月1日');
    expect(reviewFixture({ reviews: [{ ...review, sourceIds: ['another-case'] }], uncoveredIssues: [] }, links, refs).errors.length).toBeGreaterThan(0);
  });
  it('keeps previously stored consecutive rule fragments valid without regenerating their analysis', () => {
    const { current, links } = fixture();
    const original = links[0];
    const oldQuotes = ['买受人应当按照约定的数额和支付方式支付价款。', '对价款的数额和支付方式没有约定', '或者约定不明确的，', '适用本法第五百一十条、第五百一十一条第二项和第五项的规定。'];
    expect(oldQuotes.join('')).toBe(original.ruleQuote);
    let cursor = 0;
    const oldChecks = oldQuotes.map((quote, i) => {
      const check = { partId: 'P' + (i + 1), ruleStart: cursor, ruleEnd: cursor + quote.length, ruleQuote: quote, evidence: original.evidence,
        status: 'conditional' as const, application: '原有工作稿依原条文核对本案前提，不能据缺资料确认适用。',
        conclusion: '仅提出条件意见，具体履行义务仍须核实原始材料。', missingPremises: ['完整合同及其约定内容仍待核实'] };
      cursor += quote.length; return check;
    });
    const stored = { ...original, applicationChecks: oldChecks, ...compileLegalApplicationChecks(oldChecks) };
    expect(inspectLegalReasoningLinks([stored], current, orgId).passed).toBe(true);
    const mutations = [oldChecks.slice(1), [...oldChecks].reverse(), oldChecks.map((item, i) => i === 1 ? { ...item, ruleStart: item.ruleStart - 1 } : item),
      oldChecks.map((item, i) => i === 1 ? { ...item, ruleQuote: item.ruleQuote + '伪造' } : item), oldChecks.map((item, i) => i === 1 ? { ...item, partId: 'P1' } : item)];
    for (const checks of mutations) expect(inspectLegalReasoningLinks([{ ...stored, applicationChecks: checks }], current, orgId).passed).toBe(false);
    expect(inspectLegalReasoningLinks([{ ...stored, application: stored.application + '改写' }], current, orgId).passed).toBe(false);
  });

  it('preserves typed missing premises as unconfirmed questions through the actual resolver and compiler', () => {
    const { refs, current } = fixture();
    const premise = '被告付款真实性及款项对应关系已经核实';
    const check = { partId: 'P1', sourceIds: ['F1'], status: 'conditional', application: '款项原件及关联待核，现不能判断付款已完成。', conclusion: '付款数额及到期条件仍须核实。', missingPremises: [premise] };
    const raw = { entries: [{ issue: '付款条件如何核实？', ruleId: 'R1', checks: [check] }] };
    const before = JSON.stringify(raw);
    const result = resolveReasoningEntries(raw, refs);
    expect(result.errors).toEqual([]);
    expect(JSON.stringify(raw)).toBe(before);
    expect(result.links[0].applicationChecks![0].missingPremises).toEqual([premise]);
    expect(result.links[0].limitations).toContain('尚待核实是否成立：' + premise);
    expect(result.links[0].limitations).not.toMatch(/^被告付款真实性/);
    expect(result.links[0].application).toContain(check.application);
    expect(result.links[0].conclusion).toContain(check.conclusion);
    expect(inspectLegalReasoningLinks(result.links, current, orgId).passed).toBe(true);
    const supported = compileLegalApplicationChecks([{ ...result.links[0].applicationChecks![0], status: 'supported', missingPremises: [] }]);
    expect(supported.limitations).not.toContain('尚待核实是否成立');
    expect(reasoningGenerationPrompt(refs, 'fixture')).toContain('missingPremises只列尚未确认是否成立的前提');
    expect(reasoningReviewPrompt(result.links, 'fixture', refs)).toContain('missingPremises只列尚未确认是否成立的前提');
  });
  it('reads the exact legacy compiled limitations from persisted typed checks without changing the archive or accepting arbitrary prose', () => {
    const { links, current } = fixture();
    const checks = links[0].applicationChecks!;
    const oldLimitations = [...new Set(checks.flatMap(check => check.missingPremises)), '仅为给定材料范围内的拟议分析，不证明证据真实或律师已经核准。'].join('；');
    const legacy = { ...links[0], limitations: oldLimitations };
    const archived = addMaterial(orgId, userId, current.id, { source: 'tool', type: 'note', title: '旧版论证存档', content: '仅为原始论证工作稿的保存再读夹具。', reasoningLinks: [legacy], reasoningBasis: legalCaseSourceFingerprint(current) })!;
    const reloaded = getCase(orgId, current.id, userId)!;
    const before = JSON.stringify(reloaded);
    const persisted = reloaded.materials.find(material => material.id === archived.id)!.reasoningLinks!;
    expect(persisted[0].limitations).toBe(oldLimitations);
    const result = inspectLegalReasoningLinks(persisted, reloaded, orgId, { actorUserId: userId });
    expect(result.passed).toBe(true);
    expect(result.links[0].limitations).toContain('尚待核实是否成立：');
    expect(formatLegalReasoningLinks(result.links)).toContain('尚待核实是否成立：');
    const rows = buildEvidenceReviewRows({ userId }, reloaded);
    expect(rows.some(row => row.proofPurpose.includes('尚待核实是否成立：'))).toBe(true);
    expect(persisted[0].limitations).toBe(oldLimitations);
    expect(JSON.stringify(getCase(orgId, current.id, userId))).toBe(before);
    for (const patch of [{ limitations: '任意自由文字不属于原typed未核前提。' }, { application: legacy.application + '未获来源的另一事实。' }]) {
      expect(inspectLegalReasoningLinks([{ ...legacy, ...patch }], reloaded, orgId, { actorUserId: userId }).passed).toBe(false);
    }
  });
});
