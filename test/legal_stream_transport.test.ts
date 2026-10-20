import './helpers';
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {makeApp} from './helpers';
import {upsertUserPreferredLLM} from '../server/llm/user_preferences';
import {resetCircuit} from '../server/cloud/circuit_breaker';
import {runLegalLLMWithin} from '../server/regions/packs/cn/legal_tools/context';
let app:Awaited<ReturnType<typeof makeApp>>;
const uid='virtual-legal-long-stream-owner';
beforeAll(async()=>{app=await makeApp();});afterAll(()=>app.cleanup());
beforeEach(()=>{vi.stubEnv('LUMI_PRIVACY','standard');resetCircuit();upsertUserPreferredLLM(uid,{provider:'relay',model:'aliyun/deepseek-v4-flash',selectionMode:'pinned',allowCloudFallback:false,fallbackCandidates:[]});});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();resetCircuit();});
const context=(create:any,executionSignal?:AbortSignal)=>({userId:uid,domain:'personal',source:'legal-direct-tool',executionSignal,llmGetters:{getRelay:()=>({chat:{completions:{create}}})}});
describe('legal complete response uses existing bounded SSE transport',()=>{
 it('receives a 70-second complete JSON once through real provider and SDK boundary with no non-stream request',async()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
  const create=vi.fn(async(params:any)=>{expect(params.stream).toBe(true);return(async function*(){yield{choices:[{delta:{}}]};for(let i=0;i<7;i++){await new Promise(r=>setTimeout(r,10000));yield{choices:[{delta:i===6?{content:'{"entries":[{"response":"完整虚构正文"}]}'}:{},...(i===6?{finish_reason:'stop'}:{})}]};}yield{choices:[],usage:{prompt_tokens:12,completion_tokens:10,total_tokens:22}};})();});
  const pending=runLegalLLMWithin('仅虚构验收，保留原文尾句 TAIL-EXACT',context(create),8192,90000,true);
  await vi.advanceTimersByTimeAsync(70001);await expect(pending).resolves.toBe('{"entries":[{"response":"完整虚构正文"}]}');
  expect(create).toHaveBeenCalledOnce();expect(create.mock.calls[0][0]).not.toHaveProperty('thinking');expect(create.mock.calls[0][0]).toMatchObject({stream:true,max_tokens:8192,response_format:{type:'json_object'}});expect(JSON.stringify(create.mock.calls[0][0].messages)).toContain('TAIL-EXACT');
 });
 it('does not replay a failed in-band gateway stream or accept an earlier JSON prefix as complete',async()=>{
  const create=vi.fn(async()=> (async function*(){yield{choices:[{delta:{content:'{"entries":['}}]};yield{error:{code:'provider_timeout',message:'virtual upstream stream timed out'}};})());
  await expect(runLegalLLMWithin('仅虚构测试',context(create),8192,90000,true)).rejects.toThrow();expect(create).toHaveBeenCalledOnce();
 });
 it('aborts cancelled work and never accepts late SDK text',async()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});const parent=new AbortController();
  const create=vi.fn(async()=> (async function*(){yield{choices:[{delta:{}}]};await new Promise(r=>setTimeout(r,70000));yield{choices:[{delta:{content:'{"late":true}'},finish_reason:'stop'}]};})());
  const pending=runLegalLLMWithin('仅虚构测试',context(create,parent.signal),8192,90000,true);const rejected=expect(pending).rejects.toThrow('virtual user cancelled');await vi.advanceTimersByTimeAsync(1000);parent.abort(new Error('virtual user cancelled'));await rejected;await vi.advanceTimersByTimeAsync(70001);expect(create).toHaveBeenCalledOnce();
 });
 it('keeps output truncation a failure even when the streamed prefix is readable',async()=>{
  const create=vi.fn(async()=> (async function*(){yield{choices:[{delta:{content:'{"incomplete":true}'},finish_reason:'length'}]};})());
  await expect(runLegalLLMWithin('仅虚构测试',context(create),8192,90000,true)).rejects.toMatchObject({reason:'output_limit'});expect(create).toHaveBeenCalledOnce();
 });
});
