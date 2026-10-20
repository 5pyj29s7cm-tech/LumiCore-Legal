import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import crypto from 'node:crypto';
import {makeApp} from './helpers';
import {ToolRegistry} from '../server/tools/registry';
import {registerLegalTools} from '../server/tools/definitions/legal_tools';
import {decodeToolResult} from '../server/tools/result_envelope';
import {upsertUserPreferredLLM} from '../server/llm/user_preferences';
import {listModelRoutingReceipts,modelAttemptCompletion} from '../server/llm/model_routing_receipts';
import {completionMetadata} from '../server/llm/provider/response';
import {resetCircuit} from '../server/cloud/circuit_breaker';
import * as cases from '../server/org/legal_cases';
let app:Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{app=await makeApp();});afterAll(()=>app.cleanup());
beforeEach(()=>{vi.stubEnv('LUMI_PRIVACY','standard');resetCircuit();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();resetCircuit();});
const usage={prompt_tokens:19,completion_tokens:128,total_tokens:147};
const privateDetail='SYNTHETIC_PRIVATE_PROVIDER_DETAIL';
const privateThought='SYNTHETIC_PRIVATE_THOUGHT';
describe('ordered fallback terminal diagnosis reaches the actual legal handler',()=>{
 it.each([['stop','empty_response','起草返回空正文'],['length','output_limit','输出额度耗尽']] as const)('keeps primary %s when backup quota also fails',async(finish,reason,publicReason)=>{
  const userId='legal-terminal-'+crypto.randomUUID(),requestId=crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId,{provider:'relay',model:'synthetic-primary',selectionMode:'ordered_fallback',fallbackCandidates:[{provider:'openai',model:'synthetic-backup'}],allowCloudFallback:true});
  const original=cases.createCase(orgId,userId,{title:'Synthetic ordered terminal boundary'});
  const primary=vi.fn(async(params:any)=>{expect(params.stream).toBe(true);return(async function*(){yield{choices:[{delta:{reasoning_content:privateThought},finish_reason:finish}],usage};})();});
  const backup=vi.fn(async()=>{throw Object.assign(new Error('quota '+privateDetail),{status:402});});
  const registry=new ToolRegistry();registerLegalTools(registry);
  const result=decodeToolResult(await registry.execute('legal_generate_bid',{projectName:'Synthetic terminal '+original.id,caseId:original.id,requirements:'R01：Only the supplied synthetic material may be used; missing documents remain unverified.',persistCase:true},{userId,requestId,domain:'personal',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create:primary}}}),getOpenAI:()=>({chat:{completions:{create:backup}}})}}));
  const receipts=listModelRoutingReceipts(userId,10,{requestId});
  expect(receipts.length).toBeGreaterThan(0);
  const attempted=receipts.find(receipt=>receipt.attempts.some(attempt=>attempt.provider==='openai'&&attempt.status==='failed'))!;
  expect(attempted).toBeDefined();expect(attempted.fallbackReason).toBe(reason);
  expect(attempted.attempts[0]).toMatchObject({status:'failed',reason,finishReason:finish,usage:{promptTokens:19,completionTokens:128,totalTokens:147}});
  expect(attempted.attempts[1]).toMatchObject({provider:'openai',status:'failed',reason:'quota_or_billing'});
  expect(primary).toHaveBeenCalled();expect(backup).toHaveBeenCalled();
  expect(result.receipt).toMatchObject({ok:false,status:'partial'});
  expect(cases.getCase(orgId,original.id)!.materials.filter(material=>material.source==='tool')).toHaveLength(0);
  expect(JSON.stringify(receipts)).not.toContain(privateThought);expect(result.content).not.toContain(privateDetail);expect(result.content).not.toContain(privateThought);
  expect(result.content).toContain(publicReason);
 });
 it.each(['length','max_tokens','MAX_TOKENS'])('normalizes %s before it can enter the typed empty error',finish=>{expect(completionMetadata(finish)).toEqual({finishReason:'length'});});
 it.each([NaN,-1,Infinity,'123','SYNTHETIC_SECRET'])('drops invalid usage %s rather than persisting it',count=>{
  const projected=modelAttemptCompletion({finishReason:'length',usage:{promptTokens:count,completionTokens:1,totalTokens:2,rawThinking:privateThought,apiKey:privateDetail} as any});
  expect(projected).toEqual({finishReason:'length'});expect(JSON.stringify(projected)).not.toContain(privateDetail);expect(JSON.stringify(projected)).not.toContain(privateThought);
 });
 it('projects only the three safe counts and normalized finish enum',()=>{
  expect(modelAttemptCompletion({finishReason:'MAX_TOKENS' as any,usage:{promptTokens:0,completionTokens:128,totalTokens:128,rawThinking:privateThought,apiKey:privateDetail} as any,rawThinking:privateThought} as any)).toEqual({finishReason:'length',usage:{promptTokens:0,completionTokens:128,totalTokens:128}});
 });
});
