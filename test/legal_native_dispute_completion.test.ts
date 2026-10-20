import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { makeLLMCall } from '../server/llm/providers';
import { createCase, getCase } from '../server/org/legal_cases';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { finalizeExecutionForOutboundDelivery } from '../server/cognition/execution_guard_recovery';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import type { ToolExecutionRecord } from '../server/tools/types';
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn() }));
let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry();
const context = { userId: 'native-dispute-owner', domain: 'work', orgId: 'native-dispute-org', authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local', source: 'chat', llmGetters: {}, taskId: 'native-dispute-task', requestId: 'native-dispute-request' } as any;
const materials = '原告星桥公司称被告澄河公司尚欠9万元货款，未提供合同和签收单原件。\n被告称已付款7万元，目前仅有截图，原始银行流水待核实。\n被告提出质量异议但尚无检验报告，未提供原告对质量异议的回应。';
beforeAll(async () => { app = await makeApp(); registerLegalTools(registry); });
afterAll(() => app.cleanup());
afterEach(() => vi.mocked(makeLLMCall).mockReset());
async function generate(persistCase = true, modelText = JSON.stringify({ entries: [{ issue: '付款抵扣及质量异议需要补核哪些原始材料？', sourceIds: ['F1','F2','F3'] }] })) {
  vi.mocked(makeLLMCall).mockResolvedValue({ text: modelText, toolCalls: [] } as any);
  const item = createCase(context.orgId, context.userId, { title: '虚构原文归属案', factDate: '2026-09-01' });
  const before = JSON.stringify(getCase(context.orgId,item.id,context.userId));
  const task = '仅用于虚构程序验收。请针对案件ID '+item.id+' 实际调用现有争议焦点分析功能，返回律师复核工作稿；不进行法院提交、对外发送或支付。事实发生日2026-09-01，我方原告。以下材料原文：\n'+materials;
  const record = await executeToolCall({ registry, name: 'legal_extract_dispute_focus', arguments: { caseId:item.id, role:'原告', materials, persistCase, factDate:'2026-09-01' }, context: { ...context, actionIntent:task } });
  return { item, before, task, record };
}
function finalize(task: string, record: ToolExecutionRecord, responseText = record.result) {
  return finalizeLumiResponse({taskText:task,responseText,toolRecords:[record],source:'chat',requestId:context.requestId,taskId:context.taskId});
}
describe('native dispute source collation completion', () => {
  it('accepts the real canonical collation product and never starts duplicate recovery', async () => {
    const {item, task, record} = await generate();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(record.capability).toMatchObject({ operation:'create', capabilityId:'legal.dispute-focus.extract' });
    expect(record.receipt).toMatchObject({ok:true,status:'generated',persisted:true,changedCaseIds:[item.id],artifacts:[],content:record.result});
    const saved=getCase(context.orgId,item.id,context.userId)!;
    expect(saved.materials).toHaveLength(1);
    for (const original of materials.split('\n')) expect(saved.materials[0].content).toContain(original);
    expect(saved.workflowRuns?.at(-1)).toMatchObject({tool:'legal_extract_dispute_focus',ok:true,status:'generated'});
    const variants = [record.result, '已完成来源归集，以下仅为律师复核工作稿：\n'+record.result, '已生成争议焦点报告，材料中的付款和质量缺陷均待核实。'];
    for (const responseText of variants) {
      const finalization=finalize(task,record,responseText);
      expect(finalization.blocked).toBe(false);
      const attempt=vi.fn();
      const result=await finalizeExecutionForOutboundDelivery({task,responseText,finalization,allowToolUse:true,toolRecords:[record],attempt,finalize:(text,records)=>finalizeLumiResponse({taskText:task,responseText:text,toolRecords:records,source:'chat',requestId:context.requestId,taskId:context.taskId})});
      expect(attempt).not.toHaveBeenCalled();
      expect(result.finalization.blocked).toBe(false);
    }
    expect(makeLLMCall).toHaveBeenCalledTimes(1);
  });
  it('recognizes a nonpersisted text draft while leaving its existing case unchanged', async () => {
    const {item,before,task,record}=await generate(false);
    expect(record.receipt).toMatchObject({ok:true,status:'generated',persisted:false,changedCaseIds:[],articleIds:[],artifacts:[]});
    expect(JSON.stringify(getCase(context.orgId,item.id,context.userId))).toBe(before);
    expect(finalize(task,record,'已生成争议材料归集工作稿，供律师复核。').blocked).toBe(false);
  });
  it('keeps partial source selection blocked without upgrading its preserved originals', async () => {
    const {task,record}=await generate(true,JSON.stringify({entries:[{issue:'未知来源',sourceIds:['F999']}]}));
    expect(record.receipt).toMatchObject({ok:false,status:'partial'});
    expect(record.terminalVerification?.status).toBe('failed');
    expect(record.result).toContain('保留原始材料');
    expect(finalize(task,record,'已生成争议材料归集报告。').blocked).toBe(true);
  });
  it('does not accept empty tool input as a generated source product', async () => {
    const record=await executeToolCall({registry,name:'legal_extract_dispute_focus',arguments:{persistCase:false},context});
    expect(record.receipt).toMatchObject({ok:false,status:'blocked'});
    expect(record.terminalVerification?.status).toBe('failed');
    expect(finalize('生成争议材料归集工作稿',record,'已生成工作稿。').blocked).toBe(true);
    expect(makeLLMCall).not.toHaveBeenCalled();
  });
  it.each(['PDF 文件已生成。','DOCX 已生成。','已保存文件 D:/fake/争点报告.docx。'])('never treats an inline product as proof of physical output: %s', async response => {
    const {task,record}=await generate();
    expect(finalize(task,record,response).blocked).toBe(true);
  });
  it.each([{requestId:'different-request'},{taskId:'different-task'}])('rejects a generated draft from another turn: %o', async identity => {
    const {task,record}=await generate();
    expect(finalize(task,{...record,...identity},'已生成争议材料归集报告。').blocked).toBe(true);
  });
  it.each(['已经保存报告。','已归档工作稿。','已经写入报告。'])('does not claim persistence for a preview-only product: %s',async response=>{
    const {task,record}=await generate(false);
    expect(finalize(task,record,response).blocked).toBe(true);
    expect(finalize(task,record,'已生成工作稿、未入案。').blocked).toBe(false);
    const negative=finalize(task,record,'已生成工作稿，未归档，尚未保存。');
    expect(negative.blocked).toBe(false);
  });
  it('accepts actual source archive metadata without requiring a physical file',async()=>{
    const {task,record}=await generate(true);
    expect(finalize(task,record,'已归档工作稿。').blocked).toBe(false);
    const archived={...record,receipt:{...record.receipt as object,status:'archived'},capability:{...record.capability!,verification:{...record.capability!.verification,successStatuses:['archived']}}};
    expect(guardCompletionClaims({task,response:'已归档工作稿。',toolCalls:[archived],...context}).blocked).toBe(false);
  });
  it('accepts only the current host organization transaction for abstract persistence',()=>{
    const input={task:'归档源材料到知识库',response:'已归档材料。',requestId:context.requestId,taskId:context.taskId};
    const record:ToolExecutionRecord={name:'organization_business_command',arguments:{},requestId:context.requestId,taskId:context.taskId,result:JSON.stringify({ok:true,verified:true,status:'completed',verificationMethod:'organization-server-transaction',persisted:true,changedCaseIds:[],articleIds:['host-article-proof']}),terminalVerification:{status:'verified',strategy:'terminal_receipt',reason:'host transaction'},envelope:{version:1,status:'verified_success',turnId:context.requestId,completedAt:new Date().toISOString(),toolName:'organization_business_command',requestId:context.requestId,taskId:context.taskId,idempotencyKey:'transaction',targetIdentity:context.orgId,verification:{status:'verified',basis:'terminal_verification',reason:'Host transaction verified'}}};
    expect(guardCompletionClaims({...input,toolCalls:[record]}).blocked).toBe(false);
    expect(guardCompletionClaims({...input,response:'已归档1份文件到组织知识库。',toolCalls:[record]}).blocked).toBe(false);
    for(const bad of [
      {...record,result:JSON.stringify({ok:true,verified:false,status:'completed',verificationMethod:'organization-server-transaction'})},
      {...record,result:JSON.stringify({ok:true,verified:true,status:'completed',verificationMethod:'organization-server-transaction',persisted:false,changedCaseIds:[],articleIds:['host-article-proof']})},
      {...record,result:JSON.stringify({ok:true,verified:true,status:'completed',verificationMethod:'organization-server-transaction',persisted:true,changedCaseIds:[],articleIds:[]})},
      {...record,result:JSON.stringify({ok:true,verified:true,status:'completed',verificationMethod:'organization-server-transaction',persisted:true,changedCaseIds:[false,0],articleIds:['   ']})},
      {...record,requestId:'different-request'},
      {...record,envelope:{...record.envelope!,requestId:'other-scope-request'}},
      {...record,envelope:{...record.envelope!,taskId:'other-scope-task'}},
      {...record,envelope:{...record.envelope!,status:'failed' as const}},
      {...record,taskId:'different-task'},
      {...record,terminalVerification:{...record.terminalVerification!,status:'unverified' as const}},
      {...record,capability:{capabilityId:'web.fetch',lane:'web' as const,operation:'observe' as const,risk:'low' as const,sideEffects:[],verification:{strategy:'terminal_receipt' as const,required:true,requiredFields:[],successSignals:[],limitations:[]}}},
    ])expect(guardCompletionClaims({...input,toolCalls:[bad]}).blocked).toBe(true);
    expect(guardCompletionClaims({...input,response:'PDF 文件已生成。',toolCalls:[record]}).blocked).toBe(true);
    expect(guardCompletionClaims({...input,response:'文件已保存 D:/fake/report.docx。',toolCalls:[record]}).blocked).toBe(true);
  });
  it('requires terminal verification and the complete standard product receipt', async () => {
    const {task,record}=await generate();
    for (const invalid of [
      {...record,terminalVerification:{...record.terminalVerification!,status:'unverified' as const}},
      {...record,receipt:{ok:true,status:'generated'}},
      {...record,receipt:{...record.receipt as object,content:'not the generated body'}},
    ]) expect(guardCompletionClaims({task,response:'已生成争议材料归集报告。',toolCalls:[invalid],...context}).blocked).toBe(true);
  });
  it('still requires the established law gate for a claimed formal legal document', async () => {
    const {record}=await generate();
    expect(finalize('请生成法律意见书，依据本案适用法律。',record,'法律意见书已生成，可以正式使用。')).toMatchObject({blocked:true});
  });
  it('does not relax abstract report production when only a read tool succeeded', () => {
    const record:ToolExecutionRecord={name:'read_file',arguments:{},result:'some source',terminalVerification:{status:'verified',strategy:'terminal_receipt',reason:'read'}};
    expect(guardCompletionClaims({task:'生成分析报告',response:'分析报告已生成。',toolCalls:[record]}).blocked).toBe(true);
  });
});
