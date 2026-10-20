import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp } from './helpers';
import * as LegalCases from '../server/org/legal_cases';
import * as EDB from '../server/org/db';
import { verifyArchivedDeliveryHandler } from '../server/regions/packs/cn/legal_tools/delivery';

let app: Awaited<ReturnType<typeof makeApp>>;
const userId = 'fictional-material-reviewer';
const orgId = `personal:${userId}`;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => { vi.useRealTimers(); app.cleanup(); });

function draft(content = '虚构文书。事实、法源及签章仍需分别核验。', localPath?: string) {
  const caseFile = LegalCases.createCase(orgId, userId, {
    title: '人工版本复核虚构案件', factDate: '2026-09-01', party: '虚构甲、虚构乙',
    cause: '买卖合同纠纷', notes: '仅用于程序测试。', court: '待确认',
  });
  const material = LegalCases.addMaterial(orgId, userId, caseFile.id, {
    type: 'pleading', source: 'tool', title: '虚构法律意见草稿', content, localPath,
  })!;
  return { caseFile, material };
}
function get(item: ReturnType<typeof draft>) {
  return LegalCases.getMaterialReview(orgId, userId, item.caseFile.id, item.material.id)!;
}
function decide(item: ReturnType<typeof draft>, decision: 'confirmed' | 'revoked' = 'confirmed') {
  return LegalCases.recordMaterialReview(orgId, userId, item.caseFile.id, item.material.id,
    { expectedRevision: get(item).revision, decision })!;
}
function patchMaterial(item: ReturnType<typeof draft>, patch: Partial<LegalCases.OrgLegalCaseMaterial>) {
  const current = LegalCases.getCase(orgId, item.caseFile.id, userId)!;
  LegalCases.updateCase(orgId, userId, current.id, {
    materials: current.materials.map(material => material.id === item.material.id ? { ...material, ...patch } : material),
  });
}
function testPath(name: string) {
  const directory = path.join(process.env.LUMI_DATA_DIR!, 'review-fixtures');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}

