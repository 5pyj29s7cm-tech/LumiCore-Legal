import { makeApp, JWT_SECRET } from './helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { issueDesktopSessionProof, DESKTOP_SESSION_HEADER } from '../server/config/desktop_bootstrap';
import * as cases from '../server/org/legal_cases';
import { createOrg, addMember, listAuditLog } from '../server/org/db';
import { setOrganizationResourcePolicy } from '../server/org/resource_acl';
let url: string; let cleanup: () => void;
const identity = { schemaVersion: 1 as const, clientKind: 'local_acceptance_harness' as const, pid: process.pid,
  startedAtUnixMs: Date.now() - 1000, executablePath: process.execPath, executableSha256: 'd'.repeat(64),
  binaryHashUnavailable: false, buildId: 'c'.repeat(40), buildIdSemantics: 'baseline_commit' as const,
  sourceFingerprint: 'e'.repeat(64), sourceDirty: false, appVersion: '3.1.0' };
const owner = 'review-route-owner', other = 'review-route-other', viewer = 'review-route-viewer';
function headers(uid = owner, orgId = '', proofUid = uid): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt.sign({ uid, username: uid, role: 'user', ...(orgId ? { orgId } : {}) }, JWT_SECRET),
    [DESKTOP_SESSION_HEADER]: issueDesktopSessionProof(proofUid, identity).proof };
}
function fixture(orgId = cases.legalWorkspaceNamespace(owner)) {
  const c = cases.createCase(orgId, owner, { title: 'Synthetic review route', factDate: '2026-09-01' });
  const m = cases.addMaterial(orgId, owner, c.id, { type: 'pleading', title: 'Synthetic draft', source: 'tool', content: 'Original full draft with a tail marker.' })!;
  return { c, m, endpoint: () => url + '/api/legal/cases/' + c.id + '/materials/' + m.id + '/review' };
}
beforeAll(async () => { const app = await makeApp(); url = app.url; cleanup = app.cleanup;
  const noModel = () => null; mountChatRoutes(app.apiRouter, JWT_SECRET, { getDeepSeek: noModel, getGemini: noModel, getOpenAI: noModel, getAnthropic: noModel, getQwen: noModel }); });
afterAll(() => cleanup());
describe('native human material review route', () => {
  it('denies anonymous and bearer-only writes without native proof', async () => {
    const f = fixture(); expect((await fetch(f.endpoint())).status).toBe(401);
    const h = headers(); delete h[DESKTOP_SESSION_HEADER];
    expect((await fetch(f.endpoint(), { method: 'POST', headers: h, body: JSON.stringify({ decision: 'confirmed', expectedRevision: 'a'.repeat(64) }) })).status).toBe(403);
    expect(cases.getMaterialReview(f.c.orgId, owner, f.c.id, f.m.id)?.status).toBe('pending');
  });
  it('requires native proof to match authenticated identity', async () => {
    const f = fixture(); expect((await fetch(f.endpoint(), { headers: headers(owner, '', other) })).status).toBe(403);
  });
  it('records the authenticated actor and ignores forged signatory or scope fields', async () => {
    const f = fixture(), h = headers(); const current = await (await fetch(f.endpoint(), { headers: h })).json();
    expect(current).toMatchObject({ status: 'pending', content: f.m.content });
    const response = await fetch(f.endpoint(), { method: 'POST', headers: h, body: JSON.stringify({ decision: 'confirmed', expectedRevision: current.revision, userId: other, orgId: 'forged', lawyerApproved: true }) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'confirmed', reviewerId: owner, scope: 'archived_text' });
    const revoke = await fetch(f.endpoint(), { method: 'POST', headers: h, body: JSON.stringify({ decision: 'revoked', expectedRevision: current.revision }) });
    expect(revoke.status).toBe(200); expect(await revoke.json()).toMatchObject({ status: 'revoked', reviewerId: owner });
    expect(listAuditLog(f.c.orgId, null).filter(e => e.action === 'legal_case.material.review' && e.resourceId === f.c.id).map(e => e.userId)).toEqual([owner, owner]);
  });
  it('rejects changed versions without recording a new review event', async () => {
    const f = fixture(), h = headers(); const current = await (await fetch(f.endpoint(), { headers: h })).json();
    cases.updateCase(f.c.orgId, owner, f.c.id, { hearingDate: '2026-10-21' });
    const response = await fetch(f.endpoint(), { method: 'POST', headers: h, body: JSON.stringify({ decision: 'confirmed', expectedRevision: current.revision }) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'LEGAL_MATERIAL_REVISION_CHANGED' });
    expect(cases.getMaterialReview(f.c.orgId, owner, f.c.id, f.m.id)?.status).toBe('pending');
  });
  it('rejects a different personal domain and a material from a different case', async () => {
    const f = fixture(), g = fixture(); expect((await fetch(f.endpoint(), { headers: headers(other) })).status).toBe(404);
    expect((await fetch(url + '/api/legal/cases/' + g.c.id + '/materials/' + f.m.id + '/review', { headers: headers() })).status).toBe(404);
  });
  it('denies organization viewers even where a case has no resource policy', async () => {
    const org = createOrg('Synthetic review', 'review-route-viewer-org', owner); addMember(org.id, owner, 'owner'); addMember(org.id, viewer, 'viewer');
    const f = fixture(org.id), revision = cases.getMaterialReview(org.id, owner, f.c.id, f.m.id)!.revision;
    const response = await fetch(f.endpoint(), { method: 'POST', headers: headers(viewer, org.id), body: JSON.stringify({ decision: 'confirmed', expectedRevision: revision }) });
    expect(response.status).toBe(403); expect(cases.getMaterialReview(org.id, owner, f.c.id, f.m.id)?.status).toBe('pending');
  });
  it('enforces organization case resource grants for read and write', async () => {
    const org = createOrg('Synthetic restricted review', 'review-route-restricted-org', owner); addMember(org.id, owner, 'owner'); addMember(org.id, other, 'member');
    const f = fixture(org.id); setOrganizationResourcePolicy({ orgId: org.id, actorUserId: owner, resourceType: 'legal_case', resourceId: f.c.id, ownerUserId: owner, classification: 'restricted', grants: [] });
    for (const method of ['GET', 'POST']) expect((await fetch(f.endpoint(), { method, headers: headers(other, org.id), ...(method === 'POST' ? { body: JSON.stringify({ decision: 'confirmed', expectedRevision: 'a'.repeat(64) }) } : {}) })).status).toBeGreaterThanOrEqual(400);
    expect(cases.getMaterialReview(org.id, owner, f.c.id, f.m.id)?.status).toBe('pending');
  });
  it('does not expose human review as a model tool', async () => {
    const response = await fetch(url + '/api/legal/tool/legal_confirm_material_review', { method: 'POST', headers: headers(), body: JSON.stringify({ lawyerApproved: true }) });
    expect(response.status).toBe(404);
  });
});
