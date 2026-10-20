import { packetDraftFixture } from './legal_packet_fixture';
import { reasoningFixtureReply } from './legal_reasoning_fixture';
import { contractStructuredReply, sdkCompletionFixture } from './legal_contract_fixture';
import { bidStructuredReply } from './legal_bid_fixture';
import { decodeToolResult } from '../server/tools/result_envelope';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { getWebLoginSitePreset, listWebLoginSitePresets } from '../server/web_login/legal_presets';

let cleanup = () => {};
let originalOpenAIKey: string | undefined;
let registerLegalTools: (registry: ToolRegistry) => void;
let registerWebLoginTools: (registry: ToolRegistry) => void;

beforeAll(async () => {
  originalOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  const app = await makeApp();
  cleanup = app.cleanup;
  installCivilCodeFixture();
  ({ registerLegalTools } = await import('../server/tools/definitions/legal_tools'));
  ({ registerWebLoginTools } = await import('../server/tools/definitions/web_login_tools'));
});

function trustedLocalContext(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    authenticated: true,
    authRole: 'user',
    localExecution: true,
    executionBoundary: 'trusted_local' as const,
    ...overrides,
  };
}

async function traceableDeliveryInput(orgId: string, conclusion: string, caseId?: string, caseName = '有来源的交付测试案') {
  const cases = await import('../server/org/legal_cases');
  const { verifyCitation } = await import('../server/legal/kb');
  const caseFile = caseId ? cases.getCase(orgId, caseId)! : cases.createCase(orgId, 'vitest', { title: caseName });
  const source = cases.addMaterial(orgId, 'vitest', caseFile.id, { type: 'evidence', title: '虚构原始合同及签收记录', source: 'manual',
    content: '虚构合同及签收记录记载原告已经供货，被告签收后尚未支付剩余货款，违约金需要另行核算。' })!;
  return { caseId: caseFile.id, factDate: '2026-09-01', reasoningLinks: [{ issue: '虚构交易欠付款项与违约金的审查', ruleCitation: '《民法典》第五百八十五条',
    ruleQuote: verifyCitation('《民法典》第五百八十五条').sourceText!, fact: source.content,
    evidence: [{ materialId: source.id, quote: source.content, locator: '测试材料第1段' }],
    application: '需要结合合同约定及实际损失核算，付款及违约责任须以完整证据核实为条件。', conclusion,
    limitations: '仅测试关联来源，不判断法律适用或证据真实性；实际意见需要律师复核。' }] };
}

describe('legal case identity isolation', () => {
  it('recovers explicitly labelled case slots when the planner omits them', async () => {
    const registry = createLegalRegistry();
    const actionIntent = '\u65b0\u5efa\u4e00\u4e2a\u6d4b\u8bd5\u6848\u4ef6\u5de5\u4f5c\u53f0\uff0c\u6848\u4ef6\u540d\u201c\u5f8b\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4e09\u53f7\u4e70\u5356\u5408\u540c\u7ea0\u7eb7\u201d\uff0c\u5f53\u4e8b\u4eba\u7532\u65b9\u65b0\u7532\u516c\u53f8\u3001\u4e59\u65b9\u65b0\u4e59\u516c\u53f8\uff0c\u4e89\u8bae\u91d1\u989d80\u4e07\u5143\uff0c\u9636\u6bb5\u4e3a\u8bc9\u524d\u3002';
    const output = await registry.execute('legal_case_workspace', {
      facts: '\u7532\u65b9\u65b0\u7532\u516c\u53f8\u4e0e\u4e59\u65b9\u65b0\u4e59\u516c\u53f8\u5b58\u5728\u4e70\u5356\u5408\u540c\u7ea0\u7eb7\uff0c\u4e89\u8bae\u91d1\u989d80\u4e07\u5143\u3002',
    }, trustedLocalContext(`legal-slot-recovery-${Date.now()}`, {
      domain: 'personal',
      source: 'chat',
      actionIntent,
    }));

    expect(output).toContain('# \u5f8b\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4e09\u53f7\u4e70\u5356\u5408\u540c\u7ea0\u7eb7 \u6848\u4ef6\u5de5\u4f5c\u53f0');
    expect(output).toContain('- \u5f53\u4e8b\u4eba\uff1a\u65b0\u7532\u516c\u53f8\uff1b\u65b0\u4e59\u516c\u53f8');
    expect(output).toContain('- \u9636\u6bb5\uff1a\u8bc9\u524d');
  });

  it('creates a different explicitly named case and preserves planner aliases', async () => {
    const registry = createLegalRegistry();
    const cases = await import('../server/org/legal_cases');
    function persistedCaseId(output: string): string {
      const decoded = decodeToolResult(output);
      const receipt = decoded.receipt;
      expect(receipt).toMatchObject({ ok: true, status: 'updated', persisted: true });
      if (!receipt || typeof receipt !== 'object' || !('changedCaseIds' in receipt) || !Array.isArray(receipt.changedCaseIds)) {
        throw new Error('The workspace result has no structured changed-case receipt.');
      }
      expect(receipt.changedCaseIds).toHaveLength(1);
      const [caseId] = receipt.changedCaseIds;
      if (typeof caseId !== 'string' || !caseId.trim()) throw new Error('The workspace receipt has no non-empty case identity.');
      expect(decoded.content).not.toContain(caseId);
      return caseId;
    }
    const userId = `legal-case-isolation-${Date.now()}`;
    const context = trustedLocalContext(userId, { domain: 'personal' as const, source: 'chat' });
    const orgId = cases.legalWorkspaceNamespace(userId);
    const first = await registry.execute('legal_case_workspace', {
      caseName: '\u65e7\u6848\u4ef6',
      parties: '\u65e7\u7532\uff1b\u65e7\u4e59',
      stage: '\u8bc9\u524d',
    }, context);
    const firstId = persistedCaseId(first);
    const firstCase = cases.getCase(orgId, firstId, userId);
    expect(firstCase).toMatchObject({ id: firstId, orgId, title: '\u65e7\u6848\u4ef6', party: '\u65e7\u7532\uff1b\u65e7\u4e59', stage: 'consultation', createdBy: userId });

    const second = await registry.execute('legal_case_workspace', {
      // The planner may copy the currently active case ID even when the user
      // explicitly asks for a new case. The tool must trust the fresh user
      // intent over that stale model-supplied identity.
      caseId: firstId,
      caseName: '\u5f8b\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4e70\u5356\u5408\u540c\u7ea0\u7eb7',
      partyA: '\u7532\u65b9\u6d4b\u8bd5\u516c\u53f8',
      partyB: '\u4e59\u65b9\u793a\u4f8b\u516c\u53f8',
      disputeAmount: 800000,
      stage: '\u8bc9\u524d',
    }, {
      ...context,
      actionIntent: '\u65b0\u5efa\u4e00\u4e2a\u6d4b\u8bd5\u6848\u4ef6\u5de5\u4f5c\u53f0\uff0c\u6848\u4ef6\u540d\u201c\u5f8b\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4e70\u5356\u5408\u540c\u7ea0\u7eb7\u201d',
    });
    const secondId = persistedCaseId(second);
    const secondCase = cases.getCase(orgId, secondId, userId);
    expect(secondCase).toMatchObject({ id: secondId, orgId,
      title: '\u5f8b\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4e70\u5356\u5408\u540c\u7ea0\u7eb7',
      party: '\u7532\u65b9\u6d4b\u8bd5\u516c\u53f8\uff1b\u4e59\u65b9\u793a\u4f8b\u516c\u53f8',
      cause: '\u4e70\u5356\u5408\u540c\u7ea0\u7eb7', stage: 'consultation', createdBy: userId });
    expect(secondCase?.notes).toContain('\u4e89\u8bae\u91d1\u989d\uff1a\u4eba\u6c11\u5e01800000\u5143');
    expect(cases.getCase(orgId, firstId, userId)).toEqual(firstCase);

    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    expect(second).toContain('\u7532\u65b9\u6d4b\u8bd5\u516c\u53f8\uff1b\u4e59\u65b9\u793a\u4f8b\u516c\u53f8');
    expect(second).toContain('\u4e70\u5356\u5408\u540c\u7ea0\u7eb7');
    expect(second).toContain('\u4e89\u8bae\u91d1\u989d\uff1a\u4eba\u6c11\u5e01800000\u5143');
    expect(second).toContain('- \u9636\u6bb5\uff1a\u8bc9\u524d');

    const sameNameReplay = await registry.execute('legal_case_workspace', {
      caseId: secondId,
      caseName: '\u5f8b\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4e70\u5356\u5408\u540c\u7ea0\u7eb7',
      partyA: '\u7532\u65b9\u6d4b\u8bd5\u516c\u53f8',
      partyB: '\u4e59\u65b9\u793a\u4f8b\u516c\u53f8',
      disputeAmount: 800000,
      stage: '\u8bc9\u524d',
    }, {
      ...context,
      actionIntent: '\u65b0\u5efa\u4e00\u4e2a\u6d4b\u8bd5\u6848\u4ef6\u5de5\u4f5c\u53f0\uff0c\u6848\u4ef6\u540d\u201c\u5f8b\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4e70\u5356\u5408\u540c\u7ea0\u7eb7\u201d',
    });
    const replayId = persistedCaseId(sameNameReplay);
    const replayCase = cases.getCase(orgId, replayId, userId);
    expect(replayCase).toMatchObject({ id: replayId, orgId, title: secondCase?.title,
      party: secondCase?.party, cause: secondCase?.cause, stage: 'consultation', createdBy: userId });
    expect(replayCase?.notes).toBe(secondCase?.notes);
    expect(replayId).toBeTruthy();
    expect(replayId).not.toBe(secondId);

    const third = await registry.execute('legal_case_workspace', {
      caseId: secondId,
      caseName: '\u5355\u4f4d\u683c\u5f0f\u6d4b\u8bd5\u6848',
      disputeAmount: '80\u4e07\u5143',
      stage: '\u8bc9\u524d',
    }, {
      ...context,
      actionIntent: '\u65b0\u5efa\u5355\u4f4d\u683c\u5f0f\u6d4b\u8bd5\u6848\u4ef6\u5de5\u4f5c\u53f0',
    });
    expect(third).toContain('\u4e89\u8bae\u91d1\u989d\uff1a\u4eba\u6c11\u5e0180\u4e07\u5143');
    expect(third).not.toContain('80\u4e07\u5143\u5143');
    expect(cases.getCase(orgId, firstId, userId)).toEqual(firstCase);
    expect(cases.getCase(orgId, secondId, userId)).toEqual(secondCase);
    expect(cases.getCase(orgId, replayId, userId)).toEqual(replayCase);
    const unitCases = cases.listCases(orgId, '\u5355\u4f4d\u683c\u5f0f\u6d4b\u8bd5\u6848', 10, userId);
    expect(unitCases).toHaveLength(1);
    expect(unitCases[0]).toMatchObject({ orgId, title: '\u5355\u4f4d\u683c\u5f0f\u6d4b\u8bd5\u6848', stage: 'consultation', createdBy: userId });
    expect(unitCases[0]?.notes).toContain('\u4e89\u8bae\u91d1\u989d\uff1a\u4eba\u6c11\u5e0180\u4e07\u5143');
    expect([firstId, secondId, replayId]).not.toContain(unitCases[0]?.id);
    expect(cases.listCases(orgId, '', 50, userId)).toHaveLength(4);
  });
});

afterAll(() => {
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
  cleanup();
});

function createLegalRegistry() {
  const registry = new ToolRegistry();
  registerLegalTools(registry);
  return registry;
}

