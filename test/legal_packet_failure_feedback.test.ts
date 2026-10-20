import './helpers';
import { initDatabase } from '../db_layer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { sdkCompletion } from './legal_bid_fixture';
import { packetDraftFixture } from './legal_packet_fixture';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import * as cases from '../server/org/legal_cases';
import { getUserPreferredLLMConfig, upsertUserPreferredLLM } from '../server/llm/user_preferences';
const cacheFault = vi.hoisted(() => ({ invalidPending: false, scopes: [] as Array<string|null> }));
vi.mock('../server/regions/packs/cn/legal_document_progress', async original => {
 const actual = await original<typeof import('../server/regions/packs/cn/legal_document_progress')>();
 return { ...actual, legalDocumentProgress: (...args: Parameters<typeof actual.legalDocumentProgress>) => {
  cacheFault.scopes.push(args[0]); const progress=actual.legalDocumentProgress(...args);
  return { ...progress, get: (name:string) => cacheFault.invalidPending&&name==='10_civil-complaint'
   ? {reviewed:false,markdown:JSON.stringify({entries:[{sectionId:'law',sourceIds:['F_UNKNOWN_PRIVATE'],response:'Legal source remains unverified in this pending fixture.',missing:''}]})}
   : progress.get(name) };
 } };
});
beforeAll(initDatabase);
beforeEach(()=>{cacheFault.invalidPending=false;cacheFault.scopes=[];});
type Fault='length'|'empty'|'json'|'source'|'success';
async function setup(phase:'draft'|'review', fault:Fault) {
 const userId='packet-feedback-'+crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId);
 upsertUserPreferredLLM(userId,{provider:'relay',model:'aliyun/deepseek-v4-flash',selectionMode:'pinned'});
 const c=cases.createCase(orgId,userId,{title:'Synthetic feedback case '+crypto.randomUUID(),party:'Synthetic A / Synthetic B',clientRole:'plaintiff',objective:'Only the original conditional performance request.'});
 cases.addMaterial(orgId,userId,c.id,{title:'Original payment excerpt',type:'evidence',source:'import',content:'A alleges200000 paid; success, payer, recipient and contract allocation remain unknown.'});
 const originals=JSON.stringify(cases.getCase(orgId,c.id)!.materials),events:Array<{phase:string;baseName:string}>=[],control={fault};
 const create=vi.fn((request:any,options:any)=>{
  const prompt=String(request.messages.find((m:any)=>m.role==='user')?.content||'');let baseName:string,actualPhase:string,content:string;
  if(prompt.includes('## 当前文书\n')) {
   const target=JSON.parse(prompt.split('## 当前文书\n')[1]);baseName=target.baseName;actualPhase='draft';
   const body=packetDraftFixture(prompt,{baseName,markdown:'Conditional complete analysis of the original allegation only. Payment, dates and original evidence remain unverified; no new remedy or fact is established.'});
   if(phase==='draft'&&control.fault==='source'&&baseName==='10_civil-complaint')body.entries[0].sourceIds=['F_UNKNOWN_PRIVATE'];
   content=JSON.stringify(body);
  } else {
   const documents=JSON.parse(prompt.split('文书列表：')[1]);baseName=documents[0].baseName.split('/')[0];actualPhase='review';
   content=JSON.stringify({documents:documents.map((d:any)=>({baseName:d.baseName,complete:true,corrections:[],unresolved:[]}))});
  }
  events.push({phase:actualPhase,baseName});const hit=actualPhase===phase&&baseName==='10_civil-complaint';
  if(hit&&control.fault==='empty')content='';if(hit&&control.fault==='json')content='{"private_fixture":"DO_NOT_ECHO_RAW_RESPONSE"';
  return sdkCompletion(request,{choices:[{message:{content},finish_reason:hit&&control.fault==='length'?'length':'stop'}]},0,options.signal);
 });
 const registry=new ToolRegistry();registerLegalTools(registry);
 const context={userId,domain:'personal' as const,authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local' as const,source:'legal-direct-tool',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
 const args={caseId:c.id,caseName:c.title,role:'plaintiff',parties:c.party,claims:c.objective,facts:'Synthetic conditional facts only; all payment and delivery conditions are unverified.',evidence:'Use the supplied payment excerpt; original and proof value remain unverified.',includeDocx:false,persistCase:true};
 const before=getUserPreferredLLMConfig(userId);
 const run=()=>registry.execute('legal_generate_litigation_packet',args,{...context,requestId:crypto.randomUUID()}).then(decodeToolResult);
 return{userId,orgId,c,events,create,control,run,originals,before};
}
const casesToCheck=[
 ['draft','length','model_output_limit','起草输出额度耗尽，正文截断'],
 ['draft','empty','model_empty','起草返回空正文'],
 ['draft','json','invalid_json','起草 JSON 解析失败'],
 ['draft','source','起草栏目或来源校验未通过：第1项引用了未登记的原始材料编号','起草栏目或来源校验未通过'],
 ['review','length','factual_review_output_limit','事实复核输出额度耗尽，正文截断'],
 ['review','empty','factual_review_empty','事实复核返回空正文'],
 ['review','json','factual_review_invalid_json','事实复核 JSON 解析失败'],
] as const;
it.each(casesToCheck)('shows the actual %s %s stage without mislabelling transport or exposing raw output',async(phase,fault,reason,message)=>{
 const f=await setup(phase,fault);const result=await f.run();
 expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false,draftFailures:expect.arrayContaining([expect.objectContaining({baseName:'10_civil-complaint',reason})])});
 expect(result.content).toContain(message);expect(result.content).not.toContain('DO_NOT_ECHO_RAW_RESPONSE');expect(result.content).not.toContain('F_UNKNOWN_PRIVATE');expect(result.content).not.toContain('供应商不可达');
 expect(f.events.filter(e=>e.baseName==='10_civil-complaint'&&e.phase==='draft')).toHaveLength(1);
 expect(f.events.filter(e=>e.baseName==='10_civil-complaint'&&e.phase==='review')).toHaveLength(phase==='review'?1:0);
 expect(f.create).toHaveBeenCalledTimes(phase==='review'?4:3);
 expect(JSON.stringify(cases.getCase(f.orgId,f.c.id)!.materials)).toBe(f.originals);expect(getUserPreferredLLMConfig(f.userId)).toEqual(f.before);
 for(const [request] of f.create.mock.calls)expect(request).toMatchObject({max_tokens:16384,reasoning_effort:'low',stream:true,response_format:{type:'json_object'}});
 if(phase==='review'&&fault==='length') {
  const firstScope=cacheFault.scopes.at(-1);f.control.fault='success';const resumed=await f.run();
  expect(resumed.receipt).toMatchObject({ok:true,status:'generated',persisted:true});expect(f.create).toHaveBeenCalledTimes(5);
  expect(f.events.at(-1)).toEqual({phase:'review',baseName:'10_civil-complaint'});expect(cacheFault.scopes.at(-1)).toBe(firstScope);
  expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(1);
 }
});
it('identifies invalid pending source bindings before any review SDK call and does not echo the unregistered ID',async()=>{
 const f=await setup('review','success');cacheFault.invalidPending=true;const result=await f.run();
 expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false,draftFailures:expect.arrayContaining([expect.objectContaining({baseName:'10_civil-complaint',reason:'事实复核栏目或来源校验未通过：第1项引用了未登记的原始材料编号'})])});
 expect(result.content).toContain('事实复核栏目或来源校验未通过');expect(result.content).not.toContain('F_UNKNOWN_PRIVATE');
 expect(f.events.filter(e=>e.baseName==='10_civil-complaint')).toHaveLength(0);expect(f.create).toHaveBeenCalledTimes(2);
 expect(JSON.stringify(cases.getCase(f.orgId,f.c.id)!.materials)).toBe(f.originals);
});
it('preserves a healthy four-stage registered packet, exact parameters, originals and one archive',async()=>{
 const f=await setup('draft','success');const result=await f.run();
 expect(result.receipt).toMatchObject({ok:true,status:'generated',persisted:true,draftFailures:[]});expect(f.create).toHaveBeenCalledTimes(4);
 expect(f.events.filter(e=>e.phase==='draft')).toHaveLength(2);expect(f.events.filter(e=>e.phase==='review')).toHaveLength(2);
 const after=cases.getCase(f.orgId,f.c.id)!;expect(after.materials.filter(m=>m.source==='tool')).toHaveLength(1);expect(JSON.stringify(after.materials.filter(m=>m.source!=='tool'))).toBe(f.originals);
 expect(getUserPreferredLLMConfig(f.userId)).toEqual(f.before);
});