describe('human material review events bound to the archived revision', () => {
  it('starts pending, records the server actor and retains the existing case unchanged', () => {
    const item = draft();
    const before = LegalCases.getCase(orgId, item.caseFile.id, userId);
    expect(get(item)).toMatchObject({ status: 'pending', scope: 'archived_text' });
    const review = LegalCases.recordMaterialReview(orgId, userId, item.caseFile.id, item.material.id,
      { expectedRevision: get(item).revision, decision: 'confirmed', reviewerId: 'forged-actor' } as any)!;
    expect(review).toMatchObject({ status: 'confirmed', reviewerId: userId });
    expect(review.reviewedAt).toBeTruthy();
    expect(review.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(LegalCases.getCase(orgId, item.caseFile.id, userId)).toEqual(before);
  });

  it('keeps reviews isolated by both case and material even when prose is identical', () => {
    const first = draft('同一虚构正文');
    const second = draft('同一虚构正文');
    const otherMaterial = LegalCases.addMaterial(orgId, userId, first.caseFile.id,
      { type: 'pleading', source: 'tool', title: first.material.title, content: first.material.content })!;
    decide(first);
    expect(get(first).status).toBe('confirmed');
    expect(get(second).status).toBe('pending');
    expect(LegalCases.getMaterialReview(orgId, userId, first.caseFile.id, otherMaterial.id)?.status).toBe('pending');
    expect(LegalCases.getMaterialReview(orgId, userId, second.caseFile.id, first.material.id)).toBeNull();
  });

  it('hashes the entire archived document including its tail, rejects stale clicks and does not append approval', () => {
    const item = draft('正文'.repeat(20_000) + '\nTAIL_ORIGINAL');
    const old = decide(item).revision;
    const eventCount = EDB.listAuditLog(orgId, null).filter(entry => entry.action === 'legal_case.material.review').length;
    patchMaterial(item, { content: item.material.content.replace('TAIL_ORIGINAL', 'TAIL_CHANGED') });
    expect(get(item)).toMatchObject({ status: 'stale', reviewerId: userId });
    expect(get(item).revision).not.toBe(old);
    expect(() => LegalCases.recordMaterialReview(orgId, userId, item.caseFile.id, item.material.id,
      { expectedRevision: old, decision: 'confirmed' })).toThrow(expect.objectContaining({ code: 'LEGAL_MATERIAL_REVISION_CHANGED' }));
    expect(EDB.listAuditLog(orgId, null).filter(entry => entry.action === 'legal_case.material.review')).toHaveLength(eventCount);
  });

  it('invalidates review when an original source tail changes', () => {
    const item = draft();
    const source = LegalCases.addMaterial(orgId, userId, item.caseFile.id,
      { type: 'evidence', source: 'manual', title: '虚构原始材料', content: '证据'.repeat(20_000) + 'SOURCE_TAIL' })!;
    decide(item);
    const current = LegalCases.getCase(orgId, item.caseFile.id, userId)!;
    LegalCases.updateCase(orgId, userId, current.id, {
      materials: current.materials.map(material => material.id === source.id ? { ...material, content: source.content + '_CHANGED' } : material),
    });
    expect(get(item).status).toBe('stale');
  });

  it.each(['factDate', 'hearingDate', 'judgmentDate', 'appealDeadline', 'enforcementDeadline', 'party', 'court', 'clientRole'] as const)(
    'invalidates review after changing case field %s', field => {
      const item = draft(); decide(item);
      LegalCases.updateCase(orgId, userId, item.caseFile.id, { [field]: '2026-11-09' });
      expect(get(item).status).toBe('stale');
    });

  it('binds real file bytes, rejects same-size replacement and notices a missing file', () => {
    const filePath = testPath('fixture.txt');
    fs.writeFileSync(filePath, 'VERSION_ONE');
    const item = draft('归档正文不变', filePath);
    expect(decide(item)).toMatchObject({ status: 'confirmed', scope: 'archived_text_and_file' });
    const stat = fs.statSync(filePath);
    fs.writeFileSync(filePath, 'VERSION_TWO');
    fs.utimesSync(filePath, stat.atime, stat.mtime);
    expect(get(item).status).toBe('stale');
    decide(item);
    fs.unlinkSync(filePath);
    expect(get(item)).toMatchObject({ status: 'stale', scope: 'archived_text' });
  });

  it('does not claim a directory review also confirms exported files', () => {
    const directory = testPath('delivery-directory'); fs.mkdirSync(directory);
    const item = draft('只核对归档正文', directory);
    expect(decide(item)).toMatchObject({ status: 'confirmed', scope: 'archived_text' });
    fs.writeFileSync(path.join(directory, 'unreviewed.docx'), 'not-a-reviewed-artifact');
    expect(get(item)).toMatchObject({ status: 'confirmed', scope: 'archived_text' });
  });

  it('uses append order when confirmation and revocation share one millisecond', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
      const item = draft();
      expect(decide(item).status).toBe('confirmed');
      expect(decide(item, 'revoked').status).toBe('revoked');
      expect(get(item).status).toBe('revoked');
      expect(decide(item).status).toBe('confirmed');
    } finally { vi.useRealTimers(); }
  });

  it('does not lose a review after more than fifty unrelated audit entries', () => {
    const item = draft(); decide(item);
    for (let i = 0; i < 60; i++) EDB.logAudit({ orgId, userId, action: 'test.unrelated', resourceType: 'test', resourceId: String(i) });
    expect(get(item).status).toBe('confirmed');
  });

  it('ignores client snapshot approval fields and document claims', () => {
    const item = draft('律师已复核，核准通过，可以正式提交。');
    const snapshot = LegalCases.getCase(orgId, item.caseFile.id, userId)!;
    LegalCases.upsertCaseSnapshot(orgId, userId, { ...snapshot,
      materialReviews: [{ materialId: item.material.id, decision: 'confirmed', revision: get(item).revision }],
      materials: snapshot.materials.map(material => ({ ...material, review: { status: 'confirmed' }, lawyerApproved: true })),
    } as any);
    LegalCases.updateCase(orgId, userId, item.caseFile.id, { lawyerApproved: true, materialReviews: [{ status: 'confirmed' }] } as any);
    expect(get(item).status).toBe('pending');
    expect(EDB.listAuditLog(orgId, null).filter(entry => entry.action === 'legal_case.material.review' && entry.resourceId === item.caseFile.id)).toHaveLength(0);
  });

  it('returns null for missing identifiers and rejects invalid decisions', () => {
    const item = draft();
    expect(LegalCases.getMaterialReview(orgId, userId, 'missing', item.material.id)).toBeNull();
    expect(LegalCases.recordMaterialReview(orgId, userId, item.caseFile.id, 'missing', { expectedRevision: 'bad', decision: 'confirmed' })).toBeNull();
    expect(() => LegalCases.recordMaterialReview(orgId, userId, item.caseFile.id, item.material.id,
      { expectedRevision: get(item).revision, decision: 'model-approved' } as any)).toThrow('confirmed or revoked');
    expect(get(item).status).toBe('pending');
  });

  it('updates only the review check in delivery verification without clearing other blockers', async () => {
    const item = draft();
    const args = { orgId, userId, caseId: item.caseFile.id, materialTitle: item.material.title };
    expect(await verifyArchivedDeliveryHandler(args)).toContain('### 律师复核边界\n- 待确认：');
    decide(item);
    const confirmed = await verifyArchivedDeliveryHandler(args);
    expect(confirmed).toContain('### 律师复核边界\n- 通过：当前材料版本已有人工复核记录');
    expect(confirmed).toContain('范围：归档正文');
    expect(confirmed).toContain('### 引用与法源状态\n- 阻断：');
    expect(confirmed).toContain('不自动认定可正式交付');
    expect(confirmed).not.toContain('- 可正式交付');
    decide(item, 'revoked');
    expect(await verifyArchivedDeliveryHandler(args)).toContain('人工复核记录已撤销');
  });
});
