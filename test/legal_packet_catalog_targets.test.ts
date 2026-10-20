import { packetDraftFixture } from './legal_packet_fixture';
import { makeApp } from './helpers';
import { sdkCompletion } from './legal_bid_fixture';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import * as cases from '../server/org/legal_cases';
import { upsertUserPreferredLLM, getUserPreferredLLMConfig } from '../server/llm/user_preferences';
import { getDataDirectory } from '../server/config/data_path';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
const roles = [
  { role: 'plaintiff', catalog: '16_evidence-catalog', targets: ['10_civil-complaint', '16_evidence-catalog'] },
  { role: 'defendant', catalog: '27_evidence-catalog', targets: ['20_statement-of-defense', '21_cross-examination-opinion', '23_argument-outline', '27_evidence-catalog'] },
] as const;
async function setup(role: typeof roles[number], failure: 'draft' | 'review' | null = null, invalid?: 'foreign' | 'cross-record' | 'duplicate') {
  const userId = 'catalog-target-' + crypto.randomUUID(), orgId = cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'pinned' });
  const c = cases.createCase(orgId, userId, { title: 'Synthetic conditional catalog case', party: 'Synthetic A / Synthetic B', clientRole: role.role });
  const contract = cases.addMaterial(orgId, userId, c.id, { source: 'import', type: 'contract', title: 'Synthetic contract excerpt', content: 'The excerpt records a total of 800000 and delivery30days after payment. Original, full terms and actual dates are unverified.' });
  const payment = cases.addMaterial(orgId, userId, c.id, { source: 'import', type: 'evidence', title: 'Synthetic payment statement', content: 'A alleges payment of200000. Success, recipient and allocation to this contract are unverified; the600000 arithmetic difference is not admitted debt or a claim.' });
  const originals = JSON.stringify(cases.getCase(orgId, c.id)!.materials);
  const sentinel = 'CATALOG-REVIEWED-' + c.id;
  const outputDir = getDataDirectory(path.join('catalog-target-output', c.id));
  const events: Array<{ phase: 'draft' | 'review'; baseName: string }> = [];
  const create = vi.fn(async (request: any) => {
    const prompt = String(request.messages.find((m: any) => m.role === 'user')?.content || '');
    let content: string;
    if (prompt.includes('## 当前文书\n')) {
      const target = JSON.parse(prompt.split('## 当前文书\n')[1]);
      events.push({ phase: 'draft', baseName: target.baseName });
      const markdown = target.baseName === role.catalog
        ? '# CATALOG-UNREVIEWED-' + c.id + '\n\n| Source | Location | Proposed proof purpose | Limit |\n| --- | --- | --- | --- |\n| ' + contract.id + ' | supplied text line1 | Proposed contract terms, total800000 and delivery30days | Authenticity, full terms, conditions and dates unverified |\n| ' + payment.id + ' | supplied text line1 | Proposed support for A\'s alleged200000 payment | Success, recipient and contract allocation unverified; not established payment or debt |'
        : '# ' + target.label + '\n\nOnly a conditional substantive draft for the supplied fictional claim. Original evidence, payment allocation, delivery conditions and actual dates remain unverified. No signature, filing, additional remedy or admission is authorized.';
      const catalog = target.baseName === role.catalog;
      const rows = catalog ? JSON.parse(prompt.split('材料原句与固定编目（待核验，不是已证事实）：\n')[1].split('\n')[0]) : [];
      const entries = rows.map((row: any) => ({ sectionId: row.sectionId, sourceIds: row.sources.map((s: any) => s.id),
        materialId: 'MODEL-CANNOT-REPLACE-IDENTITY', name: 'MODEL-CANNOT-RENAME-SOURCE', locator: 'MODEL-CANNOT-INVENT-PAGE',
        response: '# CATALOG-UNREVIEWED-' + c.id + '\n\n' + (row.materialId === payment.id
          ? "Proposed support for A's alleged200000 payment; success, recipient and allocation unverified; not established payment or debt."
          : 'Proposed original contract terms and material statements; authenticity, full terms, conditions and dates remain unverified.'), missing: 'Original pages remain to be supplied.' }));
      if (catalog && invalid === 'foreign') entries[0].sourceIds = ['F99999'];
      if (catalog && invalid === 'cross-record') entries[0].sourceIds = entries[1].sourceIds;
      if (catalog && invalid === 'duplicate') entries[1].sectionId = entries[0].sectionId;
      content = catalog && failure === 'draft' ? '' : JSON.stringify(catalog ? { baseName: target.baseName, entries } : packetDraftFixture(prompt, { baseName: target.baseName, markdown }));
    } else {
      const documents = JSON.parse(prompt.split('文书列表：')[1]);
      for (const baseName of new Set<string>(documents.map((document: any) => document.baseName.split('/')[0]))) events.push({ phase: 'review', baseName });
      content = JSON.stringify({ documents: documents.map((d: any) => ({ baseName: d.baseName,
        complete: !(d.baseName.startsWith(role.catalog + '/') && failure === 'review'),
        corrections: d.baseName.startsWith(role.catalog + '/') && !failure ? [{ paragraphId: 'P1', replacement: '# ' + sentinel, reason: 'Mark the exact reviewed catalog; preserve all source identities and conditional proof purposes.' }] : [],
        unresolved: d.baseName.startsWith(role.catalog + '/') && failure === 'review' ? ['Catalog proof purposes still need source-bound correction.'] : [],
      })) });
    }
    return sdkCompletion(request, { choices: [{ message: { content }, finish_reason: 'stop' }] });
  });
  const registry = new ToolRegistry(); registerLegalTools(registry);
  const context = { userId, domain: 'personal' as const, authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local' as const,
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
  const args = { caseId: c.id, caseName: c.title, role: role.role, parties: c.party, claims: 'Only the supplied fictional contract remedy; no added damages, fee claim or admission.', facts: 'Only fictional conditional pleadings; payment, delivery, authority and dates remain unverified.', evidence: 'Use the two original source records, keeping alleged payment separate from established fact.', outputDir, persistCase: true };
  const preferencesBefore = getUserPreferredLLMConfig(userId);
  const run = (extra = {}) => registry.execute('legal_generate_litigation_packet', { ...args, ...extra }, { ...context, requestId: crypto.randomUUID() }).then(decodeToolResult);
  return { userId, orgId, c, contract, payment, originals, sentinel, outputDir, events, create, run, preferencesBefore };
}
describe.each(roles)('catalog generation and factual review for $role', role => {
  it.each(['draft', 'review'] as const)('does not mark or archive a complete packet when the required catalog %s is missing', async failure => {
    const f = await setup(role, failure);
    const result = await f.run({ includeDocx: false });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', draftMode: 'mixed', persisted: false });
    expect(result.receipt).toMatchObject({ draftFailures: expect.arrayContaining([expect.objectContaining({ baseName: role.catalog })]) });
    expect(f.events.filter(e => e.phase === 'draft' && e.baseName === role.catalog)).toHaveLength(1);
    expect(f.events.filter(e => e.phase === 'review' && e.baseName === role.catalog)).toHaveLength(failure === 'review' ? 1 : 0);
    expect(cases.getCase(f.orgId, f.c.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
    expect(JSON.stringify(cases.getCase(f.orgId, f.c.id)!.materials)).toBe(f.originals);
    const manifest = fs.readFileSync(path.join(f.outputDir, '99_manifest.md'), 'utf8');
    expect(manifest.split('\n').find(line => line.includes(role.catalog + '.md'))).toContain('正文未完成');
    expect(result.content).toContain('尚未完成的文书');
  });
  it('writes the actually reviewed catalog to Markdown and DOCX before archiving once', async () => {
    const f = await setup(role);
    const result = await f.run();
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated', draftMode: 'model', persisted: true });
    for (const name of role.targets) for (const phase of ['draft', 'review']) expect(f.events.filter(e => e.baseName === name && e.phase === phase)).toHaveLength(1);
    expect(f.create).toHaveBeenCalledTimes(role.targets.length * 2);
    const markdown = fs.readFileSync(path.join(f.outputDir, role.catalog + '.md'), 'utf8');
    expect(markdown).toContain(f.sentinel); expect(markdown).not.toContain('CATALOG-UNREVIEWED-');
    for (const id of [f.contract.id, f.payment.id]) expect(markdown).toContain(id);
    const matrix = fs.readFileSync(path.join(f.outputDir, '03_evidence-review-matrix.md'), 'utf8');
    for (const [index, material] of [f.payment, f.contract].entries()) {
      expect(markdown).toContain('| ' + (index + 1) + ' | ' + material.title + ' |');
      expect(matrix).toContain('### ' + (index + 1) + '. ' + material.title);
      expect(markdown).toContain('F' + (index + 1) + '：提供材料正文第1行');
      expect(matrix).toContain('F' + (index + 1) + '；提供材料正文第1行');
    }
    expect(markdown).toContain('该行位不是外部原件页码');
    expect(markdown.match(/外部原件页码：\[待逐份核对补录\]/g)).toHaveLength(3);
    expect(markdown).not.toMatch(/MODEL-CANNOT-/);
    const manifest = fs.readFileSync(path.join(f.outputDir, '99_manifest.md'), 'utf8');
    expect(manifest.split('\n').find(line => line.includes('02_authorization-checklist.md'))).toContain('空白表式');
    expect(markdown).toContain('Proposed support for A\'s alleged200000 payment');
    expect(markdown).toContain('not established payment or debt');
    expect(result.content).toContain(f.sentinel);
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(f.outputDir, role.catalog + '.docx')));
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain(f.sentinel); expect(xml).toContain(f.contract.id); expect(xml).toContain(f.payment.id);
    const after = cases.getCase(f.orgId, f.c.id)!;
    expect(after.materials.filter(m => m.source === 'tool')).toHaveLength(1);
    expect(JSON.stringify(after.materials.filter(m => m.source !== 'tool'))).toBe(f.originals);
    expect(getUserPreferredLLMConfig(f.userId)).toEqual(f.preferencesBefore);
  });
  it('returns the reviewed catalog inline without files or automatic archive when requested', async () => {
    const f = await setup(role);
    const result = await f.run({ writeFiles: false, persistCase: false });
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated', draftMode: 'model', persisted: false });
    expect(result.content).toContain(f.sentinel); expect(result.content).not.toContain('CATALOG-UNREVIEWED-');
    expect(result.content).toContain(f.contract.id); expect(result.content).toContain(f.payment.id);
    expect(result.content).toContain('not established payment or debt');
    for (const phase of ['draft', 'review']) expect(f.events.filter(e => e.baseName === role.catalog && e.phase === phase)).toHaveLength(1);
    expect(f.create).toHaveBeenCalledTimes(role.targets.length * 2);
    expect(fs.readdirSync(f.outputDir)).toEqual([]);
    expect(JSON.stringify(cases.getCase(f.orgId, f.c.id)!.materials)).toBe(f.originals);
  });
  it.each(['foreign', 'cross-record', 'duplicate'] as const)('rejects %s catalog source identities before review or archive', async invalid => {
    const f = await setup(role, null, invalid), result = await f.run({ includeDocx: false });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(f.events.filter(e => e.phase === 'draft' && e.baseName === role.catalog)).toHaveLength(1);
    expect(f.events.filter(e => e.phase === 'review' && e.baseName === role.catalog)).toHaveLength(0);
    expect(JSON.stringify(cases.getCase(f.orgId, f.c.id)!.materials)).toBe(f.originals);
  });

});
