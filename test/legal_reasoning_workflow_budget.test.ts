import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { ToolRegistry, getToolExecutionTimeoutMs } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import { reasoningFixtureReply } from './legal_reasoning_fixture';
import { sdkCompletion } from './legal_bid_fixture';
let app:Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{app=await makeApp();installCivilCodeFixture();});afterAll(()=>app.cleanup());afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
const raw='原告主张九万元尚欠，待核实。被告主张七万元转账，原始凭证与本案关联待核实；两万元差额不等于自认余额。REASONING-WORKFLOW-SOURCE';
async function fixture(){
 const userId='reasoning-time-'+crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId),item=cases.createCase(orgId,userId,{title:'虚构两阶段论证预算验收',factDate:'2026-09-01'});
 cases.addMaterial(orgId,userId,item.id,{type:'evidence',source:'manual',title:'双方待核实原始陈述',content:raw});upsertUserPreferredLLM(userId,{provider:'relay',model:'virtual-reasoning-time',selectionMode:'pinned',allowCloudFallback:false,fallbackCandidates:[]});
 const plan={draftMs:70000,reviewMs:70000,invalidFirst:false},events:Array<{kind:string;at:number}>=[];
 const create=vi.fn(async(request:any,options:any)=>{
  const prompt=String(request.messages.find((m:any)=>m.role==='user')?.content||''),review=prompt.includes('你是法律适用复核者'),kind=review?'review':'draft';events.push({kind,at:Date.now()});
  const application='双方付款陈述需与原件和本案逐项核对，材料不足时只作条件分析，不确认任何已付款或尚欠数额。',conclusion='尚需核实原件、款项对应及付款期限，不据现有陈述确认两万元为自认余额。';
  const value=!review&&plan.invalidFirst&&events.filter(e=>e.kind==='draft').length===1?{entries:[]} : review?{reviews:[{index:1,status:'conditional',application,conclusion,reason:'原件和本案关联待核实',missingPremises:['原件和本案关联']}],uncoveredIssues:[]}:{entries:[{issue:'仅核对付款陈述与原件关联',ruleId:'R1',sourceIds:['F1'],application,conclusion,limitations:'原件和本案关联待核实'}]};
  return sdkCompletion(request,{choices:[{message:{content:reasoningFixtureReply(prompt,value)},finish_reason:'stop'}]},review?plan.reviewMs:plan.draftMs,options.signal);
 });
 const registry=new ToolRegistry();registerLegalTools(registry);const context:any={userId,domain:'personal',source:'legal-direct-tool',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
 const run=(signal?:AbortSignal)=>registry.execute('legal_generate_argument_or_opinion',{caseId:item.id,caseName:item.title,facts:raw,legalAuthorities:'《民法典》第626条',role:'被告',documentType:'代理词',issues:['仅核对付款陈述与原件关联'],factDate:'2026-09-01',persistCase:true},{...context,requestId:crypto.randomUUID(),executionSignal:signal}).then(decodeToolResult);
 return{item,orgId,events,plan,create,run};
}
describe('reasoning phases share a finite workflow budget while retaining stage limits',()=>{
 it('accepts a real registered70s draft plus70s applicability review within180s using exactly two SDK calls',async()=>{
  const f=await fixture();vi.useFakeTimers();const work=f.run();await vi.waitFor(()=>expect(f.events).toHaveLength(1));await vi.advanceTimersByTimeAsync(140001);vi.useRealTimers();const result=await work;expect(result.receipt).toMatchObject({ok:true,status:'generated',reasoningReviewed:true});expect(f.events.map(e=>e.kind)).toEqual(['draft','review']);expect(f.create).toHaveBeenCalledTimes(2);expect(result.content).toContain('两万元');expect(cases.getCase(f.orgId,f.item.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(1);
 });
 it('keeps the existing correction path inside180s total and does not archive when review has insufficient remaining time',async()=>{
  const f=await fixture();f.plan.invalidFirst=true;vi.useFakeTimers();const started=Date.now(),work=f.run();await vi.waitFor(()=>expect(f.events).toHaveLength(1));await vi.advanceTimersByTimeAsync(180001);vi.useRealTimers();const result=await work;expect(result.receipt).toMatchObject({ok:false,status:'partial',reasoningReviewed:false});expect(f.events.map(e=>e.kind)).toEqual(['draft','draft','review']);expect(cases.getCase(f.orgId,f.item.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);expect(result.content).toContain('复核超时');
 });
 it('retains the90s single-stage cap without calling review or archiving a stalled draft',async()=>{
  const f=await fixture();f.plan.draftMs=100000;vi.useFakeTimers();const work=f.run();await vi.waitFor(()=>expect(f.events).toHaveLength(1));await vi.advanceTimersByTimeAsync(90001);vi.useRealTimers();const result=await work;expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(f.events.map(e=>e.kind)).toEqual(['draft']);expect(cases.getCase(f.orgId,f.item.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
 });
 it('honors caller cancellation during review and does not make a correction/retry or archive',async()=>{
  const f=await fixture(),c=new AbortController();vi.useFakeTimers();const work=expect(f.run(c.signal)).rejects.toThrow('virtual reasoning stopped');await vi.waitFor(()=>expect(f.events).toHaveLength(1));await vi.advanceTimersByTimeAsync(70001);expect(f.events.map(e=>e.kind)).toEqual(['draft','review']);c.abort(new Error('virtual reasoning stopped'));await work;expect(f.create).toHaveBeenCalledTimes(2);expect(cases.getCase(f.orgId,f.item.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
 });
 it('gives only the three shared reasoning tools195s while retaining unrelated legal budgets',()=>{
  for(const tool of ['legal_case_reasoning_matrix','legal_case_strategy','legal_generate_argument_or_opinion'])expect(getToolExecutionTimeoutMs(tool)).toBe(195000);expect(getToolExecutionTimeoutMs('legal_review_contract')).toBe(120000);
 });
});
