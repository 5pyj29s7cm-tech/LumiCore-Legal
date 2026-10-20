import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { readDB } from '../db_layer';
import { addMember, createOrg } from '../server/org/db';
import { listOrganizationWorkItems } from '../server/org/work_routing';
import * as cases from '../server/org/legal_cases';
import * as kb from '../server/org/kb';
import { createBindingCode, authorizeMessagingGroup } from '../server/messaging/bindings';
import { dispatchIncomingMessage } from '../server/regions/packs/cn/messaging_routes';
import { listMessagingJournal } from '../server/messaging/message_journal';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { toolRegistry } from '../server/tools/registry';
import type { IncomingMessage } from '../server/messaging/types';
vi.mock('../server/llm/embedding_provider', async original => ({ ...await original<typeof import('../server/llm/embedding_provider')>(), generateConfiguredEmbedding: vi.fn().mockRejectedValue(new Error('Synthetic test: remote embedding disabled')) }));
const finalizationTrace=vi.hoisted(()=>({calls:[] as any[]}));
vi.mock('../server/cognition/result_finalizer',async original=>{const actual=await original<typeof import('../server/cognition/result_finalizer')>();return{...actual,finalizeLumiResponse:(input:any)=>{const result=actual.finalizeLumiResponse(input);finalizationTrace.calls.push({taskText:input.taskText,responseText:input.responseText,requestId:input.requestId,taskId:input.taskId,toolNames:(input.toolRecords||[]).map((record:any)=>({name:record.name,status:record.envelope?.status,terminal:record.terminalVerification?.status,capability:record.capability,receipt:record.receipt,requestId:record.requestId,taskId:record.taskId,envelope:record.envelope,result:record.result})),result});return result;}};});
let cleanup=()=>{};let orgId='';const owner='synthetic-e2e-owner',member='synthetic-e2e-member',viewer='synthetic-e2e-viewer';
const deliveries:any[]=[];let sequence=0;let modelCalls=0;
const options={llmGetters:{getDeepSeek:()=>{modelCalls++;throw new Error('Synthetic test must not call a model');},getGemini:()=>{modelCalls++;throw new Error('Synthetic test must not call a model');}}};
async function send(lumiUserId:string,text:string,group=false,attachments?:IncomingMessage['attachments']) {
 const message:IncomingMessage={platform:'feishu',userId:'ou-'+lumiUserId,userName:lumiUserId,chatId:group?'oc-e2e-group':'oc-private-'+lumiUserId,chatType:group?'group':'private',botMentioned:group,messageId:'e2e-'+(++sequence),text,attachments,raw:{},timestamp:new Date().toISOString()};
 expect(dispatchIncomingMessage(message,{enrich:async value=>value,reply:async(target,reply)=>{deliveries.push({userId:target.userId,chatId:target.chatId,messageId:target.messageId,text:reply});return 'mock-ack-'+target.messageId;}},options)).toBe(true);
 let journal:any;
 await vi.waitFor(()=>{journal=listMessagingJournal().find(item=>item.messageId===message.messageId);expect(['completed','ignored','delivery_unknown','failed']).toContain(journal?.status);},{timeout:6000});
 return {message,journal,reply:deliveries.find(value=>value.messageId===message.messageId)?.text||''};
}
beforeAll(async()=>{const app=await makeApp();cleanup=app.cleanup;orgId=createOrg('Synthetic full-chain organization','synthetic-full-chain',owner).id;addMember(orgId,owner,'owner');addMember(orgId,member,'member');addMember(orgId,viewer,'viewer');registerLegalTools(toolRegistry);for(const user of [owner,member,viewer]){const code=createBindingCode('feishu',user,orgId,'work');const bound=await send(user,'绑定 Lumi '+code.code);expect(bound.journal.status).toBe('completed');}authorizeMessagingGroup({platform:'feishu',chatId:'oc-e2e-group',orgId,createdBy:owner,allowedPlatformUserIds:[owner,member,viewer].map(user=>'ou-'+user)});});
afterAll(()=>cleanup());
describe('synthetic Feishu legal and organization receipt chain',()=>{
 it('binds members individually and returns the actual scoped legal intake result',async()=>{
  const created=await send(owner,'请新建案件并归档：虚构甲公司诉虚构乙公司买卖合同纠纷，合同总价80万元、已付款20万元，交货未核实，仅程序验收。');
  fs.writeFileSync("C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/legal-all-modules-20261013/messaging-org/created-case-diagnosis.json",JSON.stringify({created,cases:cases.listCases(orgId,'',20,owner),receipts:readDB().conversationActionReceipts,workItems:listOrganizationWorkItems(orgId),modelCalls,finalizationTrace:finalizationTrace.calls},null,2));
  expect(created.journal.status).toBe('completed');expect(created.reply).toContain('远程法律消息已入案');expect(created.reply).not.toMatch(/legal_[a-z_]+|LUMI_TOOL_RECEIPT|案件ID|原文材料：[0-9a-f-]+/);
  expect(created.reply).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  const caseFiles=cases.listCases(orgId,'',20,owner);expect(caseFiles.length).toBeGreaterThan(0);expect(caseFiles.some(caseFile=>caseFile.createdBy===owner&&caseFile.materials.some(material=>material.source==='feishu'&&material.content.includes('已付款20万元')))).toBe(true);
 });
 it('archives and retrieves member-scoped knowledge with a durable local transport acknowledgement',async()=>{
  const archived=await send(member,'归档附件到组织知识库',false,[{id:'synthetic-text',type:'file',fileName:'SyntheticE2EKB.txt',extractedText:'SyntheticE2EKB complete factual source body. This is simulated input only.'}]);
  fs.writeFileSync('C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/legal-all-modules-20261013/other-modules/meeting-source-coherence/organization-archive-guard-diagnosis.json',JSON.stringify({archived,trace:finalizationTrace.calls},null,2));
  expect(archived.journal.status).toBe('completed');expect(archived.reply).toContain('已归档 1 份');
  const articles=kb.listArticles(orgId,undefined,member);expect(articles.some(article=>article.authorId===member&&article.content.includes('complete factual source body'))).toBe(true);
  const found=await send(member,'查询组织知识库 SyntheticE2EKB',true);expect(found.journal.status).toBe('completed');expect(found.reply).toContain('SyntheticE2EKB');
  expect(found.journal).toMatchObject({boundUserId:member,orgId,domain:'work',replyMessageId:'mock-ack-'+found.message.messageId});
  const taskReceipts=readDB().conversationActionReceipts.filter((receipt:any)=>receipt.externalMessageId===archived.message.messageId);expect(taskReceipts.some((receipt:any)=>receipt.toolName==='organization_business_command'&&receipt.outcome==='verified_success')).toBe(true);
  const archiveTrace=finalizationTrace.calls.find(input=>input.toolNames.some((record:any)=>record.name==='organization_business_command'&&record.envelope?.externalMessageId===archived.message.messageId))!;
  const archiveRecord=archiveTrace.toolNames.find((record:any)=>record.name==='organization_business_command');
  const archiveReceipt=JSON.parse(archiveRecord.result);
  expect(archiveReceipt).toMatchObject({ok:true,persisted:true,changedCaseIds:[]});
  expect(archiveReceipt.articleIds).toEqual(articles.filter(article=>article.content.includes('complete factual source body')).map(article=>article.id));
  expect(archiveRecord.envelope.result.articleIds).toEqual(archiveReceipt.articleIds);
  expect(archiveTrace.result.blocked).toBe(false);
  expect(modelCalls).toBe(0);
  fs.writeFileSync("C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/legal-all-modules-20261013/messaging-org/feishu-local-legal-kb-chain.json",JSON.stringify({simulation:true,externalDelivery:false,modelCalls,checks:{bindings:3,caseScopedToCreator:true,knowledgeScopedToMember:true,groupIdentityExact:true,localTransportAck:true},journal:[archived.journal,found.journal],receipts:taskReceipts},null,2));
 });
 it('does not certify a viewer-denied knowledge write as a verified successful business transaction',async()=>{
  const before=kb.listArticles(orgId,undefined,owner).length;
  const denied=await send(viewer,'归档附件到组织知识库',true,[{id:'denied-source',type:'file',fileName:'viewer-denied.txt',extractedText:'Synthetic viewer data must not be written.'}]);
  fs.writeFileSync("C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/legal-all-modules-20261013/messaging-org/viewer-early-route-diagnosis.json",JSON.stringify({denied,receipts:readDB().conversationActionReceipts.filter((receipt:any)=>receipt.externalMessageId===denied.message.messageId),modelCalls},null,2));
  expect(denied.reply).toMatch(/只有查看权限|read-only|organization member/i);expect(kb.listArticles(orgId,undefined,owner)).toHaveLength(before);
  const receipts=readDB().conversationActionReceipts.filter((receipt:any)=>receipt.externalMessageId===denied.message.messageId);
  fs.writeFileSync("C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/legal-all-modules-20261013/messaging-org/viewer-denial-receipt-diagnosis.json",JSON.stringify({simulation:true,externalDelivery:false,modelCalls,sourceUnchanged:true,reply:denied.reply,journal:denied.journal,receipts},null,2));
  expect(receipts.some((receipt:any)=>receipt.toolName==='organization_business_command'&&receipt.outcome==='verified_success')).toBe(false);
 });
});
