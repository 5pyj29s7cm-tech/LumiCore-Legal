import { describe, expect, it } from 'vitest';
import { legalRuleParts, formatLegalReasoningLinks } from '../server/regions/packs/cn/legal_reasoning_links';
import { resolveReasoningEntries, applyReasoningReview, reasoningGenerationPrompt, reasoningReviewPrompt, type ReasoningSources } from '../server/regions/packs/cn/legal_reasoning_generation';

const quote = '买受人应当按照约定的数额和支付方式支付价款。对价款的数额和支付方式没有约定或者约定不明确的，适用本法第五百一十条、第五百一十一条第二项和第五项的规定。';
const sources: ReasoningSources = { rules: [{ id: 'R1', citation: '《民法典》第626条', quote, referenceDate: '2026-09-01', temporalScope: 'fact' }],
  sources: [{ id: 'F1', materialId: 'owned-original', title: '本次审阅记录', quote: '审阅者未取得合同条款，不证明当事人没有约定或者约定不明确。', locator: '提供材料正文第1行' }] };
const old = { issue: '价款及支付方式适用前提', ruleId: 'R1', sourceIds: ['F1'], application: '有约定按约定，无约定才适用510及511。', conclusion: '有约定按约定；无约定依法补缺。', limitations: '合同完整条款尚待核实。' };
const entry = () => ({ issue: old.issue, ruleId: 'R1', checks: legalRuleParts(quote).map(part => ({ partId: part.id, sourceIds: ['F1'], status: 'conditional',
  application: '本案未提供完整条款，不能认定无约定；对约定不明确这一备选路径，也须核实完整条款。两者均未知时不能确定补充规则已适用。',
  conclusion: '完整条款核实之前，仅提出对应的条件意见，不确认具体付款义务。', missingPremises: ['完整条款及其约定清晰程度'] })) });
const review = () => ({ reviews: [{ index: 1, ruleId: 'R1', checks: entry().checks }], uncoveredIssues: [] });
const legacyLink = { issue: old.issue, ruleCitation: sources.rules[0].citation, ruleQuote: quote, fact: sources.sources[0].quote,
  evidence: [{ materialId: sources.sources[0].materialId, quote: sources.sources[0].quote, locator: sources.sources[0].locator }],
  application: old.application, conclusion: old.conclusion, limitations: old.limitations };

