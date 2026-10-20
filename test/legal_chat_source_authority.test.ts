import { buildEvidenceReviewRows } from '../server/regions/packs/cn/legal_tools/case_workflow';
import { contractPromptSources } from './legal_contract_fixture';
import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initDatabase } from '../db_layer';
import { addMessageIdempotent, startIsolatedConversation } from '../server/conversation/manager';
import { bindConversationActionTurnTask } from '../server/conversation/action_turn_ledger';
import * as LegalCases from '../server/org/legal_cases';
import { resolveLegalCaseArguments } from '../server/regions/packs/cn/legal_tools/context';
import { caseWorkspaceHandler } from '../server/regions/packs/cn/legal_tools/case_workspace';
import { caseStrategyHandler, extractDisputeFocusHandler } from '../server/regions/packs/cn/legal_tools/argument_drafting';
import { readBidRequirementInput } from '../server/regions/packs/cn/legal_tools/documents';
import { draftContractHandler, reviewContractHandler } from '../server/regions/packs/cn/legal_tools/contracts';
import { buildLitigationPacketDrafts } from '../server/regions/packs/cn/legal_tools/litigation_drafts';
import { importMaterialsToKbHandler } from '../server/regions/packs/cn/legal_tools/knowledge';
import { buildLegalMeetingCaseUpdateMarkdown } from '../server/regions/packs/cn/legal_tools/meetings';
import { decodeToolResult } from '../server/tools/result_envelope';
import { makeLLMCall } from '../server/llm/providers';

vi.mock('../server/llm/providers', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn(),
}));
vi.mock('../server/legal/kb', async importOriginal => ({
  ...await importOriginal<typeof import('../server/legal/kb')>(), indexLegalArticle: vi.fn().mockResolvedValue(1),
}));
const original = '原告虚构甲公司主张已交货，尚未用合同或交货原件核实。\n被告虚构乙公司称已付7万元，只有付款截图，真实性和本案关联尚未查明。\n没有提供付款期限和完整合同；未提供不代表未约定。';
const rewrites = { facts: '原告已交货', evidence: '缺少验收记录', complaint: '原告认可质量异议',
  opponentMaterials: '被告承认欠款2万元', opponentArguments: '被告承认无质量问题', transcript: '双方确认争议事实',
  trialNotes: '法庭已确认欠款', meetingText: '双方已和解', notes: '用户已确认全部事实', contract: '合同没有付款期限',
  details: '已经确认全部交易条件', requirements: '无需任何投标资格', templateText: '编造官方模板正文' };