async function reasoningSourceInput(orgId: string, userId: string, title: string, content: string, caseId?: string) {
  const cases = await import('../server/org/legal_cases');
  const item = caseId ? cases.getCase(orgId, caseId)! : cases.createCase(orgId, userId, { title });
  cases.addMaterial(orgId, userId, item.id, { type: 'evidence', source: 'manual', title: '虚构原始材料', content });
  return { caseId: item.id, factDate: '2026-09-01', legalAuthorities: '《民法典》第626条' };
}

function reasoningReply(prompt: string, text: string): string {
  if (prompt.includes('你是法律适用复核者')) return reasoningFixtureReply(prompt, { reviews: [{ index: 1, status: 'conditional', application: text, conclusion: text, missingPremises: ['原件及交易对应关系尚需律师核实'], reason: '仅对给定虚构原文作条件分析，不确认未知事实。' }], uncoveredIssues: [] });
  if (prompt.includes('你在编写供律师复核的法律分析')) {
    const sources = JSON.parse(prompt.split('\n材料：')[1].split('\n上次编号')[0]);
    return reasoningFixtureReply(prompt, { entries: [{ issue: '虚构材料与法律适用核对', ruleId: 'R1', sourceIds: sources.slice(0, 30).map((source: any) => source.id), application: text, conclusion: text, limitations: '原件及交易对应关系仍须核实。' }] });
  }
  return text;
}

