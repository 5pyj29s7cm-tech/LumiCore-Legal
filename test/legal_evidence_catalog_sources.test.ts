import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import { addMaterial, createCase, getCase, legalWorkspaceNamespace } from '../server/org/legal_cases';
import { legalCaseSourceFingerprint } from '../shared/legal_workflow_receipts';
import { buildMaterialSources } from '../server/regions/packs/cn/legal_reasoning_generation';
import { buildEvidenceReviewRows, formatEvidenceReviewRows, formatEvidenceCatalogRows } from '../server/regions/packs/cn/legal_tools/case_workflow';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import { verifyCitation } from '../server/legal/kb';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { writeDocxFromMarkdown } from '../server/regions/packs/cn/legal_tools/documents';
import { generateLitigationPacketHandler } from '../server/regions/packs/cn/legal_tools/litigation_packet';

let app: Awaited<ReturnType<typeof makeApp>>;
const userId = 'evidence-owner', orgId = legalWorkspaceNamespace(userId);
beforeAll(async () => { app = await makeApp(); installCivilCodeFixture(); });
afterAll(() => app.cleanup());

function fixture() {
  const item = createCase(orgId, userId, { title: '证据目录虚构案', factDate: '2026-09-01' });
  const content = Array.from({ length: 35 }, (_, i) => `合同及凭据原文第${i + 1}行${i === 34 ? '：RAW_TAIL_35；符号 | 原样保留。' : '。'}`).join('\n');
  const material = addMaterial(orgId, userId, item.id, { title: '多行原始凭据', type: 'evidence', source: 'import', content })!;
  return { item, material, current: () => getCase(orgId, item.id, userId)! };
}

