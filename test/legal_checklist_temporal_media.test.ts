import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import * as LegalCases from '../server/org/legal_cases';
import { evaluateCurrentLawGate, buildLegalWorkProductPreflightSection, formatCitationReportMarkdown } from '../server/regions/packs/cn/legal_tools/citations';
import { resolveLegalCaseArguments } from '../server/regions/packs/cn/legal_tools/context';
import { normalizeFormalDocumentType } from '../server/regions/packs/cn/legal_tools/documents';
import { legalCaseSourceFingerprint } from '../shared/legal_workflow_receipts';
import { ToolRegistry } from '../server/tools/registry';
import { registerProductVariantTools } from '../server/tools/definitions';
import * as LegalKnowledge from '../server/legal/kb';
import { searchCaseHandler } from '../server/regions/packs/cn/legal_tools/knowledge';
import { formatCnToolFailureDetail, formatCnMediaGenerationFailure } from '../server/regions/messages/voice_fast_path_messages';

let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); installCivilCodeFixture(); });
afterAll(() => app.cleanup());

describe('lawyer checklist: temporal law and shared media', () => {
  it('keeps a missing-file error distinct from an actual vision HTTP failure', () => {
    expect(formatCnToolFailureDetail('ENOENT: no such file, open D:/vision/1790000042947-material.txt')).toContain('文件');
    expect(formatCnToolFailureDetail('ENOENT: no such file, open D:/vision/1790000042947-material.txt')).not.toContain('HTTP');
    expect(formatCnToolFailureDetail('vision service HTTP 503: provider unavailable')).toContain('HTTP 503');
    expect(formatCnToolFailureDetail('400 status code (no body)')).toContain('HTTP 400');
  });
  it('explains an unavailable gateway model without exposing durable-claim protocol to the customer', () => {
    const text = formatCnMediaGenerationFailure(['Tool "generate_video" external commit outcome is unknown and automatic resend was stopped. The handler failed after the durable claim. Lumi Official API request failed (400): 指定平台下的模型不存在，或当前未启用。']);
    expect(text).toContain('模型不存在或未启用');
    expect(text).not.toMatch(/Tool|durable|outcome|resend|handler|已提交任务/iu);
  });
  it('cannot approve even a verified statute without the case fact date', () => {
    const text = '依据《民法典》第585条核对违约金。';
    const missing = evaluateCurrentLawGate(text);
    expect(missing.blockingStatutes).toHaveLength(0);
    expect(missing).toMatchObject({ passed: false, missingFactDate: true });
    expect(formatCitationReportMarkdown({}, text, 'same-source')).toContain('现行有效法律硬门槛：未通过');
    expect(formatCitationReportMarkdown({ factDate: '2026-09-01' }, text, 'same-source')).toContain('现行有效法律硬门槛：通过');
    expect(evaluateCurrentLawGate(text, undefined, [], '2026-09-01')).toMatchObject({ passed: true, missingFactDate: false });
    expect(evaluateCurrentLawGate(text, undefined, [], '2019-01-01')).toMatchObject({ passed: false, missingFactDate: false });
  });

  it.each(['2026-13-99', '2026-02-30', '2026-2-3', 'not-a-date'])('blocks an invalid fact date: %s', factDate => {
    expect(evaluateCurrentLawGate('《民法典》第585条', undefined, [], factDate))
      .toMatchObject({ passed: false, missingFactDate: true });
  });

  it('uses the historical case date during draft preflight as well as delivery', () => {
    const text = '《民法典》第585条';
    expect(buildLegalWorkProductPreflightSection(text, { factDate: '2019-01-01' })).toContain('预检：未通过');
    expect(buildLegalWorkProductPreflightSection(text, { factDate: '2026-09-01' })).toContain('预检：通过');
  });

  it('retains the recorded fact date across client sync and a different document tool', () => {
    const userId = 'checklist-date-owner', orgId = LegalCases.legalWorkspaceNamespace(userId);
    const record = LegalCases.createCase(orgId, userId, { title: '事实日期续办验收', factDate: '2019-01-01', hearingDate: '2026-10-20' });
    LegalCases.upsertCaseSnapshot(orgId, userId, { id: record.id, title: record.title, hearingDate: '2026-10-21' });
    const args = resolveLegalCaseArguments('legal_generate_argument_or_opinion', { caseId: record.id }, { userId, domain: 'personal' });
    expect(args.factDate).toBe('2019-01-01');
    expect(LegalCases.getCase(orgId, record.id, userId)?.factDate).toBe('2019-01-01');
  });

  it('invalidates old verification when the fact date changes without changing undated case identity', () => {
    const original = { title: '事实日期', notes: '同一份案件材料', materials: [] };
    expect(legalCaseSourceFingerprint(original)).toBe(legalCaseSourceFingerprint({ ...original, factDate: '' }));
    expect(legalCaseSourceFingerprint({ ...original, factDate: '2019-01-01' }))
      .not.toBe(legalCaseSourceFingerprint({ ...original, factDate: '2026-09-01' }));
  });

  it('does not turn a contract or receipt date into a hearing date', () => {
    expect(LegalCases.extractLegalCaseHints('合同于2020年6月1日签订，2020年6月3日付款。').hearingDate).toBeUndefined();
    expect(LegalCases.extractLegalCaseHints('通知：2026年10月20日14时30分开庭。').hearingDate).toBe('2026-10-20 14:30');
  });

  it('preserves an element-form complaint instead of classifying it as the ordinary complaint', () => {
    expect(normalizeFormalDocumentType('要素式起诉状')).toBe('要素式诉状');
    expect(normalizeFormalDocumentType('民事起诉状')).toBe('起诉状');
  });

  it('registers the existing image and video paths in the lawyer edition without expanding unrelated domains', () => {
    const registry = new ToolRegistry();
    registerProductVariantTools(registry);
    for (const name of ['generate_image', 'ai_edit_image', 'generate_video']) expect(registry.get(name)).toBeDefined();
    expect(registry.get('legal_generate_litigation_packet')?.parameters.properties?.factDate).toBeDefined();
    expect(registry.get('git_commit')).toBeUndefined();
    expect(registry.get('python_exec')).toBeUndefined();
  });

  it('orders actual court metadata ahead of similarity and does not rank a quoted Supreme Court reference as the deciding court', async () => {
    const courts = ['某县人民法院', '某省高级人民法院', '某市中级人民法院', '最高人民法院', undefined];
    const search = vi.spyOn(LegalKnowledge, 'searchSimilarCases').mockResolvedValueOnce(courts.map((court, index) => ({
      articleId: 'sorting-' + index, title: index === 0 ? '基层裁判引用最高人民法院规则' : '排序验收' + index,
      court, chunk: '独立排序测试材料', score: 100 - index, date: '', source: 'keyword' as const,
    })));
    try {
      const text = await searchCaseHandler({ query: '排序验收', limit: 4 }, { userId: 'sorting-test', domain: 'personal' });
      const positions = ['法院: 最高人民法院', '法院: 某省高级人民法院', '法院: 某市中级人民法院', '法院: 某县人民法院'].map(value => text.indexOf(value));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(search).toHaveBeenCalledWith('personal:sorting-test', '排序验收', 16, 'sorting-test');
    } finally { search.mockRestore(); }
  });
});
