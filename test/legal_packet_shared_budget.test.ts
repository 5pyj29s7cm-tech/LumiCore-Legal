import { packetDraftFixture } from './legal_packet_fixture';
import { sdkCompletion } from './legal_bid_fixture';
import { makeApp } from './helpers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ToolRegistry } from '../server/tools/registry';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import * as cases from '../server/org/legal_cases';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
afterEach(() => vi.useRealTimers());
async function setup(delays: { ten?: number; catalog?: number; review?: number; failTen?: boolean; model?: string } = {}) {
  const userId = 'packet-clock-' + crypto.randomUUID(), orgId = cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId, { provider: 'relay', model: delays.model || 'synthetic-packet-clock-model', selectionMode: 'pinned' });
  const c = cases.createCase(orgId, userId, { title: 'Synthetic bounded packet', party: 'Synthetic A / Synthetic B', factDate: '2026-09-01' });
  const outputDir = getDataDirectory(path.join('packet-clock-output', c.id));
  const events: Array<{ kind: string; name: string; at: number; signal: AbortSignal }> = [];
  const plan = { ten: 1000, catalog: 1000, review: 1000, failTen: false, ...delays };
  const body = (name: string) => '# Synthetic draft ' + name + '\nOnly a conditional draft for fictional materials. Payment allocation, delivery and evidence authenticity remain unverified. CHECKPOINT-' + c.id;
  const create = vi.fn((request: any, options: any) => {
    const prompt = String(request.messages.find((m: any) => m.role === 'user')?.content || '');
    const draft = prompt.includes('## 当前文书');
    const documents = draft ? [JSON.parse(prompt.split('## 当前文书\n')[1])] : JSON.parse(prompt.split('文书列表：')[1]);
    const name = documents[0].baseName.split('/')[0];
    events.push({ kind: draft ? 'draft' : 'review', name, at: Date.now(), signal: options.signal });
    const content = draft ? plan.failTen && name === '10_civil-complaint' ? '' : JSON.stringify(packetDraftFixture(prompt, { baseName: name, markdown: body(name) }))
      : JSON.stringify({ documents: documents.map((d: any) => ({ baseName: d.baseName, complete: true, corrections: [], unresolved: [] })) });
    return sdkCompletion(request, { choices: [{ message: { content }, finish_reason: 'stop' }] },
      draft ? name === '10_civil-complaint' ? plan.ten : name === '16_evidence-catalog' ? plan.catalog : plan.ten : plan.review, options.signal);
  });
  const registry = new ToolRegistry(); registerLegalTools(registry);
  const args = { caseId: c.id, caseName: c.title, role: '原告', parties: c.party, claims: 'Request original contract performance only; no added damages or admission.', facts: 'Synthetic source: claimant alleges delivery, payment allocation and due date remain unverified.', evidence: 'Synthetic contract copy, payment description; originals not verified.', includeDocx: false, outputDir, persistCase: true };
  const context = { userId, domain: 'personal' as const, authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local' as const, llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } };
  const run = (extra = {}) => registry.execute('legal_generate_litigation_packet', args, { ...context, requestId: crypto.randomUUID(), ...extra }).then(decodeToolResult);
  const checkpoints = () => fs.readdirSync(getDataDirectory('legal_document_progress')).map(name => JSON.parse(fs.readFileSync(path.join(getDataDirectory('legal_document_progress'), name), 'utf8'))).filter(saved => Object.values(saved.documents || {}).some((d: any) => d.markdown.includes(c.id)));
  return { c, orgId, userId, outputDir, create, events, plan, args, run, checkpoints };
}
describe('litigation packet shared drafting and review budget', () => {
  it('finishes the shared pleading analysis and catalog with two workers before archive; 11 derives without another model call', async () => {
    const f = await setup({ ten: 70_000, catalog: 70_000, review: 70_000 }); vi.useFakeTimers();
    let done = false; const start = Date.now(); const pending = f.run().then(result => { done = true; return result; });
    await vi.advanceTimersByTimeAsync(70_001);
    expect(f.events.map(event => event.kind)).toEqual(['draft', 'draft', 'review', 'review']);
    expect(f.create).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(done).toBe(false);
    expect(f.events.filter(event => event.kind === 'review').every(event => !event.signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(20_001); const result = await pending;
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated', draftMode: 'model' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(140_000);
    expect(f.create).toHaveBeenCalledTimes(4);
    expect(f.checkpoints()[0].documents['10_civil-complaint']).toMatchObject({ reviewed: true });
    expect(f.checkpoints()[0].documents).not.toHaveProperty('11_element-complaint');
    expect(f.checkpoints()[0].documents['16_evidence-catalog']).toMatchObject({ reviewed: true });
    expect(cases.getCase(f.orgId, f.c.id)!.materials.filter(material => material.source === 'tool')).toHaveLength(1);
  });
  it('accepts a 46-second draft under the existing 90-second phase limit instead of cancelling it at 45 seconds', async () => {
    const f = await setup({ ten: 46_000 }); vi.useFakeTimers();
    const pending = f.run(); await vi.advanceTimersByTimeAsync(45_001);
    expect(f.events.find(e => e.kind === 'draft' && e.name === '10_civil-complaint')!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_001); const result = await pending;
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated', draftMode: 'model' }); expect(f.create).toHaveBeenCalledTimes(4);
  });
  it('saves the fast reviewed draft while the other draft is still running', async () => {
    const f = await setup({ ten: 65_000, catalog: 1000, review: 1000 }); vi.useFakeTimers();
    const pending = f.run(); await vi.advanceTimersByTimeAsync(2_001);
    expect(f.events.filter(e => e.kind === 'review').map(e => e.name)).toEqual(['16_evidence-catalog']);
    expect(f.events.find(e => e.name === '10_civil-complaint')!.signal.aborted).toBe(false);
    expect(f.checkpoints()[0].documents['16_evidence-catalog']).toMatchObject({ reviewed: true });
    await vi.advanceTimersByTimeAsync(64_001); expect((await pending).receipt).toMatchObject({ ok: true, status: 'generated' });
  });
  it('resumes only the missing draft and retains the exact reviewed checkpoint without drafting or reviewing it again', async () => {
    const f = await setup({ failTen: true }); vi.useFakeTimers();
    const firstPending = f.run(); await vi.advanceTimersByTimeAsync(3_001); const first = await firstPending;
    expect(first.receipt).toMatchObject({ ok: false, status: 'partial', draftMode: 'mixed' });
    const reviewed = f.checkpoints()[0].documents['16_evidence-catalog']; expect(reviewed.reviewed).toBe(true);
    f.plan.failTen = false; const before = f.events.length; const secondPending = f.run(); await vi.advanceTimersByTimeAsync(3_001); const second = await secondPending;
    expect(second.receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(f.events.slice(before).map(e => [e.kind, e.name])).toEqual([['draft', '10_civil-complaint'], ['review', '10_civil-complaint']]);
    expect(f.checkpoints()[0].documents['16_evidence-catalog']).toEqual(reviewed);
  });
  it('ends the slow phase at the bounded 180 seconds, preserves the fast reviewed draft, and does not archive a partial packet', async () => {
    const f = await setup({ ten: 185_000 }); vi.useFakeTimers();
    let done = false; const pending = f.run().then(result => { done = true; return result; });
    await vi.advanceTimersByTimeAsync(179_999); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2); const result = await pending;
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', draftMode: 'mixed' });
    expect(f.checkpoints()[0].documents['16_evidence-catalog']).toMatchObject({ reviewed: true });
    expect(f.checkpoints()[0].documents).not.toHaveProperty('10_civil-complaint');
    expect(cases.getCase(f.orgId, f.c.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
    expect(f.events.find(e => e.name === '10_civil-complaint')!.signal.aborted).toBe(true);
  });
  it('honors an earlier caller cancellation and never writes a completed packet after it', async () => {
    const f = await setup({ ten: 46_000, catalog: 46_000 }); vi.useFakeTimers(); const owner = new AbortController();
    const pending = f.run({ executionSignal: owner.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(5_000); owner.abort(new DOMException('Synthetic user cancelled', 'AbortError')); await vi.advanceTimersByTimeAsync(1);
    const result = await pending; expect(result).toBeInstanceOf(Error); expect(f.events.filter(e => e.kind === 'review')).toEqual([]);
    expect(cases.getCase(f.orgId, f.c.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
    expect(fs.existsSync(path.join(f.outputDir, '99_manifest.md'))).toBe(false);
  });
});

// Current real packet failures were a 90-second phase and an 8192-token review cap.
it('allows two 100-second drafting/review phases with provider-default reasoning and the existing structured 16K output, without changing user preferences',async()=>{
 const f=await setup({ten:100_000,catalog:100_000,review:100_000,model:'aliyun/deepseek-v4-flash'});const prefs=await import('../server/llm/user_preferences');const before=prefs.getUserPreferredLLMConfig(f.userId);vi.useFakeTimers();
 const pending=f.run();await vi.advanceTimersByTimeAsync(90_001);expect(f.events.every(e=>!e.signal.aborted)).toBe(true);await vi.advanceTimersByTimeAsync(211_001);const r=await pending;
 expect(r.receipt).toMatchObject({ok:true,status:'generated',draftMode:'model'});expect(f.create).toHaveBeenCalledTimes(4);
 for(const [request] of f.create.mock.calls){expect(request.max_tokens).toBe(16384);expect(request).not.toHaveProperty('reasoning_effort');expect(request.stream).toBe(true);}
 expect(prefs.getUserPreferredLLMConfig(f.userId)).toEqual(before);expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(1);
});
it('allows two fresh plaintiff targets their serial170s draft and170s review without extra calls or premature cancellation',async()=>{
 const f=await setup({ten:170_000,catalog:170_000,review:170_000});vi.useFakeTimers();let done=false;const start=Date.now(),pending=f.run().then(r=>{done=true;return r;});
 await vi.advanceTimersByTimeAsync(339_999);expect(done).toBe(false);expect(f.events.filter(e=>e.kind==='review')).toHaveLength(2);expect(f.events.filter(e=>e.kind==='review').every(e=>!e.signal.aborted)).toBe(true);await vi.advanceTimersByTimeAsync(2);const r=await pending;
 expect(r.receipt).toMatchObject({ok:true,status:'generated',draftMode:'model'});expect(Date.now()-start).toBe(340001);expect(f.create).toHaveBeenCalledTimes(4);expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(1);expect(f.events.filter(e=>e.kind==='review').every(e=>!e.signal.aborted)).toBe(true);
 expect(f.checkpoints()[0].documents['10_civil-complaint']).toMatchObject({reviewed:true});expect(f.checkpoints()[0].documents['16_evidence-catalog']).toMatchObject({reviewed:true});
});
