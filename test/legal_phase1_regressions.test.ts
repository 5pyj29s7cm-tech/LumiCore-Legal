import { packetDraftFixture } from './legal_packet_fixture';
import { reasoningChecks } from './legal_reasoning_fixture';
import { contractStructuredReply, contractPromptSources } from './legal_contract_fixture';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { makeLLMCall } from '../server/llm/providers';
import { verifyCitation, verifyMultipleCitations } from '../server/legal/kb';
import { resetStatuteAuthorityRefreshStateForTest } from '../server/legal/statute_authority_store';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import { ENCRYPTED_PDF_BASE64 } from './fixtures/encrypted_pdf';
import { createCase, getCase, addMaterial } from '../server/org/legal_cases';
import { listKbArticles } from '../server/org/db';
import { getDataDirectory } from '../server/config/data_path';
import { parseDocument } from '../server/legal/parser';
import { splitContractForReview } from '../server/regions/packs/cn/legal_work_product_quality';

vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: vi.fn(async messages => ({ text: contractStructuredReply(String(messages.find((message:any)=>message.role==='user')?.content || ''), '片段审查工作稿：原文条款、权利义务和适用条件仍需律师核对，未确认的主体、履行和交易事实保持待核实。'), toolCalls: [] })),
}));
vi.mock('../server/llm/embedding_provider', async original => ({
  ...await original<typeof import('../server/llm/embedding_provider')>(),
  generateConfiguredEmbedding: vi.fn(async () => ({ vector: [1, 0], provider: 'synthetic', model: 'offline-fixture' })),
}));

let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry();
const context = { userId: 'quality-owner', authenticated: true, authRole: 'admin', domain: 'work', orgId: 'quality-org', localExecution: true, executionBoundary: 'trusted_local' } as any;
const run = (name: string, args: Record<string, any>, extra = {}) => executeToolCall({ registry, name, arguments: { orgId: 'quality-org', userId: 'quality-owner', persistCase: false, ...(name === 'legal_generate_litigation_packet' ? { parties: '虚构甲公司/虚构乙公司', claims: '仅按原始合同及请求核对履行范围，不追加诉费、赔偿或自认。' } : {}), ...args }, context: { ...context, ...extra } });
const batchReview = (prompt: string, corrections: any[] = []) => ({ documents: JSON.parse(prompt.split('\n文书列表：').at(-1)!).map((document: any) => ({ baseName: document.baseName, complete: true, corrections, unresolved: [] })) });
const packetTarget = (prompt: string): { baseName: string; label: string } => JSON.parse(prompt.split('## 当前文书\n').at(-1)!);
beforeAll(async () => {
  app = await makeApp();
  app.apiRouter.use('/', (await import('../routes/files')).default);
  registerLegalTools(registry);
});
afterAll(() => app.cleanup());
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks(); resetStatuteAuthorityRefreshStateForTest(); });

