import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import * as cases from '../server/org/legal_cases';
import { sdkCompletion } from './legal_bid_fixture';
import { resolveSourceDraftEntries } from '../server/regions/packs/cn/legal_reasoning_generation';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{app=await makeApp();});afterAll(()=>app.cleanup());
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
const body='仅依据本项绑定原句编写待责任人核对的响应工作稿，不新增未确认事实或承诺；来源、资格及正式使用条件均待复核。';
async function fixture(){
 const userId='workload-'+crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId),c=cases.createCase(orgId,userId,{title:'虚构有限预算验收'});
 upsertUserPreferredLLM(userId,{provider:'relay',model:'virtual-workload-model',selectionMode:'pinned',allowCloudFallback:false,fallbackCandidates:[]});
 const plan={contractMs:0},events:Array<{kind:string;ids:string[];at:number}>=[];
 const create=vi.fn(async(request:any,options:any)=>{
  const prompt=String(request.messages.find((m:any)=>m.role==='user')?.content||''),contract=prompt.includes('指定栏目：');
  if(contract){const ids=JSON.parse(prompt.split('指定栏目：')[1].split('\n')[0]).map((s:any)=>s.id||s);events.push({kind:'contract',ids,at:Date.now()});const content=JSON.stringify({complete:true,entries:ids.map((sectionId:string)=>({sectionId,sourceIds:['F2'],response:'虚构甲乙双方约定无偿保密，双方互负保密义务，期限自签署后两年；具体签署日期和争议地点待双方确认。本稿不设付款、交付验收或担保，不声称已签署或正式核准。',missing:'具体日期、签章代表、争议解决待确认。'}))});return sdkCompletion(request,{choices:[{message:{content},finish_reason:'stop'}]},plan.contractMs,options.signal);}
  throw new Error('Unexpected non-contract test request');
 });
 const registry=new ToolRegistry();registerLegalTools(registry);const context:any={userId,domain:'personal',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
 const contract=(signal?:AbortSignal)=>registry.execute('legal_draft_contract',{caseId:c.id,type:'无偿保密合同',details:'虚构甲乙双方无偿保密，双方互负保密义务，签署后两年，不设付款、交付验收或担保；签署日期与管辖待双方确认。',persistCase:true},{...context,requestId:crypto.randomUUID(),executionSignal:signal}).then(decodeToolResult);
 return{plan,events,create,contract,c,orgId};
}
describe('actual registered legal work has a finite workload-aligned budget',()=>{
 it('allows one100s structured NDA response and does not change model preference or add a second call',async()=>{
  const f=await fixture();f.plan.contractMs=100000;vi.useFakeTimers();const work=f.contract();await vi.waitFor(()=>expect(f.events[0]?.kind).toBe('contract'));await vi.advanceTimersByTimeAsync(100001);vi.useRealTimers();const result=await work;expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(f.create).toHaveBeenCalledTimes(1);expect(result.content).toContain('无偿');expect(result.content).toContain('不设付款');
 });
 it.each([{change:(e:any)=>({...e,sourceIds:['MODEL-PRIVATE-SOURCE']}),message:'第1项引用了未登记的原始材料编号'},{change:(e:any)=>({...e,response:''}),message:'第1项缺少拟议正文'},{change:(e:any)=>({...e,sourceIds:[]}),message:'第1项未引用原始材料'},{change:(e:any)=>({...e,sectionId:'MODEL-PRIVATE-SECTION'}),message:'第1项返回了未指定的章节编号'}])('keeps strict source/section rejection while reporting a safe specific issue:$message',({change,message})=>{
  const e={sectionId:'a',sourceIds:['F1'],response:body,missing:''},sources=[{id:'F1',materialId:'one',title:'虚构原件',quote:'原句',locator:'原文第1行'}];let thrown='';try{resolveSourceDraftEntries({entries:[change(e)]},sources,['a']);}catch(error){thrown=(error as Error).message;}expect(thrown).toBe(message);expect(thrown).not.toContain('MODEL-PRIVATE');
 });
});