beforeAll(initDatabase);
beforeEach(() => vi.mocked(makeLLMCall).mockReset());
function fixture(content = original, domain = 'personal', orgId = '') {
  const userId = 'source-authority-' + randomUUID(), taskId = 'task-' + randomUUID();
  const conversation = startIsolatedConversation(userId, 'lumi', domain, orgId);
  const requestId = 'request-' + randomUUID();
  const userMessageId = addMessageIdempotent({ userId, agentId: 'lumi', conversationId: conversation.id,
    requestId, domain, orgId, source: 'chat', channel: 'chat', role: 'user', content, deferActionPreparation: true });
  expect(userMessageId).not.toBe('');
  expect(bindConversationActionTurnTask({ userId, conversationId: conversation.id, requestId, taskId }).bound).toBe(true);
  const context = { userId, conversationId: conversation.id, requestId, taskId, domain, orgId,
    actionIntent: '不得拿这个改写替代原始消息', routedTaskText: '内部续办摘要：已交货且欠款2万元', llmGetters: {} };
  return { context, userMessageId };
}
function reader(context: ReturnType<typeof fixture>['context'], overrides: Record<string, any> = {}) {
  return { name: 'ocr_image_file', arguments: { imagePath: 'D:/fixtures/claim.png' },
    result: JSON.stringify({ analysis: '图片中原告主张已交货，尚未核对原件。' }),
    requestId: context.requestId, taskId: context.taskId, terminalVerification: { status: 'verified' },
    envelope: { status: 'verified_success', requestId: context.requestId, taskId: context.taskId,
      verification: { status: 'verified', basis: 'terminal_verification' } }, ...overrides };
}
describe('legal chat source authority through existing request and task identities', () => {
  it('uses persisted literal current user text before the no-case early return and rejects parent rewritten source slots', async () => {
    const { context } = fixture();
    const resolved = resolveLegalCaseArguments('legal_extract_dispute_focus', { ...rewrites, persistCase: false }, context);
    expect(resolved.materials).toBe(original);
    for (const key of Object.keys(rewrites)) expect(resolved[key]).toBeUndefined();
    vi.mocked(makeLLMCall).mockResolvedValue({ text: JSON.stringify({ entries: [{ issue: '交货主张和付款截图如何核实？', sourceIds: ['F1', 'F2'] }] }) } as any);
    const report = await extractDisputeFocusHandler(resolved, context);
    expect(report).toContain('原告虚构甲公司主张已交货，尚未用合同或交货原件核实。');
    expect(report).toContain('被告虚构乙公司称已付7万元，只有付款截图，真实性和本案关联尚未查明。');
    expect(report).not.toContain('争议材料归集未完成');
    expect(report).not.toContain('缺少验收记录');
    expect(report).not.toContain('被告承认欠款2万元');
  });
  it('keeps ordinary model notice source rewriting tied to the actual current user row without native proof', () => {
    const { context } = fixture('归档到 1');
    const resolved = resolveLegalCaseArguments('legal_message_intake_to_case', {
      message: 'MODEL-FORGED https://court.example.test/untrusted', materials: 'MODEL-FORGED source', persistCase: false,
    }, context);
    expect(resolved.materials).toBe('归档到 1');
    expect(resolved.materials).not.toContain('MODEL-FORGED');
    expect(resolved.userId).toBe(context.userId);
  });
  it('preserves long raw messages rather than prompt history or the 700-character durable goal', () => {
    const source = original + '\n' + '完整虚构合同条款。'.repeat(1100) + '\nSOURCE-END';
    const { context } = fixture(source);
    expect(resolveLegalCaseArguments('legal_case_strategy', rewrites, context).materials).toBe(source);
  });
  it.each([
    { userId: 'other-owner' }, { conversationId: 'other-conversation' }, { requestId: 'other-request' },
    { domain: 'work', orgId: 'other-org' }, { orgId: 'other-org' }, { taskId: 'other-task' },
  ])('cannot borrow a raw original from a different server identity: %j', override => {
    const { context } = fixture();
    expect(() => resolveLegalCaseArguments('legal_extract_dispute_focus', rewrites, { ...context, ...override })).toThrow(/original legal/i);
  });
  it('continues only exact same-task original turns and does not scan other requests in the conversation', () => {
    const { context } = fixture();
    const unrelated = '另一个案件已欠款100万元，不能混入原案。';
    const unrelatedRequest = 'unrelated-' + randomUUID();
    addMessageIdempotent({ ...context, agentId: 'lumi', requestId: unrelatedRequest, role: 'user', content: unrelated,
      source: 'chat', channel: 'chat', deferActionPreparation: true });
    bindConversationActionTurnTask({ ...context, requestId: unrelatedRequest, taskId: 'different-task' });
    const followup = '继续原任务，不要重新改写材料。', followupRequest = 'followup-' + randomUUID();
    addMessageIdempotent({ ...context, agentId: 'lumi', requestId: followupRequest, role: 'user', content: followup,
      source: 'chat', channel: 'chat', deferActionPreparation: true });
    bindConversationActionTurnTask({ ...context, requestId: followupRequest });
    const resolved = resolveLegalCaseArguments('legal_extract_dispute_focus', rewrites,
      { ...context, requestId: followupRequest, trustedActionContinuation: true });
    expect(resolved.materials).toContain(original);
    expect(resolved.materials).toContain(followup);
    expect(resolved.materials).not.toContain(unrelated);
    expect(resolved.materials).not.toContain(context.routedTaskText);
  });
  it('keeps authorized manual/import source intact without promoting tool or meeting summaries into originals', () => {
    const { context } = fixture(); const orgId = 'personal:' + context.userId;
    const legalCase = LegalCases.createCase(orgId, context.userId, { title: '来源权威虚构案', notes: '旧模型摘要已认定欠款2万元。' });
    for (const item of [
      { source: 'manual' as const, title: '手工原文', content: '人工提供付款截图，是否属于本案待核实。' },
      { source: 'import' as const, title: '导入文书原文', content: '原告诉状写明：请求9万元。' },
      { source: 'tool' as const, title: '案件事实与时间线', content: '模型已经核准付款事实。' },
      { source: 'meeting' as const, title: '会议派生纪要', content: '生成的会议摘要，不是会议记录原文。' },
    ]) LegalCases.addMaterial(orgId, context.userId, legalCase.id, { ...item, type: 'note' });
    const resolved = resolveLegalCaseArguments('legal_extract_dispute_focus', { caseId: legalCase.id, ...rewrites }, context);
    expect(resolved.materials).toContain(original);
    expect(resolved.materials).toContain('人工提供付款截图，是否属于本案待核实。');
    expect(resolved.materials).toContain('原告诉状写明：请求9万元。');
    expect(resolved.materials).not.toContain('模型已经核准');
    expect(resolved.materials).not.toContain('生成的会议摘要');
    expect(resolved.materials).not.toContain('旧模型摘要');
  });
  it('archives actual chat originals instead of assigning model rewrites the manual source flag', async () => {
    const { context } = fixture();
    const resolved = resolveLegalCaseArguments('legal_case_workspace', { ...rewrites, caseName: '原文归档虚构案' }, context);
    await caseWorkspaceHandler(resolved, context);
    const stored = LegalCases.listCases('personal:' + context.userId, '原文归档虚构案', 1, context.userId)[0];
    expect(stored.materials.some(m => m.source === 'manual' && m.content === original)).toBe(true);
    expect(JSON.stringify(stored.materials)).not.toContain(rewrites.facts);
    expect(JSON.stringify(stored.materials)).not.toContain(rewrites.evidence);
  });
  it('preserves explicitly pasted direct-tool source fields', () => {
    const { context } = fixture();
    const result = resolveLegalCaseArguments('legal_extract_dispute_focus', rewrites, { ...context, source: 'legal-direct-tool' });
    expect(result).toEqual({ ...rewrites, userId: context.userId });
  });
  it('preserves neutral source aliases and keeps strategy partial before actual source-case and law linkage', async () => {
    const { context } = fixture();
    const resolved = resolveLegalCaseArguments('legal_case_strategy', { ...rewrites, persistCase: false }, context);
    vi.mocked(makeLLMCall).mockResolvedValue({ text: '虚构策略工作稿；付款截图和主张待核实。' } as any);
    const result = decodeToolResult(await caseStrategyHandler(resolved, context));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reasoningReviewed: false });
    for (const paragraph of original.split('\n')) expect(result.content).toContain(paragraph);
    expect(result.content).not.toContain('原告已交货');
    expect(result.content).not.toContain('虚构策略工作稿');
    expect(makeLLMCall).not.toHaveBeenCalled();
    const input = await readBidRequirementInput(resolved);
    expect(input.requirements).toContain(original);
    expect(input.requirements).not.toContain(rewrites.requirements);
    expect(buildLegalMeetingCaseUpdateMarkdown(resolved)).toBe(original);
  });
  it('uses full neutral originals for contract drafting/review and litigation templates without reasserting model source rewrites', async () => {
    const { context } = fixture();
    const resolved = resolveLegalCaseArguments('legal_draft_contract', { ...rewrites, persistCase: false, type: '虚构合同' }, context);
    vi.mocked(makeLLMCall).mockResolvedValue({ text: '虚构合同工作稿，未核实条件待确认。' } as any);
    await draftContractHandler(resolved, context);
    const prompt = vi.mocked(makeLLMCall).mock.calls[0][0].find(message => message.role === 'user')?.content;
    expect(prompt).toContain(original.replace(/\n/g, '\\n'));
    expect(prompt).not.toContain(rewrites.details);
    expect(prompt).not.toContain(rewrites.templateText);
    vi.mocked(makeLLMCall).mockClear();
    const review = await reviewContractHandler(resolved, context);
    const reviewPrompt = vi.mocked(makeLLMCall).mock.calls[0][0].find(message => message.role === 'user')?.content;
    expect(contractPromptSources(String(reviewPrompt)).some(source=>source.quote===original)).toBe(true);
    expect(review).toContain(`输入全文：${original.length} 字符`);
    expect(review).not.toContain(rewrites.contract);
    const drafts = buildLitigationPacketDrafts(resolved, '原告', buildEvidenceReviewRows(resolved));
    expect(resolved.materials).toContain(original);
    const complaint = drafts.find(draft => draft.baseName === '10_civil-complaint')?.markdown;
    const factSection = String(complaint).split('## 事实与理由\n')[1]?.split('\n\n## 证据和证据来源')[0] || '';
    expect(factSection).toContain('### 本次中性材料输入（未编目）');
    expect(factSection).toContain('本次输入未编目，不代表已取得原件');
    for (const paragraph of original.split('\n')) expect(factSection).toContain('> ' + paragraph);
    for (const row of buildEvidenceReviewRows(resolved)) for (const source of row.sources) {
      expect(factSection).toContain('- ' + source.id + '；' + source.locator);
    }
    for (const rewrite of Object.values(rewrites)) expect(factSection).not.toContain(rewrite);
    expect(complaint).toContain('当事人身份、事实、请求、金额、证据、授权范围、签字盖章和提交信息均须逐项人工确认。');
    expect(complaint).toContain('未核验内容不得转为正式文书。');
    expect(complaint).toContain('［待结合请求权基础检索并核验现行有效法律、司法解释和类案，不得凭模型记忆补写］');
    const originals = drafts.find(draft => draft.baseName === '03_evidence-review-matrix')?.markdown;
    for (const paragraph of original.split('\n')) expect(originals).toContain(paragraph);
  });
  it('imports actual chat text into knowledge/manual material instead of parent rewritten content', async () => {
    const { context } = fixture(); const orgId = 'personal:' + context.userId;
    const file = LegalCases.createCase(orgId, context.userId, { title: '知识原文虚构案' });
    const resolved = resolveLegalCaseArguments('legal_import_materials_to_kb',
      { caseId: file.id, content: '模型已经确认原告交货，被告欠款2万元。', title: '知识原文测试' }, context);
    await importMaterialsToKbHandler(resolved, context);
    const stored = LegalCases.getCase(orgId, file.id, context.userId)!;
    expect(stored.materials.some(material => material.content.endsWith(original))).toBe(true);
    expect(JSON.stringify(stored.materials)).not.toContain('模型已经确认原告交货');
  });
  it('accepts actual current-target OCR text from a verified server record, labelled for original-image recheck', () => {
    const { context } = fixture('请依据这张图 D:/fixtures/claim.png 归集争议材料。');
    const resolved = resolveLegalCaseArguments('legal_extract_dispute_focus', rewrites,
      { ...context, getCurrentToolRecords: () => [reader(context)] });
    expect(resolved.materials).toContain('[附件实际读取/OCR文字，需核对原件]');
    expect(resolved.materials).toContain('图片中原告主张已交货，尚未核对原件。');
  });
  it.each([
    { requestId: undefined }, { taskId: undefined }, { requestId: 'old-request' }, { taskId: 'different-task' },
    { arguments: { imagePath: 'D:/different/claim.png' } },
    { result: JSON.stringify({ analysis: { metadata: 'not text' } }) },
    { result: JSON.stringify({ error: 'read failed', analysis: '失败不能当已读原件' }) },
    { name: 'generate_image', result: JSON.stringify({ analysis: '其它工具摘要不是OCR原件' }) },
    { envelope: { status: 'failed', verification: { status: 'failed' } } },
  ])('does not elevate metadata, failed, stale or wrong-target reader data into original material: %j', override => {
    const { context } = fixture('请依据这张图 D:/fixtures/claim.png 归集争议材料。');
    const resolved = resolveLegalCaseArguments('legal_extract_dispute_focus', rewrites,
      { ...context, getCurrentToolRecords: () => [reader(context, override)] });
    expect(resolved.materials).not.toContain('[附件实际读取/OCR文字');
  });
});
