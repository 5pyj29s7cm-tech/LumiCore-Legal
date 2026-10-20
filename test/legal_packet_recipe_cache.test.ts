import { packetDraftFixture } from './legal_packet_fixture';
import { sdkCompletion } from './legal_bid_fixture';
import { makeApp } from './helpers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import * as cases from '../server/org/legal_cases';
import { getUserPreferredLLMConfig, upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { legalDocumentProgress } from '../server/regions/packs/cn/legal_document_progress';
import { buildCaseContext, resolveLegalCaseArguments } from '../server/regions/packs/cn/legal_tools/context';
import { getDataDirectory } from '../server/config/data_path';
const recipe = vi.hoisted(() => ({ preference: {} as Record<string, unknown>, drafting: '', template: '', review: '', scopes: [] as Array<string | null> }));
vi.mock('../server/llm/user_preferences', async original => { const actual = await original<typeof import('../server/llm/user_preferences')>(); return { ...actual, getUserPreferredLLMConfig: (userId: string, options: any) => ({ ...actual.getUserPreferredLLMConfig(userId, options), ...recipe.preference }) }; });
vi.mock('../server/regions/packs/cn/legal_tools/context', async original => { const actual = await original<typeof import('../server/regions/packs/cn/legal_tools/context')>(); return { ...actual, get LEGAL_REASONING_BASELINE() { return actual.LEGAL_REASONING_BASELINE + recipe.drafting; } }; });
vi.mock('../server/regions/packs/cn/legal_tools/litigation_drafts', async original => { const actual = await original<typeof import('../server/regions/packs/cn/legal_tools/litigation_drafts')>(); return { ...actual, buildLitigationPacketDrafts: (...args: Parameters<typeof actual.buildLitigationPacketDrafts>) => actual.buildLitigationPacketDrafts(...args).map(document => /^(10_|11_|16_|20_|21_|23_|27_)/.test(document.baseName) ? { ...document, markdown: document.markdown + recipe.template } : document) }; });
vi.mock('../server/regions/packs/cn/legal_document_grounding', async original => { const actual = await original<typeof import('../server/regions/packs/cn/legal_document_grounding')>(); return { ...actual, legalDocumentBatchReviewPrompt: (...args: Parameters<typeof actual.legalDocumentBatchReviewPrompt>) => recipe.review + actual.legalDocumentBatchReviewPrompt(...args) }; });
vi.mock('../server/regions/packs/cn/legal_document_progress', async original => { const actual = await original<typeof import('../server/regions/packs/cn/legal_document_progress')>(); return { ...actual, legalDocumentProgress: (...args: Parameters<typeof actual.legalDocumentProgress>) => { recipe.scopes.push(args[0]); return actual.legalDocumentProgress(...args); } }; });
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
beforeEach(() => { recipe.preference = {}; recipe.drafting = ''; recipe.template = ''; recipe.review = ''; recipe.scopes = []; });
async function setup(withCorrections = false) {
  const userId = 'packet-recipe-' + crypto.randomUUID(), orgId = cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-recipe-model', selectionMode: 'pinned' });
  const c = cases.createCase(orgId, userId, { title: 'Synthetic recipe case', party: 'Synthetic A / Synthetic B', factDate: '2026-09-01' });
  const body = '# Synthetic conditional draft\nOriginal sources must be checked. Payment direction, due dates and evidence authenticity remain unverified. RECIPE-' + c.id;
  const create = vi.fn(async (request: any) => {
    const prompt = String(request.messages.find((m: any) => m.role === 'user')?.content || ''); let content: string;
    if (prompt.includes('## 当前文书')) { const target = JSON.parse(prompt.split('## 当前文书\n')[1]); content = JSON.stringify(packetDraftFixture(prompt, { baseName: target.baseName, markdown: body })); }
    else { const documents = JSON.parse(prompt.split('文书列表：')[1]); content = JSON.stringify({ documents: documents.map((d: any) => ({ baseName: d.baseName, complete: true, corrections: withCorrections && d.baseName.startsWith('10_civil-complaint/') ? [{ paragraphId: 'P1', replacement: '# Synthetic conditional draft', reason: 'Unchanged valid heading.' }, { paragraphId: 'P2', replacement: 'The supplied source remains an unverified statement; no adverse factual finding or additional request is adopted. REVISED-' + c.id, reason: 'Preserve the actual source boundary.' }] : [], unresolved: [] })) }); }
    return sdkCompletion(request, { choices: [{ message: { content }, finish_reason: 'stop' }] });
  });
  const registry = new ToolRegistry(); registerLegalTools(registry);
  const args = { caseId: c.id, caseName: c.title, role: '原告', parties: c.party, claims: 'Request only the original contract performance, subject to source verification.', facts: 'Synthetic source statement: payment allocation, delivery and due date require verification.', evidence: 'Synthetic contract copy and payment note; originals not yet verified.', includeDocx: false, outputDir: getDataDirectory(path.join('packet-recipe-output', c.id)), persistCase: true };
  const context = { userId, domain: 'personal' as const, authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local' as const, llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
  const run = (extra = {}) => registry.execute('legal_generate_litigation_packet', { ...args, ...extra }, { ...context, requestId: crypto.randomUUID() }).then(decodeToolResult);
  return { userId, orgId, c, body, create, args, context, run };
}
describe('existing packet progress uses the effective nonsecret generation recipe', () => {
  it('reuses the same full recipe without another SDK request', async () => {
    const f = await setup(); expect((await f.run()).receipt).toMatchObject({ ok: true }); expect(f.create).toHaveBeenCalledTimes(4);
    f.create.mockClear(); expect((await f.run()).receipt).toMatchObject({ ok: true }); expect(f.create).not.toHaveBeenCalled();
  });
  it.each(['selection', 'fallback', 'cloud-policy', 'tokens', 'draft-prompt', 'target-template', 'review-prompt', 'source'] as const)('does not reuse a reviewed packet after %s changes', async change => {
    const f = await setup(); expect((await f.run()).receipt).toMatchObject({ ok: true }); f.create.mockClear();
    if (change === 'selection') recipe.preference = { selectionMode: 'ordered_fallback' };
    if (change === 'fallback') recipe.preference = { fallbackCandidates: [{ provider: 'relay', model: 'another-synthetic-model' }] };
    if (change === 'cloud-policy') recipe.preference = { allowCloudFallback: false };
    if (change === 'tokens') recipe.preference = { maxTokens: 4096 };
    if (change === 'draft-prompt') recipe.drafting = '\nSYNTHETIC-DRAFT-INSTRUCTION-REVISION';
    if (change === 'target-template') recipe.template = '\nSYNTHETIC-TEMPLATE-REVISION';
    if (change === 'review-prompt') recipe.review = 'SYNTHETIC-REVIEW-INSTRUCTION-REVISION\n';
    expect((await f.run(change === 'source' ? { facts: f.args.facts + ' Additional supplied source sentence.' } : {})).receipt).toMatchObject({ ok: true });
    expect(f.create).toHaveBeenCalledTimes(4);
    for (const [request] of f.create.mock.calls) { expect(request.max_tokens).toBe(change === 'tokens' ? 4096 : 16384); expect(request).not.toHaveProperty('thinking'); expect(request).not.toHaveProperty('reasoning_effort'); }
  });
  it('leaves legacy provider/model-only checkpoint bytes intact and starts the new recipe separately', async () => {
    const f = await setup(); const resolved = resolveLegalCaseArguments('legal_generate_litigation_packet', f.args, f.context);
    const preference = getUserPreferredLLMConfig(f.userId, { domain: f.context.domain });
    const scope = JSON.stringify({ orgId: f.orgId, userId: f.userId, caseId: f.c.id, caseContext: buildCaseContext(resolved), role: '原告', factDate: String(resolved.factDate || '').trim(), temporalReviews: resolved.temporalReviews, dataRoutingPolicy: undefined, authorities: String(resolved.legalAuthorities || '').trim(), provider: preference.provider, model: preference.model });
    const old = legalDocumentProgress(scope); old.save('11_element-complaint', f.body + '\nLEGACY-RECIPE-UNKNOWN', true);
    const file = path.join(getDataDirectory('legal_document_progress'), crypto.createHash('sha256').update('legal-document-review-v2\n' + scope).digest('hex') + '.json'); const before = fs.readFileSync(file);
    const result = await f.run(); expect(result.receipt).toMatchObject({ ok: true }); expect(f.create).toHaveBeenCalledTimes(4); expect(result.content).not.toContain('LEGACY-RECIPE-UNKNOWN'); expect(fs.readFileSync(file)).toEqual(before);
  });
  it('records the effective review profile and effective edits with same-target hashes in the existing checkpoint only', async () => {
    const f = await setup(true);
    expect((await f.run()).receipt).toMatchObject({ ok: true });
    expect(f.create).toHaveBeenCalledTimes(4);
    const scope = recipe.scopes[0]!;
    expect(JSON.parse(scope).recipe.reviewReasoningEffort).toBe('low');
    const cached = legalDocumentProgress(scope);
    const saved = cached.get('10_civil-complaint') as any;
    const draftRequest = f.create.mock.calls.map(([request]) => String(request.messages.find((m: any) => m.role === 'user')?.content || '')).find(prompt => prompt.includes('## 当前文书\n') && JSON.parse(prompt.split('## 当前文书\n')[1]).baseName === '10_civil-complaint')!;
    const sections = JSON.parse(draftRequest.split('## 当前文书\n')[1]).sections;
    const entries = JSON.parse(saved.markdown).entries;
    expect(saved.reviewSummary).toMatchObject({ proposedCorrections: sections.length * 2, appliedCorrections: sections.length, hashScope: 'review-documents-v1' });
    const before = JSON.stringify(sections.map((section: any) => ({ baseName: '10_civil-complaint/' + section.id, markdown: f.body })));
    const after = JSON.stringify(entries.map((entry: any) => ({ baseName: '10_civil-complaint/' + entry.sectionId, markdown: entry.response })));
    expect(saved.reviewSummary.beforeSha256).toBe(crypto.createHash('sha256').update(before).digest('hex'));
    expect(saved.reviewSummary.afterSha256).toBe(crypto.createHash('sha256').update(after).digest('hex'));
    expect(cached.get('11_element-complaint')).toBeUndefined();
    for (const name of ['16_evidence-catalog']) {
      const summary = (cached.get(name) as any).reviewSummary;
      expect(summary).toMatchObject({ proposedCorrections: 0, appliedCorrections: 0 });
      expect(summary.beforeSha256).toBe(summary.afterSha256);
    }
    const file = path.join(getDataDirectory('legal_document_progress'), crypto.createHash('sha256').update('legal-document-review-v2\n' + scope).digest('hex') + '.json');
    const persisted = fs.readFileSync(file, 'utf8');
    expect(persisted).not.toContain('文书列表：');
    expect(persisted).not.toContain('核对文书草稿');
    expect(Object.keys(JSON.parse(persisted))).toEqual(['fingerprint', 'updatedAt', 'documents']);
  });
  it('opens a new review-profile cache key without touching prior bytes or invoking any SDK by itself', async () => {
    const f = await setup();
    const scope = { fixture: f.c.id, recipe: { draft: 'same draft', review: 'same review', reviewReasoningEffort: 'low' } };
    const oldScope = JSON.stringify(scope);
    legalDocumentProgress(oldScope).save('10_civil-complaint', f.body, true);
    const file = path.join(getDataDirectory('legal_document_progress'), crypto.createHash('sha256').update('legal-document-review-v2\n' + oldScope).digest('hex') + '.json');
    const before = fs.readFileSync(file);
    const nextScope = JSON.stringify({ ...scope, recipe: { ...scope.recipe, reviewReasoningEffort: 'provider_default' } });
    expect(nextScope).not.toBe(oldScope);
    expect(legalDocumentProgress(nextScope).get('10_civil-complaint')).toBeUndefined();
    expect(fs.readFileSync(file)).toEqual(before);
    expect(f.create).not.toHaveBeenCalled();
    expect(legalDocumentProgress(oldScope).get('10_civil-complaint')?.markdown).toBe(f.body);
  });
});
