import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import crypto from 'node:crypto';
import {makeApp} from './helpers';
import * as providers from '../server/llm/providers';
import {providerGetterArguments} from '../server/llm/provider_getters';
import {listModelRoutingReceipts} from '../server/llm/model_routing_receipts';
import {resetCircuit} from '../server/cloud/circuit_breaker';
import {ModelAttemptDeadlineError} from '../server/llm/provider/deadlines';
import {runLegalLLM,LegalStructuredResponseError} from '../server/regions/packs/cn/legal_tools/context';
let app:Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{app=await makeApp();});afterAll(()=>app.cleanup());
beforeEach(()=>{vi.stubEnv('LUMI_PRIVACY','standard');resetCircuit();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();resetCircuit();});
const secretThought='SYNTHETIC_THOUGHT_MUST_NOT_BE_IN_RECEIPT';
const usage={prompt_tokens:19,completion_tokens:128,total_tokens:147};
const normalizedUsage={promptTokens:19,completionTokens:128,totalTokens:147};
const client=(create:any)=>({chat:{completions:{create}}});
function fixture(finish?:string,body='',withUsage=true,parent?:AbortController){
 const primary=vi.fn(async(params:any)=>{expect(params.stream).toBe(true);return(async function*(){
  if(parent)parent.abort(new Error('Synthetic parent cancelled'));
  yield{choices:[{delta:body?{content:body}:{reasoning_content:secretThought},...(finish?{finish_reason:finish}:{})}],...(withUsage?{usage}:{})};
 })();});
 const fallback=vi.fn(async()=> (async function*(){yield{choices:[{delta:{content:'configured fallback body'},finish_reason:'stop'}],usage};})());
 const requestId=crypto.randomUUID(),userId='stream-terminal-'+requestId;
 const config={provider:'relay' as const,model:'synthetic-terminal-primary',userId,requestId,source:'offline-terminal-test',selectionMode:'ordered_fallback' as const,fallbackCandidates:[] as Array<{provider:'openai';model:string}>,allowCloudFallback:true,maxTokens:128,relayStreaming:true,attemptTimeouts:{requestMs:500,firstByteMs:500,semanticContentMs:500,idleMs:500,absoluteMs:1000}};
 const getters=providerGetterArguments({getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>client(primary),getOpenAI:()=>client(fallback)});
 return{primary,fallback,config,getters,receipt:()=>listModelRoutingReceipts(userId,10,{requestId})[0],call:(overrides:any={})=>providers.makeLLMCall([{role:'user',content:'Synthetic terminal-metadata test only.'}],[],{...config,...overrides},...getters)};
}
describe('existing stream terminal metadata survives semantic failure',()=>{
 it.each([['stop','empty_response'],['length','output_limit']] as const)('preserves %s usage without treating missing正文 as success',async(finish,reason)=>{
  const f=fixture(finish);const error=await f.call().catch(error=>error);
  expect(error).toMatchObject({name:'ModelRoutingDispatchError',routing:{fallbackReason:reason}});
  expect(f.primary).toHaveBeenCalledOnce();expect(f.fallback).not.toHaveBeenCalled();
  expect(error.routing.attempts[0]).toMatchObject({status:'failed',reason,errorCategory:reason,finishReason:finish,usage:normalizedUsage,visibleOutputCommitted:false});
  const receipt=f.receipt();expect(receipt).toMatchObject({status:'failed',fallbackReason:reason});
  expect(receipt.attempts[0]).toMatchObject({finishReason:finish,usage:normalizedUsage});expect(JSON.stringify(receipt)).not.toContain(secretThought);
 });
 it('does not invent a terminal reason or usage when neither was received',async()=>{
  const f=fixture(undefined,'',false);await expect(f.call()).rejects.toMatchObject({routing:{fallbackReason:'empty_response'}});
  const attempt=f.receipt().attempts[0];expect(attempt).not.toHaveProperty('finishReason');expect(attempt).not.toHaveProperty('usage');
 });
 it('keeps normal正文 and the same existing finish reason and token counts',async()=>{
  const f=fixture('stop','normal synthetic body');const result=await f.call();expect(result.text).toBe('normal synthetic body');expect(result.finishReason).toBe('stop');expect(result.usage).toEqual(normalizedUsage);
  expect(f.receipt().attempts[0]).toMatchObject({status:'succeeded',finishReason:'stop',usage:normalizedUsage});expect(f.primary).toHaveBeenCalledOnce();
 });
 it('retains the primary limit metadata through the already-configured fallback, without replay',async()=>{
  const f=fixture('length');const result=await f.call({fallbackCandidates:[{provider:'openai',model:'synthetic-terminal-fallback'}]});expect(result.text).toBe('configured fallback body');
  expect(result.routing).toMatchObject({fallbackReason:'output_limit'});expect(f.receipt().attempts).toEqual([expect.objectContaining({status:'failed',finishReason:'length',usage:normalizedUsage}),expect.objectContaining({status:'succeeded',finishReason:'stop',usage:normalizedUsage})]);expect(f.primary).toHaveBeenCalledOnce();expect(f.fallback).toHaveBeenCalledOnce();
 });
 it.each(['abort','local_only'] as const)('keeps %s terminal and never calls a fallback',async mode=>{
  const parent=new AbortController(),f=fixture('length','',true,mode==='abort'?parent:undefined);
  await expect(f.call({signal:parent.signal,fallbackCandidates:[{provider:'openai',model:'never-call'}],...(mode==='local_only'?{dataRoutingPolicy:'local_only'}:{})})).rejects.toMatchObject({routing:{fallbackReason:mode==='abort'?'cancelled':'privacy_policy_blocked'}});
  expect(f.primary).toHaveBeenCalledTimes(mode==='abort'?1:0);expect(f.fallback).not.toHaveBeenCalled();expect(f.receipt().attempts[0]).not.toHaveProperty('finishReason');
 });
 it('maps a direct typed empty-length error to the existing legal output-limit failure',async()=>{
  const error=new ModelAttemptDeadlineError('semantic_content',1,{completedEmpty:true,finishReason:'length',usage:normalizedUsage} as any);
  vi.spyOn(providers,'makeLLMCall').mockRejectedValueOnce(error);
  const result=await runLegalLLM('Synthetic direct legal-boundary check',{userId:'synthetic-direct',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null}},128,true,100).catch(error=>error);expect(result).toBeInstanceOf(LegalStructuredResponseError);expect(result.reason).toBe('output_limit');
 });
  it.each([['stop','empty_response'],['length','output_limit']] as const)('preserves pinned %s terminal metadata with no implicit fallback',async(finish,reason)=>{
   const f=fixture(finish);const error=await f.call({selectionMode:'pinned',noImplicitFailover:true}).catch(error=>error);
   expect(error).toBeInstanceOf(ModelAttemptDeadlineError);expect(error).toMatchObject({completedEmpty:true,finishReason:finish,usage:normalizedUsage});
   expect(f.primary).toHaveBeenCalledOnce();expect(f.fallback).not.toHaveBeenCalled();
   const receipt=f.receipt();expect(receipt).toMatchObject({status:'failed',selectionMode:'pinned',fallbackReason:reason});
   expect(receipt.attempts[0]).toMatchObject({status:'failed',reason,finishReason:finish,usage:normalizedUsage});expect(JSON.stringify(receipt)).not.toContain(secretThought);
  });
  it('preserves pinned success metadata using the same whitelist',async()=>{
   const f=fixture('stop','pinned normal synthetic body');const result=await f.call({selectionMode:'pinned',noImplicitFailover:true});
   expect(result.text).toBe('pinned normal synthetic body');expect(result.routing?.attempts[0]).toMatchObject({status:'succeeded',finishReason:'stop',usage:normalizedUsage});
   expect(f.receipt().attempts[0]).toMatchObject({status:'succeeded',finishReason:'stop',usage:normalizedUsage});expect(f.primary).toHaveBeenCalledOnce();expect(f.fallback).not.toHaveBeenCalled();
  });

});