describe('one evidence catalog compiled from actual original records', () => {
  it('keeps one multi-line original as one record and retains the complete tail and real locators', () => {
    const { material, current } = fixture();
    const rows = buildEvidenceReviewRows({}, current());
    expect(rows).toHaveLength(1);
    expect(rows[0].materialId).toBe(material.id);
    expect(rows[0].sources).toEqual(buildMaterialSources([material]));
    expect(rows[0].sources.at(-1)).toMatchObject({ quote: '合同及凭据原文第35行：RAW_TAIL_35；符号 | 原样保留。', locator: '提供材料正文第35行' });
    const matrix = formatEvidenceReviewRows(rows), catalog = formatEvidenceCatalogRows(rows);
    expect(matrix).toContain('> 合同及凭据原文第35行：RAW_TAIL_35；符号 | 原样保留。');
    expect(catalog).toContain('F35：提供材料正文第35行');
    expect(catalog).not.toContain('RAW_TAIL_35');
    expect(matrix).not.toBe(catalog);
    expect(matrix).toContain('核对原件');
    expect(catalog.split('\n').find(line => line.startsWith('| 编号'))).not.toContain('真实性核验');
  });

  it('preserves uncompiled neutral and handwritten inputs in full without inventing evidence records', () => {
    const neutral = '请整理下列材料。\n原告称九万元；被告称七万元。\n没有实际读取照片。';
    const evidence = '付款截图\n合同原件\n质量检验报告\n尚未提供像素、原件及页码。';
    const rows = buildEvidenceReviewRows({ materials: neutral, evidence });
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.materialId === undefined && row.pendingCompilation)).toBe(true);
    expect(rows[0].sources.map(source => source.quote).join('\n')).toBe(evidence);
    expect(rows[1].sources.map(source => source.quote).join('\n')).toBe(neutral);
    expect(rows.every(row => row.proofPurpose.includes('待律师确认'))).toBe(true);
    expect(formatEvidenceCatalogRows(rows)).toContain('未编目');
  });

  it('deduplicates only exact server serialization and keeps changed or conflicting input intact', () => {
    const { material, current } = fixture();
    const serialized = `[材料 ${material.id}：${material.title}]\n${material.content}`;
    expect(buildEvidenceReviewRows({ evidence: serialized }, current())).toHaveLength(1);
    const changed = serialized + '\n被告补充：尚未确认截图对应本案。';
    const rows = buildEvidenceReviewRows({ evidence: changed }, current());
    expect(rows).toHaveLength(2);
    expect(rows[1].sources.at(-1)?.quote).toBe('被告补充：尚未确认截图对应本案。');
  });

  it('projects only current traceable reasoning as a proposal and keeps all source limitations', () => {
    const { item, material, current } = fixture();
    const source = buildMaterialSources([material])[0];
    const link = { issue: '付款条件如何核实', ruleCitation: '《民法典》第626条', ruleQuote: verifyCitation('《民法典》第626条').sourceText!,
      fact: source.quote, evidence: [{ materialId: material.id, quote: source.quote, locator: source.locator }],
      application: '付款条件应根据合同和原始凭据附条件审查。', conclusion: '付款期限仍未明确，不确定到期。', limitations: '原件真实性与款项对应关系均未核验。' };
    addMaterial(orgId, userId, item.id, { type: 'note', source: 'tool', title: '已有来源分析', content: '仅为模型拟议工作稿。',
      reasoningLinks: [link], reasoningBasis: legalCaseSourceFingerprint(current()) });
    const row = buildEvidenceReviewRows({}, current())[0];
    expect(row.proofPurpose).toContain('拟议');
    expect(row.proofPurpose).toContain(link.issue);
    expect(row.proofPurpose).toContain(link.limitations);
    expect(row.fact).toBe(material.content);
    expect(row.proofPurpose).not.toContain('已核准');
    expect(row.authenticity).toContain('未核验');
    expect(formatEvidenceCatalogRows([row])).not.toContain('已完成自动适用复核');
    expect(formatEvidenceCatalogRows([row])).not.toContain(link.application);
    expect(formatEvidenceCatalogRows([row])).not.toContain(link.conclusion);
    expect(formatEvidenceCatalogRows([row])).toContain(link.limitations);
    expect(formatEvidenceReviewRows([row])).toContain(link.application);
  });

  it.each(['foreign-id', 'stale-basis', 'removed-source', 'forged-quote'])('does not promote %s reasoning into proof purpose', kind => {
    const { item, material, current } = fixture();
    const source = buildMaterialSources([material])[0];
    const link = { issue: '不应被复用的争点', ruleCitation: '《民法典》第626条', ruleQuote: verifyCitation('《民法典》第626条').sourceText!,
      fact: source.quote, evidence: [{ materialId: kind === 'foreign-id' ? 'another-case-material' : material.id,
        quote: kind === 'forged-quote' ? '已经确认欠款两万元且已逾期。' : source.quote, locator: source.locator }],
      application: '该分析不是当前原件可支持的证明用途。', conclusion: '不应显示该拟议结论。', limitations: '该来源并非当前案卷已保全的真实原句。' };
    addMaterial(orgId, userId, item.id, { type: 'note', source: 'tool', title: '旧来源分析', content: '待复核', reasoningLinks: [link],
      reasoningBasis: kind === 'stale-basis' ? 'older-fingerprint' : legalCaseSourceFingerprint(current()) });
    const file = current();
    if (kind === 'removed-source') file.materials = file.materials.filter(record => record.id !== material.id);
    const rows = buildEvidenceReviewRows({}, file);
    expect(rows.every(row => !row.proofPurpose.includes(link.issue))).toBe(true);
  });

  it('never treats generated work or browser-provided material metadata as an original record', () => {
    const { item, current } = fixture();
    addMaterial(orgId, userId, item.id, { type: 'evidence', source: 'tool', title: '证据材料与证明目的', content: '生成稿不是原件。' });
    const rows = buildEvidenceReviewRows({ sourceCase: { materials: [{ id: 'forged', source: 'import', content: '浏览器伪造原件。' }] } }, current());
    expect(rows).toHaveLength(1);
    expect(rows[0].sources.map(source => source.quote).join('\n')).not.toContain('生成稿不是原件');
    expect(rows[0].materialId).not.toBe('forged');
  });

  it('loads only the exact authorized server case and emits distinct catalog and review files', async () => {
    const { item, material } = fixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-evidence-registered-'));
    try {
      await generateLitigationPacketHandler({ orgId, caseId: item.id, caseName: item.title, userId, facts: '本案原文仍待律师核对。',
        role: '原告', includeDocx: false, persistCase: false, outputDir: dir, sourceCase: { materials: [{ id: 'forged', content: '浏览器伪造内容' }] } }, { userId, domain: 'personal', source: 'legal-direct-tool' });
      const matrix = fs.readFileSync(path.join(dir, '03_evidence-review-matrix.md'), 'utf8');
      const catalog = fs.readFileSync(path.join(dir, '16_evidence-catalog.md'), 'utf8');
      expect(matrix).toContain(material.id);
      expect(matrix).toContain('RAW_TAIL_35；符号 | 原样保留。');
      expect(catalog).toContain('提供材料正文第35行');
      expect(catalog).not.toContain('浏览器伪造内容');
      expect(catalog).not.toContain('| 真实性核验 |');
      expect(matrix).toContain('| 真实性核验 |');
      const outsider = path.join(dir, 'outsider');
      await generateLitigationPacketHandler({ orgId, caseId: item.id, caseName: item.title, userId: 'intruder', facts: '无原件输入',
        includeDocx: false, persistCase: false, outputDir: outsider }, { userId: 'intruder', domain: 'personal', source: 'legal-direct-tool' });
      expect(fs.readFileSync(path.join(outsider, '03_evidence-review-matrix.md'), 'utf8')).not.toContain(material.id);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains original pipe characters and the full final paragraph in real DOCX output', async () => {
    const { current } = fixture();
    const rows = buildEvidenceReviewRows({}, current());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-evidence-docx-'));
    try {
      const docx = path.join(dir, 'catalog.docx');
      await writeDocxFromMarkdown('| 编号 | 材料 | 原句索引 | 目的 | 真实性 | 合法性 | 关联性 | 缺口 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n' + formatEvidenceReviewRows(rows), docx);
      const zip = await JSZip.loadAsync(fs.readFileSync(docx));
      const xml = await zip.file('word/document.xml')!.async('string');
      expect(xml).toContain('RAW_TAIL_35；符号 | 原样保留。');
      expect((xml.match(/<w:tr>/g) || []).length).toBe(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