async function legalModelContext(text: string, finishReason = 'stop') {
  const { upsertUserPreferredLLM } = await import('../server/llm/user_preferences');
  const userId = 'explicit-legal-work-product-model-user';
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'official-work-product-test', selectionMode: 'pinned' });
  return { userId, llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create: async (params: any) => {
    const prompt = String(params.messages.find((message: any) => message.role === 'user')?.content || '');
    let content = contractStructuredReply(prompt, reasoningReply(prompt, text));
    if (prompt.includes('\n指定子节：') || prompt.includes('\n待核对JSON草稿：')) content = bidStructuredReply(prompt, text);
    if (prompt.includes('## 当前文书\n')) { const target = JSON.parse(prompt.split('## 当前文书\n')[1]); content = JSON.stringify(packetDraftFixture(prompt, { baseName: target.baseName, markdown: text })); }
    if (prompt.includes('文书列表：')) { const documents = JSON.parse(prompt.split('文书列表：')[1]); content = JSON.stringify({ documents: documents.map((entry: any) => ({ baseName: entry.baseName, complete: true, corrections: [], unresolved: [] })) }); }
    return sdkCompletionFixture(content, finishReason, params.stream);
  } } } }) } };
}
describe('semi-automated legal workflows', () => {
  it('reports an incomplete legal opinion without archiving a static draft when no model is available', async () => {
    const { generateArgumentOrOpinionHandler } = await import('../server/regions/packs/cn/legal_tools/argument_drafting');
    const cases = await import('../server/org/legal_cases');
    const userId = 'missing-opinion-model-user';
    const result = decodeToolResult(await generateArgumentOrOpinionHandler({ caseName: 'Missing opinion model', facts: '虚构合同80万元，证据待核实。', persistCase: true }, { userId, domain: 'personal', llmGetters: null }));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).toContain('拟议正文未完成');
    expect(cases.listCases(cases.legalWorkspaceNamespace(userId), 'Missing opinion model', 10)).toHaveLength(0);
  });

  it('rejects truncated model text before it can become a successful archived strategy', async () => {
    const { caseStrategyHandler } = await import('../server/regions/packs/cn/legal_tools/argument_drafting');
    const context = await legalModelContext('HALF_FINISHED_STRATEGY', 'length');
    const cases = await import('../server/org/legal_cases');
    const args = await reasoningSourceInput(cases.legalWorkspaceNamespace(context.userId), context.userId, 'Truncated strategy', '虚构事实及交易对应关系尚待核实。');
    const result = decodeToolResult(await caseStrategyHandler({ ...args, caseName: 'Truncated strategy', facts: '虚构事实待核实。', persistCase: true }, context));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).toContain('输出额度已耗尽');
    expect(result.content).not.toContain('HALF_FINISHED_STRATEGY');
    expect(cases.getCase(cases.legalWorkspaceNamespace(context.userId), args.caseId)!.materials.filter(material => material.source === 'tool')).toHaveLength(0);
  });

  it('drafts plaintiff litigation packets with manual filing gates', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_generate_litigation_packet', {
      caseName: 'Sales Contract Case',
      role: 'plaintiff',
      caseType: '买卖合同纠纷',
      court: '上海市黄浦区人民法院',
      parties: 'Plaintiff: Alpha Trading Co.; Defendant: Beta Retail Co.',
      claims: '请求支付货款及违约金',
      facts: '2026年1月签订买卖合同，Alpha 已供货，Beta 尚欠货款 350000 元。',
      evidence: '合同、订单、发货单、签收单、发票、银行流水。',
    });

    expect(output).toContain('Sales Contract Case');
    expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄/);
    expect(output).toMatch(/起诉状|要素式诉状|诉讼文书包/);
    expect(output).toMatch(/证据目录|证明目的/);
    expect(output).toMatch(/三性审查|真实性|合法性|关联性/);
    expect(output).toMatch(/缺口|补强|质证风险/);
    expect(output).toMatch(/律师|人工|确认/);
    expect(output).toContain('法律成果预检');
    expect(output).toContain('现行有效法律预检');
    expect(output).toContain('人民法院在线服务');
      expect(output).not.toMatch(/web_login_run|web_login_profile_save_from_preset/);
  });

  it('drafts defendant response packets without auto-submitting anything', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_generate_litigation_packet', {
      caseName: 'Defense Contract Case',
      role: 'defendant',
      caseType: '买卖合同纠纷',
      facts: '原告主张被告拖欠货款，但货物存在严重质量问题且双方曾协商退货。',
      evidence: '验收异议函、聊天记录、退货沟通记录、原告起诉状。',
      opponentMaterials: '原告起诉状、证据目录、合同复印件。',
    });

    expect(output).toContain('Defense Contract Case');
    expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄/);
    expect(output).toMatch(/答辩状|质证意见/);
    expect(output).toMatch(/真实性|合法性|关联性|证明目的/);
    expect(output).toMatch(/程序抗辩|时效|主体资格/);
    expect(output).toMatch(/提交|签字|盖章|发送/);
    expect(output).toMatch(/律师|人工|确认/);
    expect(output).toContain('法律成果预检');
  });

  it('writes no-model packet templates but keeps the incomplete packet out of the case workspace', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-litigation-files-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_litigation_packet_'));
    const caseName = '诉讼文书包文件输出测试案';

    try {
      const output = await registry.execute('legal_generate_litigation_packet', {
        orgId,
        userId: 'vitest',
        caseName,
        role: '原告',
        caseType: '买卖合同纠纷',
        court: '上海市黄浦区人民法院',
        parties: '原告 Alpha；被告 Beta',
        claims: '请求支付货款及违约金',
        facts: '被告收货后未付剩余货款。',
        evidence: '买卖合同；送货单；签收单；银行流水。',
        outputDir: dir,
      });

      const packetPath = path.join(dir, '00_litigation-packet.md');
      const filingChecklistPath = path.join(dir, '01_filing-material-checklist.md');
      const authorizationChecklistPath = path.join(dir, '02_authorization-checklist.md');
      const evidenceMatrixPath = path.join(dir, '03_evidence-review-matrix.md');
      const complaintPath = path.join(dir, '10_civil-complaint.md');
      const elementComplaintPath = path.join(dir, '11_element-complaint.md');
      const engagementPath = path.join(dir, '12_engagement-agreement.md');
      const powerOfAttorneyPath = path.join(dir, '12_power-of-attorney.md');
      const lawFirmLetterPath = path.join(dir, '12_law-firm-letter.md');
      const serviceAddressPath = path.join(dir, '15_service-address-confirmation.md');
      const evidenceCatalogPath = path.join(dir, '16_evidence-catalog.md');
      const manifestPath = path.join(dir, '99_manifest.md');

      expect(output).toContain('诉讼文书包文件输出');
      for (const file of [packetPath, filingChecklistPath, authorizationChecklistPath, evidenceMatrixPath, manifestPath]) {
        expect(output).toContain(file);
      }
      expect(output).toContain('DOCX 生成：全部成功');
      expect(fs.existsSync(packetPath)).toBe(true);
      expect(fs.existsSync(filingChecklistPath)).toBe(true);
      expect(fs.existsSync(authorizationChecklistPath)).toBe(true);
      expect(fs.existsSync(evidenceMatrixPath)).toBe(true);
      expect(fs.existsSync(complaintPath)).toBe(true);
      expect(fs.existsSync(elementComplaintPath)).toBe(true);
      expect(fs.existsSync(engagementPath)).toBe(true);
      expect(fs.existsSync(powerOfAttorneyPath)).toBe(true);
      expect(fs.existsSync(lawFirmLetterPath)).toBe(true);
      expect(fs.existsSync(serviceAddressPath)).toBe(true);
      expect(fs.existsSync(evidenceCatalogPath)).toBe(true);
      expect(fs.existsSync(manifestPath)).toBe(true);
      expect(fs.readFileSync(filingChecklistPath, 'utf8')).toContain('Filing Material Checklist');
      expect(fs.readFileSync(authorizationChecklistPath, 'utf8')).toContain('Authorization Checklist');
      expect(fs.readFileSync(evidenceMatrixPath, 'utf8')).toContain('Evidence Catalog And Three-Property Review');
      const complaint = fs.readFileSync(complaintPath, 'utf8');
      expect(complaint).toContain('民事起诉状（系统草稿）');
      expect(complaint).toContain('待结合请求权基础检索并核验现行有效法律');
      expect(complaint).toContain('正式交付前必须完成');
      expect(output).not.toMatch(/legal_finalize_delivery_package|web_login_run|web_login_profile_save_from_preset/);
      expect(complaint).not.toMatch(/《[^》]+》第/);
      expect(fs.readFileSync(elementComplaintPath, 'utf8')).toContain('要素式诉状（系统草稿）');
      expect(fs.readFileSync(engagementPath, 'utf8')).toContain('委托代理合同（系统草稿）');
      expect(fs.readFileSync(powerOfAttorneyPath, 'utf8')).toContain('特别授权');
      expect(fs.readFileSync(lawFirmLetterPath, 'utf8')).toContain('律师事务所函（系统草稿）');
      expect(fs.readFileSync(serviceAddressPath, 'utf8')).toContain('电子送达意愿');
      expect(fs.readFileSync(evidenceCatalogPath, 'utf8')).toContain('原告证据目录（系统草稿）');
      expect(fs.readFileSync(manifestPath, 'utf8')).toContain('尚未通过正式交付核验');

      for (const baseName of [
        '00_litigation-packet',
        '10_civil-complaint',
        '11_element-complaint',
        '12_engagement-agreement',
        '12_power-of-attorney',
        '12_law-firm-letter',
        '15_service-address-confirmation',
        '16_evidence-catalog',
        '99_manifest',
      ]) {
        const docxPath = path.join(dir, `${baseName}.docx`);
        expect(fs.existsSync(docxPath), `${baseName}.docx should exist`).toBe(true);
        expect(fs.statSync(docxPath).size, `${baseName}.docx should not be empty`).toBeGreaterThan(1000);
      }

      const LegalCases = await import('../server/org/legal_cases');
      expect(decodeToolResult(output).receipt).toMatchObject({ ok: false, status: 'partial', draftMode: 'template' });
      expect(LegalCases.listCases(orgId, caseName, 1)).toHaveLength(0);
      expect(output).toContain('案件空间：未归档');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes separate defendant answer, cross-examination, procedural, and authorization documents', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_defendant_packet_'));

    try {
      const output = await registry.execute('legal_generate_litigation_packet', {
        orgId: `test-legal-defendant-files-${Date.now()}`,
        userId: 'vitest',
        caseName: '被告独立文书输出测试案',
        role: '被告',
        caseType: '买卖合同纠纷',
        court: '上海市黄浦区人民法院',
        parties: '被告 Beta；原告 Alpha',
        claims: '请求驳回原告缺乏事实和证据依据的诉讼请求',
        facts: '被告认为货物存在质量问题，双方曾协商退货。',
        evidence: '质量异议函；退货沟通记录；检测记录。',
        opponentMaterials: '原告起诉状；合同复印件；送货单。',
        outputDir: dir,
      });

      expect(output).toContain('DOCX 生成：全部成功');
      const expected = [
        ['20_statement-of-defense', '民事答辩状（系统草稿）'],
        ['21_cross-examination-opinion', '质证意见（系统草稿）'],
        ['22_procedural-defense-checklist', '程序抗辩检查表（系统草稿）'],
        ['23_argument-outline', '代理词工作稿（系统草稿）'],
        ['24_engagement-agreement', '委托代理合同（系统草稿）'],
        ['24_power-of-attorney', '授权委托书（系统草稿）'],
        ['24_law-firm-letter', '律师事务所函（系统草稿）'],
        ['27_evidence-catalog', '被告证据目录与反证矩阵（系统草稿）'],
      ];

      for (const [baseName, heading] of expected) {
        const markdownPath = path.join(dir, `${baseName}.md`);
        const docxPath = path.join(dir, `${baseName}.docx`);
        expect(fs.existsSync(markdownPath), `${baseName}.md should exist`).toBe(true);
        expect(fs.readFileSync(markdownPath, 'utf8')).toContain(heading);
        expect(fs.existsSync(docxPath), `${baseName}.docx should exist`).toBe(true);
        expect(fs.statSync(docxPath).size, `${baseName}.docx should not be empty`).toBeGreaterThan(1000);
      }

      const answer = fs.readFileSync(path.join(dir, '20_statement-of-defense.md'), 'utf8');
      expect(answer).toContain('逐项答辩意见');
      expect(answer).toContain('待围绕抗辩要件检索并核验现行有效法律');
      expect(answer).not.toMatch(/《[^》]+》第/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts dispute focuses from complaint, evidence, and trial notes', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_extract_dispute_focus', {
      caseName: 'Trial Focus Case',
      role: 'defendant',
      caseType: '买卖合同纠纷',
      complaint: '原告称双方合同成立，被告拖欠货款并应承担违约金。',
      evidence: '合同、发货单、签收单、质量异议函、聊天记录。',
      transcript: '庭审中双方争议付款条件是否成就、质量异议是否成立、违约金是否过高。',
    });

    expect(output).toContain('Trial Focus Case');
    expect(output).not.toMatch(/底层三段论|三段论|大前提|小前提|涵摄/);
    expect(output).toContain('原告称双方合同成立，被告拖欠货款并应承担违约金。');
    expect(output).toContain('庭审中双方争议付款条件是否成就、质量异议是否成立、违约金是否过高。');
    expect(output).toContain('归集未完成');
    expect(output).toContain('保留原始材料');
    expect(output).not.toContain('对方可能主张');
    expect(output).toMatch(/律师|复核|确认/);
  });

  it('creates unified legal case workspaces with case state and search order', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-workspace-${Date.now()}`;

    const rawOutput = await registry.execute('legal_case_workspace', {
      orgId,
      userId: 'vitest',
      caseName: '统一案件工作台测试案',
      stage: '立案',
      role: '原告',
      caseType: '买卖合同纠纷',
      court: '上海市黄浦区人民法院',
      parties: '原告 Alpha Trading Co.; 被告 Beta Retail Co.',
      claims: '请求支付货款及违约金',
      facts: '2026年1月签订买卖合同，被告收货后未按约付款。',
      evidence: '买卖合同；送货单；微信催款记录；银行流水',
      legalAuthorities: '拟引用《民法典》第五百八十五条。',
    });
    const output = decodeToolResult(rawOutput).content;

    expect(output).toContain('案件工作台');
    const CaseStore = await import('../server/org/legal_cases');
    const createdCases = CaseStore.listCases(orgId, "统一案件工作台测试案", 50, 'vitest')
      .filter(item => item.title === "统一案件工作台测试案");
    expect(createdCases).toHaveLength(1);
    const createdCase = createdCases[0];
    expect(createdCase).toMatchObject({ orgId, title: "统一案件工作台测试案", createdBy: 'vitest' });
    expect(createdCase.materials).toHaveLength(3);
    expect(output).toContain(createdCase.title);
    expect(output).toContain(`案件现有材料：共 ${createdCase.materials.length} 份`);
    expect(output).not.toContain(createdCase.id);
    expect(output).not.toContain(orgId);
    for (const material of createdCase.materials) {
      expect(output).not.toContain(material.id);
    }
    expect(output).toContain('闭环状态');
    expect(output).toContain('完成度：');
    expect(output).toContain('下一动作：');
    expect(output).not.toContain('推荐工具');
    expect(output).toContain('优先行动队列');
    expect(output).not.toContain('Standard Legal Casework Sequence');
    expect(output).toContain('| 顺位 | 模块 | 状态 | 下一步 |');
    expect(output).not.toContain('legal_message_intake_to_case -> legal_case_workspace');
    expect(output).not.toContain('legal_generate_citation_verification_report -> legal_finalize_delivery_package');
    expect(output).toContain('三段论分析');
    expect(output).toContain('尚未形成完整法律分析底稿');
    expect(output).toContain('证据目录与三性审查矩阵');
    expect(output).toContain('三性审查矩阵');
    expect(output).toContain('真实性核验');
    expect(output).toContain('合法性核验');
    expect(output).toContain('关联性核验');
    expect(output).toContain('现行有效法律');
    expect(output).toContain('最高人民法院 > 高级人民法院 > 中级人民法院 > 基层人民法院');
    expect(output).not.toContain('legal_case_reasoning_matrix');
    expect(output).not.toContain('legal_generate_litigation_packet');
    expect(output).toContain('正式交付');
    expect(output).toContain('人民法院在线服务');
  });

  it('marks blocked current-law steps in the case workflow state machine', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-workflow-block-${Date.now()}`;

    const output = await registry.execute('legal_case_workspace', {
      orgId,
      userId: 'vitest',
      caseName: '闭环阻断测试案',
      role: '原告',
      caseType: '买卖合同纠纷',
      parties: '原告 Alpha；被告 Beta',
      facts: '双方签订买卖合同，被告收货后未付款。',
      evidence: '买卖合同；送货单；银行流水',
      legalAuthorities: '拟引用《合同法》第六十条作为请求权基础。',
    });

    expect(output).toContain('闭环状态');
    expect(output).toContain('阻断项：');
    expect(output).toMatch(/\| 现行有效法律 \| 阻断 \|/);
    expect(output).toContain('合同法');
    expect(output).not.toContain('legal_search_statute / legal_generate_citation_verification_report');
    expect(output).toContain('正式交付');
    expect(output).not.toContain('下一步工具链');
  });

  it('reports legal case workflow status without creating work products', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-workflow-status-${Date.now()}`;

    const workspace = await registry.execute('legal_case_workspace', {
      orgId,
      userId: 'vitest',
      caseName: '直接状态查询测试案',
      role: '原告',
      caseType: '买卖合同纠纷',
      parties: '原告 Alpha；被告 Beta',
      facts: '双方签订买卖合同，被告收货后未付款。',
      evidence: '买卖合同；送货单；银行流水',
    });
    const CaseStore = await import('../server/org/legal_cases');
    const createdCases = CaseStore.listCases(orgId, "直接状态查询测试案", 50, 'vitest')
      .filter(item => item.title === "直接状态查询测试案");
    expect(createdCases).toHaveLength(1);
    const createdCase = createdCases[0];
    expect(createdCase).toMatchObject({ orgId, title: "直接状态查询测试案", createdBy: 'vitest' });
    expect(createdCase.materials).toHaveLength(2);
    const caseId = createdCase.id;
    expect(caseId).toBeTruthy();

    const rawOutput = await registry.execute('legal_case_workflow_status', {
      orgId,
      caseId,
      legalAuthorities: '拟引用《合同法》第六十条。',
    });
    const output = decodeToolResult(rawOutput).content;

    expect(output).toContain('案件闭环状态');
    expect(output).toContain('直接状态查询测试案');
    expect(output).toContain(createdCase.title);
    expect(output).toContain(`案件现有材料：共 ${createdCase.materials.length} 份`);
    expect(output).not.toContain(createdCase.id);
    expect(output).not.toContain(orgId);
    for (const material of createdCase.materials) {
      expect(output).not.toContain(material.id);
    }
    expect(decodeToolResult(workspace).content).not.toContain(caseId);
    expect(CaseStore.getCase(orgId, caseId, 'vitest')?.materials).toEqual(createdCase.materials);
    expect(output).toContain('完成度：');
    expect(output).toContain('下一动作：');
    expect(output).toContain('优先行动队列');
    expect(output).toContain('| 顺位 | 模块 | 状态 | 下一步 |');
    expect(output).toMatch(/\| 现行有效法律 \| 阻断 \|/);
    expect(output).toContain('合同法');
    expect(output).not.toContain('正式交付包已生成');
  });

  it('archives filing handoffs and delivery packages into the same legal case workspace', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-archive-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_archive_'));

    try {
      const workspace = await registry.execute('legal_case_workspace', {
        orgId,
        userId: 'vitest',
        caseName: '案件归档闭环测试案',
        role: '原告',
        caseType: '买卖合同纠纷',
        facts: '被告收货后未付款。',
        evidence: '合同；送货单；银行流水',
      });
      const CaseStore = await import('../server/org/legal_cases');
      const createdCases = CaseStore.listCases(orgId, "案件归档闭环测试案", 50, 'vitest')
        .filter(item => item.title === "案件归档闭环测试案");
      expect(createdCases).toHaveLength(1);
      const createdCase = createdCases[0];
      expect(createdCase).toMatchObject({ orgId, title: "案件归档闭环测试案", createdBy: 'vitest' });
      expect(createdCase.materials).toHaveLength(2);
      const caseId = createdCase.id;
      expect(decodeToolResult(workspace).content).toContain(createdCase.title);
      expect(decodeToolResult(workspace).content).not.toContain(caseId);
      expect(caseId).toBeTruthy();

      const filing = await registry.execute('legal_prepare_filing_handoff', {
        orgId,
        userId: 'vitest',
        caseId,
        caseName: '案件归档闭环测试案',
        role: '原告',
        caseType: '买卖合同纠纷',
        facts: '被告收货后未付款。',
        evidence: '合同；送货单；银行流水',
      });
      expect(filing).toContain('已归档到案件空间');
      expect(filing).toContain('法律成果预检');

      const delivery = await registry.execute('legal_finalize_delivery_package', { factDate: '2026-09-01',
        ...await traceableDeliveryInput(orgId, '被告应承担违约责任。', caseId),
        orgId,
        userId: 'vitest',
        caseId,
        caseName: '案件归档闭环测试案',
        documentType: '代理词',
        outputDir: dir,
        reasoningMatrix: 'Major premise: The cited civil statute provides a contractual damages remedy subject to proof.\nMinor premise: The synthetic contract and delivery records show an unpaid obligation.\nConclusion: Apply the contractual damages provision to proven delivery and nonpayment, subject to lawyer review.',
        includeDocx: false,
        content: [
          '# 代理词草稿',
          '根据《民法典》第五百八十五条，被告应承担违约责任。',
        ].join('\n'),
      });
      expect(delivery).toContain('案件空间：已归档正式交付包');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.getCase(orgId, caseId!);
      expect(caseFile?.materials.some(material => material.title.includes('半自动立案交接单'))).toBe(true);
      expect(caseFile?.materials.some(material => material.title.includes('正式交付包'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns legal meeting transcripts into archived case minutes', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-meeting-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_meeting_'));
    const caseName = '法律会议闭环测试案';

    try {
      const output = await registry.execute('legal_meeting_minutes_to_case', {
        orgId,
        userId: 'vitest',
        caseName,
        caseType: '买卖合同纠纷',
        stage: '咨询',
        participants: '承办律师、原告法务、业务负责人',
        meetingTime: '2026-07-10 09:30',
        objective: '整理立案前事实、证据和期限',
        report: '已有模型会议报告：付款条件和质量争议需核对。证据核对真实性、合法性、关联性；7月15安排仅以会议原文为线索，法院期限待确认。',
        outputDir: dir,
        transcript: [
          '双方在2026年3月签订买卖合同，被告收货后只支付部分货款。',
          '现有证据包括合同原件、送货单、发票、银行流水和微信催款聊天记录。',
          '争议焦点是付款条件是否成就、逾期付款责任以及违约金是否过高。',
          '需要在7月15日前提交立案材料，并确认电子数据导出方式。',
        ].join('\n'),
      });

      expect(output).toContain('法律会议纪要已生成');
      expect(output).toContain('纪要文件');
      expect(output).toContain('实时摘要文件');
      expect(output).toContain('行动项文件');
      expect(output).toContain('案件更新文件');
      expect(output).toContain('案件空间：已归档');
      expect(output).toContain('法律成果预检');

      const minutesPath = path.join(dir, 'legal-meeting-minutes.md');
      const liveBriefPath = path.join(dir, 'legal-meeting-live-brief.md');
      const actionItemsPath = path.join(dir, 'legal-meeting-action-items.md');
      const caseUpdatePath = path.join(dir, 'legal-meeting-case-update.md');
      expect(fs.existsSync(minutesPath)).toBe(true);
      expect(fs.existsSync(liveBriefPath)).toBe(true);
      expect(fs.existsSync(actionItemsPath)).toBe(true);
      expect(fs.existsSync(caseUpdatePath)).toBe(true);
      const markdown = fs.readFileSync(minutesPath, 'utf8');
      expect(markdown).toContain('已有模型会议报告');
      expect(markdown).not.toContain('原始转写/沟通记录');
      expect(markdown).not.toContain('双方在2026年3月签订买卖合同');
      expect(markdown).not.toContain('需要在7月15日前提交立案材料');
      expect(markdown).toContain('法律成果预检');
      expect(markdown).not.toContain('legal_case_workspace');
      expect(fs.readFileSync(liveBriefPath, 'utf8')).toContain('已有模型会议报告');
      expect(fs.readFileSync(actionItemsPath, 'utf8')).toContain('已有模型会议报告');
      expect(fs.readFileSync(caseUpdatePath, 'utf8')).toContain('需要在7月15日前提交立案材料');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials).toHaveLength(2);
      expect(caseFile?.materials.some(material => (
        material.source === 'import' && material.type === 'consultation'
        && material.localPath === caseUpdatePath && material.content === fs.readFileSync(caseUpdatePath, 'utf8')
        && material.content.includes('双方在2026年3月签订买卖合同') && material.content.includes('需要在7月15日前提交立案材料')
      ))).toBe(true);
      expect(caseFile?.materials.some(material => (
        material.source === 'tool' && material.type === 'note'
        && material.localPath === minutesPath && material.content.includes('已有模型会议报告')
      ))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates archived legal reasoning matrices for syllogism-style case analysis', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-reasoning-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_reasoning_'));
    const caseName = '三段论分析闭环测试案';

    try {
      const output = await registry.execute('legal_case_reasoning_matrix', { factDate: '2026-09-01',
        orgId,
        userId: 'vitest',
        caseName,
        role: '原告',
        caseType: '买卖合同纠纷',
        facts: '双方签订买卖合同后，原告完成供货，被告收货后拖欠剩余货款。',
        evidence: '买卖合同；送货单；签收单；银行流水；微信催款记录',
        issues: ['付款条件是否成就', '被告是否应承担逾期付款违约责任'],
        legalAuthorities: '拟引用《民法典》第五百八十五条。',
        similarCases: '待检索最高人民法院、高级人民法院、中级人民法院和基层人民法院类案。',
        outputDir: dir,
      });

      expect(output).toContain('法律分析未完成，已保留待补底稿');
      expect(output).toContain('现行有效法律预检：通过');
      expect(output).toContain('底稿文件');
      expect(output).toContain('案件空间：已归档');

      const matrixPath = path.join(dir, 'legal-reasoning-matrix.md');
      expect(fs.existsSync(matrixPath)).toBe(true);
      const markdown = fs.readFileSync(matrixPath, 'utf8');
      expect(markdown).toContain('法律分析三段论底稿');
      expect(markdown).toContain('大前提：检索法律、解释法律、类案补强');
      expect(markdown).toContain('小前提：待证事实、证据材料、举证质证');
      expect(markdown).toContain('结论：涵摄、文书表达、风险');
      expect(markdown).toContain('最高人民法院 > 高级人民法院 > 中级人民法院 > 基层人民法院');
      expect(markdown).toContain('正式交付');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.source === 'tool'
        && material.type === 'note'
        && material.title.includes('法律分析三段论底稿')
        && material.localPath === matrixPath
      ))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('archives contract and bid work products into the case workspace', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-contract-bid-${Date.now()}`;
    const caseName = '合同标书闭环测试案';
    const context = await legalModelContext('仅用于虚构测试的完整初审正文，原始凭证及交叉引用仍须责任人核验，未确认未知主体、资质、报价或交付。');

    const review = await registry.execute('legal_review_contract', {
      orgId,
      userId: 'vitest',
      caseName,
      caseType: '合同审查',
      contract: [
        '建设工程施工合同',
        '发包人逾期付款的，承包人每日按合同总价30%收取违约金。',
        '任一方可单方解除合同，无需通知对方。',
      ].join('\n'),
    }, context);
    expect(review).toContain('案件归档与交付边界');
    expect(review).toContain('案件空间：已归档');
    expect(review).toContain('正式交付');

    const draft = await registry.execute('legal_draft_contract', {
      orgId,
      userId: 'vitest',
      caseName,
      caseType: '合同起草',
      type: '建设工程施工合同',
      details: '项目名称：测试工程；工期：90日；价款：待填写；需要违约责任和付款节点。',
    });
    expect(draft).toContain('合同正文没有完成生成');
    expect(draft).not.toContain('案件空间：已归档');

    const bid = await registry.execute('legal_generate_bid', {
      orgId,
      userId: 'vitest',
      caseName,
      caseType: '投标/招标文件响应',
      projectName: '测试工程投标项目',
      requirements: '招标要求：提交商务标、技术标、项目管理机构、施工组织设计、授权委托书和报价清单。',
    }, context);
    expect(bid).toContain('投标响应工作底稿');
    expect(bid).toContain('案件空间：已归档');
    expect(bid).not.toContain('三段论核心基础');
    expect(bid).toContain('正式投标文件仍需人工补齐资质、业绩、报价和签章材料');

    const LegalCases = await import('../server/org/legal_cases');
    const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
    expect(caseFile?.materials.some(material => (
      material.type === 'contract'
      && material.title.includes('合同审查报告')
    ))).toBe(true);
    expect(caseFile?.materials.some(material => (
      material.type === 'contract'
      && material.title.includes('合同起草底稿')
    ))).toBe(false);
    expect(caseFile?.materials.some(material => (
      material.type === 'note'
      && material.title.includes('投标书工作底稿')
    ))).toBe(true);
  });

  it('keeps generated prose out of source evidence gaps in workflow status', async () => {
    const registry = createLegalRegistry();
    const cases = await import('../server/org/legal_cases');
    const orgId = `status-evidence-${Date.now()}`;
    const caseFile = cases.createCase(orgId, 'vitest', { title: '来源边界测试案' });
    cases.addMaterial(orgId, 'vitest', caseFile.id, { type: 'evidence', title: '付款流水', source: 'manual', content: '原始付款证据标记' });
    cases.addMaterial(orgId, 'vitest', caseFile.id, { type: 'note', title: '投标书工作底稿', source: 'tool', content: '模型派生正文不属于原始证据' });
    const output = await registry.execute('legal_case_workflow_status', { orgId, userId: 'vitest', caseId: caseFile.id });
    expect(output).toContain('原始付款证据标记');
    expect(output).not.toContain('模型派生正文不属于原始证据');
  });

  it('preflights draft legal work products before formal delivery', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_generate_argument_or_opinion', {
      caseName: '草稿法源预检测试案',
      role: '原告',
      caseType: '买卖合同纠纷',
      facts: '双方发生买卖合同纠纷，草稿材料中仍写有根据《合同法》第六十条主张继续履行。',
      evidence: '买卖合同、发货单、聊天记录。',
      objective: '生成代理词草稿并提示法源风险。',
    }, await legalModelContext("# 代理词草稿\n争议焦点及证据评价。文中《合同法》第六十条为未核验引用，正式法律意见需律师复核。"));

    expect(output).toContain('法律成果预检');
    expect(output).toContain('现行有效法律预检：未通过');
    expect(output).toContain('合同法');
    expect(output).toContain('不得标记为正式成果');
    expect(output).toContain('正式交付');
  });

  it('archives core litigation work products into the same case workspace', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-core-products-${Date.now()}`;
    const caseName = '核心办案产物闭环测试案';

    const packet = await registry.execute('legal_generate_litigation_packet', {
      orgId,
      userId: 'vitest',
      caseName,
      role: '原告',
      parties: '虚构供货方/虚构采购方',
      claims: '请求按原合同核对并支付剩余货款，范围待原件核验。',
      caseType: '买卖合同纠纷',
      facts: '被告收货后未付剩余货款。',
      evidence: '买卖合同；送货单；签收单；银行流水。',
    }, await legalModelContext('# 虚构诉讼文书草稿\n仅依据本次虚构材料起草，付款及交货事实均待核验，不假定催告、逾期或质量抗辩成立；当事人身份、日期及正式提交均须律师复核。'));
    const focus = await registry.execute('legal_extract_dispute_focus', {
      orgId,
      userId: 'vitest',
      caseName,
      role: '原告',
      caseType: '买卖合同纠纷',
      complaint: '请求支付货款及违约金。',
      evidence: '合同、送货单、签收单、银行流水。',
    });
    const cases = await import('../server/org/legal_cases');
    const caseFile = cases.listCases(orgId, caseName, 1)[0];
    const sourceInput = await reasoningSourceInput(orgId, 'vitest', caseName, '原告主张已完成供货，被告主张质量待核验；付款与交易关联仍需核实。', caseFile.id);
    const argument = await registry.execute('legal_generate_argument_or_opinion', {
      orgId,
      userId: 'vitest',
      caseName,
      role: '原告',
      documentType: '代理词',
      ...sourceInput,
      caseType: '买卖合同纠纷',
      facts: '原告已完成供货，被告收货后拖欠货款。',
      issues: ['付款条件是否成就', '被告是否应承担违约责任'],
      evidence: '合同、送货单、签收单、银行流水。',
      objective: '请求支持货款和违约金。',
    }, await legalModelContext("# 代理词草稿\n依据虚构供货与拒付材料，先核验签收和质量证据，再决定请求范围。律师复核清单：法源待核验，证据待补证。"));
    const strategy = await registry.execute('legal_case_strategy', {
      orgId, userId: 'vitest', caseName, caseType: '买卖合同纠纷', ...sourceInput,
      facts: '原告主张已完成供货，被告以质量问题拒付；主张及原件待核实。',
    }, await legalModelContext('依据虚构材料，先核验签收和质量证据，再决定请求范围。'));

    for (const output of [packet, focus, argument, strategy]) {
      expect(output).toContain('案件归档与交付边界');
      expect(output).toContain('案件空间：已归档');
      expect(output).toContain('正式交付');
    }

    const LegalCases = await import('../server/org/legal_cases');
    const archived = LegalCases.getCase(orgId, caseFile.id)!;
    const titles = archived.materials.map(material => material.title).join('\n') || '';
    expect(titles).toContain('半自动诉讼文书包');
    expect(titles).toContain('争议焦点提炼');
    expect(titles).toContain('代理词草稿');
    expect(titles).toContain('应对策略草稿');
    expect(archived.materials.find(material => material.title.endsWith('应对策略草稿'))).toMatchObject({ type: 'note', source: 'tool' });
    expect(decodeToolResult(argument).receipt).toMatchObject({ ok: true, reasoningLinked: true, reasoningReviewed: true });
    expect(decodeToolResult(strategy).receipt).toMatchObject({ ok: true, reasoningLinked: true, reasoningReviewed: true });
  });


  it.each([{ generationMs: 70_000, reviewMs: 10_000, succeeds: true }, { generationMs: 70_000, reviewMs: 70_000, succeeds: true }, { generationMs: 80_000, reviewMs: 110_000, succeeds: false }])('uses a 180-second workflow and90-second stage budget for generation $generationMs and review $reviewMs', async ({ generationMs, reviewMs, succeeds }) => {
    const { upsertUserPreferredLLM } = await import('../server/llm/user_preferences');
    const cases = await import('../server/org/legal_cases');
    const userId = 'slow-strategy-model-user';
    upsertUserPreferredLLM(userId, { provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'pinned' });
    const args = await reasoningSourceInput(cases.legalWorkspaceNamespace(userId), userId, 'Slow strategy acceptance', '虚构合同80万元，付款截图记载20万元，交货与付款对应关系未确认。');
    const create = vi.fn(async (request: any, options: any) => (async function* () {
      const prompt = String(request.messages.find((message: any) => message.role === 'user').content);
      const duration = prompt.includes('你是法律适用复核者') ? reviewMs : generationMs;
      yield { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] };
      for (let elapsed = 0; elapsed < duration; elapsed += 10_000) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
          const timer = setTimeout(() => { options?.signal?.removeEventListener('abort', abort); resolve(); }, Math.min(10_000, duration - elapsed));
          options?.signal?.addEventListener('abort', abort, { once: true });
        });
        if (elapsed + 10_000 < duration) yield { choices: [{ delta: {}, finish_reason: null }] };
      }
      yield { choices: [{ delta: { content: reasoningReply(prompt, 'CASE_SPECIFIC_STRATEGY: 核验合同及付款凭证，交货与付款对应关系尚未确认。') }, finish_reason: 'stop' }] };
    })());
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = createLegalRegistry().execute('legal_case_strategy', {
        ...args, caseName: 'Slow strategy acceptance', facts: '虚构合同80万元，付款截图记载20万元，交货与付款对应关系未确认。', persistCase: false,
      }, { userId, domain: 'personal', llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } }).then(value => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(generationMs + 1);
      expect(settled).toBe(false);
      expect(create).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(Math.min(reviewMs, 90_000) + 1);
      const result = decodeToolResult(await pending);
      expect(result.receipt).toMatchObject({ ok: succeeds, status: succeeds ? 'generated' : 'partial', reasoningReviewed: succeeds });
      if (succeeds) expect(result.content).toContain('CASE_SPECIFIC_STRATEGY');
      else { expect(result.content).not.toContain('CASE_SPECIFIC_STRATEGY'); expect(result.content).toMatch(/预算|超时/); }
      for (const [request] of create.mock.calls) {
        expect(request).toMatchObject({ max_tokens: 8192 });
        expect(request).not.toHaveProperty('reasoning_effort');
        expect(request).not.toHaveProperty('thinking');
      }
    } finally { vi.useRealTimers(); }
  });

  it('does not archive a static success template when the strategy model is unavailable', async () => {
    const { caseStrategyHandler } = await import('../server/regions/packs/cn/legal_tools/argument_drafting');
    const LegalCases = await import('../server/org/legal_cases');
    const userId = 'missing-strategy-model-user', namespace = LegalCases.legalWorkspaceNamespace(userId);
    const result = decodeToolResult(await caseStrategyHandler({ caseName: 'Missing model strategy', facts: '虚构事实，交货待核实。', persistCase: true }, { userId, domain: 'personal', llmGetters: null }));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).toContain('拟议正文未完成');
    expect(LegalCases.listCases(namespace, 'Missing model strategy', 10)).toHaveLength(0);
  });
  it('keeps unavailable asset and equity reports partial without archiving them as case evidence', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-asset-equity-${Date.now()}`;
    const caseName = '执行财产线索闭环测试案';
    const LegalCases = await import('../server/org/legal_cases');
    const caseFile = LegalCases.createCase(orgId, 'vitest', { title: caseName, notes: '已有事实摘要保持原样' });
    LegalCases.addMaterial(orgId, 'vitest', caseFile.id, { title: '既有原件', content: '原始材料不能被查询失败报告替代', type: 'evidence', source: 'manual' });
    const before = LegalCases.getCase(orgId, caseFile.id)!;
    const subjectName = `测试被执行人${Date.now()}`;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 404, headers: { 'content-type': 'text/plain' } }),
    );

    try {
      const assets = await registry.execute('legal_trace_assets', {
        orgId,
        userId: 'vitest',
        caseName,
        caseId: caseFile.id,
        caseType: '执行/财产保全',
        name: subjectName,
      });
      const equity = await registry.execute('legal_equity_penetration', {
        orgId,
        userId: 'vitest',
        caseName,
        caseId: caseFile.id,
        caseType: '主体/股权穿透',
        name: `${subjectName}有限公司`,
      });

      expect(assets).toContain('财产线索报告');
      expect(decodeToolResult(assets).receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
      expect(assets).toContain('案件空间：未归档');
      expect(equity).toContain('授权网页登录协作');
      expect(decodeToolResult(equity).receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
      expect(equity).toContain('案件空间：未归档');

      const after = LegalCases.getCase(orgId, caseFile.id)!;
      expect(after.materials).toEqual(before.materials);
      expect(after.notes).toBe(before.notes);
      expect(after.workflowRuns?.slice(-2).map(run => ({ tool: run.tool, ok: run.ok, status: run.status, materialIds: run.materialIds }))).toEqual([
        { tool: 'legal_equity_penetration', ok: false, status: 'partial', materialIds: [] },
        { tool: 'legal_trace_assets', ok: false, status: 'partial', materialIds: [] },
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('generates bid work products directly from local tender files', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-bid-file-${Date.now()}`;
    const caseName = '招标文件直读闭环测试案';
    const context = await legalModelContext('虚构项目仅按招标来源起草响应，报价及资质待责任人核实，未确认或提交任何投标材料。');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_bid_file_'));
    const tenderPath = path.join(dir, 'tender-requirements.txt');

    try {
      fs.writeFileSync(tenderPath, [
        '招标要求：提交商务标、技术标、项目管理机构、施工组织设计。',
        '评分标准：企业资质、类似业绩、技术方案、报价清单、授权委托书。',
        '合同条款：需响应付款节点、违约责任、工期、质量标准。',
      ].join('\n'), 'utf8');

      const output = await registry.execute('legal_generate_bid', {
        orgId,
        userId: 'vitest',
        caseName,
        caseType: '投标/招标文件响应',
        projectName: '直读招标文件测试项目',
        filePath: tenderPath,
      }, context);

      expect(output).toContain('直读招标文件测试项目');
      expect(output).toContain('招标文件来源');
      expect(output).toContain('tender-requirements.txt');
      expect(output).toContain('案件空间：已归档');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.type === 'note'
        && material.title.includes('投标书工作底稿')
        && material.content.includes('招标文件来源')
        && material.content.includes('tender-requirements.txt')
      ))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('processes SMS and court notice links with case archive records', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-notice-link-${Date.now()}`;
    const caseName = '短信通知链接闭环测试案';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>上海市黄浦区人民法院 开庭通知 （2026）沪0101民初123号 2026年7月15日开庭。</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    try {
      const output = await registry.execute('legal_process_notice_link', {
        orgId,
        userId: 'vitest',
        caseName,
        noticeText: '【人民法院】你有一份开庭通知，请查看 https://court.example.test/notice/123',
      });

      expect(output).toContain('短信/通知链接处理结果');
      expect(output).toContain('留痕报告');
      expect(output).toContain('案件空间归档');
      expect(output).toContain('案件空间：已归档');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.type === 'note'
        && material.title.includes('短信/法院通知链接材料')
        && material.content.includes('开庭通知')
      ))).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('archives remote legal bot messages into the case workflow', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-message-intake-${Date.now()}`;
    const caseName = '远程消息入案闭环测试案';

    const output = await registry.execute('legal_message_intake_to_case', {
      orgId,
      userId: 'vitest',
      platform: 'wechat',
      sender: '阿陆',
      caseName,
      message: [
        '请发给 Lumi 入案：买卖合同纠纷。',
        '被告收货后未支付尾款，证据包括合同、送货单、微信催款记录。',
        '法院短信链接 https://court.example.test/notice/456',
      ].join('\n'),
      fileNames: ['微信聊天记录导出.pdf'],
      processLinks: false,
    });

    expect(output).toContain('远程法律消息已入案');
    expect(output).toContain('平台：微信');
    expect(output).toContain('发送人：阿陆');
    expect(output).toContain('案件闭环状态');
    expect(output).toContain('processLinks=false');
    expect(output).toContain('下一动作');

    const LegalCases = await import('../server/org/legal_cases');
    const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
    expect(caseFile).toBeTruthy();
    expect(caseFile.materials.some(material => (
      material.source === 'wechat'
      && material.type === 'consultation'
      && material.title.includes('微信法律消息原文')
      && material.content.includes('court.example.test/notice/456')
      && material.content.includes('阿陆')
    ))).toBe(true);
  });

  it('generates argument and legal-opinion drafts through source binding and automatic review without lawyer approval', async () => {
    const registry = createLegalRegistry();
    const cases = await import('../server/org/legal_cases');
    const modelContext = await legalModelContext('争议焦点及法律分析：付款与质量主张须核对原件，证据仍待补证并经律师核验。');
    const orgId = cases.legalWorkspaceNamespace(modelContext.userId);
    const argumentInput = await reasoningSourceInput(orgId, modelContext.userId, 'Argument Draft Case', '原告主张已完成供货，被告以质量问题拒付剩余货款；主张待原件核实。');
    const opinionInput = await reasoningSourceInput(orgId, modelContext.userId, 'Opinion Draft Case', '客户主张质量异议并需评估付款与违约责任，验收资料尚未核实。');

    const argument = await registry.execute('legal_generate_argument_or_opinion', {
      ...argumentInput,
      caseName: 'Argument Draft Case',
      role: 'plaintiff',
      documentType: '代理词',
      caseType: '买卖合同纠纷',
      facts: '双方签订买卖合同后，原告完成供货，被告以质量问题拒付剩余货款。',
      issues: ['付款条件是否成就', '质量异议抗辩是否成立', '违约金是否需要调整'],
      evidence: '合同、订单、发货单、签收单、发票、银行流水。',
      opponentArguments: '被告主张货物存在质量问题，拒绝支付剩余货款。',
      objective: '请求支持货款和违约金。',
    }, modelContext);
    const opinion = await registry.execute('legal_generate_argument_or_opinion', {
      ...opinionInput,
      caseName: 'Opinion Draft Case',
      role: 'defendant',
      documentType: '法律意见书',
      caseType: '买卖合同纠纷',
      facts: '客户收到起诉状后，需要评估质量异议抗辩、违约金调整和和解空间。',
      evidence: '验收异议函、退货沟通记录、检测报告。',
      opponentArguments: '原告主张已按约供货并要求支付全额货款。',
      objective: '形成应诉和谈判意见。',
    }, modelContext);

    for (const output of [argument, opinion]) {
      expect(decodeToolResult(output).receipt).toMatchObject({ ok: true, reasoningLinked: true, reasoningReviewed: true });
      expect(output).toContain('大前提');
      expect(output).toContain('本案材料'); expect(output).toContain('规则原文衔接片段');
      expect(output).toContain('未经律师核准');
      expect(output).toMatch(/争议焦点|法律分析|证据评价|复核清单/);
      expect(output).toMatch(/待检索|待核验|待补证|律师/);
    }
    expect(argument).toMatch(/代理词|结论请求/);
    expect(opinion).toMatch(/法律意见书|风险提示|处理建议/);
  });

  it('builds external research plans around authorized browser sessions', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-research-plan-${Date.now()}`;
    const caseName = '外部检索行动单归档测试案';

    const output = await registry.execute('legal_external_research_plan', {
      orgId,
      userId: 'vitest',
      caseName,
      caseType: '买卖合同纠纷',
      facts: '合同履行后拖欠货款，争议集中在质量异议、付款条件和违约金调整。',
      issues: ['货款支付条件', '质量异议抗辩', '违约金调整'],
      companyNames: ['Beta Retail Co.', 'Alpha Trading Co.'],
    });

    expect(output).not.toContain('web_login_profile_save_from_preset');
    expect(output).not.toContain('web_login_run');
    expect(output).not.toMatch(/底层三段论|三段论检索框架|大前提|小前提|涵摄/);
    expect(output).not.toContain('"profileId":"court-online-service"');
    expect(output).toContain('https://zxfw.court.gov.cn/');
    expect(output).toContain('people-court-case-library');
    expect(output).toContain('china-judgments-online');
    expect(output).toContain('fachan');
    expect(output).toContain('alpha-lawyer');
    expect(output).toContain('qichacha');
    expect(output).toContain('national-enterprise-credit');
    expect(output).toContain('court-online-service');
    expect(output).toMatch(/来源登记表|来源.*登记/);
    expect(output).toContain('案件空间：已归档');

    const LegalCases = await import('../server/org/legal_cases');
    const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
    expect(caseFile?.materials.some(material => (
      material.source === 'tool'
      && material.type === 'note'
      && material.title.includes('外部检索行动单')
    ))).toBe(true);
  });

  it('writes formal legal delivery packages with DOCX and citation reports', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-delivery-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_'));

    try {
      await registry.execute('legal_import_judgment', {
        orgId,
        userId: 'vitest',
        content: [
          '上海市黄浦区人民法院',
          '（2025）沪0101民初123号',
          '案由：买卖合同纠纷',
          '本院认为，买卖合同依法成立并生效，买受人应依约支付价款。',
          '裁判日期：二〇二五年六月一日',
        ].join('\n'),
      });

      const output = await registry.execute('legal_finalize_delivery_package', { factDate: '2026-09-01',
        orgId,
        userId: 'vitest',
        caseName: '正式交付测试案',
        ...await traceableDeliveryInput(orgId, '被告应支付货款并承担违约责任。', undefined, '正式交付测试案'),
        documentType: '代理词',
        caseType: '买卖合同纠纷',
        role: '原告',
        court: '上海市黄浦区人民法院',
        lawFirmName: '测试律师事务所',
        lawyerName: '测试律师',
        outputDir: dir,
        includeDocx: true,
        includePdf: false,
        reasoningSummary: [
          '大前提：依据《民法典》第五百八十五条及买卖合同违约责任规则。',
          '小前提：原告已供货，被告未按约付款，证据包括合同、送货单和付款记录。',
          '结论：被告应承担付款和违约责任，代理词围绕合同成立、履行和违约责任展开。',
        ].join('\n'),
        content: [
          '# 代理词草稿',
          '根据《民法典》第五百八十五条，结合（2025）沪0101民初123号案件材料，形成如下意见。',
          '一、双方存在买卖合同关系。',
          '二、被告应支付货款并承担违约责任。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包已生成');
      expect(output).toContain('引用核验报告');
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_citation-verification-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '03_source-register.md'))).toBe(true);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(true);

      const report = fs.readFileSync(path.join(dir, '02_citation-verification-report.md'), 'utf-8');
      expect(report).toContain('引用核验报告');
      expect(output).toContain('现行有效法律硬门槛：通过');
      expect(report).toContain('现行有效法律硬门槛：通过');
      expect(report).toMatch(/民法典|现行有效/);
      expect(report).not.toContain('合同法');
      expect(report).toContain('已废止/失效风险：0');
      expect(report).toContain('律师最终检索');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks formal legal delivery packages when the reasoning chain is missing', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_reasoning_blocked_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', { factDate: '2026-09-01',
        caseName: '三段论阻断测试案',
        documentType: '法律意见书',
        outputDir: dir,
        includeDocx: true,
        content: [
          '# 法律意见书草稿',
          '根据《民法典》第五百八十五条，形成如下法律意见。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包未生成');
      expect(output).toContain('推理底稿结构不完整');
      expect(output).not.toContain('legal_case_reasoning_matrix');
      expect(fs.existsSync(path.join(dir, '00_reasoning-gate-blocked.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_citation-verification-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '03_source-register.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(false);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks formal legal delivery packages when no current-law citation is present', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_no_statute_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', { factDate: '2026-09-01',
        caseName: '无法条引用阻断测试案',
        documentType: '法律意见书',
        outputDir: dir,
        includeDocx: true,
        reasoningSummary: [
          '大前提：本意见需要补充现行有效法律依据后才能作为正式法律文书交付。',
          '小前提：原告已供货，被告未付款，证据包括合同、送货单和付款记录。',
          '结论：被告可能承担付款责任，但正式文书前必须补充可核验法条引用。',
        ].join('\n'),
        content: [
          '# 法律意见书草稿',
          '原告已供货，被告未支付剩余货款，建议主张付款责任。',
          '该草稿故意不写具体法条名称，用于验证正式交付 gate。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包未生成');
      expect(output).toContain('正式法律交付包未检测到可核验的法条引用');
      expect(output).toContain('已识别法条数：0');
      expect(fs.existsSync(path.join(dir, '00_current-law-gate-blocked.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_citation-verification-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '03_source-register.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(false);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(false);

      const report = fs.readFileSync(path.join(dir, '02_citation-verification-report.md'), 'utf-8');
      expect(report).toContain('现行有效法律硬门槛：未通过');
      const gateReport = fs.readFileSync(path.join(dir, '00_current-law-gate-blocked.md'), 'utf-8');
      expect(gateReport).toContain('Missing statute citation: yes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks formal legal delivery packages when case citations are not source-verified', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-delivery-case-source-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_case_source_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', { factDate: '2026-09-01',
        orgId,
        userId: 'vitest',
        caseName: '未核验类案阻断测试案',
        documentType: '代理词',
        outputDir: dir,
        includeDocx: true,
        reasoningSummary: [
          '大前提：依据《民法典》第五百八十五条，违约方应承担违约责任，并可结合已核验类案裁判规则补强。',
          '小前提：原告已供货，被告未付款，证据包括合同、送货单和付款记录。',
          '结论：被告应承担付款及违约责任，但类案引用必须先完成来源核验。',
        ].join('\n'),
        content: [
          '# 代理词草稿',
          '根据《民法典》第五百八十五条，并参照（2026）沪0101民初999号裁判思路，原告请求应获支持。',
          '该案号故意未导入组织知识库，用于验证案例来源 gate。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包未生成');
      expect(output).toContain('类案/案号来源硬门槛未通过');
      expect(output).toContain('未核验案例数：1');
      expect(output).toContain('（2026）沪0101民初999号');
      expect(fs.existsSync(path.join(dir, '00_case-source-gate-blocked.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_citation-verification-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '03_source-register.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(false);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(false);

      const report = fs.readFileSync(path.join(dir, '02_citation-verification-report.md'), 'utf-8');
      expect(report).toContain('现行有效法律硬门槛：通过');
      expect(report).toContain('类案/案号来源硬门槛：未通过');
      const gateReport = fs.readFileSync(path.join(dir, '00_case-source-gate-blocked.md'), 'utf-8');
      expect(gateReport).toContain('Missing Case Citations');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not block formal delivery when the only unarchived case number is the current case', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-delivery-own-case-${Date.now()}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_own_case_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', { factDate: '2026-09-01',
        orgId,
        userId: 'vitest',
        caseName: '本案案号豁免测试案',
        ...await traceableDeliveryInput(orgId, '被告应承担违约责任。', undefined, '本案案号豁免测试案'),
        caseNumber: '（2026）沪0101民初888号',
        documentType: '代理词',
        outputDir: dir,
        includeDocx: false,
        reasoningSummary: [
          '大前提：依据《民法典》第五百八十五条，违约方应承担违约责任。',
          '小前提：本案（2026）沪0101民初888号中，原告已供货，被告未付款。',
          '结论：被告应承担付款及违约责任。',
        ].join('\n'),
        content: [
          '# 代理词草稿',
          '本案案号为（2026）沪0101民初888号。根据《民法典》第五百八十五条，被告应承担违约责任。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包已生成');
      expect(fs.existsSync(path.join(dir, '00_case-source-gate-blocked.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(true);
      const report = fs.readFileSync(path.join(dir, '02_citation-verification-report.md'), 'utf-8');
      expect(report).toContain('类案/案号来源硬门槛：通过');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses archived case reasoning matrices for formal delivery packages', async () => {
    const registry = createLegalRegistry();
    const orgId = `test-legal-delivery-archived-reasoning-${Date.now()}`;
    const reasoningDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_reasoning_for_delivery_'));
    const deliveryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_archived_reasoning_'));
    const caseName = '归档三段论复用测试案';

    try {
      await registry.execute('legal_case_reasoning_matrix', { factDate: '2026-09-01',
        ...await traceableDeliveryInput(orgId, '原告请求被告支付货款并承担违约责任。', undefined, caseName),
        orgId,
        userId: 'vitest',
        caseName,
        role: '原告',
        caseType: '买卖合同纠纷',
        facts: '原告已供货，被告签收后未支付剩余货款。',
        evidence: '买卖合同、送货单、签收单、银行流水。',
        issues: ['被告是否应支付货款和违约金'],
        legalAuthorities: '引用《民法典》第五百八十五条。',
        outputDir: reasoningDir,
      });

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.id).toBeTruthy();

      const output = await registry.execute('legal_finalize_delivery_package', { factDate: '2026-09-01',
        orgId,
        userId: 'vitest',
        caseId: caseFile.id,
        caseName,
        documentType: '代理词',
        outputDir: deliveryDir,
        includeDocx: false,
        content: [
          '# 代理词草稿',
          '根据《民法典》第五百八十五条，原告请求被告支付货款并承担违约责任。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包已生成');
      expect(output).toContain('推理底稿结构检查：通过');
      expect(fs.existsSync(path.join(deliveryDir, '00_manifest.md'))).toBe(true);
      expect(fs.existsSync(path.join(deliveryDir, '00_reasoning-gate-blocked.md'))).toBe(false);
      const sourceRegister = fs.readFileSync(path.join(deliveryDir, '03_source-register.md'), 'utf-8');
      expect(sourceRegister).toContain('已归档三段论底稿');
      expect(sourceRegister).toContain('已复用');
    } finally {
      fs.rmSync(reasoningDir, { recursive: true, force: true });
      fs.rmSync(deliveryDir, { recursive: true, force: true });
    }
  });

  it('blocks formal legal delivery packages when statute citations are repealed or unverified', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_blocked_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', { factDate: '2026-09-01',
        caseName: '废止法阻断测试案',
        documentType: '代理词',
        caseType: '买卖合同纠纷',
        role: '原告',
        outputDir: dir,
        includeDocx: true,
        content: [
          '# 代理词草稿',
          '根据《合同法》第六十条，原告请求被告承担违约责任。',
          '本段故意引用已废止法律，用于验证正式交付包硬门槛。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包未生成');
      expect(output).toContain('现行有效法律硬门槛未通过');
      expect(output).toContain('合同法');
      expect(fs.existsSync(path.join(dir, '00_current-law-gate-blocked.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_citation-verification-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '03_source-register.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '00_manifest.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(false);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(false);

      const report = fs.readFileSync(path.join(dir, '02_citation-verification-report.md'), 'utf-8');
      expect(report).toContain('现行有效法律硬门槛：未通过');
      expect(report).toMatch(/合同法|已废止/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks formal legal delivery packages when statute citations cannot be verified', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_delivery_unverified_'));

    try {
      const output = await registry.execute('legal_finalize_delivery_package', { factDate: '2026-09-01',
        caseName: '未知法条阻断测试案',
        documentType: '法律意见书',
        outputDir: dir,
        includeDocx: true,
        content: [
          '# 法律意见书草稿',
          '根据《不存在特别保护法》第十条，形成如下法律意见。',
        ].join('\n'),
      });

      expect(output).toContain('正式交付包未生成');
      expect(output).toContain('现行有效法律硬门槛未通过');
      expect(output).toContain('不存在特别保护法');
      expect(fs.existsSync(path.join(dir, '00_current-law-gate-blocked.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '01_formal-document.md'))).toBe(false);
      expect(fs.readdirSync(dir).some(file => file.endsWith('.docx'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes standalone citation verification reports', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_citation_'));

    try {
      const output = await registry.execute('legal_generate_citation_verification_report', {
        caseName: '引用核验测试案',
        outputDir: dir,
        text: '本案拟引用《合同法》第六十条、《民法典》第五百八十五条及（2025）沪0101民初123号。',
      });

      expect(output).toContain('引用核验报告已生成');
      expect(output).toContain('已废止/失效风险');
      const reportPath = path.join(dir, 'citation-verification-report.md');
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = fs.readFileSync(reportPath, 'utf-8');
      expect(report).toContain('引用总数');
      expect(report).toMatch(/合同法|已废止/);
      expect(report).toContain('未确认案例');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns customer instructions without backend command names or argument objects', async () => {
    const registry = createLegalRegistry();
    const status = await registry.execute('legal_external_source_status', {});
    const assets = await registry.execute('legal_trace_assets', { name: '虚构输出边界验收公司', persistCase: false });
    const handoff = await registry.execute('legal_prepare_filing_handoff', { caseName: '虚构输出边界验收案', facts: '材料尚未提供', persistCase: false });
    for (const output of [status, assets, handoff]) {
      expect(output).not.toMatch(/web_login_[a-z_]+|legal_finalize_delivery_package|legal_import_materials_to_kb|legal_trace_assets|legal_equity_penetration|\"headless\"|\"profileId\"/);
    }
    expect(assets).toContain('企查查官网');
    expect(handoff).toContain('https://zxfw.court.gov.cn/');
  });

  it('writes external browser workspaces with source registers', async () => {
    const registry = createLegalRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_browser_'));

    try {
      const output = await registry.execute('legal_prepare_external_browser_workspace', {
        caseName: '外部检索测试案',
        caseType: '买卖合同纠纷',
        issues: ['付款条件是否成就', '违约金是否过高'],
        companyNames: ['Beta Retail Co.'],
        sourceIds: ['people-court-case-library', 'china-judgments-online', 'fachan', 'alpha-lawyer', 'qichacha'],
        outputDir: dir,
      }, {
        requestConfirmation: async () => true,
      });

      expect(output).toContain('外部网页登录工作区已生成');
      expect(output).not.toContain('web_login_run');
      expect(output).toContain('不自动抓取');
      expect(fs.existsSync(path.join(dir, '00_browser-workspace.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '01_source-register.csv'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '02_web-login-commands.md'))).toBe(false);
      const runbook = fs.readFileSync(path.join(dir, '00_browser-workspace.md'), 'utf-8');
      expect(runbook).toContain('人民法院案例库');
      expect(runbook).toContain('https://www.qcc.com/');
      expect(runbook).not.toMatch(/web_login_[a-z_]+|\"headless\"|\"profileId\"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports local legal materials into the organization knowledge base', async () => {
    const registry = createLegalRegistry();
    const KB = await import('../server/org/kb');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_legal_materials_'));

    try {
      fs.writeFileSync(path.join(dir, '起诉状.txt'), [
        '案由：买卖合同纠纷',
        '原告主张被告拖欠货款，争议包括付款条件是否成就。',
        '被告提出质量异议并要求扣减违约金。',
      ].join('\n'), 'utf-8');
      fs.writeFileSync(path.join(dir, '证据目录.md'), [
        '# 证据目录',
        '1. 合同：证明买卖合同关系。',
        '2. 质量异议函：证明被告曾提出质量问题。',
      ].join('\n'), 'utf-8');
      fs.writeFileSync(path.join(dir, '现场照片.png'), 'not a real image', 'utf-8');

      const output = await registry.execute('legal_import_materials_to_kb', {
        orgId: 'org-legal-material-import',
        userId: 'lawyer-1',
        folderPath: dir,
        caseName: '材料入库测试案',
        caseType: '买卖合同纠纷',
        materialType: '案件材料',
        tags: ['import-test'],
      });

      expect(output).toContain('法律材料导入知识库报告');
      expect(output).toMatch(/成功导入：2 份|成功导入：2/);
      expect(output).toMatch(/跳过\/失败：1 份|跳过\/失败：1/);
      expect(output).toContain('起诉状.txt');
      expect(output).toContain('证据目录.md');
      expect(output).toContain('ocr_image_file');
      expect(output).not.toContain('legal_import_materials_to_kb');

      const results = await KB.searchKnowledgeBase('org-legal-material-import', '质量异议 付款条件', {
        limit: 5,
        status: 'published',
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.map(result => result.title)).toEqual(expect.arrayContaining(['起诉状.txt']));
      expect(results[0].chunk).toMatch(/质量异议|付款条件/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports external source capabilities without overstating web access', async () => {
    const registry = createLegalRegistry();

    const output = await registry.execute('legal_external_source_status', {});

    expect(output).toContain('外部法律数据源接入状态');
    expect(output).toContain('企查查');
    expect(output).toContain('启信宝');
    expect(output).toContain('招投标数据网关');
    expect(output).toContain('全国公共资源交易平台');
    expect(output).toContain('动产融资统一登记公示系统');
    expect(output).toContain('api');
    expect(output).toMatch(/Alpha|法蝉|中国裁判文书网/);
    expect(output).toMatch(/授权网页登录协作|网页登录/);
    expect(output).toMatch(/不绕过验证码|不绕过/);
    expect(output).not.toMatch(/已接入.*法蝉|已接入.*Alpha|自动抓取.*已完成|批量同步.*已完成/);
  });

  it('queries configured external legal authority APIs', async () => {
    const registry = createLegalRegistry();
    const original = {
      PKULAW_API_KEY: process.env.PKULAW_API_KEY,
      PKULAW_BASE_URL: process.env.PKULAW_BASE_URL,
    };
    const query = `authority-api-test-${Date.now()}`;
    const orgId = `test-legal-authority-archive-${Date.now()}`;
    const caseName = '外部类案检索归档测试案';
    process.env.PKULAW_API_KEY = 'test-pkulaw-key';
    process.env.PKULAW_BASE_URL = 'https://pkulaw.local/search';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        items: [
          {
            title: '基层法院买卖合同案例',
            caseNumber: '(2026) Test Case No.4',
            court: '上海市黄浦区人民法院',
            summary: 'A controlled mocked basic court result.',
            url: 'https://pkulaw.local/case/4',
          },
          {
            title: '最高院买卖合同案例',
            caseNumber: '(2026) Test Case No.1',
            court: '最高人民法院',
            summary: 'A controlled mocked supreme court result.',
            url: 'https://pkulaw.local/case/1',
          },
          {
            title: '中院买卖合同案例',
            caseNumber: '(2026) Test Case No.3',
            court: '上海市第一中级人民法院',
            summary: 'A controlled mocked intermediate court result.',
            url: 'https://pkulaw.local/case/3',
          },
          {
            title: '高院买卖合同案例',
            caseNumber: '(2026) Test Case No.2',
            court: '上海市高级人民法院',
            summary: 'A controlled mocked high court result.',
            url: 'https://pkulaw.local/case/2',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      const output = await registry.execute('legal_search_external_authorities', {
        orgId,
        userId: 'vitest',
        caseName,
        query,
        type: 'case',
        sourceIds: ['pkulaw'],
        limit: 4,
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(output).toContain('最高院买卖合同案例');
      expect(output).toContain('(2026) Test Case No.1');
      expect(output).toContain('pkulaw');
      expect(output).toContain('最高人民法院 > 高级人民法院 > 中级人民法院 > 基层人民法院');
      expect(output.indexOf('最高院买卖合同案例')).toBeLessThan(output.indexOf('高院买卖合同案例'));
      expect(output.indexOf('高院买卖合同案例')).toBeLessThan(output.indexOf('中院买卖合同案例'));
      expect(output.indexOf('中院买卖合同案例')).toBeLessThan(output.indexOf('基层法院买卖合同案例'));
      expect(output).toMatch(/授权|API|复核/);
      expect(output).toContain('来源登记回填');
      expect(output).toContain('案件空间：已归档');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.source === 'tool'
        && material.type === 'judgment'
        && material.title.includes('外部法律数据库检索')
        && material.content.includes('(2026) Test Case No.1')
      ))).toBe(true);
    } finally {
      fetchMock.mockRestore();
      if (original.PKULAW_API_KEY === undefined) delete process.env.PKULAW_API_KEY;
      else process.env.PKULAW_API_KEY = original.PKULAW_API_KEY;
      if (original.PKULAW_BASE_URL === undefined) delete process.env.PKULAW_BASE_URL;
      else process.env.PKULAW_BASE_URL = original.PKULAW_BASE_URL;
    }
  });

  it('queries configured company database APIs', async () => {
    const registry = createLegalRegistry();
    const original = {
      TIANYANCHA_API_KEY: process.env.TIANYANCHA_API_KEY,
      TIANYANCHA_BASE_URL: process.env.TIANYANCHA_BASE_URL,
    };
    const companyName = `Demo Tech Co ${Date.now()}`;
    const orgId = `test-legal-company-archive-${Date.now()}`;
    const caseName = '企业主体查询归档测试案';
    process.env.TIANYANCHA_API_KEY = 'test-tyc-key';
    process.env.TIANYANCHA_BASE_URL = 'https://tianyancha.local/company';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        error_code: 0,
        result: {
          name: companyName,
          legalPersonName: 'Jane Test',
          regCapital: '1000万人民币',
          regStatus: '存续',
          creditCode: '91310000TESTCODE',
          businessScope: 'software services',
          id: 123456,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      const output = await registry.execute('legal_company_database_lookup', {
        orgId,
        userId: 'vitest',
        caseName,
        name: companyName,
        sourceIds: ['tianyancha'],
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(output).toContain(companyName);
      expect(output).toContain('Jane Test');
      expect(output).toContain('91310000TESTCODE');
      expect(output).toMatch(/天眼查|API|网页登录/);
      expect(output).toContain('主体信息来源登记');
      expect(output).toContain('案件空间：已归档');

      const LegalCases = await import('../server/org/legal_cases');
      const caseFile = LegalCases.listCases(orgId, caseName, 1)[0];
      expect(caseFile?.materials.some(material => (
        material.source === 'tool'
        && material.type === 'evidence'
        && material.title.includes('企业/被执行主体数据库查询')
        && material.content.includes(companyName)
      ))).toBe(true);
    } finally {
      fetchMock.mockRestore();
      if (original.TIANYANCHA_API_KEY === undefined) delete process.env.TIANYANCHA_API_KEY;
      else process.env.TIANYANCHA_API_KEY = original.TIANYANCHA_API_KEY;
      if (original.TIANYANCHA_BASE_URL === undefined) delete process.env.TIANYANCHA_BASE_URL;
      else process.env.TIANYANCHA_BASE_URL = original.TIANYANCHA_BASE_URL;
    }
  });

  it('queries a configured Qixinbao gateway without assuming a default endpoint', async () => {
    const registry = createLegalRegistry();
    const original = {
      QIXINBAO_API_KEY: process.env.QIXINBAO_API_KEY,
      QIXINBAO_BASE_URL: process.env.QIXINBAO_BASE_URL,
    };
    const companyName = `Qixinbao Test Company ${Date.now()}`;
    process.env.QIXINBAO_API_KEY = 'test-qixinbao-key';
    process.env.QIXINBAO_BASE_URL = 'https://qixinbao.local/company-search';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        items: [{
          companyName,
          legalPersonName: 'Qixin Test Lawyer',
          registeredCapital: '500万人民币',
          regStatus: '存续',
          creditCode: '91310000QIXINTEST',
          companyId: 'qixin-1',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    try {
      const output = await registry.execute('legal_company_database_lookup', {
        name: companyName,
        sourceIds: ['qixinbao'],
        persistCase: false,
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('qixinbao.local/company-search');
      expect(output).toContain(companyName);
      expect(output).toContain('Qixin Test Lawyer');
      expect(output).toContain('91310000QIXINTEST');
      expect(output).toContain('启信宝授权 API 网关');
    } finally {
      fetchMock.mockRestore();
      if (original.QIXINBAO_API_KEY === undefined) delete process.env.QIXINBAO_API_KEY;
      else process.env.QIXINBAO_API_KEY = original.QIXINBAO_API_KEY;
      if (original.QIXINBAO_BASE_URL === undefined) delete process.env.QIXINBAO_BASE_URL;
      else process.env.QIXINBAO_BASE_URL = original.QIXINBAO_BASE_URL;
    }
  });

  it('queries a configured tender gateway and otherwise keeps an official-web handoff', async () => {
    const registry = createLegalRegistry();
    const original = {
      TENDER_DATA_API_KEY: process.env.TENDER_DATA_API_KEY,
      TENDER_DATA_BASE_URL: process.env.TENDER_DATA_BASE_URL,
    };
    const keyword = `Tender Test Company ${Date.now()}`;
    process.env.TENDER_DATA_API_KEY = 'test-tender-key';
    process.env.TENDER_DATA_BASE_URL = 'https://tender.local/search';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        records: [{
          projectName: '测试信息化采购项目',
          projectNo: 'TENDER-2026-001',
          buyerName: '测试采购单位',
          winnerName: keyword,
          winningAmount: '1280000元',
          publishDate: '2026-08-01',
          detailUrl: 'https://tender.local/notices/1',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    try {
      const output = await registry.execute('legal_search_tender_projects', {
        keyword,
        sourceIds: ['tender-data'],
        persistCase: false,
      });

      expect(fetchMock).toHaveBeenCalled();
      expect(output).toContain('测试信息化采购项目');
      expect(output).toContain('TENDER-2026-001');
      expect(output).toContain('1280000元');
      expect(output).toContain('招投标授权数据网关');
      expect(output).toContain('仅凭中标公告不能认定债权真实存在');
    } finally {
      fetchMock.mockRestore();
      if (original.TENDER_DATA_API_KEY === undefined) delete process.env.TENDER_DATA_API_KEY;
      else process.env.TENDER_DATA_API_KEY = original.TENDER_DATA_API_KEY;
      if (original.TENDER_DATA_BASE_URL === undefined) delete process.env.TENDER_DATA_BASE_URL;
      else process.env.TENDER_DATA_BASE_URL = original.TENDER_DATA_BASE_URL;
    }
  });

  it('keeps triad reasoning as core legal logic rather than a standalone UI tab', () => {
    const registry = createLegalRegistry();
    const legalHubSource = ['scope', 'workspace', 'readiness', 'case_values', 'useLegalCaseWorkspaceState'].map(file => fs.readFileSync(path.join(process.cwd(), 'src/components/org/legal_hub/' + file + '.tsx'), 'utf8')).join('\n');
    const toolRouterSource = fs.readFileSync(path.join(process.cwd(), 'server/cognition/tool_router.ts'), 'utf-8');
    const legalToolsShimSource = fs.readFileSync(path.join(process.cwd(), 'server/tools/definitions/legal_tools.ts'), 'utf-8');
    const legalToolsDir = path.join(process.cwd(), 'server/regions/packs/cn/legal_tools');
    const legalToolsSource = fs.readdirSync(legalToolsDir).filter(file => file.endsWith('.ts')).map(file => fs.readFileSync(path.join(legalToolsDir, file), 'utf8')).join('\n');
    const uiMessagesSource = fs.readFileSync(path.join(process.cwd(), 'src/i18n/locales/ui.generated.json'), 'utf-8');
    const chatRoutesSource = fs.readFileSync(path.join(process.cwd(), 'server/routes/chat_routes.ts'), 'utf-8');

    expect(legalHubSource).not.toContain("id: 'triad'");
    expect(legalHubSource).not.toContain('LegalTriadView');
    expect(legalHubSource).toContain('legal_generate_litigation_packet');
    expect(legalHubSource).toContain('legal_external_research_plan');
    expect(legalHubSource).toContain('buildLegalCaseReadiness');
    expect(legalHubSource).toContain('evaluateLegalCaseWorkflow');
    expect(legalHubSource).toContain('LEGAL_CASE_READINESS_TOOLS');
    expect(legalHubSource).not.toContain('buildLegalCaseActionSummary');
    expect(legalHubSource).not.toContain('Case Action Board');
    expect(legalHubSource).not.toContain('案件行动面板');
    expect(legalHubSource).toContain('legalCaseToolArgs');
    expect(legalHubSource).toContain("legal_case_reasoning_matrix");
    expect(legalHubSource).not.toContain('办案闭环');
    expect(uiMessagesSource).toContain('办案闭环');
    expect(legalHubSource).toContain('persistCase: true');
    expect(legalHubSource).toContain('legal_finalize_delivery_package');
    expect(legalHubSource).toContain('onAddMaterial={toolAddMaterial}');
    expect(legalHubSource).toContain('legal_process_notice_link');
    expect(legalHubSource).not.toContain('处理短信链接');
    expect(uiMessagesSource).toContain('处理短信链接');
    expect(fs.readFileSync(path.join(process.cwd(), 'src/lib/legalToolClient.ts'), 'utf-8')).toContain('/api/legal/tool/');
    expect(chatRoutesSource).toContain('DIRECT_LEGAL_TOOL_ALLOWLIST');
    expect(chatRoutesSource).toContain('/legal/tool/:toolName');
    expect(chatRoutesSource).toContain('legalToolDefinitions().map(tool => tool.name)');
    for (const name of ['legal_generate_litigation_packet', 'legal_case_strategy', 'legal_finalize_delivery_package', 'legal_process_notice_link']) expect(registry.get(name)).toBeTruthy();
    expect(registry.get('legal_triad_analysis')).toBeUndefined();
    expect(registry.get('legal_case_reasoning_matrix')).toBeTruthy();
    expect(registry.get('legal_case_workflow_status')).toBeTruthy();
    expect(registry.get('legal_message_intake_to_case')).toBeTruthy();
    expect(registry.get('legal_refresh_authoritative_sources')).toBeTruthy();
    expect(registry.get('legal_authority_source_status')).toBeTruthy();
    expect(legalToolsShimSource).toContain("../../regions/packs/cn/legal_tools");
    expect(legalToolsShimSource).not.toContain('三段论是 Lumi 法律工作的核心基础');
    expect(legalToolsSource).toContain('三段论是 Lumi 法律工作的核心基础');
    expect(legalToolsSource).toContain('formatLegalWorkflowActionQueue(workflow)');
    expect(legalToolsSource).not.toContain('formatStandardLegalCaseworkSequence');
    expect(toolRouterSource).toContain('legal_case_reasoning_matrix');
    expect(toolRouterSource).toContain('legal_case_workflow_status');
    expect(toolRouterSource).toContain('legal_message_intake_to_case');
    expect(toolRouterSource).not.toContain('legal_triad_analysis');
  });
});

describe('legal web login presets', () => {
  const requiredPresetIds = [
    'faxin',
    'china-judgments-online',
    'people-court-case-library',
    'court-online-service',
    'qichacha',
    'qixinbao',
    'tianyancha',
    'national-enterprise-credit',
    'china-enforcement-disclosure',
    'national-public-resources',
    'movable-financing-register',
    'cnipa-public-service',
    'construction-market',
    'customs-credit',
    'bankruptcy-restructuring',
    'fachan',
    'alpha-lawyer',
  ];

  it('exposes all legal research and filing presets', () => {
    const presets = listWebLoginSitePresets('legal');
    const ids = presets.map(preset => preset.id);

    expect(ids).toEqual(expect.arrayContaining(requiredPresetIds));
    for (const id of requiredPresetIds) {
      const preset = getWebLoginSitePreset(id);
      expect(preset).toBeTruthy();
      expect(preset?.loginUrl).toMatch(/^https:\/\//);
      expect(preset?.matchHosts.length).toBeGreaterThan(0);
      expect(preset?.notes).toMatch(/Lumi/);
      expect(preset?.notes).toMatch(/授权|登录|人工|验证码|限制/);
    }
  });

  it('lists legal presets through the web login tool without touching credentials', async () => {
    const registry = new ToolRegistry();
    registerWebLoginTools(registry);

    const output = await registry.execute(
      'web_login_site_presets',
      { category: 'legal' },
      { requestConfirmation: async () => true },
    );
    const data = JSON.parse(output);
    const ids = data.presets.map((preset: { id: string }) => preset.id);

    expect(ids).toEqual(expect.arrayContaining(requiredPresetIds));
    expect(data.note).not.toContain('web_login_profile_save_from_preset');
  });
});
