import { sdkCompletion } from './legal_bid_fixture';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { buildMaterialSources, resolveSourceDraftEntries, resolveMaterialOutline, resolveReasoningEntries } from '../server/regions/packs/cn/legal_reasoning_generation';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
let app: Awaited<ReturnType<typeof makeApp>>, folder: string;
beforeAll(async () => { app = await makeApp(); folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-failure-stages-')); });
afterAll(() => { fs.rmSync(folder, { recursive: true, force: true }); app.cleanup(); });
afterEach(() => vi.restoreAllMocks());
const proposal = 'This synthetic proposal uses only supplied originals; missing supporting documents, dates, conditions and approvals remain subject to confirmation.';
const privateDetail = 'PRIVATE_PROVIDER_OR_MODEL_DETAIL_MUST_NOT_LEAK';
type Mode = 'pass' | 'request' | 'empty' | 'length';
function fixture(count: number, mode: Mode = 'pass') {
  const userId = 'bid-stage-' + crypto.randomUUID(), orgId = cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-stage-model', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
  const item = cases.createCase(orgId, userId, { title: 'Synthetic bid stage case' });
  const original = Array.from({ length: count }, (_, index) => (index === 0 ? 'R01：' : '材料原句 ') + 'Supplied original ' + (index + 1) + ' retained; unknown matters require confirmation.').join('\n');
  const file = path.join(folder, crypto.randomUUID() + '.txt'); fs.writeFileSync(file, original);
  const plan = { mode }; const events: string[] = [];
  const create = vi.fn(async (params: any) => {
    if (plan.mode === 'request') throw new Error(privateDetail);
    const content = plan.mode === 'empty' ? null : proposal;
    events.push('generate');
    return sdkCompletion(params, { choices: [{ message: { content }, finish_reason: plan.mode === 'length' ? 'length' : 'stop' }] });
  });
  const registry = new ToolRegistry(); registerLegalTools(registry);
  const context: import('../server/tools/types').ToolContext = { userId, domain: 'personal', requestId: crypto.randomUUID(), authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local', llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
  const run = (extra = {}) => registry.execute('legal_generate_bid', { projectName: 'Synthetic-' + item.id, caseId: item.id, filePath: file, persistCase: true, ...extra }, { ...context, requestId: crypto.randomUUID() }).then(decodeToolResult);
  return { userId, orgId, item, original, file, create, events, plan, run };
}
describe('bid existing source projection and honest failure stages', () => {
  it.each([31, 164])('accepts all %i actual original lines through one normal Markdown generation', async count => {
    const f = fixture(count); const result = await f.run(); expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(f.create).toHaveBeenCalledTimes(1);
    expect(result.content).toContain('Supplied original ' + count + ' retained'); expect(cases.getCase(f.orgId, f.item.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(1);
  });
  it('still rejects unknown/empty references and wrong sections, and deduplicates real references without changing source bytes', () => {
    const sources = buildMaterialSources([{ id: 'supplied-original', title: 'Synthetic originals', content: Array.from({ length: 164 }, (_, i) => 'Actual original line ' + (i + 1)).join('\n') }]);
    const entry = { sectionId: 'section', sourceIds: sources.map(s => s.id), response: proposal, missing: '' };
    for (const invalid of [{ ...entry, sourceIds: [] }, { ...entry, sourceIds: ['invented'] }, { ...entry, sectionId: 'wrong' }]) expect(() => resolveSourceDraftEntries({ entries: [invalid] }, sources, ['section'])).toThrow();
    expect(() => resolveMaterialOutline({ entries: [{ issue: 'Synthetic issue', sourceIds: entry.sourceIds }] }, sources)).toThrow();
    expect(resolveReasoningEntries({ entries: [{ issue: 'Synthetic issue', ruleId: 'R1', sourceIds: entry.sourceIds, application: proposal, conclusion: proposal, limitations: proposal }] }, { sources, rules: [{ id: 'R1', citation: 'Synthetic test rule only', quote: 'Not a verified actual statute.' }] }).errors.length).toBeGreaterThan(0);
    const result = resolveSourceDraftEntries({ entries: [{ ...entry, sourceIds: [...entry.sourceIds, sources[0].id] }] }, sources, ['section']); expect(result[0].sources).toHaveLength(164); for (let index = 0; index < sources.length; index++) expect(result[0].sources[index]).toBe(sources[index]);
  });
  it.each([['request', '起草请求失败'], ['empty', '未取得标书正文'], ['length', '标书正文截断']] as const)('reports known %s control-flow stage without private details or fake archival', async (mode, expected) => {
    const f = fixture(31, mode); const result = await f.run(); expect(result.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(result.content).toContain(expected); expect(result.content).not.toContain(privateDetail); expect(cases.getCase(f.orgId, f.item.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
    expect(f.create).toHaveBeenCalledTimes(1); expect(result.content).toContain('Supplied original 31 retained');
  });
  it('rejects an output path outside the legal delivery root before model use or archive', async () => {
    const f = fixture(1); await expect(f.run({ outputDir: path.join(folder, 'outside-delivery-' + crypto.randomUUID()) })).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled(); expect(cases.getCase(f.orgId, f.item.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
  });
});
