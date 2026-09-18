import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { toolRegistry, ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { bindIndustryWorkspaceContext } from '../server/industry/workspace_context';
import * as LegalCases from '../server/org/legal_cases';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import { verifyCitation } from '../server/legal/kb';
import { parseDocument } from '../server/legal/parser';
import { inspectLegalReasoningLinks, type LegalReasoningLink } from '../server/regions/packs/cn/legal_reasoning_links';
import { startIndustryWorkflow, getIndustryWorkflowTask } from '../server/industry/workflow_service';

let app: Awaited<ReturnType<typeof makeApp>>;
const uid = 'two-fictional-cases';
const orgId = `personal:${uid}`;
const token = jwt.sign({ uid, username: uid, role: 'user' }, JWT_SECRET);
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const call = async (endpoint: string, body: any, method = 'POST') => {
  const response = await fetch(`${app.url}/api/${endpoint}`, { method, headers, body: method === 'DELETE' ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
const tool = (name: string, args: any) => call(`legal/tool/${name}`, { args });

beforeAll(async () => {
  app = await makeApp(); installCivilCodeFixture(); registerLegalTools(toolRegistry);
  const unavailable = () => null;
  mountChatRoutes(app.apiRouter, JWT_SECRET, { getDeepSeek: unavailable, getGemini: unavailable, getOpenAI: unavailable, getAnthropic: unavailable, getQwen: unavailable, getRelay: unavailable } as any);
});
afterAll(() => app.cleanup());

describe('two fictional cases through actual HTTP routes and artifact writers', () => {
  let plaintiff: LegalCases.OrgLegalCaseFile;
  let defendant: LegalCases.OrgLegalCaseFile;
  let links: LegalReasoningLink[];

  it('synchronizes a selected client case without accepting forged progress', async () => {
    const synced = await call('legal/client-case-sync', { case: {
      id: 'fictional-plaintiff', title: '虚构甲公司诉乙公司', party: '甲公司、乙公司', clientRole: '原告',
      objective: '请求支付未付货款二万元，并核对约定违约金。', cause: '买卖合同纠纷',
      notes: '2026年甲公司向乙公司供货，乙公司已经签收，尚欠货款二万元。',
      workflowRuns: [{ ok: true, tool: 'legal_finalize_delivery_package' }],
      materials: [{ id: 'plaintiff-source', type: 'evidence', source: 'manual', title: '合同及签收凭据',
        content: '合同约定乙公司签收后付款。乙公司于2026年9月1日签收货物，欠付货款二万元。约定违约金仍需核算。' }],
    } });
    expect(synced.status).toBe(200);
    plaintiff = synced.data.case;
    expect(plaintiff.workflowRuns).toBeUndefined();
    expect(plaintiff.id).toBe('fictional-plaintiff');
    const unchanged = await call('legal/client-case-sync', { case: plaintiff, activate: true });
    expect(unchanged.data.case.updatedAt).toBe(plaintiff.updatedAt);
    const implicit = await tool('legal_case_workflow_status', {});
    expect(implicit.data.text).toContain(plaintiff.title);
    const created = await tool('legal_case_workspace', {
      caseName: '虚构丙公司应诉丁公司', role: '被告', parties: '丙公司、丁公司',
      facts: '丁公司主张货款九万元，丙公司已付七万元，剩余部分因质量争议未结算。',
      evidence: '银行流水：已转账七万元；验收报告：发现三处质量不符。',
      complaint: '丁公司起诉要求丙公司支付货款九万元。', claims: '抗辩已付款七万元，核实质量损失。', caseType: '买卖合同纠纷',
    });
    expect(created.status).toBe(200);
    expect(created.data.receipt.ok).toBe(true);
    expect(created.data.caseUpdates).toHaveLength(1);
    defendant = created.data.caseUpdates[0];
    expect(defendant.clientRole).toBe('被告');
    expect(LegalCases.evaluateCaseWorkflow(defendant).steps.find(s => s.key === 'drafts')?.state).not.toBe('done');
  });

  it('continues both exact cases, produces separate DOCX documents, and returns case updates to the client', async () => {
    for (const [c, expected, forbidden] of [[plaintiff, '二万元', '九万元'], [defendant, '七万元', '二万元']] as const) {
      const result = await tool('legal_generate_litigation_packet', { caseId: c.id });
      expect(result.status).toBe(200);
      expect(result.data.receipt).toMatchObject({ ok: true, status: 'generated' });
      expect(result.data.caseUpdates.map((item: any) => item.id)).toEqual([c.id]);
      expect(result.data.artifacts.length).toBeGreaterThan(0);
      const packet = result.data.artifacts.find((p: string) => p.endsWith('00_litigation-packet.md'));
      const directory = path.dirname(packet);
      const documents = fs.readdirSync(directory).filter(name => name.endsWith('.docx'));
      expect(documents.length).toBeGreaterThan(4);
      const pleading = documents.find(name => c.clientRole === '原告' ? name.includes('complaint') && !name.includes('elements') : name.includes('defense'));
      expect(pleading).toBeTruthy();
      const document = await parseDocument(path.join(directory, pleading!));
      expect(document?.text).toContain(expected);
      expect(document?.text).not.toContain(forbidden);
      const matrix = fs.readFileSync(path.join(directory, '03_evidence-review-matrix.md'), 'utf8');
      if (c.clientRole === '被告') {
        expect(matrix).toContain('付款事实、欠款金额');
        expect(matrix).toContain('质量异议、验收状态');
      }
    }
  }, 45000);

  it('reuses persisted case identity in a new registry/conversation even when another case is active', async () => {
    const registry = new ToolRegistry(); registerLegalTools(registry);
    const context = { userId: uid, domain: 'personal', authenticated: true, authRole: 'user' } as any;
    bindIndustryWorkspaceContext({ userId: uid, domain: 'personal', orgId: '' }, { name: defendant.title, attributes: { caseId: defendant.id, caseName: defendant.title } });
    const output = await registry.execute('legal_case_reasoning_matrix', { caseId: plaintiff.id, writeFiles: false }, context);
    expect(output).toContain(plaintiff.title);
    expect(output).not.toContain(defendant.title);
    await expect(registry.execute('legal_case_reasoning_matrix', { caseId: 'missing-case', facts: '不可另建案件代替' }, context)).rejects.toThrow();
    expect(LegalCases.listCases(orgId, '', 100, uid)).toHaveLength(2);
  });

  it('blocks heading-only reasoning, wrong-case sources, fabricated quotes and historical-law misuse', async () => {
    const source = LegalCases.getCase(orgId, plaintiff.id, uid)!;
    links = [{ issue: '本案欠付款项及违约金如何核实', ruleCitation: '《民法典》第585条',
      ruleQuote: verifyCitation('《民法典》第585条').sourceText!, fact: '乙公司签收货物后尚欠货款二万元。',
      evidence: [{ materialId: 'plaintiff-source', quote: '乙公司于2026年9月1日签收货物，欠付货款二万元。', locator: '材料正文第2句' }],
      application: '需结合约定和实际损失核算违约金；签收和欠付记载仅作为待核实的付款事实依据。',
      conclusion: '本案约定违约金仍需核算并结合损失复核，不能直接确定支持金额。',
      limitations: '尚未核对原件、违约金约定全文及对方提出的反证。' }];
    expect(inspectLegalReasoningLinks(links, source, orgId).passed).toBe(true);
    const content = `依据《民法典》第585条分析。\n${links[0].conclusion}`;
    for (const extra of [
      { reasoningSummary: '大前提：现行法律规定应当履行合同义务。\n小前提：本案已提交合同和签收材料，仍需核对原件。\n结论：根据前述法律和事实提出请求，具体金额需核对。' },
      { reasoningLinks: [{ ...links[0], evidence: [{ ...links[0].evidence[0], materialId: defendant.materials[0].id }] }] },
      { reasoningLinks: [{ ...links[0], evidence: [{ ...links[0].evidence[0], quote: '乙公司承认需要支付一百万元。' }] }] },
      { reasoningLinks: links, factDate: '2019-01-01' },
    ]) {
      const result = await tool('legal_finalize_delivery_package', { caseId: plaintiff.id, content, includeDocx: false, ...extra });
      expect(result.status).toBe(200);
      expect(result.data.receipt).toMatchObject({ ok: false, status: 'blocked' });
      expect(result.data.text).toContain('正式交付包未生成');
    }
  });

  it('archives traceable reasoning and delivery, then invalidates progress when source materials change', async () => {
    const reasoning = await tool('legal_case_reasoning_matrix', { caseId: plaintiff.id, reasoningLinks: links, legalAuthorities: '《民法典》第585条' });
    expect(reasoning.status).toBe(200);
    expect(reasoning.data.receipt.reasoningLinked).toBe(true);
    const result = await tool('legal_finalize_delivery_package', {
      caseId: plaintiff.id, content: `依据《民法典》第585条分析。\n${links[0].conclusion}`, documentType: '法律意见书',
    });
    expect(result.status).toBe(200);
    expect(result.data.receipt).toMatchObject({ ok: true });
    const current = result.data.caseUpdates[0];
    expect(LegalCases.evaluateCaseWorkflow(current).steps.find(s => s.key === 'delivery')?.state).toBe('done');
    expect(result.data.artifacts.some((p: string) => p.endsWith('.docx') && fs.existsSync(p))).toBe(true);
    const changed = await call('legal/client-case-sync', { case: { ...current, materials: current.materials.map((m: any) => m.id === 'plaintiff-source' ? { ...m, content: '证据内容已更正，需要重新核验。' } : m) } });
    expect(changed.status).toBe(200);
    expect(changed.data.case.materials.length).toBe(current.materials.length);
    expect(LegalCases.evaluateCaseWorkflow(changed.data.case).steps.find(s => s.key === 'delivery')?.state).not.toBe('done');
    const stale = await tool('legal_finalize_delivery_package', { caseId: plaintiff.id, content: `依据《民法典》第585条分析。\n${links[0].conclusion}`, includeDocx: false });
    expect(stale.data.receipt.ok).toBe(false);
  });

  it('keeps personal synchronization authenticated and scoped', async () => {
    const anonymous = await fetch(`${app.url}/api/legal/client-case-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ case: { id: 'bad' } }) });
    expect(anonymous.status).toBe(401);
    const malformed = await call('legal/client-case-sync', { case: { id: '../bad' } });
    expect(malformed.status).toBe(400);
    const otherToken = jwt.sign({ uid: 'another-lawyer', username: 'another-lawyer', role: 'user' }, JWT_SECRET);
    const response = await fetch(`${app.url}/api/legal/client-case-sync/${plaintiff.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${otherToken}` } });
    expect((await response.json()).deleted).toBe(false);
    expect(LegalCases.getCase(orgId, plaintiff.id, uid)).not.toBeNull();
  });

  it('settles the client workflow from the actual tool receipt and refuses a different case binding', async () => {
    const scope = { userId: uid, domain: 'personal' as const, orgId: '' };
    const started = startIndustryWorkflow({ ...scope, entryId: 'packet', context: { caseIdentity: `id:${defendant.id}` } });
    const mismatch = await call('legal/tool/legal_generate_litigation_packet', { args: { caseId: plaintiff.id }, industryWorkflowTaskId: started.task.id });
    expect(mismatch.status).toBe(409);
    expect(getIndustryWorkflowTask(scope, started.task.id)?.status).toBe('in_progress');
    const result = await call('legal/tool/legal_generate_litigation_packet', { args: { caseId: defendant.id }, industryWorkflowTaskId: started.task.id });
    expect(result.status).toBe(200);
    expect(result.data.receipt.draftMode).toBe('template');
    expect(result.data.industryWorkflow.task.status).toBe('blocked');
    expect(getIndustryWorkflowTask(scope, started.task.id)?.metadata?.workTakeoverToolRuns?.length).toBeGreaterThan(0);
  });
});
