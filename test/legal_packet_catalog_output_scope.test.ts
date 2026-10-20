import './helpers';
import { initDatabase } from '../db_layer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sdkCompletion } from './legal_bid_fixture';
import { packetDraftFixture } from './legal_packet_fixture';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import * as cases from '../server/org/legal_cases';
import { getDataDirectory } from '../server/config/data_path';
import { getUserPreferredLLMConfig, upsertUserPreferredLLM } from '../server/llm/user_preferences';
const captured = vi.hoisted(() => ({ scopes: [] as Array<string | null> }));
vi.mock('../server/regions/packs/cn/legal_document_progress', async original => {
  const actual = await original<typeof import('../server/regions/packs/cn/legal_document_progress')>();
  return { ...actual, legalDocumentProgress: (...args: Parameters<typeof actual.legalDocumentProgress>) => { captured.scopes.push(args[0]); return actual.legalDocumentProgress(...args); } };
});
beforeAll(async () => { await initDatabase(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); captured.scopes = []; });
const roles = [
  { role: 'plaintiff', catalog: '16_evidence-catalog', targets: ['10_civil-complaint', '16_evidence-catalog'] },
  { role: 'defendant', catalog: '27_evidence-catalog', targets: ['20_statement-of-defense', '21_cross-examination-opinion', '23_argument-outline', '27_evidence-catalog'] },
] as const;
async function setup(role: typeof roles[number], failure: 'draft' | 'review' | null = null, delay = 0) {
  const fetchSpy = vi.fn(() => { throw Error('No network/model/API allowed in offline SDK fixture.'); });
  vi.stubGlobal('fetch', fetchSpy);
  const userId = 'catalog-output-scope-' + crypto.randomUUID(), orgId = cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'pinned' });
  const c = cases.createCase(orgId, userId, { title: 'Synthetic catalog scope', party: 'Synthetic A / Synthetic B', clientRole: role.role, objective: 'Only supplied contract performance; no additional remedy.' });
  cases.addMaterial(orgId, userId, c.id, { source: 'import', type: 'contract', title: 'Synthetic contract text', content: 'Excerpt total800000; delivery30days after payment. Original, payment trigger, full terms and actual dates remain unverified.' });
  cases.addMaterial(orgId, userId, c.id, { source: 'import', type: 'evidence', title: 'Synthetic payment text', content: 'A alleges200000 paid. Payment success, recipient and contract allocation remain unverified;600000 is only arithmetic, not debt or a remedy.' });
  const originals = JSON.stringify(cases.getCase(orgId, c.id, userId)!.materials), preferences = getUserPreferredLLMConfig(userId);
  const outputDir = getDataDirectory(path.join('catalog-output-scope', c.id));
  const events: Array<{ phase: string; baseName: string; prompt: string; request: any; signal: AbortSignal }> = [];
  const create = vi.fn((request: any, options: any) => {
    const prompt = String(request.messages.find((message: any) => message.role === 'user')?.content || '');
    const drafting = prompt.includes('## 当前文书\n');
    let body: any;
    if (drafting) {
      const target = JSON.parse(prompt.split('## 当前文书\n')[1]);
      events.push({ phase: 'draft', baseName: target.baseName, prompt, request, signal: options.signal });
      if (target.baseName === role.catalog) {
        const rows = JSON.parse(prompt.split('材料原句与固定编目（待核验，不是已证事实）：\n')[1].split('\n')[0]);
        body = { baseName: target.baseName, complete: failure !== 'draft', entries: rows.map((row: any) => ({
          sectionId: row.sectionId, sourceIds: row.sources.map((source: any) => source.id),
          response: 'PURPOSE-' + row.sectionId + ': proposed support only for the supplied material statement; payment, allocation, trigger and actual dates remain unverified. No lateness or legal qualification is established.',
          missing: 'The original material, actual time and relationship to this case remain to be verified.',
        })) };
      } else body = packetDraftFixture(prompt, { baseName: target.baseName, markdown: '# Conditional work analysis\nOnly the supplied fictional original performance remedy is analyzed. Source authenticity, payment, allocation, delivery trigger and actual dates remain unverified; no new admission, debt or signing authority is established.' });
    } else {
      const documents = JSON.parse(prompt.split('文书列表：')[1]);
      const name = documents[0].baseName.split('/')[0];
      events.push({ phase: 'review', baseName: name, prompt, request, signal: options.signal });
      body = { documents: documents.map((document: any) => ({ baseName: document.baseName, complete: !(name === role.catalog && failure === 'review'), corrections: [], unresolved: name === role.catalog && failure === 'review' ? ['Proposed purpose remains unresolved.'] : [] })) };
    }
    return sdkCompletion(request, { choices: [{ message: { content: JSON.stringify(body) }, finish_reason: 'stop' }] }, delay, options.signal);
  });
  const registry = new ToolRegistry(); registerLegalTools(registry);
  const args = { caseId: c.id, caseName: c.title, role: role.role, parties: c.party, claims: c.objective, outputDir, includeDocx: false, persistCase: true };
  const context = { userId, source: 'legal-direct-tool', domain: 'personal' as const, authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local' as const,
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
  const run = (extraContext = {}) => registry.execute('legal_generate_litigation_packet', args, { ...context, requestId: crypto.randomUUID(), ...extraContext }).then(decodeToolResult);
  const originalsUnchanged = () => JSON.stringify(cases.getCase(orgId, c.id, userId)!.materials.filter(material => material.source !== 'tool')) === originals;
  return { c, userId, orgId, outputDir, originals, preferences, create, events, fetchSpy, run, originalsUnchanged };
}
describe.each(roles)('catalog output scope for $role', role => {
  it('requests only proposed purpose and corresponding unknowns through actual SDK while retaining source compilation, phases, recipe and archive', async () => {
    const f = await setup(role), result = await f.run();
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated', persisted: true, draftMode: 'model' });
    const catalogRequest = f.events.find(event => event.phase === 'draft' && event.baseName === role.catalog)!;
    const outputRules = catalogRequest.prompt.split('## 输出要求\n')[1].split('\n## 当前文书\n')[0];
    expect(outputRules).not.toContain('证据目录必须逐项包含真实性、合法性、关联性、证明目的、补强缺口和质证风险');
    expect(outputRules).not.toContain('分析该材料的拟议证明目的、三性与质证风险');
    expect(outputRules).toContain('仅填写拟议证明目的与对应待核前提');
    expect(outputRules).toContain('不重写编号、名称、来源、原句或页码');
    expect(outputRules).toContain('未知不能写成肯定或否定事实');
    expect(outputRules).toContain('确定性法律或证据资格判断须有本次提供的法律来源支持');
    for (const name of role.targets) for (const phase of ['draft', 'review']) expect(f.events.filter(event => event.baseName === name && event.phase === phase)).toHaveLength(1);
    expect(f.create).toHaveBeenCalledTimes(role.targets.length * 2);
    for (const { request } of f.events) expect(request).toMatchObject({ max_tokens: 16384, reasoning_effort: 'low', stream: true, response_format: { type: 'json_object' } });
    const after = cases.getCase(f.orgId, f.c.id, f.userId)!;
    const originalRecords = after.materials.filter(material => material.source !== 'tool');
    const matrix = fs.readFileSync(path.join(f.outputDir, '03_evidence-review-matrix.md'), 'utf8');
    const catalog = fs.readFileSync(path.join(f.outputDir, role.catalog + '.md'), 'utf8');
    for (const material of originalRecords) {
      expect(catalogRequest.prompt).toContain(material.content);
      expect(matrix).toContain(material.content);
      expect(catalog).toContain(material.id);
      expect(catalog).toContain(material.title);
    }
    expect(matrix).toContain('未核验；核对取得方式、授权来源、隐私与平台规则');
    expect(catalog).toContain('该行位不是外部原件页码');
    expect(catalog).toContain('PURPOSE-M1');
    expect(catalog).toContain('payment, allocation, trigger and actual dates remain unverified');
    if (role.role === 'defendant') expect(fs.readFileSync(path.join(f.outputDir, '21_cross-examination-opinion.md'), 'utf8')).toContain('Conditional work analysis');
    expect(f.originalsUnchanged()).toBe(true);
    expect(after.materials.filter(material => material.source === 'tool')).toHaveLength(1);
    expect(captured.scopes).toHaveLength(1);
    const recipe = JSON.parse(captured.scopes[0]!).recipe;
    expect(catalogRequest.prompt).toContain(recipe.prompt);
    expect(recipe.prompt).toContain('仅填写拟议证明目的与对应待核前提');
    expect(recipe.reviewReasoningEffort).toBe('low');
    expect(getUserPreferredLLMConfig(f.userId)).toEqual(f.preferences);
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
  it.each(['draft', 'review'] as const)('retains partial and no archive when catalog %s is not complete', async failure => {
    const f = await setup(role, failure), result = await f.run();
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false, draftMode: 'mixed' });
    expect((result.receipt as { draftFailures: unknown[] }).draftFailures).toEqual(expect.arrayContaining([expect.objectContaining({ baseName: role.catalog })]));
    expect(f.events.filter(event => event.phase === 'draft' && event.baseName === role.catalog)).toHaveLength(1);
    expect(f.events.filter(event => event.phase === 'review' && event.baseName === role.catalog)).toHaveLength(failure === 'review' ? 1 : 0);
    expect(f.create).toHaveBeenCalledTimes(role.targets.length * 2 - (failure === 'draft' ? 1 : 0));
    expect(f.originalsUnchanged()).toBe(true);
    expect(cases.getCase(f.orgId, f.c.id, f.userId)!.materials.filter(material => material.source === 'tool')).toHaveLength(0);
    expect(fs.readFileSync(path.join(f.outputDir, '99_manifest.md'), 'utf8').split('\n').find(line => line.includes(role.catalog + '.md'))).toContain('正文未完成');
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
  it('honors parent cancellation during actual SDK work without review, completed files or archive', async () => {
    const f = await setup(role, null, 1000); vi.useFakeTimers();
    const owner = new AbortController(), pending = f.run({ executionSignal: owner.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.events.filter(event => event.phase === 'draft')).toHaveLength(2);
    owner.abort(new DOMException('Synthetic operator cancelled', 'AbortError'));
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeInstanceOf(Error);
    expect(f.events.filter(event => event.phase === 'review')).toHaveLength(0);
    expect(f.events.every(event => event.signal.aborted)).toBe(true);
    expect(f.originalsUnchanged()).toBe(true);
    expect(cases.getCase(f.orgId, f.c.id, f.userId)!.materials.filter(material => material.source === 'tool')).toHaveLength(0);
    expect(fs.existsSync(path.join(f.outputDir, '99_manifest.md'))).toBe(false);
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
});
