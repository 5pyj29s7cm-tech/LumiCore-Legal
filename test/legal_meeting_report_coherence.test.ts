import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import { ToolRegistry, toolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { createCase, getCase, listCases } from '../server/org/legal_cases';
import { createOrg, addMember } from '../server/org/db';
import { isLegalSourceMaterial } from '../shared/legal_workflow_receipts';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { makeLLMCall } from '../server/llm/providers';
import { addMessageIdempotent, startIsolatedConversation } from '../server/conversation/manager';
import { bindConversationActionTurnTask } from '../server/conversation/action_turn_ledger';
import { buildLegalMeetingMinutesMarkdown, buildLegalMeetingActionItemsMarkdown, buildLegalMeetingCaseUpdateMarkdown, buildLegalMeetingLiveBriefMarkdown } from '../server/regions/packs/cn/legal_tools/meetings';
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall:vi.fn() }));
let app:Awaited<ReturnType<typeof makeApp>>;
const registry=new ToolRegistry();
const context={userId:'meeting-original-owner',domain:'work',orgId:'meeting-original-org',authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local'} as any;
const lines=Array.from({length:320},(_,i)=> i===319?'模拟丙：仅安排10月30内部提醒；没有收到法院期限通知；原告对质量异议的回应尚未提供。':'模拟甲：虚构沟通原句 '+i+'；是否付款及是否交货均待原件核实。');
const transcript=lines.join('\n');
const report='# 虚构会议报告\n仅为律师复核摘要。\n末段行动：模拟丙负责10月30内部提醒，该日期不是法院期限。\n原告对质量异议的回应未提供，不推定其承认或否认。';
beforeAll(async()=>{app=await makeApp();registerLegalTools(registry);registerLegalTools(toolRegistry);const unavailable=()=>null;mountChatRoutes(app.apiRouter,JWT_SECRET,{getDeepSeek:unavailable,getGemini:unavailable,getOpenAI:unavailable,getAnthropic:unavailable,getQwen:unavailable});});
afterAll(()=>app.cleanup());afterEach(()=>vi.mocked(makeLLMCall).mockReset());
async function run(options:Record<string,unknown>={}){const item=createCase(context.orgId,context.userId,{title:'虚构长会议来源归属',notes:'先前原始备注，仅验收。'});const before=JSON.stringify(getCase(context.orgId,item.id,context.userId));const record=await executeToolCall({registry,name:'legal_meeting_minutes_to_case',arguments:{caseId:item.id,transcript,report,persistCase:true,...options},context});return{item,before,record,saved:getCase(context.orgId,item.id,context.userId)!};}
describe('one legal meeting report and separate complete originals',()=>{
 it('does not archive model rewritten message or attachment text beside server-bound originals',async()=>{
   const userId='virtual-intake-source-owner',requestId='virtual-intake-request',taskId='virtual-intake-task';const conversation=startIsolatedConversation(userId,'lumi','personal','');
   const original='虚构原始消息：原告主张货款9万元，被告称付款7万元但只有截图；未提供原告对质量异议的回应。';
   addMessageIdempotent({userId,agentId:'lumi',conversationId:conversation.id,requestId,domain:'personal',orgId:'',source:'chat',channel:'chat',role:'user',content:original,deferActionPreparation:true});
   expect(bindConversationActionTurnTask({userId,conversationId:conversation.id,requestId,taskId}).bound).toBe(true);
   const scope={...context,userId,domain:'personal',orgId:'',source:'chat',conversationId:conversation.id,requestId,taskId};
   const record=await executeToolCall({registry,name:'legal_message_intake_to_case',arguments:{caseName:'虚构聊天来源入案',message:'模型改写：对方承认欠款2万元。',attachments:[{fileName:'编造附件.txt',extractedText:'MODEL FORGED ATTACHMENT'}],processLinks:false},context:scope});
   fs.writeFileSync('C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/legal-all-modules-20261013/other-modules/meeting-source-coherence/intake-source-diagnosis.json',JSON.stringify(record,null,2));expect(record.receipt).toMatchObject({ok:true,persisted:true});const saved=listCases('personal:'+userId,'虚构聊天来源入案',20,userId)[0];expect(saved.materials).toHaveLength(1);expect(saved.materials[0].content).toContain(original);expect(JSON.stringify(saved.materials)).not.toContain('MODEL FORGED ATTACHMENT');expect(JSON.stringify(saved.materials)).not.toContain('对方承认欠款2万元');
 });

 it('archives the existing model report and all 320 original turns without rebuilding keyword summaries',async()=>{const {record,saved}=await run();expect(record.receipt).toMatchObject({ok:true,status:'generated',persisted:true});expect(record.terminalVerification?.status).toBe('verified');const source=saved.materials.filter(isLegalSourceMaterial);expect(source).toHaveLength(1);expect(source[0]).toMatchObject({source:'import',type:'consultation',content:transcript});expect(fs.readFileSync(source[0].localPath!,'utf8')).toBe(transcript);expect(saved.materials.some(m=>m.source==='tool'&&m.content.includes(report))).toBe(true);expect(saved.materials.filter(m=>m.source==='tool').every(m=>!m.content.includes(lines[0])&&!m.content.includes(lines[319]))).toBe(true);for(const material of saved.materials)if(material.localPath)expect(fs.readFileSync(material.localPath,'utf8')).toBe(material.content);const artifacts=(record.receipt as any).artifacts as string[];expect(artifacts).toHaveLength(4);for(const file of artifacts.filter(p=>!p.endsWith('legal-meeting-case-update.md')))expect(fs.readFileSync(file,'utf8')).toContain(report);expect(makeLLMCall).not.toHaveBeenCalled();});
 it('reports missing summary as partial while preserving full originals and never assigning owners or court deadlines',async()=>{const {record,saved}=await run({report:''});expect(record.receipt).toMatchObject({ok:false,status:'partial',persisted:true});expect(record.result).toContain('尚未生成总结');expect(saved.materials.filter(isLegalSourceMaterial)[0].content).toBe(transcript);const minutes=saved.materials.find(m=>m.source==='tool')!.content;expect(minutes).not.toContain('暂未识别明确期限');expect(minutes).not.toContain('Fact Timeline Seeds');expect(makeLLMCall).not.toHaveBeenCalled();});
 it('keeps files readable but does not mutate an existing case when persistence is disabled',async()=>{const {item,before,record}=await run({persistCase:false});expect(record.receipt).toMatchObject({ok:true,status:'generated',persisted:false,changedCaseIds:[]});expect(JSON.stringify(getCase(context.orgId,item.id,context.userId))).toBe(before);expect((record.receipt as any).artifacts).toHaveLength(4);});
 it('uses the server-bound materials alias in every existing meeting renderer and the handler',async()=>{const args={materials:'BOUND ORIGINAL BODY marker 319',transcript:'MODEL REWRITTEN BODY',meetingText:'MODEL ALIAS',notes:'MODEL NOTES',report};const files={minutesPath:'minutes.md',actionItemsPath:'actions.md',caseUpdatePath:'original.md'};expect(buildLegalMeetingCaseUpdateMarkdown(args)).toBe(args.materials);for(const markdown of [buildLegalMeetingMinutesMarkdown(args),buildLegalMeetingActionItemsMarkdown(args),buildLegalMeetingLiveBriefMarkdown(args,files)])expect(markdown).not.toContain('MODEL REWRITTEN BODY');const {saved}=await run(args);expect(saved.materials.filter(isLegalSourceMaterial)[0].content).toBe(args.materials);});
 it('generates one meeting report without writing a case or invoking an archive tool',async()=>{
    const org=createOrg('虚构会议报告组织','synthetic-report-coherence',context.userId);addMember(org.id,context.userId,'owner');
    const item=createCase(org.id,context.userId,{title:'虚构HTTP会议归档'});const before=JSON.stringify(getCase(org.id,item.id,context.userId));
    vi.mocked(makeLLMCall).mockResolvedValueOnce({text:report,toolCalls:[],finishReason:'stop'} as any);
    const token=jwt.sign({uid:context.userId,username:'SyntheticOwner',role:'admin',orgId:org.id},JWT_SECRET,{expiresIn:'1h'});
    const response=await fetch(app.url+'/api/meeting/analyze',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({notes:lines.map((text,i)=>({text,time:Date.now()+i})),language:'zh',purpose:'legal_consultation',legalCase:{id:item.id,title:item.title}})});
    const data=await response.json();expect(response.status).toBe(200);expect(data).toMatchObject({report});expect(data).not.toHaveProperty('legalCaseArchived');
    expect(JSON.stringify(getCase(org.id,item.id,context.userId))).toBe(before);expect(makeLLMCall).toHaveBeenCalledTimes(1);
    const prompt=String(vi.mocked(makeLLMCall).mock.calls[0][0][0].content);expect(prompt).toContain(lines[319]);expect(listCases(org.id,'',20,context.userId)).toHaveLength(1);
  });
});
