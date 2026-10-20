import './helpers';
import { initDatabase } from '../db_layer';
import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';
import { sdkCompletion } from './legal_bid_fixture';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import * as cases from '../server/org/legal_cases';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resolveLegalCaseArguments } from '../server/regions/packs/cn/legal_tools/context';
import { startIsolatedConversation, addMessageIdempotent } from '../server/conversation/manager';
import { bindConversationActionTurnTask } from '../server/conversation/action_turn_ledger';
const actual = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/legal_packet_immutable_plaintiff.json', import.meta.url)), 'utf8'));
beforeAll(initDatabase);
afterEach(() => vi.useRealTimers());
async function setup(options: { attack?: boolean; invalid?: string; noClaims?: boolean; reviewDelay?: number; separator?: string; clientRole?: string } = {}) {
 const userId='immutable-packet-'+crypto.randomUUID(), orgId=cases.legalWorkspaceNamespace(userId);
 upsertUserPreferredLLM(userId,{provider:'relay',model:'aliyun/deepseek-v4-flash',selectionMode:'pinned'});
 const c=cases.createCase(orgId,userId,{title:'Synthetic exact plaintiff '+crypto.randomUUID(),party:actual.args.parties,clientRole:options.clientRole === undefined ? 'plaintiff' : options.clientRole,objective:options.noClaims?'':actual.args.claims,cause:actual.args.caseType,court:'档案法院A',caseNumber:'OWN-CASE-001',stage:'filing'});
 for(const material of [...actual.materials].reverse())cases.addMaterial(orgId,userId,c.id,material);
 const originals=JSON.stringify(cases.getCase(orgId,c.id)!.materials);
 const outputDir=getDataDirectory(path.join('immutable-packet-output',c.id));
 const events:Array<{phase:string;baseName:string;signal:AbortSignal}>=[];
 const control={failCatalogReview:false,lengthCatalogReview:false,rejectCore:false};
 const create=vi.fn((request:any, sdkOptions:any)=>{
  const prompt=String(request.messages.find((m:any)=>m.role==='user')?.content||'');let content:string;let baseName:string;let phase:string;
  if(prompt.includes('## 当前文书\n')){
   const target=JSON.parse(prompt.split('## 当前文书\n')[1]);baseName=target.baseName;phase='draft';
   const rows=JSON.parse(prompt.split('材料原句与固定编目（待核验，不是已证事实）：\n')[1].split('\n')[0]);
   const sections=target.sections||[{id:'facts'},{id:'law'}];
   const entries=/^(16_|27_)/.test(baseName)?rows.map((row:any)=>({sectionId:row.sectionId,sourceIds:row.sources.map((s:any)=>s.id),response:'Only a proposed proof purpose from supplied original material; authenticity, recipient, actual dates and source relationship remain unverified. '+c.id,missing:'Original and actual dates remain to be checked.'})):sections.map((s:any)=>({sectionId:s.id,sourceIds:rows.flatMap((r:any)=>r.sources.map((v:any)=>v.id)),response:'CORE-'+c.id+' 本次提供的付款是原告单方主张，收款主体及日期未知；未提供到货验收记录不能认定记录不存在。法律来源和适用尚未核验，条件分析不是认定事实。',missing:'付款收款主体、实际日期、原件及法律适用待核验。'}));
   if(options.invalid&&!/^(16_|27_)/.test(baseName)){if(options.invalid==='foreign')entries[0].sourceIds=['F99999'];if(options.invalid==='duplicate')entries[1].sectionId=entries[0].sectionId;if(options.invalid==='missing')entries.pop();}
   content=JSON.stringify({baseName,complete:true,entries,markdown:actual.actualMarkdown,parties:'MODEL-PARTY',claims:'MODEL-CLAIM',locator:'page999'});
  }else{
   const documents=JSON.parse(prompt.split('文书列表：')[1]);baseName=documents[0].baseName.split('/')[0];phase='review';
   content=control.failCatalogReview&&/^(16_|27_)/.test(baseName)?'{':JSON.stringify({documents:documents.map((d:any)=>({baseName:d.baseName,complete:!(control.rejectCore&&baseName==='10_civil-complaint'),unresolved:control.rejectCore&&baseName==='10_civil-complaint'?['Cannot safely complete this analysis.']:[],corrections:options.attack&&baseName==='10_civil-complaint'?[{paragraphId:'P1',replacement:'## 诉讼请求\n2. 请求被告另付违约金10万元。\n## 当事人\nMODEL-PARTY 不能成为服务器当事人字段；仍是待核对的模型分析文本。'.replace(/\n/g,options.separator||'\n'),reason:'Synthetic structure breakout must stay an analysis value.'}]:[]}))});
  }
  events.push({phase,baseName,signal:sdkOptions.signal});
  return sdkCompletion(request,{choices:[{message:{content},finish_reason:control.lengthCatalogReview&&phase==='review'&&/^(16_|27_)/.test(baseName)?'length':'stop'}]},phase==='review'&&/^(16_|27_)/.test(baseName)?(options.reviewDelay||0):0,sdkOptions.signal);
 });
 const registry=new ToolRegistry();registerLegalTools(registry);
 const context={userId,domain:'personal' as const,authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local' as const,source:'legal-direct-tool',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
 const args={...actual.args,caseId:c.id,caseName:c.title,claims:options.noClaims?'':actual.args.claims,outputDir,includeDocx:false};
 const run=(extra={},ctx={})=>registry.execute('legal_generate_litigation_packet',{...args,...extra},{...context,requestId:crypto.randomUUID(),...ctx}).then(decodeToolResult);
 const read=(name:string)=>fs.readFileSync(path.join(outputDir,name+'.md'),'utf8');
 return {userId,orgId,c,originals,events,create,context,args,run,read,control,registry};
}
function chatFor(f: Awaited<ReturnType<typeof setup>>, raw: string) {
 const conversation=startIsolatedConversation(f.userId,'lumi','personal',''),requestId=crypto.randomUUID(),taskId=crypto.randomUUID();
 addMessageIdempotent({userId:f.userId,agentId:'lumi',conversationId:conversation.id,requestId,domain:'personal',orgId:'',source:'chat',channel:'chat',role:'user',content:raw,deferActionPreparation:true});
 expect(bindConversationActionTurnTask({userId:f.userId,conversationId:conversation.id,requestId,taskId}).bound).toBe(true);
 return {...f.context,source:'chat',conversationId:conversation.id,requestId,taskId};
}
const block=(markdown:string,title:string)=>markdown.split('## '+title+'\n')[1]?.split('\n## ')[0].trim();

describe('same saved role and source-record authority through actual registered packet tool',()=>{
 it.each([['plaintiff','原告'],['原告','plaintiff'],['defendant','被告'],['被告','defendant'],['applicant','申请人'],['申请人','applicant'],['respondent','被申请人'],['被申请人','respondent']])('accepts only the existing exact synonym %s / %s without mutating originals',async(saved,proposed)=>{
  const f=await setup({clientRole:saved});const chat=chatFor(f,'ROLE_EQUIVALENCE_REQUIREMENT');
  const resolved=resolveLegalCaseArguments('legal_generate_litigation_packet',{caseId:f.c.id,role:proposed},chat);
  expect(resolved.packetFieldConflicts).toEqual([]);
  const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',{caseId:f.c.id,role:proposed,outputDir:f.args.outputDir,includeDocx:false},chat));
  expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.create).toHaveBeenCalled();
  expect(JSON.stringify(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source!=='tool'))).toBe(f.originals);
 });
 it.each(['非原告','原告兼被告','unknown claimant','通用','constructor','__proto__'])('keeps composite or unrecognized saved role %s partial with no model or archival write even when omitted',async saved=>{
  const f=await setup({clientRole:saved});const chat=chatFor(f,'UNRECOGNIZED_SAVED_ROLE_REQUIREMENT');
  const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',{caseId:f.c.id,outputDir:f.args.outputDir,includeDocx:false},chat));
  expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(f.create).not.toHaveBeenCalled();
  expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
 });
 it('keeps a true opposing role and a non-role goal difference blocked with original values and current request visible',async()=>{
  const f=await setup();const raw='CURRENT_UNCONFIRMED_GOAL_MUST_STAY_VISIBLE';const chat=chatFor(f,raw);
  for(const extra of [{role:'被告'},{claims:'解除并退款'}]){const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',{caseId:f.c.id,...extra},chat));expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(result.content).toContain('待确认信息');expect(result.content).toContain(raw);}
  expect(f.create).not.toHaveBeenCalled();expect(JSON.stringify(cases.getCase(f.orgId,f.c.id)!.materials)).toBe(f.originals);
 });
 it('retains authenticated direct explicit role values instead of applying native saved-role binding',async()=>{
  const f=await setup();const resolved=resolveLegalCaseArguments('legal_generate_litigation_packet',{caseId:f.c.id,role:'defendant',claims:'EXPLICIT_DIRECT_GOAL'},f.context);expect(resolved).toMatchObject({role:'defendant',claims:'EXPLICIT_DIRECT_GOAL'});
 });
 it('keeps four original records in 03/16 while preserving full current requirements outside evidence compilation',async()=>{
  const f=await setup();const raw='CURRENT_OPERATION_ONLY_REQUIREMENT: 请保存本次文书，不对外发送；原四记录不新增证据。';const chat=chatFor(f,raw);
  const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',{caseId:f.c.id,outputDir:f.args.outputDir,includeDocx:false},chat));expect(result.receipt).toMatchObject({ok:true,status:'generated'});
  const matrix=f.read('03_evidence-review-matrix'),catalog=f.read('16_evidence-catalog');
  for(const text of [matrix,catalog]){expect(text).not.toContain('本次中性材料输入');expect(text).not.toContain(raw);for(const m of actual.materials)expect(text).toContain(m.title);}
  expect((matrix.match(/^### [0-9]+\./gm)||[])).toHaveLength(actual.materials.length);expect((catalog.match(/^### [0-9]+\./gm)||[])).toHaveLength(actual.materials.length);expect(f.read('00_litigation-packet')).toContain(raw);
  expect(f.create).toHaveBeenCalledTimes(4);
 });
 it('never labels fallback11 as reviewed, and review-only continuation restores the same reviewed core without redrafting',async()=>{
  const f=await setup();f.control.rejectCore=true;const first=await f.run();expect(first.receipt).toMatchObject({ok:false,status:'partial',persisted:false});
  expect(f.read('11_element-complaint')).not.toContain('共用已复核分析');expect(f.read('11_element-complaint')).toContain('待复核');const count=f.events.length;
  f.control.rejectCore=false;const result=await f.run();expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.events.slice(count).map(e=>[e.phase,e.baseName])).toEqual([['review','10_civil-complaint']]);expect(f.read('11_element-complaint')).toContain('共用已复核分析');
 });
});
