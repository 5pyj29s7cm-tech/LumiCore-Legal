import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp } from './helpers';
import * as cases from '../server/org/legal_cases';
import { listAuditLog } from '../server/org/db';
import { legalCaseSourceFingerprint } from '../shared/legal_workflow_receipts';
import { appendLegalCaseMaterial } from '../server/regions/packs/cn/legal_tools/case_workflow';
import { processNoticeLinkHandler } from '../server/regions/packs/cn/legal_tools/notice_intake';

let app: Awaited<ReturnType<typeof makeApp>>;
const userId = 'synthetic-summary-owner';
const orgId = cases.legalWorkspaceNamespace(userId);
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
function fixture(notes = '用户记录：付款事实尚待核实。') {
  const caseFile = cases.createCase(orgId, userId, { title: '归档摘要边界虚构案件', notes });
  cases.recordWorkflowRun(orgId, userId, caseFile.id, {
    tool: 'synthetic_history', ok: false, status: 'partial', materialIds: [], artifacts: [], displayText: '既有只读结果，不能提升为成功。',
  });
  return cases.getCase(orgId, caseFile.id, userId)!;
}

describe('material archives do not rewrite user case summaries', () => {
  it.each(['manual', 'tool'] as const)('retains summary, original bytes, history and audit after %s archive', source => {
    const current = fixture();
    const localPath = path.join(process.env.LUMI_DATA_DIR!, source + '-original.txt');
    fs.writeFileSync(localPath, 'UNCHANGED-ORIGINAL-BYTES');
    const input = { type: 'note' as const, title: source + ' 新材料标题', content: '归档正文，不能写入案件摘要。', localPath };
    const material = source === 'manual'
      ? cases.addMaterial(orgId, userId, current.id, { ...input, source })!
      : appendLegalCaseMaterial({ orgId, userId, caseId: current.id, ...input })!;
    const saved = cases.getCase(orgId, current.id, userId)!;
    expect(saved.materials).toEqual([material]);
    expect(material).toMatchObject({ ...input, source, createdBy: userId });
    expect(saved.workflowRuns).toEqual(current.workflowRuns);
    expect(fs.readFileSync(localPath, 'utf8')).toBe('UNCHANGED-ORIGINAL-BYTES');
    const audit = listAuditLog(orgId, null).filter(event => event.resourceId === current.id);
    expect(audit.filter(event => event.action === 'legal_case.material.add')).toHaveLength(1);
    expect(JSON.parse(audit.find(event => event.action === 'legal_case.material.add')!.details)).toMatchObject({ title: input.title, source });
    expect(saved.notes).toBe(current.notes);
  });

  it('keeps a notice archive readable without appending its title to the summary', async () => {
    const current = fixture();
    const body = '<html><body><p>仅用于离线验收的通知原文。</p><p>NOTICE-SOURCE-TAIL</p></body></html>';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/html' } }));
    try {
      const result = await processNoticeLinkHandler({ caseId: current.id, caseName: current.title,
        url: 'https://court.example.test/notice', confirmedForKb: false }, { userId, domain: 'personal' });
      const saved = cases.getCase(orgId, current.id, userId)!;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toContain('partial');
      expect(saved.materials).toHaveLength(1);
      expect(saved.materials[0].content).toContain('NOTICE-SOURCE-TAIL');
      expect(fs.readFileSync(saved.materials[0].localPath!, 'utf8')).toContain('NOTICE-SOURCE-TAIL');
      expect(saved.workflowRuns).toEqual(current.workflowRuns);
      expect(listAuditLog(orgId, null).filter(event => event.resourceId === current.id && event.action === 'legal_case.material.add')).toHaveLength(1);
      expect(saved.notes).toBe(current.notes);
    } finally { fetchMock.mockRestore(); }
  });

  it('preserves existing archive markers and user text verbatim instead of migrating old notes', () => {
    const notes = '用户摘要第一行。\n【材料归档】旧标题由早期程序写入\n用户继续记录。';
    const current = fixture(notes);
    cases.addMaterial(orgId, userId, current.id, { type: 'evidence', source: 'manual', title: '新证据', content: '仅归入材料列表。' });
    expect(cases.getCase(orgId, current.id, userId)!.notes).toBe(notes);
  });

  it('keeps an empty summary empty after an archive', () => {
    const current = fixture('');
    cases.addMaterial(orgId, userId, current.id, { type: 'note', source: 'tool', title: '工具草稿', content: '待复核稿。' });
    expect(cases.getCase(orgId, current.id, userId)!.notes).toBe('');
  });

  it('keeps generated drafts outside the source fingerprint while real originals still invalidate a review', () => {
    const current = fixture('用户摘要。\n【材料归档】历史标题');
    const original = cases.addMaterial(orgId, userId, current.id, { type: 'evidence', source: 'manual', title: '当事人原始陈述', content: '待核实陈述。' })!;
    const draft = cases.addMaterial(orgId, userId, current.id, { type: 'pleading', source: 'tool', title: '旧待核准稿', content: '尚未核准。' })!;
    const before = cases.getCase(orgId, current.id, userId)!;
    cases.recordMaterialReview(orgId, userId, current.id, draft.id, { decision: 'confirmed', expectedRevision: cases.getMaterialReview(orgId, userId, current.id, draft.id)!.revision });
    cases.addMaterial(orgId, userId, current.id, { type: 'pleading', source: 'tool', title: '另一份待核准稿', content: '新生成内容不得当原始证据。' });
    const generated = cases.getCase(orgId, current.id, userId)!;
    expect(legalCaseSourceFingerprint(generated)).toBe(legalCaseSourceFingerprint(before));
    expect(cases.getMaterialReview(orgId, userId, current.id, draft.id)?.status).toBe('confirmed');
    expect(legalCaseSourceFingerprint({ ...before, notes: '用户摘要。' })).toBe(legalCaseSourceFingerprint(before));
    const added = cases.addMaterial(orgId, userId, current.id, { type: 'evidence', source: 'manual', title: '新增原件', content: '新原文确实改变依据。' })!;
    const after = cases.getCase(orgId, current.id, userId)!;
    expect(after.materials.map(material => material.id)).toEqual(expect.arrayContaining([original.id, added.id, draft.id]));
    expect(legalCaseSourceFingerprint(after)).not.toBe(legalCaseSourceFingerprint(generated));
    expect(cases.getMaterialReview(orgId, userId, current.id, draft.id)?.status).toBe('stale');
  });
});
