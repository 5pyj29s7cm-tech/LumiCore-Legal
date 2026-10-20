import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { contractPromptSources, contractStructuredReply } from './legal_contract_fixture';
import { PDFDocument } from 'pdf-lib';
import { makeApp, JWT_SECRET } from './helpers';
import jwt from 'jsonwebtoken';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { makeLLMCall } from '../server/llm/providers';
import * as LegalCases from '../server/org/legal_cases';
import { isLegalSourceMaterial } from '../shared/legal_workflow_receipts';
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn() }));
let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry();
const context = { userId: 'report-repair-owner', domain: 'work', orgId: 'report-repair-org', authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local', llmGetters: {} } as any;
beforeAll(async () => { app = await makeApp(); registerLegalTools(registry); const unavailable=()=>null; mountChatRoutes(app.apiRouter,JWT_SECRET,{getDeepSeek:unavailable,getGemini:unavailable,getOpenAI:unavailable,getAnthropic:unavailable,getQwen:unavailable}); });
afterAll(() => app.cleanup());
afterEach(() => { vi.restoreAllMocks(); vi.mocked(makeLLMCall).mockReset(); });
const run = async (name: string, args: Record<string, any>) => decodeToolResult(await registry.execute(name, { persistCase: false, factDate: '2026-09-01', ...args }, context));
async function samplePdf() { const doc=await PDFDocument.create(); doc.addPage().drawText('NOTICE REPAIR MARKER 731829. Hearing 2026-10-20.', { size: 12 }); return doc.save(); }
describe('report repair: completed documents require actual body', () => {
  it('drafts a service contract without pretending to possess an official template', async () => {
    vi.mocked(makeLLMCall).mockImplementationOnce(async messages=>({ text: contractStructuredReply(String(messages.find(message=>message.role==='user')!.content), '技术服务合同工作稿：双方主体待填写。价款3万元，分两次支付。服务范围、履行期限及验收附件待双方确认。'), toolCalls: null } as any));
    const result=await run('legal_draft_contract', { type: '技术服务合同', details: '价款3万元，分两次支付，未知信息待填写' });
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' });
    const prompt=vi.mocked(makeLLMCall).mock.calls[0][0].find(m=>m.role==='user')?.content;
    expect(String(prompt)).toContain('没有提供官方模板正文');
    expect(result.content).toContain('未使用未经取得的官方模板正文');
  });
  it('feeds actual supplied template content instead of directory metadata', async () => {
    vi.mocked(makeLLMCall).mockImplementationOnce(async messages=>({ text: contractStructuredReply(String(messages.find(message=>message.role==='user')!.content), '服务合同工作稿：保密义务、服务范围、履行期限及验收安排待双方确认，其他未提供的条件不作已达成认定。'), toolCalls: null } as any));
    await run('legal_draft_contract', { type: '服务合同', templateText: '真实提供模板标记T428731；第三条：服务成果在收到后5日内核验。' });
    const prompt=vi.mocked(makeLLMCall).mock.calls[0][0].find(m=>m.role==='user')?.content;
    expect(String(prompt)).toContain('T428731');
    expect(String(prompt)).toContain('合同模板正文');
    expect(String(prompt)).not.toContain('粘贴的招标要求');
  });
  it('keeps unselected template terms separate from the confirmed transaction data', async () => {
    const details = '虚构甲公司向虚构乙公司赠与图书100本，价值3000元，2026-10-20在上海交付；质量、瑕疵、附义务、公证及公益性质均未确认。';
    const template = '质量：□全新 □其他；赠与财产□是□否存在瑕疵；本合同□是□否附义务。\n通知条款：\"按原件填写\"。';
    vi.mocked(makeLLMCall).mockImplementationOnce(async messages=>({ text: contractStructuredReply(String(messages.find(message=>message.role==='user')!.content), '虚构赠与合同工作稿：图书100本，价值3000元；质量、瑕疵、附义务、公证及公益性质均待双方确认，不自动勾选。'), toolCalls: null } as any));
    await run('legal_draft_contract', { type: '赠与合同', details, templateText: template });
    const prompt = String(vi.mocked(makeLLMCall).mock.calls[0][0].find(m => m.role === 'user')?.content);
    expect(contractPromptSources(prompt).some(source=>source.quote===details)).toBe(true);
    expect(contractPromptSources(prompt).some(source=>source.quote===template)).toBe(true);
    expect(prompt).not.toContain('先形成内部');
    expect(prompt).toContain('是/否未确认时保持□是 □否');
    expect(makeLLMCall).toHaveBeenCalledTimes(1);
  });
  it('sends each original pleading once without filling an unstated opposing position', async () => {
    const complaint = '原告星桥公司称被告欠款9万元；只有原告陈述，尚无原件。';
    const evidence = '被告澄河公司提供7万元付款截图，银行原始流水待核实。';
    const opponentMaterials = '被告提出质量异议但未提供检测；没有提供原告对质量异议的回应。';
    vi.mocked(makeLLMCall).mockResolvedValueOnce({ text: JSON.stringify({ entries: [{ issue: '付款截图是否对应本案交易？', sourceIds: ['F1', 'F2', 'F3'] }] }), toolCalls: null } as any);
    const result = await run('legal_extract_dispute_focus', { caseName: '事实归属虚构案', role: '原告', complaint, evidence, opponentMaterials });
    const prompt = String(vi.mocked(makeLLMCall).mock.calls[0][0].find(m => m.role === 'user')?.content);
    for (const original of [complaint, evidence, opponentMaterials]) expect(prompt.split(original)).toHaveLength(2);
    for (const original of [complaint, evidence, opponentMaterials]) expect(result.content).toContain(original);
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' });
    expect(result.content).toContain('尚未开展外部检索');
    expect(result.content).not.toContain('原告否认质量异议');
    expect(prompt).not.toContain('先形成内部');
    expect(prompt).not.toContain('对方可能主张');
    expect(makeLLMCall).toHaveBeenCalledTimes(1);
  });
  it('does not count a truncated contract as a generated document', async () => {
    vi.mocked(makeLLMCall).mockResolvedValueOnce({ text: '# 合同\n被截断的正文', finishReason: 'length', toolCalls: null } as any);
    const result=await run('legal_draft_contract', { type: '买卖合同', details: '仅用于验收' });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).not.toContain('案件空间：已归档');
  });
  it('keeps an incomplete bid outline available while reporting partial', async () => {
    vi.mocked(makeLLMCall).mockResolvedValueOnce({ text: '| 技术服务', finishReason: 'length', toolCalls: null } as any);
    const result=await run('legal_generate_bid', { projectName: '虚构验收标书', requirements: '报价不得超过3万元。R77要求：五日内提供方案。' });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).toContain('R77');
    expect(result.content).toContain('不能当成已完成标书');
    expect(result.content).toContain('DOCX 文件');
  });
});
describe('notice PDF capture uses the real parse path', () => {
  it('follows one explicit same-origin PDF and extracts its actual body', async () => {
    const pdf=await samplePdf();
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('<a href="/documents/notice.pdf">下载正式文书</a>', {headers:{'content-type':'text/html'}})).mockResolvedValueOnce(new Response(new Uint8Array(pdf), {headers:{'content-type':'application/pdf'}}));
    const result=await run('legal_process_notice_link', { url: 'https://court.example.test/sms/1' });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.receipt).toMatchObject({ ok: true, status: 'downloaded' });
    expect(result.content).toContain('731829');
  });
  it('archives the downloaded PDF and full original text as imported source material', async () => {
    const c=LegalCases.createCase(context.orgId,context.userId,{title:'模拟PDF原文入案'});
    const pdf=await samplePdf();
    vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(new Uint8Array(pdf),{headers:{'content-type':'application/pdf'}}));
    const result=await run('legal_process_notice_link',{url:'https://court.example.test/doc.pdf',caseId:c.id,persistCase:true});
    expect(result.receipt).toMatchObject({ok:true,status:'downloaded'});
    const item=LegalCases.getCase(context.orgId,c.id,context.userId)?.materials.find(m=>m.source==='import');
    expect(item?.content).toContain('731829');
    expect(item?.localPath).toMatch(/\.pdf$/);
    expect(isLegalSourceMaterial(item!)).toBe(true);
  });
  it('does not promote a saved HTML notice to a completed document download', async () => {
    vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('<html>有通知，未提供正式文书</html>', {headers:{'content-type':'text/html'}}));
    const result=await run('legal_process_notice_link', { url: 'https://court.example.test/notice/1' });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).toContain('正式 PDF 尚未取得');
  });
  it('does not follow a private redirect or save it as a document', async () => {
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('', {status:302,headers:{location:'http://127.0.0.1/private.pdf'}}));
    const result=await run('legal_process_notice_link', { url: 'https://court.example.test/notice/1' });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.receipt).toMatchObject({ ok: false, status: 'blocked' });
  });
});

describe('meeting report completion through HTTP', () => {
  it('does not archive a token-limited meeting result as a complete report', async () => {
    vi.mocked(makeLLMCall).mockResolvedValueOnce({text:'会议要点被截断',finishReason:'length',toolCalls:null} as any);
    const token=jwt.sign({uid:'report-meeting-probe',role:'user'},JWT_SECRET);
    const response=await fetch(app.url+'/api/meeting/analyze',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({notes:[{text:'仅用于程序验收，需要收集原始合同。',timestamp:Date.now()}],language:'zh'})});
    const body=await response.json();
    expect(response.status).toBe(502);
    expect(body).not.toHaveProperty('legalCaseArchived');
    expect(body.error).toContain('未取得完整会议报告');
  });
});
