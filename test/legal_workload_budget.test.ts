import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
import { bidPromptSources, sdkCompletion } from './legal_bid_fixture';
import { resolveSourceDraftEntries } from '../server/regions/packs/cn/legal_reasoning_generation';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{app=await makeApp();});afterAll(()=>app.cleanup());
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
const body='仅依据本项绑定原句编写待责任人核对的响应工作稿，不新增未确认事实或承诺；来源、资格及正式使用条件均待复核。';
async function fixture(count=56){
 const userId='workload-'+crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId),c=cases.createCase(orgId,userId,{title:'虚构有限预算验收'});
 upsertUserPreferredLLM(userId,{provider:'relay',model:'virtual-workload-model',selectionMode:'pinned',allowCloudFallback:false,fallbackCandidates:[]});
 const source=Array.from({length:count},(_,i)=>'R'+(i+1)+'：本项仅为虚构编号原文，条件未确认。SOURCE-'+(i+1)).join('\n');
 const plan={draftMs:0,reviewMs:0,invalidTechnical:false,contractMs:0},events:Array<{kind:string;ids:string[];at:number}>=[];
 const before=new Set(fs.readdirSync(getDataDirectory('legal_document_progress')));
 const create=vi.fn(async(request:any,options:any)=>{
  const prompt=String(request.messages.find((m:any)=>m.role==='user')?.content||''),contract=prompt.includes('指定栏目：');
  if(contract){const ids=JSON.parse(prompt.split('指定栏目：')[1].split('\n')[0]).map((s:any)=>s.id||s);events.push({kind:'contract',ids,at:Date.now()});const content=JSON.stringify({complete:true,entries:ids.map((sectionId:string)=>({sectionId,sourceIds:['F2'],response:'虚构甲乙双方约定无偿保密，双方互负保密义务，期限自签署后两年；具体签署日期和争议地点待双方确认。本稿不设付款、交付验收或担保，不声称已签署或正式核准。',missing:'具体日期、签章代表、争议解决待确认。'}))});return sdkCompletion(request,{choices:[{message:{content},finish_reason:'stop'}]},plan.contractMs,options.signal);}
  const review=prompt.includes('待核对JSON草稿：'),sources=bidPromptSources(prompt);
  const draft=review?JSON.parse(prompt.split('待核对JSON草稿：')[1]):null;
  const ids=review?draft.entries.map((e:any)=>e.sectionId):JSON.parse(prompt.split('\n指定子节：')[1]).map((s:any)=>s.id);
  events.push({kind:review?'review':'draft',ids,at:Date.now()});
  const entries=ids.map((sectionId:string,index:number)=>({sectionId,sourceIds:[sources.some((s:any)=>s.id===sectionId)?sectionId:sources[0].id],response:body,missing:plan.invalidTechnical&&sectionId==='schedule'?{private:'MODEL-PRIVATE-DETAIL'}:'原始条件待责任人核实。'}));
  const content=JSON.stringify(review?{complete:true,entries:draft.entries,unresolved:[]}: {entries});
  return sdkCompletion(request,{choices:[{message:{content},finish_reason:'stop'}]},review?plan.reviewMs:plan.draftMs,options.signal);
 });
 const registry=new ToolRegistry();registerLegalTools(registry);const context:any={userId,domain:'personal',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
 const run=(signal?:AbortSignal)=>registry.execute('legal_generate_bid',{caseId:c.id,projectName:'Workload-'+c.id,requirements:source,persistCase:true},{...context,requestId:crypto.randomUUID(),executionSignal:signal}).then(decodeToolResult);
 const contract=(signal?:AbortSignal)=>registry.execute('legal_draft_contract',{caseId:c.id,type:'无偿保密合同',details:'虚构甲乙双方无偿保密，双方互负保密义务，签署后两年，不设付款、交付验收或担保；签署日期与管辖待双方确认。',persistCase:true},{...context,requestId:crypto.randomUUID(),executionSignal:signal}).then(decodeToolResult);
 const checkpoint=()=>fs.readdirSync(getDataDirectory('legal_document_progress')).filter(n=>!before.has(n)).map(n=>({file:path.join(getDataDirectory('legal_document_progress'),n),value:JSON.parse(fs.readFileSync(path.join(getDataDirectory('legal_document_progress'),n),'utf8'))}))[0];
 return{plan,events,create,run,contract,c,orgId,checkpoint};
}
describe('actual registered legal work has a finite workload-aligned budget',()=>{
 it('completes seven units with80s drafts and20s reviews beyond the old180/240s limits without duplicate calls',async()=>{
  const f=await fixture();f.plan.draftMs=80000;f.plan.reviewMs=20000;vi.useFakeTimers();const work=f.run();await vi.waitFor(()=>expect(f.events).toHaveLength(2));await vi.advanceTimersByTimeAsync(405000);vi.useRealTimers();const result=await work;
  expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.events.filter(e=>e.kind==='draft')).toHaveLength(7);expect(f.events.filter(e=>e.kind==='review')).toHaveLength(7);expect(result.content).toContain('56/56');expect(Object.values(f.checkpoint().value.documents).every((d:any)=>d.reviewed)).toBe(true);
 });
 it('reviews saved pending units before starting a missing draft and reuses whole reviewed chapters without SDK calls',async()=>{
  const f=await fixture(25);await f.run();const saved=f.checkpoint(),docs=saved.value.documents;delete docs.business;const responseKeys=Object.keys(docs).filter(k=>k.startsWith('response:'));docs[responseKeys[0]].reviewed=false;fs.writeFileSync(saved.file,JSON.stringify(saved.value));const start=f.events.length;
  expect((await f.run()).receipt).toMatchObject({ok:true,status:'generated'});const resumed=f.events.slice(start);expect(resumed[0]).toMatchObject({kind:'review',ids:Array.from({length:12},(_,i)=>'F'+(i+1))});expect(resumed.filter(e=>e.kind==='draft').map(e=>e.ids)).toEqual([['bid-letter','business-response','payment']]);expect(resumed).toHaveLength(3);const at=f.events.length;expect((await f.run()).receipt).toMatchObject({ok:true,status:'generated'});expect(f.events).toHaveLength(at);
 });
 it('still caps a larger job and preserves partial drafts without case archive when the finite budget expires',async()=>{
  const f=await fixture(120);f.plan.draftMs=80000;f.plan.reviewMs=80000;vi.useFakeTimers();const work=f.run();await vi.waitFor(()=>expect(f.events).toHaveLength(2));await vi.advanceTimersByTimeAsync(721000);vi.useRealTimers();const result=await work;
  expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(result.content).toContain('本轮预算耗尽');expect(cases.getCase(f.orgId,f.c.id)!.materials).toHaveLength(0);expect(f.events.length).toBeLessThan(24);expect(Object.values(f.checkpoint().value.documents).some((d:any)=>d.reviewed)).toBe(true);
 });
 it('retains parent cancellation during the longer finite batch without retry or archive',async()=>{
  const f=await fixture();f.plan.draftMs=80000;vi.useFakeTimers();const c=new AbortController(),work=expect(f.run(c.signal)).rejects.toThrow('virtual workload stopped');await vi.waitFor(()=>expect(f.events).toHaveLength(2));await vi.advanceTimersByTimeAsync(10000);c.abort(new Error('virtual workload stopped'));await work;expect(f.events).toHaveLength(2);expect(cases.getCase(f.orgId,f.c.id)!.materials).toHaveLength(0);
 });
 it('allows one100s structured NDA response and does not change model preference or add a second call',async()=>{
  const f=await fixture(1);f.plan.contractMs=100000;vi.useFakeTimers();const work=f.contract();await vi.waitFor(()=>expect(f.events[0]?.kind).toBe('contract'));await vi.advanceTimersByTimeAsync(100001);vi.useRealTimers();const result=await work;expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.create).toHaveBeenCalledTimes(1);expect(result.content).toContain('无偿');expect(result.content).toContain('不设付款');
 });
 it('reports the exact rejected technical field without echoing model data, and never reviews or archives that invalid draft',async()=>{
  const f=await fixture(1);f.plan.invalidTechnical=true;const result=await f.run();expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(result.content).toContain('第2项的待补事项必须是文本');expect(result.content).not.toContain('MODEL-PRIVATE-DETAIL');expect(f.events.filter(e=>e.kind==='review').some(e=>e.ids.includes('technical-plan'))).toBe(false);expect(cases.getCase(f.orgId,f.c.id)!.materials).toHaveLength(0);expect(f.events.filter(e=>e.kind==='draft'&&e.ids.includes('technical-plan'))).toHaveLength(1);
 });
 it.each([{change:(e:any)=>({...e,sourceIds:['MODEL-PRIVATE-SOURCE']}),message:'第1项引用了未登记的原始材料编号'},{change:(e:any)=>({...e,response:''}),message:'第1项缺少拟议正文'},{change:(e:any)=>({...e,sourceIds:[]}),message:'第1项未引用原始材料'},{change:(e:any)=>({...e,sectionId:'MODEL-PRIVATE-SECTION'}),message:'第1项返回了未指定的章节编号'}])('keeps strict source/section rejection while reporting a safe specific issue:$message',({change,message})=>{
  const e={sectionId:'a',sourceIds:['F1'],response:body,missing:''},sources=[{id:'F1',materialId:'one',title:'虚构原件',quote:'原句',locator:'原文第1行'}];let thrown='';try{resolveSourceDraftEntries({entries:[change(e)]},sources,['a']);}catch(error){thrown=(error as Error).message;}expect(thrown).toBe(message);expect(thrown).not.toContain('MODEL-PRIVATE');
 });
});