describe('legal phase one regressions', () => {
  it('does not replace a requested contract report with an unrelated asset report', async () => {
    const item = createCase('quality-org', 'quality-owner', { title: 'Delivery target test', notes: 'Only a synthetic case.', materials: [] });
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'contract', title: '买卖合同审查报告', content: 'Contract review draft.', source: 'tool' });
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'note', title: '财产线索报告', content: 'No verified external data.', source: 'tool' });
    const result = await run('legal_verify_archived_delivery', { caseId: item.id, materialTitle: '合同审查 合同审查报告' });
    expect(result.result).toContain('未找到与请求名称匹配');
    expect(result.result).not.toContain('核验材料：财产线索报告');
  });
  it('blocks placeholder courts when verifying an archived draft', async () => {
    const item = createCase('quality-org', 'quality-owner', { title: 'Placeholder court test', court: '待确认', notes: 'Synthetic facts only.', materials: [] });
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'contract', title: '模拟合同审查报告', content: 'Contract review draft.', source: 'tool' });
    const result = await run('legal_verify_archived_delivery', { caseId: item.id, materialTitle: '模拟合同审查报告' });
    expect(result.result).toMatch(/管辖信息\n- 阻断/);
  });
  it('keeps contract source review within its budget without forcing the model thinking setting', async () => {
    const result = await run('legal_review_contract', { contract: 'Synthetic equipment purchase: price and acceptance remain unconfirmed.' }, { llmGetters: {} });
    expect(result.receipt).toMatchObject({ ok: true });
    expect(vi.mocked(makeLLMCall).mock.calls.at(-1)?.[2]).not.toHaveProperty('thinkingMode');
    expect(vi.mocked(makeLLMCall).mock.calls.at(-1)?.[2]).not.toHaveProperty('reasoningEffort');
  });
  it('reports a partial packet when DOCX output fails despite successful Markdown files', async () => {
    const original = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file).endsWith('.docx')) throw new Error('Synthetic DOCX writer failure');
      return (original as any)(file, ...args);
    }) as any);
    const result = await run('legal_generate_litigation_packet', { role: '原告', facts: '虚构甲公司已交货，对方尚未付款。', caseName: 'DOCX失败验收' });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.result).toContain('DOCX 生成异常');
    expect((result.receipt as any).artifacts.some((p: string) => p.endsWith('.md'))).toBe(true);
  });
  it('writes model-generated pleadings into the actual individual DOCX files', async () => {
    const documents = [
      { baseName: '20_statement-of-defense', markdown: '# 答辩状\n对于九万元诉请，已有银行凭据显示支付七万元，请核对剩余本金和质量争议；该结论仅为测试草稿。' },
      { baseName: '21_cross-examination-opinion', markdown: '# 质证意见\n对方主张应与银行付款凭据逐项核对，检验报告需核实原件、形成过程及检测范围；不得将未核对内容视为承认。' },
      { baseName: '23_argument-outline', markdown: '# 代理词\n首先核实付款金额及时间，再核对交付质量与对方诉请，保留不足材料的补证事项；本段仅测试正文文件写入。' },
      { baseName: '27_evidence-catalog', markdown: '# 被告证据目录\n银行付款凭据拟用于核对七万元付款主张，原件、收款主体及与本案对应关系仍待核实；证明目的为拟议，不视为已核准事实。' },
    ];
    vi.mocked(makeLLMCall).mockImplementation(async messages => {
      const prompt = String(messages.find(message => message.role === 'user')!.content);
      return { text: JSON.stringify(prompt.startsWith('核对文书草稿') ? batchReview(prompt)
        : packetDraftFixture(prompt, documents.find(document => document.baseName === packetTarget(prompt).baseName))), toolCalls: [] } as any;
    });
    const result = await run('legal_generate_litigation_packet', { role: '被告', caseName: '独立正文验收', facts: '对方主张九万元，我方已付七万元。', evidence: '银行转账凭据。' }, { llmGetters: {} });
    expect(result.receipt).toMatchObject({ ok: true, draftMode: 'model' });
    const total = (result.receipt as any).artifacts.find((p: string) => p.endsWith('00_litigation-packet.md'));
    const document = await parseDocument(path.join(path.dirname(total), '20_statement-of-defense.docx'));
    expect(document?.text).toContain('已有银行凭据显示支付七万元');
    expect(document?.text).not.toContain('按对方每项诉讼请求');
    expect(vi.mocked(makeLLMCall).mock.calls.every(call => call[2].responseFormat === 'json_object')).toBe(true);
  });

  it('finishes a multi-document model batch that exceeds the generic 30-second tool limit', async () => {
    vi.useFakeTimers();
    vi.mocked(makeLLMCall).mockImplementation(messages => {
      const prompt = String(messages.find(message => message.role === 'user')!.content);
      if (prompt.startsWith('核对文书草稿')) return Promise.resolve({ text: JSON.stringify(batchReview(prompt)), toolCalls: [] });
      const { baseName } = packetTarget(prompt);
      return new Promise(resolve => setTimeout(() => resolve({
        text: JSON.stringify(packetDraftFixture(prompt, { baseName, markdown: '# 文书草稿\n对方九万元请求应当扣除已经支付的七万元，剩余部分需核实合同、签收和质量材料，不编造未提供事实。' })), toolCalls: [],
      } as any), 20000));
    });
    const pending = run('legal_generate_litigation_packet', { role: '被告', caseName: '分批超时回归', facts: '主张九万元，已付七万元。', writeFiles: false }, { llmGetters: {} });
    await vi.advanceTimersByTimeAsync(40001);
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.receipt).toMatchObject({ ok: true, draftMode: 'model' });
    expect(makeLLMCall).toHaveBeenCalledTimes(8);
  });

  it('retains completed documents when another document has malformed model output', async () => {
    vi.mocked(makeLLMCall).mockImplementation(async messages => {
      const prompt = String(messages.find(message => message.role === 'user')!.content);
      if (prompt.startsWith('核对文书草稿')) return { text: JSON.stringify(batchReview(prompt)), toolCalls: [] };
      const { baseName } = packetTarget(prompt);
      if (baseName === '16_evidence-catalog') return { text: '{"baseName":', toolCalls: [] } as any;
      const markdown = baseName === '10_civil-complaint'
        ? '# 起诉状\n虚构甲公司供货后已收到七万元，尚欠二万元，具体交易事实应与合同和签收单逐项核对，不推定未知的违约金数额。'
        : '# 原告证据目录\n七万元付款主张拟以原始银行记录核对，收款主体、对应关系和付款期限均待核实；不根据目录登记推定证明目的已成立。';
      return { text: JSON.stringify(packetDraftFixture(prompt, { baseName, markdown })), toolCalls: [] };
    });
    const result = await run('legal_generate_litigation_packet', { role: '原告', caseName: '部分正文保留', facts: '已收七万元，尚欠二万元。', writeFiles: false }, { llmGetters: {} });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', draftMode: 'mixed' });
    expect((result.receipt as any).draftFailures).toContainEqual({ baseName: '16_evidence-catalog', reason: 'invalid_json' });
    expect(result.result).toContain('虚构甲公司供货后已收到七万元');
    expect(result.result).toContain('正文未完成，保留结构模板');
    expect(result.result).toContain('起草 JSON 解析失败');
  });

  it('applies factual corrections to the actual pleading and refuses unreviewed output', async () => {
    vi.mocked(makeLLMCall).mockImplementation(async messages => {
      const prompt = String(messages.find(message => message.role === 'user')!.content);
      if (prompt.startsWith('核对文书草稿')) return { text: JSON.stringify(batchReview(prompt, batchReview(prompt).documents.some((document: any) => document.baseName.startsWith('10_civil-complaint/')) ? [
        { original: '原告多次催讨未付，已构成违约。', replacement: '现有材料未提供催告或付款期限，是否到期及违约须核实。', reason: '不能根据未付款自行推定催告与违约。' },
      ] : [])), toolCalls: [] };
      const { baseName } = packetTarget(prompt);
      if (baseName === '16_evidence-catalog') return { text: '{"baseName":', toolCalls: [] };
      const markdown = baseName === '10_civil-complaint'
        ? '# 起诉状\n总价九万元，已有付款记录七万元，剩余二万元的具体付款期限仍需核实。原告多次催讨未付，已构成违约。'
        : '# 原告证据目录\n付款记录拟证明七万元付款主张；原件、主体、对应关系及到期条件仍须核实，不补造催告或违约事实。';
      return { text: JSON.stringify(packetDraftFixture(prompt, { baseName, markdown })), toolCalls: [] };
    });
    const result = await run('legal_generate_litigation_packet', { role: '原告', caseName: '事实纠偏', facts: '已收七万元，尚欠二万元。' }, { llmGetters: {} });
    expect(result.receipt).toMatchObject({ ok: false, draftMode: 'mixed' });
    const total = (result.receipt as any).artifacts.find((p: string) => p.endsWith('00_litigation-packet.md'));
    const document = await parseDocument(path.join(path.dirname(total), '10_civil-complaint.docx'));
    expect(document?.text).toContain('现有材料未提供催告或付款期限');
    expect(document?.text).not.toContain('原告多次催讨未付');
  });

  it('continues just a failed review without regenerating already returned document bodies', async () => {
    const item = createCase('quality-org', 'quality-owner', { title: '文书复核接续', notes: '已付七万元，余款期限待核实。' });
    let failReview = true;
    vi.mocked(makeLLMCall).mockImplementation(async messages => {
      const prompt = String(messages.find(message => message.role === 'user')!.content);
      if (prompt.startsWith('核对文书草稿')) {
        if (failReview && batchReview(prompt).documents.some((document: any) => document.baseName.startsWith('16_evidence-catalog/'))) throw new Error('504 synthetic review timeout');
        return { text: JSON.stringify(batchReview(prompt)), toolCalls: [] };
      }
      const { baseName } = packetTarget(prompt);
      return { text: JSON.stringify(packetDraftFixture(prompt, { baseName, markdown: '# 文书草稿\n已付款记录七万元，余款支付期限及是否到期须核实；对未提供的付款条款不作确定推断，仍需律师核对原件。' })), toolCalls: [] };
    });
    const args = { caseId: item.id, role: '原告', persistCase: true };
    expect((await run('legal_generate_litigation_packet', args, { llmGetters: {} })).receipt).toMatchObject({ ok: false, draftMode: 'mixed' });
    vi.mocked(makeLLMCall).mockClear(); failReview = false;
    const resumed = await run('legal_generate_litigation_packet', args, { llmGetters: {} });
    expect(resumed.receipt).toMatchObject({ ok: true, draftMode: 'model' });
    expect(makeLLMCall).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(makeLLMCall).mock.calls[0][0].find(message => message.role === 'user')!.content)).toContain('核对文书草稿');
    expect(resumed.result).toContain('复用 1 份已复核正文，继续核对 1 份待复核稿');
  });

  it.each(['买卖合同纠纷', '民间借贷纠纷', '侵权责任纠纷'])('keeps the stated %s case type without adding a default dispute', async caseType => {
    const result = await run('legal_case_workspace', { caseName: '案由优先测试', caseType, facts: '已转账七万元，本金、利息与担保材料需复核。', writeFiles: false });
    expect(result.result).toContain(caseType);
    expect(result.result).toContain('已转账七万元，本金、利息与担保材料需复核。');
    expect(result.result).not.toMatch(/合同关系及履行事实|借贷合意是否成立|侵权行为及过错认定/);
  });

  it('invalidates only the existing packet progress when temporal applicability input changes', async () => {
    const item = createCase('quality-org', 'quality-owner', { title: '程序适用复核缓存', notes: '虚构主体的交易情况待原件核实。', factDate: '2019-01-01' });
    vi.mocked(makeLLMCall).mockImplementation(async messages => {
      const prompt = String(messages.find(message => message.role === 'user')!.content);
      if (prompt.startsWith('核对文书草稿')) return { text: JSON.stringify(batchReview(prompt)), toolCalls: [] };
      const { baseName } = packetTarget(prompt);
      return { text: JSON.stringify(packetDraftFixture(prompt, { baseName, markdown: '# 文书工作稿\n虚构交易材料中的主体、履行情况和原始凭据均待复核，日期适用说明仅为本次输入，不当成已经核准的法律结论。' })), toolCalls: [] };
    });
    const first = { caseId: item.id, role: '原告', persistCase: true,
      temporalReviews: [{ citation: '受控引用', referenceDate: '2019-01-01', scope: 'fact', authorityCitation: '受控来源', authorityQuote: '受控原文', applicability: '原适用说明仍需核实' }] };
    expect((await run('legal_generate_litigation_packet', first, { llmGetters: {} })).receipt).toMatchObject({ ok: true, draftMode: 'model' });
    vi.mocked(makeLLMCall).mockClear();
    expect((await run('legal_generate_litigation_packet', first, { llmGetters: {} })).receipt).toMatchObject({ ok: true, draftMode: 'model' });
    expect(makeLLMCall).not.toHaveBeenCalled();
    const changed = { ...first, temporalReviews: [{ ...first.temporalReviews[0], applicability: '已更新时点说明，旧稿不能复用' }] };
    expect((await run('legal_generate_litigation_packet', changed, { llmGetters: {} })).receipt).toMatchObject({ ok: true, draftMode: 'model' });
    expect(makeLLMCall).toHaveBeenCalledTimes(4);
    vi.mocked(makeLLMCall).mockClear();
    expect((await run('legal_generate_litigation_packet', changed, { llmGetters: {}, dataRoutingPolicy: 'local_only' })).receipt).toMatchObject({ ok: true, draftMode: 'model' });
    expect(makeLLMCall).toHaveBeenCalledTimes(4);
  });

  it('accepts structured model reasoning only after verifying original law and evidence links', async () => {
    installCivilCodeFixture();
    const caseFile = createCase('quality-org', 'quality-owner', { title: '结构化分析', notes: '已签收供货，尚欠二万元；违约金约定需核实。' });
    const material = addMaterial('quality-org', 'quality-owner', caseFile.id, { type: 'evidence', source: 'manual', title: '合同及签收记录', content: '已签收供货，尚欠二万元；违约金约定需核实。' })!;
    const link = {
      issue: '违约金金额的核实', ruleCitation: '《民法典》第585条', ruleQuote: verifyCitation('《民法典》第585条').sourceText,
      fact: material.content, evidence: [{ materialId: material.id, quote: material.content, locator: '第1段' }],
      application: '须结合约定全文与实际损失核实违约金，欠款记录本身不证明违约金具体金额。',
      conclusion: '现有证据不足以确认违约金数额，须补充约定全文与损失资料。', limitations: '原件、签收权限与反证尚未核实。',
    };
    vi.mocked(makeLLMCall).mockResolvedValueOnce({ text: JSON.stringify({ entries: [{ issue: link.issue, ruleId: 'R1', checks: reasoningChecks(link.ruleQuote!, { sourceIds: ['F1'], application: link.application, conclusion: link.conclusion, limitations: link.limitations }) }] }), toolCalls: [] } as any)
      .mockResolvedValueOnce({ text: JSON.stringify({ reviews: [{ index: 1, checks: reasoningChecks(link.ruleQuote!, { sourceIds: ['F1'], status: 'supported', application: link.application, conclusion: link.conclusion, missingPremises: [] }) }], uncoveredIssues: [] }), toolCalls: [] } as any);
    const result = await run('legal_case_reasoning_matrix', { caseId: caseFile.id, legalAuthorities: '《民法典》第585条', persistCase: true, writeFiles: false }, { llmGetters: {} });
    expect(result.receipt).toMatchObject({ reasoningLinked: true });
    expect(getCase('quality-org', caseFile.id, 'quality-owner')?.materials.some(item => item.reasoningLinks?.[0]?.applicationChecks?.every(check => check.conclusion === link.conclusion))).toBe(true);
    expect(vi.mocked(makeLLMCall).mock.calls[0][2].responseFormat).toBe('json_object');
  });
  it('verifies real paragraphs and rejects fabricated paragraphs, items, inserted articles, and quotations', () => {
    installCivilCodeFixture();
    const valid = verifyCitation('《民法典》第五百八十五条第二款');
    expect(valid).toMatchObject({ provisionVerified: true, verificationStatus: 'verified', quotationVerified: null });
    expect(valid.sourceText).toContain('适当减少');
    for (const bad of ['《民法典》第五百八十五条第999款第999项', '《民法典》第585条第二款第999项', '《民法典》第585条之一']) {
      expect(verifyCitation(bad)).toMatchObject({ provisionVerified: false, verificationStatus: 'not_found' });
    }
    expect(verifyMultipleCitations('《民法典》第585条规定：“违约金必须是合同总价的百分之五十”。')[0])
      .toMatchObject({ verificationStatus: 'text_mismatch', quotationVerified: false });
    expect(verifyMultipleCitations('《民法典》第585条第三款规定：“违约方支付违约金后，还应当履行债务。”')[0])
      .toMatchObject({ verificationStatus: 'verified', quotationVerified: true });
    expect(verifyMultipleCitations('《民法典》 第585条 第999款第（999）项')[0])
      .toMatchObject({ provisionVerified: false, verificationStatus: 'not_found' });
    expect(verifyMultipleCitations('《民法典》第585条、第999999条')[1]).toMatchObject({ exists: false });
    expect(verifyCitation('《民法典》第585条', undefined, { factDate: '2019-01-01' }))
      .toMatchObject({ isEffective: null, applicabilityStatus: 'historical_review_required' });
  });

  it('does not issue a positive generation receipt when the contract model is unavailable', async () => {
    const result = await run('legal_draft_contract', { type: '保密协议' });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', artifacts: [] });
    expect(result.terminalVerification?.status).not.toBe('verified');
  });

  it('blocks a formal delivery with an invented quotation or an inapplicable current-version date', async () => {
    installCivilCodeFixture();
    for (const args of [
      { content: '依据《民法典》第585条规定：“所有违约金必须自动翻倍”。' },
      { content: '依据《民法典》第585条提出主张。', factDate: '2019-01-01' },
    ]) {
      const result = await run('legal_finalize_delivery_package', { caseName: '法条核验阻断', ...args });
      expect(result.result).toContain('正式交付包未生成');
      expect(result.receipt).toMatchObject({ ok: false, status: 'blocked' });
      expect(result.terminalVerification?.status).not.toBe('verified');
    }
  });

  it('keeps unrelated project promises out of the actual DOCX bid draft', async () => {
    const result = await run('legal_generate_bid', { projectName: '办公家具采购', requirements: '采购桌椅100套。交货期60天。', useModel: false });
    expect(result.receipt).toMatchObject({ ok: true });
    const file = (result.receipt as any).artifacts.find((p: string) => p.endsWith('.docx'));
    const output = await parseDocument(file);
    expect(output?.text).toContain('交货期60天');
    expect(output?.text).toContain('采购桌椅100套');
    expect(output?.text).not.toMatch(/30天|30 天|AI法律|多模型|私有化部署/);
  });

  it('sends every character including the tail attachment to review, and reports provider failure as partial', async () => {
    vi.mocked(makeLLMCall).mockImplementation(async messages => ({ text: contractStructuredReply(String(messages.find(message=>message.role==='user')!.content), '本片段初审工作稿：原文条款与附件仍应律师逐项核对，不确定未知主体、责任范围、交易事实或法律效力。'), toolCalls: [] } as any));
    const contract = '普通合同条款。'.repeat(2000) + '\n附件末尾：永久免除乙方全部责任。';
    const parts = splitContractForReview(contract);
    const llmGetters = { getOpenAI: () => null };
    const result = await run('legal_review_contract', { contract }, { llmGetters });
    expect(result.receipt).toMatchObject({ ok: true, status: 'reviewed' });
    const prompts = vi.mocked(makeLLMCall).mock.calls.map(call => String(call[0].find(message => message.role === 'user')!.content));
    expect(prompts).toHaveLength(parts.length);
    for (const part of parts) expect(prompts.some(prompt => contractPromptSources(prompt).some(source=>source.quote===part.text))).toBe(true);
    expect(prompts.at(-1)).toContain('永久免除乙方全部责任');
    vi.mocked(makeLLMCall).mockRejectedValueOnce(new Error('Synthetic provider timeout'));
    const partial = await run('legal_review_contract', { contract }, { llmGetters });
    expect(partial.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(partial.result).toContain('未完成，需继续审查');
    expect(partial.terminalVerification?.status).not.toBe('verified');
  });

  it('retries encrypted material in its original case without duplicate articles or leaked passwords', async () => {
    const folder = getDataDirectory('quality-input');
    const filePath = path.join(folder, 'protected.pdf');
    fs.writeFileSync(filePath, Buffer.from(ENCRYPTED_PDF_BASE64, 'base64'));
    const caseFile = createCase('quality-org', 'quality-owner', { title: '加密材料重试' });
    const before = listKbArticles('quality-org').length;
    const missing = await run('legal_import_materials_to_kb', { filePath, caseId: caseFile.id });
    expect(missing.result).toContain('PDF_PASSWORD_REQUIRED');
    expect(missing.receipt).toMatchObject({ ok: false });
    const wrong = await run('legal_import_materials_to_kb', { filePath, caseId: caseFile.id, password: 'test-wrong-secret' });
    expect(wrong.result).toContain('PDF_PASSWORD_INCORRECT');
    expect(JSON.stringify(wrong.arguments)).not.toContain('test-wrong-secret');
    expect(listKbArticles('quality-org')).toHaveLength(before);
    const args = { filePath, caseId: caseFile.id, password: 'open-sesame' };
    const correct = await run('legal_import_materials_to_kb', args);
    expect(correct.receipt).toMatchObject({ ok: true, status: 'imported' });
    const again = await run('legal_import_materials_to_kb', args);
    expect(again.receipt).toMatchObject({ ok: true, status: 'imported' });
    expect(listKbArticles('quality-org')).toHaveLength(before + 1);
    expect(getCase('quality-org', caseFile.id, 'quality-owner')?.materials).toHaveLength(1);
    expect(JSON.stringify([correct, again, listKbArticles('quality-org'), getCase('quality-org', caseFile.id, 'quality-owner')])).not.toContain('open-sesame');
  });

  it('reads the complete uploaded source with authentication and unlocks the same PDF', async () => {
    const uid = 'quality-upload-owner';
    const headers = { Cookie: `token=${jwt.sign({ uid, username: uid, role: 'user' }, JWT_SECRET)}` };
    const full = 'Full contract provision.\n'.repeat(2600) + 'TAIL-ATTACHMENT-MUST-BE-REVIEWED';
    const form = new FormData();
    form.append('files', new Blob([full]), 'long-contract.txt');
    form.append('files', new Blob([Buffer.from(ENCRYPTED_PDF_BASE64, 'base64')], { type: 'application/pdf' }), 'protected.pdf');
    const upload = await fetch(`${app.url}/api/files/upload`, { method: 'POST', headers, body: form });
    expect(upload.status).toBe(200);
    const entries = (await upload.json()).files;
    const read = async (id: string, password?: string, auth = headers) => fetch(`${app.url}/api/files/text/${encodeURIComponent(id)}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const text = await (await read(entries[0].id)).json();
    expect(text.text).toBe(full);
    expect(text.truncated).toBe(false);
    expect((await read(entries[0].id, undefined, { Cookie: '' })).status).toBe(401);
    const other = { Cookie: `token=${jwt.sign({ uid: 'other', username: 'other', role: 'user' }, JWT_SECRET)}` };
    expect((await read(entries[0].id, undefined, other)).ok).toBe(false);
    expect((await (await read(entries[1].id)).json()).code).toBe('PDF_PASSWORD_REQUIRED');
    expect((await (await read(entries[1].id, 'bad')).json()).code).toBe('PDF_PASSWORD_INCORRECT');
    expect((await (await read(entries[1].id, 'open-sesame')).json()).text).toContain('Lumi encrypted PDF test');
  });

  it('continues dispute focus from complete neutral originals without turning pleadings into a party assertion', async () => {
    const item = createCase('quality-org', 'quality-owner', { title: '中性诉状续办', clientRole: '被告', cause: '买卖合同纠纷' });
    const pleadingText = '未归属诉状内容。'.repeat(180) + 'UNASSIGNED-PLEADING-TAIL';
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'pleading', title: '导入诉状尚未指定归属', content: pleadingText, source: 'import' });
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'evidence', title: '银行流水原件', content: 'ORIGINAL-BANK-SOURCE', source: 'manual' });
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'pleading', title: '起诉状/答辩状/对方材料', content: 'CAPTURED-ORIGINAL-PLEADING', source: 'tool' });
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'pleading', title: '系统起诉状草稿', content: 'GENERATED-PLEADING-MUST-NOT-BECOME-EVIDENCE', source: 'tool' });
    vi.mocked(makeLLMCall).mockResolvedValueOnce({ text: JSON.stringify({ entries: [{ issue: '付款材料如何对应本案？', sourceIds: ['F1'] }] }), toolCalls: [] } as any);
    const result = await run('legal_extract_dispute_focus', { caseId: item.id }, { llmGetters: {} });
    const prompt = String(vi.mocked(makeLLMCall).mock.calls.at(-1)![0].find(message => message.role === 'user')!.content);
    const sources = JSON.parse(prompt.split('\n材料：')[1]);
    expect(prompt).toContain('- 我方身份: 被告');
    expect(sources.filter((source: any) => source.materialId === 'materials').map((source: any) => source.quote).join('\n')).toContain(pleadingText);
    expect(sources.filter((source: any) => source.materialId === 'materials').map((source: any) => source.quote).join('\n')).toContain('CAPTURED-ORIGINAL-PLEADING');
    expect(sources.filter((source: any) => source.materialId === 'evidence').map((source: any) => source.quote).join('\n')).toContain('ORIGINAL-BANK-SOURCE');
    expect(sources.some((source: any) => ['complaint', 'opponentMaterials'].includes(source.materialId))).toBe(false);
    expect(prompt).not.toContain('GENERATED-PLEADING-MUST-NOT-BECOME-EVIDENCE');
    expect(result.receipt).toMatchObject({ ok: true });
  });

  it('retains explicitly assigned complaint and opponent originals once alongside neutral sources', async () => {
    const item = createCase('quality-org', 'quality-owner', { title: '显式归属续办', clientRole: '原告', cause: '买卖合同纠纷' });
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'pleading', title: '未归属材料', content: 'UNOWNED-SOURCE-ONLY', source: 'manual' });
    for (const args of [{ complaint: 'EXPLICIT-OWN-COMPLAINT' }, { complaint: 'EXPLICIT-OWN-COMPLAINT', opponentMaterials: 'EXPLICIT-OPPONENT-ANSWER', opponentArguments: 'EXPLICIT-OPPONENT-POSITION' }]) {
      vi.mocked(makeLLMCall).mockResolvedValueOnce({ text: JSON.stringify({ entries: [{ issue: '材料如何核实？', sourceIds: ['F1'] }] }), toolCalls: [] } as any);
      await run('legal_extract_dispute_focus', { caseId: item.id, evidence: 'EXPLICIT-EVIDENCE', materials: 'EXPLICIT-UNOWNED-MATERIALS', ...args }, { llmGetters: {} });
      const prompt = String(vi.mocked(makeLLMCall).mock.calls.at(-1)![0].find(message => message.role === 'user')!.content);
      const sources = JSON.parse(prompt.split('\n材料：')[1]);
      expect(sources.filter((s: any) => s.materialId === 'complaint').map((s: any) => s.quote)).toEqual(['EXPLICIT-OWN-COMPLAINT']);
      expect(sources.filter((s: any) => s.materialId === 'materials').map((s: any) => s.quote)).toContain('UNOWNED-SOURCE-ONLY');
      if ('opponentMaterials' in args) {
        expect(sources.filter((s: any) => s.materialId === 'opponentMaterials').map((s: any) => s.quote)).toEqual(['EXPLICIT-OPPONENT-ANSWER']);
        expect(sources.filter((s: any) => s.materialId === 'opponentArguments').map((s: any) => s.quote)).toEqual(['EXPLICIT-OPPONENT-POSITION']);
        expect(prompt.split('EXPLICIT-OPPONENT-ANSWER')).toHaveLength(2);
      }
    }
  });

  it.each(['opponentArguments', 'opponentMaterials', 'complaint', 'evidence', 'transcript', 'materials'])('retains complete standalone %s source and its tail', async field => {
    const full = '原始材料正文。'.repeat(140) + 'SOURCE-TAIL-MUST-BE-SEEN';
    vi.mocked(makeLLMCall).mockResolvedValueOnce({ text: JSON.stringify({ entries: [{ issue: '原件何时核实？', sourceIds: ['F1'] }] }), toolCalls: [] } as any);
    const result = await run('legal_extract_dispute_focus', { [field]: full }, { llmGetters: {} });
    const prompt = String(vi.mocked(makeLLMCall).mock.calls.at(-1)![0].find(message => message.role === 'user')!.content);
    expect(prompt).toContain(full);
    expect(prompt.split(full)).toHaveLength(2);
    expect(result.result).toContain(full);
    expect(result.receipt).toMatchObject({ ok: true });
  });

  it.each([
    { entries: [{ issue: '付款如何核实？', sourceIds: ['F999'] }] },
    { entries: [{ issue: '付款如何核实？', sourceIds: ['F1'], fact: '原告自认未核实，被告仅欠两万元。' }] },
    { entries: [] },
  ])('preserves raw allegations and returns partial for forged facts or missing source selection', async response => {
    const facts = '原告主张九万元；原告陈述尚未用原件核实。\n被告主张已支付七万元，截图对应交易尚待核实。';
    vi.mocked(makeLLMCall).mockResolvedValueOnce({ text: JSON.stringify(response), toolCalls: [] } as any);
    const result = await run('legal_extract_dispute_focus', { facts }, { llmGetters: {} });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.result).toContain('原告陈述尚未用原件核实。');
    expect(result.result).toContain('被告主张已支付七万元，截图对应交易尚待核实。');
    expect(result.result).not.toContain('原告自认');
    expect(result.result).not.toContain('仅欠两万元');
    expect(makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('passes neutral imported pleadings into the actual defendant packet drafting prompts', async () => {
    const item = createCase('quality-org', 'quality-owner', { title: '答辩材料输入', clientRole: '被告', cause: '买卖合同纠纷' });
    const neutral = '未指定主张归属的原始诉状。'.repeat(90) + 'DEFENSE-NEUTRAL-TAIL';
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'pleading', title: '中性原始诉状', content: neutral, source: 'manual' });
    vi.mocked(makeLLMCall).mockImplementation(async messages => {
      const prompt = String(messages.find(message => message.role === 'user')!.content);
      if (prompt.startsWith('核对文书草稿')) return { text: JSON.stringify(batchReview(prompt)), toolCalls: [] };
      const { baseName } = packetTarget(prompt);
      return { text: JSON.stringify(packetDraftFixture(prompt, { baseName, markdown: '# 条件文书草稿\n中性原始诉状尚未指定当事人主张归属，付款、交付及证据真实性均须核实，不从材料类型推定角色或承认事实。' })), toolCalls: [] };
    });
    await run('legal_generate_litigation_packet', { caseId: item.id, facts: '虚构原告诉请与被告材料尚待核实。', writeFiles: false }, { llmGetters: {} });
    const prompts = vi.mocked(makeLLMCall).mock.calls.map(call => String(call[0].find(message => message.role === 'user')!.content));
    const expectedTargets = ['20_statement-of-defense', '21_cross-examination-opinion', '23_argument-outline', '27_evidence-catalog'];
    const drafted: string[] = [], reviewed: string[] = [];
    expect(prompts).toHaveLength(expectedTargets.length * 2);
    for (const prompt of prompts) {
      expect(prompt).toContain('案件材料（未指定当事人角色）');
      expect(prompt).toContain(neutral);
      expect(prompt.split(neutral)).toHaveLength(2);
      expect(prompt).not.toContain('## 证据三性审查底稿');
      if (prompt.startsWith('核对文书草稿')) reviewed.push(...batchReview(prompt).documents.map((document: any) => document.baseName.split('/')[0]));
      else {
        const target = packetTarget(prompt);
        expect(target).toEqual({ baseName: target.baseName, label: expect.any(String), sections: target.baseName === '27_evidence-catalog' ? undefined : expect.arrayContaining([expect.objectContaining({id:expect.any(String),title:expect.any(String)})]) });
        expect(expectedTargets).toContain(target.baseName);
        drafted.push(target.baseName);
      }
    }
    expect(drafted.sort()).toEqual([...expectedTargets].sort());
    expect([...new Set(reviewed)].sort()).toEqual([...expectedTargets].sort());
  });

  it('does not insert case-type default quality or damages disputes into the shared argument reasoning request', async () => {
    installCivilCodeFixture();
    const item = createCase('quality-org', 'quality-owner', { title: '仅核对付款截图真实性' });
    const raw = '虚构双方仅要求梳理付款截图真实性与关联性。\nNEUTRAL-ARGUMENT-TAIL';
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'evidence', source: 'manual', title: '中性付款原文', content: raw });
    vi.mocked(makeLLMCall).mockResolvedValueOnce({ text: JSON.stringify({ entries: [{ issue: '付款截图真实性与关联性的核对', ruleId: 'R1', checks: reasoningChecks(verifyCitation('《民法典》第626条').sourceText!, { sourceIds: ['F1', 'F2'], application: '须先核对截图原件及交易关联，不能推定已履行付款义务。', conclusion: '原件及交易关联核实前，不确定付款是否完成。', limitations: '原件及付款截图对应关系尚未核实。' }) }] }), toolCalls: [] } as any)
      .mockResolvedValueOnce({ text: JSON.stringify({ reviews: [{ index: 1, checks: reasoningChecks(verifyCitation('《民法典》第626条').sourceText!, { sourceIds: ['F1', 'F2'], status: 'conditional', application: '须先核对截图原件及交易关联。', conclusion: '原件关联核实前不确定付款是否完成。', missingPremises: ['截图原件及交易关联'] }) }], uncoveredIssues: [] }), toolCalls: [] } as any);
    const result = await run('legal_generate_argument_or_opinion', { caseId: item.id, caseType: '买卖合同纠纷', facts: raw, legalAuthorities: '《民法典》第626条', factDate: '2026-09-01' }, { llmGetters: {} });
    const prompt = String(vi.mocked(makeLLMCall).mock.calls[0][0].find(message => message.role === 'user')!.content);
    expect(result.receipt).toMatchObject({ ok: true, reasoningReviewed: true });
    expect(prompt).toContain('NEUTRAL-ARGUMENT-TAIL');
    expect(prompt.split('NEUTRAL-ARGUMENT-TAIL')).toHaveLength(2);
    expect(prompt).not.toContain('质量异议或拒付抗辩是否成立');
    expect(prompt).not.toContain('违约责任、损失和违约金调整');
  });

  it('keeps the complete statute candidate and its case date boundary without certifying a search hit', async () => {
    const kb = await import('../server/legal/kb');
    const full = '权威原文尚待核验。'.repeat(60) + 'STATUTE-CANDIDATE-TAIL';
    vi.spyOn(kb, 'searchStatutes').mockResolvedValueOnce([{ articleId: 'fixture', title: '《民法典》第626条', chunk: full, score: 1, isEffective: true }]);
    const result = await run('legal_case_strategy', { facts: '虚构交易，发生于2019年。', materials: '中性诉状仍待归属。', factDate: '2019-01-01', procedureDate: '2026-10-13' }, { llmGetters: {} });
    const output = result.result;
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(makeLLMCall).not.toHaveBeenCalled();
    expect(output).toContain(full);
    expect(output).toContain('未作本案适用或类案核准');
    expect(output).not.toContain('相关法条（已验证有效）');
    expect(output).toContain('实体法律适用时间基准（仅案件级，不代表各事件日期）: 2019-01-01');
    expect(output).toContain('程序法律适用时间基准（仅案件级，不代表具体程序已发生）: 2026-10-13');
    expect(output).toContain('中性诉状仍待归属。');
  });

  it('rejects dispute continuation from a case outside the active authorized workspace', async () => {
    const foreign = createCase('other-quality-org', 'foreign-owner', { title: '无权续办' });
    addMaterial('other-quality-org', 'foreign-owner', foreign.id, { type: 'pleading', title: '其他域原始诉状', content: 'FOREIGN-CASE-MATERIAL', source: 'manual' });
    const result = await run('legal_extract_dispute_focus', { caseId: foreign.id }, { llmGetters: {} });
    expect(result.error).toContain('selected legal case is unavailable');
    expect(result.terminalVerification?.status).toBe('failed');
    expect(makeLLMCall).not.toHaveBeenCalled();
  });

  it('retains completion boundaries without claiming an unverified internal methodology in contract and bid outputs', async () => {
    vi.mocked(makeLLMCall).mockImplementationOnce(async messages => ({ text: contractStructuredReply(String(messages.find(message=>message.role==='user')!.content), '合同工作稿：双方主体、价款及期限均待填写，具体义务、签署、责任条款及适用条件均须律师核对，不确认未知事实。'), toolCalls: [] } as any));
    const contract = await run('legal_draft_contract', { type: '买卖合同', details: '主体和价款尚未明确。' }, { llmGetters: {} });
    const bid = await run('legal_generate_bid', { projectName: '设备采购', requirements: '需要资质、报价及签章；信息待填写。', useModel: false });
    expect(contract.result).toContain('合同工作稿：双方主体、价款及期限均待填写');
    expect(bid.result).toContain('正式投标文件仍需人工补齐资质、业绩、报价和签章材料');
    for (const output of [contract, bid]) {
      expect(output.result).toContain('法律成果预检');
      expect(output.result).not.toMatch(/三段论核心基础|已作为内部.*逻辑使用/u);
    }
  });

  it.each(['律师复核已完成。', '律师复核通过。', '承办律师已完成复核。'])('does not promote self-declared approval %s to a lawyer sign-off or formal delivery', async declaration => {
    installCivilCodeFixture();
    const { recordWorkflowRun, evaluateCaseWorkflow } = await import('../server/org/legal_cases');
    const item = createCase('quality-org', 'quality-owner', { title: '正文自称核准', party: '虚构甲公司；虚构乙公司', cause: '买卖合同纠纷', notes: '双方发生虚构买卖交易，已签收供货，尚欠部分款项，金额与原件仍应核对。', court: '上海市黄浦区人民法院', factDate: '2026-09-01', hearingDate: '2026-11-01' });
    addMaterial('quality-org', 'quality-owner', item.id, { type: 'evidence', title: '虚构签收和付款记录', content: '原始签收和付款测试材料。', source: 'manual' });
    const outputPath = path.join(getDataDirectory('quality-output'), item.id + '.txt');
    const content = '依据《民法典》第585条核对违约金条款。' + declaration;
    fs.writeFileSync(outputPath, content);
    const material = addMaterial('quality-org', 'quality-owner', item.id, { type: 'contract', title: '模拟核准合同', content, localPath: outputPath, source: 'tool' })!;
    recordWorkflowRun('quality-org', 'quality-owner', item.id, { tool: 'legal_draft_contract', ok: true, status: 'generated', materialIds: [material.id], artifacts: [outputPath], currentLawGate: 'passed', reasoningLinked: true, draftMode: 'model' });
    expect(evaluateCaseWorkflow(getCase('quality-org', item.id, 'quality-owner')!, { currentLawGate: 'passed' }).readyForFormalDelivery).toBe(true);
    const result = await run('legal_verify_archived_delivery', { caseId: item.id, materialTitle: material.title });
    expect(result.result).toMatch(/案件事实\n- 通过/u);
    expect(result.result).toMatch(/引用与法源状态\n- 通过/u);
    expect(result.result).toMatch(/时效与期限\n- 通过/u);
    expect(result.result).toMatch(/管辖信息\n- 通过/u);
    expect(result.result).toMatch(/草稿文件状态\n- 通过/u);
    expect(result.result).toMatch(/律师复核边界\n- 待确认/u);
    expect(result.result).toContain('正文自称复核通过不能作为签发依据');
    expect(result.result).toContain('不可正式交付');
    expect(result.result).not.toContain('当前核验项均有可追溯依据');
    expect(result.result).not.toContain('草稿内存在可核对的律师复核完成记录');
  });


  it.each([
    ['2026-09-01', '2019-01-01', '通过'],
    ['2019-01-01', '2026-09-01', '阻断'],
  ])('uses saved fact date %s instead of requested replacement %s in archived law verification', async (factDate, suppliedDate, status) => {
    installCivilCodeFixture();
    const item = createCase('quality-org', 'quality-owner', { title: '归档日期优先', factDate });
    const material = addMaterial('quality-org', 'quality-owner', item.id, { type: 'contract', title: '已归档文本', content: '依据《民法典》第585条核对违约金。', source: 'tool' })!;
    const conflict = await run('legal_verify_archived_delivery', { caseId: item.id, materialTitle: material.title, factDate: suppliedDate });
    expect(conflict.result).toContain('本次传入日期与之冲突');
    expect(conflict.receipt).toMatchObject({ ok: false, status: 'blocked' });
    const result = await run('legal_verify_archived_delivery', { caseId: item.id, materialTitle: material.title });
    expect(result.result).toContain('### 引用与法源状态\n- ' + status);
    expect(result.result).toContain('律师核准记录待确认');
    expect(getCase('quality-org', item.id, 'quality-owner')?.factDate).toBe(factDate);
  });

  it.each([
    ['依据《民法典》第585条核对违约金。', '', '案件事实日期缺失或无效'],
  ])('reports the actual temporal gate blocker for archived text %s', async (content, factDate, reason) => {
    installCivilCodeFixture();
    const item = createCase('quality-org', 'quality-owner', { title: '归档时间缺口', factDate });
    const material = addMaterial('quality-org', 'quality-owner', item.id, { type: 'contract', title: '已归档文本', content, source: 'tool' })!;
    const result = await run('legal_verify_archived_delivery', { caseId: item.id, materialTitle: material.title });
    expect(result.result).toContain('### 引用与法源状态\n- 阻断：' + reason);
    expect(result.result).not.toContain('未发现来源阻断');
  });

});