describe('literal rule parts bind the operative analysis and the existing review', () => {
  it('rejects the old r2 whole-rule free analysis that omitted an alternative', () => {
    const result = resolveReasoningEntries({ entries: [old] }, sources);
    expect(result.errors.length).toBeGreaterThan(0); expect(result.links).toHaveLength(0);
  });
  it('rejects the old whole-rule review even though its approved label says supported', () => {
    const result = applyReasoningReview({ reviews: [{ index: 1, status: 'supported', application: old.application, conclusion: old.conclusion, missingPremises: [], reason: '已复核' }], uncoveredIssues: [] }, [legacyLink], sources);
    expect(result.errors.length).toBeGreaterThan(0);
  });
  it('retains exact offsets and connecting text without interpreting or splitting a single 或', () => {
    const text = '  或有负债应当披露，未约定或者约定不明确的，依全文补充。\n';
    const parts = legalRuleParts(text);
    expect(parts.map(part => part.quote).join('')).toBe(text);
    expect(parts).toEqual([{ id: 'P1', start: 0, end: text.length, quote: text }]);
    for (const part of parts) expect(text.slice(part.start, part.end)).toBe(part.quote);
  });
  it('binds complete current originals and dates, ignoring model facts, raw law and verified metadata', () => {
    const result = resolveReasoningEntries({ entries: [{ ...entry(), application: 'RETIRED-FREE-TEXT', conclusion: 'RETIRED-CONCLUSION', fact: '被告承认欠款', verified: true, ruleQuote: '伪造规则', checks: entry().checks.map(check => ({ ...check, quote: '伪造片段', ruleStart: 999, verified: true })) }] }, sources);
    expect(result.errors).toEqual([]); const link = result.links[0];
    expect(link.fact).toBe(sources.sources[0].quote); expect(link.ruleQuote).toBe(quote);
    expect(link).toMatchObject({ ruleReferenceDate: '2026-09-01', ruleTemporalScope: 'fact' });
    expect(link.application).not.toContain('RETIRED'); expect(JSON.stringify(link)).not.toContain('伪造'); expect(link).not.toHaveProperty('verified');
    for (const [i, part] of legalRuleParts(quote).entries()) expect(link.applicationChecks![i]).toMatchObject({ partId: part.id, ruleStart: part.start, ruleEnd: part.end, ruleQuote: part.quote });
  });
  it.each(['missing-full-rule', 'duplicate-part', 'forged-source', 'unsupported', 'unknown-without-missing', 'supported-with-missing'])('rejects %s before a complete applicability result exists', failure => {
    const item = entry();
    if (failure === 'missing-full-rule') item.checks = [];
    if (failure === 'duplicate-part') item.checks.push({ ...item.checks[0] });
    if (failure === 'forged-source') item.checks[0].sourceIds = ['unrelated-case'];
    if (failure === 'unsupported') item.checks[0].status = 'unsupported';
    if (failure === 'unknown-without-missing') item.checks[0].missingPremises = [];
    if (failure === 'supported-with-missing') item.checks[0].status = 'supported';
    expect(resolveReasoningEntries({ entries: [item] }, sources).errors.length).toBeGreaterThan(0);
  });
  it('uses the same checked structure after review and renders both alternatives in the operative analysis', () => {
    const initial = resolveReasoningEntries({ entries: [entry()] }, sources);
    const result = applyReasoningReview(review(), initial.links, sources);
    expect(result.errors).toEqual([]);
    const body = formatLegalReasoningLinks(result.links);
    expect(body).toContain('本案未提供完整条款'); expect(body).toContain('对约定不明确这一备选路径');
    expect(body).toContain('不表示各片段是独立成立的法律条件'); expect(body).toContain('不证明证据真实或律师已经核准');
    expect(body).not.toContain('有约定按约定，无约定才适用');
  });
  it('does not apply an incomplete review or its forged source to the accepted structure', () => {
    const initial = resolveReasoningEntries({ entries: [entry()] }, sources);
    for (const invalid of [ { ...review().reviews[0], checks: entry().checks.slice(0, -1) },
      { ...review().reviews[0], checks: entry().checks.map(check => ({ ...check, sourceIds: ['forged'] })) } ]) {
      const result = applyReasoningReview({ reviews: [invalid], uncoveredIssues: [] }, initial.links, sources);
      expect(result.errors.length).toBeGreaterThan(0); expect(result.links).toEqual(initial.links);
    }
  });
  it('preserves per-rule procedural and factual baselines without filling individual event dates', () => {
    const procedural: ReasoningSources = { ...sources, rules: [{ ...sources.rules[0], referenceDate: '2026-10-16', temporalScope: 'procedure' }] };
    const generated = resolveReasoningEntries({ entries: [entry()] }, procedural);
    const reviewed = applyReasoningReview(review(), generated.links, procedural);
    expect(reviewed.links[0]).toMatchObject({ ruleReferenceDate: '2026-10-16', ruleTemporalScope: 'procedure' });
    const text = formatLegalReasoningLinks(reviewed.links); expect(text).toContain('程序，不代替具体事件日期');
    expect(text).not.toContain('付款日2026-10-16'); expect(text).not.toContain('交付日2026-10-16');
  });
  it('passes one ordered full-text rule context to generation and review without a second free legal premise', () => {
    const generated = resolveReasoningEntries({ entries: [entry()] }, sources);
    for (const prompt of [reasoningGenerationPrompt(sources, '本次法律分析'), reasoningReviewPrompt(generated.links, '本次法律分析', sources)]) {
      const rule = JSON.parse(prompt.match(/^法条（同条各parts按原文次序合读）：(.+)$/m)![1])[0];
      expect(rule.parts.map((part: any) => part.quote).join('')).toBe(quote);
      expect(rule).toMatchObject({ referenceDate: '2026-09-01', temporalScope: 'fact' });
    }
  });
});
