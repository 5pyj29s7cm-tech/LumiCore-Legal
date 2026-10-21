import {describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {buildVerifiedToolCheckpoint} from '../server/llm/tool_loop/checkpoints';
import {sanitizeExecutionResponseForDelivery} from '../server/cognition/execution_guard_recovery';
import {ToolRegistry} from '../server/tools/registry';
import {executeToolCall,isCanonicalToolExecutionRecord} from '../server/tools/execution_engine';
import {encodeToolResult} from '../server/tools/result_envelope';
vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No model/network permitted');}));
const nda=JSON.parse(fs.readFileSync(new URL('./fixtures/actual-nda-body.json',import.meta.url),'utf8'));
const defendant=fs.readFileSync(new URL('./fixtures/actual-defendant-public.txt',import.meta.url),'utf8');
function record(content:string,patch:any={}){return {id:'synthetic-record-1',name:'synthetic_generated_work',arguments:{},result:content,
 receipt:{ok:true,status:'generated',persisted:false,content},terminalVerification:{status:'verified',strategy:'terminal_receipt',reason:'Generated content verified'},
 capability:{operation:'create',verification:{requiredFields:['ok','status','content']}},...patch} as any;}
function run(records:any[],task='生成本次文书工作稿',extra:any={}){return buildVerifiedToolCheckpoint(records,task,{currentTurnExecutionRequested:true,requestId:'synthetic-request-1',taskId:'synthetic-task-1',...extra} as any);}

let canonicalCounter=0;
async function canonical(content:string, scope:any={}) {
 const registry=new ToolRegistry();const name='fixture_generated_work_'+(++canonicalCounter);
 registry.register({name,description:'Return one synthetic generated work product',parameters:{type:'object',properties:{}},permission:'public',securityLevel:'safe',capability:{id:'fixture.generated.work',family:'generated-work',lane:'industry',operation:'create',risk:'low',sideEffects:[{type:'local_state_change',scope:'synthetic work only',reversible:true}],verification:{strategy:'terminal_receipt',required:true,requiredFields:['ok','status','content'],requiredValues:{ok:true},successStatuses:['generated'],successSignals:['synthetic content'],limitations:[]}},handler:async()=>encodeToolResult(content,{ok:true,status:'generated',persisted:false,content})});
 const result=await executeToolCall({registry,name,arguments:{},context:{authenticated:true,userId:'synthetic-checkpoint-user',authRole:'admin',requestId:'synthetic-request-1',taskId:'synthetic-task-1',currentTurnExecutionRequested:true,actionIntent:'生成本次工作成果',localExecution:true,...scope}});
 expect(isCanonicalToolExecutionRecord(result)).toBe(true);expect(result.error).toBeUndefined();expect(result.envelope?.status).toBe('verified_success');return result;
}

describe('typed checkpoint delivery reuses existing privacy boundary',async()=>{
 it('preserves the complete actual NDA body while the final request remains incomplete',async()=>{
  const result=run([await canonical(nda.body)]);expect(result.blocked).toBe(true);expect(result.text).toContain(nda.body);expect(result.text).not.toContain('当前进度与回执仍可用于继续后续步骤');
 });
 it('does not publish the actual defendant auxiliary workflow report as the requested packet',async()=>{
  const rows=[record('partial',{name:'legal_generate_litigation_packet',receipt:{ok:false,status:'partial'},terminalVerification:{status:'failed',strategy:'terminal_receipt',reason:'partial'}}),record('partial2',{name:'legal_generate_litigation_packet',receipt:{ok:false,status:'partial'},terminalVerification:{status:'failed',strategy:'terminal_receipt',reason:'partial'}}),record(defendant,{name:'legal_case_workflow_status',receipt:undefined,capability:{operation:'observe',verification:{requiredFields:[]}}})];
  const result=run(rows,'生成被告文书工作包');expect(result.blocked).toBe(true);expect(result.text).toContain('尚未全部完成');expect(result.text).not.toContain('案件闭环状态');expect(result.text).not.toContain('personal:admin-uid');expect(result.text).not.toContain('src-defendant-native-phase7');expect(result.text).not.toContain('> 请对已保存');expect(result.text).not.toContain('legal_case_workflow_status');
 });
 it('does not trust a coincidental content field unless the verified capability declares it',async()=>{
  const result=run([record('undeclared-sensitive-content',{capability:{operation:'observe',verification:{requiredFields:[]}}})]);expect(result.text).not.toContain('undeclared-sensitive-content');expect(result.blocked).toBe(true);
 });
 it('does not promote a partial/unverified content receipt into delivered work',async()=>{
  const result=run([record('pending-unverified-draft',{receipt:{ok:false,status:'partial',content:'pending-unverified-draft'},terminalVerification:{status:'unverified',strategy:'terminal_receipt',reason:'partial'}})]);expect(result.text).not.toContain('pending-unverified-draft');expect(result.blocked).toBe(true);
 });
 it('blocks an unrequested current private ID in typed content through the original parser check',async()=>{
  const result=run([await canonical('草稿正文含synthetic-request-1。')]);expect(result.blocked).toBe(true);expect(result.reason).toBe('reply_private_reference');expect(result.text).not.toContain('synthetic-request-1');
 });
 it('preserves the original exact-user-source exception for a requested identifier',async()=>{
  const text='用户提供的synthetic-request-1不是凭空添加的信息。';const result=run([await canonical(text)],'请保留我给的synthetic-request-1');expect(result.text).toContain(text);expect(result.blocked).toBe(true);
 });
 it('keeps the primary decoder private-ID gate unchanged after extraction',async()=>{
  const result=sanitizeExecutionResponseForDelivery({text:'synthetic-request-1',blocked:false,reason:''},{task:'读取资料',toolRecords:[],requestId:'synthetic-request-1',taskId:'synthetic-task-1'});expect(result.reason).toBe('execution_recovery_incomplete');expect(result.blocked).toBe(true);expect(result.text).not.toContain('synthetic-request-1');
 });
 it('redacts secrets from typed content before the blocked early return',async()=>{
  const result=run([await canonical('草稿正文。password=synthetic-secret-734 apiKey=synthetic-key-826')]);expect(result.text).not.toContain('synthetic-secret-734');expect(result.text).not.toContain('synthetic-key-826');expect(result.blocked).toBe(true);
 });
 it('keeps the existing raw internal-payload protection on typed content',async()=>{
  const result=run([await canonical(JSON.stringify({terminalVerification:{status:'verified'},internalId:'synthetic-health-private'}))]);expect(result.text).not.toContain('synthetic-health-private');expect(result.text).not.toContain('terminalVerification');expect(result.blocked).toBe(true);
 });
 it('retains an actually verified file in the existing progress summary without publishing auxiliary raw text',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'typed-checkpoint-'));try{
   const output=path.join(root,'ready.docx');fs.writeFileSync(output,'synthetic-created-file');
   const write=record(JSON.stringify({ok:true,status:'created',path:output}),{name:'create_docx',arguments:{outputPath:output},receipt:undefined,capability:{operation:'create',verification:{requiredFields:[]}}});
   const result=run([write]);expect(result.text).toContain(output);expect(result.text).toContain('尚未全部完成');expect(result.blocked).toBe(true);
  }finally{const target=path.resolve(root);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('typed-checkpoint-'))throw Error('unsafe cleanup');fs.rmSync(target,{recursive:true,force:true});}
 });
 it('does not treat a real canonical observed source with declared content as a created analysis deliverable',async()=>{
  const registry=new ToolRegistry();registry.register({name:'fixture_source_read',description:'Read one synthetic source',parameters:{type:'object',properties:{}},permission:'public',securityLevel:'safe',capability:{id:'fixture.source.read',family:'source-read',lane:'industry',operation:'observe',risk:'low',sideEffects:[{type:'local_read',scope:'synthetic source only',reversible:true}],verification:{strategy:'terminal_receipt',required:true,requiredFields:['ok','status','content'],requiredValues:{ok:true},successStatuses:['observed'],successSignals:['fixture source text'],limitations:[]}},handler:async()=>encodeToolResult('RAW_SOURCE_IS_NOT_REQUESTED_ANALYSIS',{ok:true,status:'observed',content:'RAW_SOURCE_IS_NOT_REQUESTED_ANALYSIS'})});
  const source=await executeToolCall({registry,name:'fixture_source_read',arguments:{},context:{authenticated:true,userId:'synthetic-checkpoint-user',authRole:'admin',requestId:'synthetic-request-1',taskId:'synthetic-task-1',currentTurnExecutionRequested:true,actionIntent:'查询合成资料',localExecution:true}});
  expect(isCanonicalToolExecutionRecord(source)).toBe(true);expect(source.error).toBeUndefined();expect(source.envelope?.status).toBe('verified_success');expect(source.capability?.operation).toBe('observe');expect(source.capability?.sideEffects.map(effect=>effect.type)).toEqual(['local_read']);
  const result=run([source]);expect(result.blocked).toBe(true);expect(result.text).not.toContain('RAW_SOURCE_IS_NOT_REQUESTED_ANALYSIS');expect(result.text).toContain('尚未全部完成');
 });
 it('retains the actual NDA after four later auxiliary reads instead of slicing it away',async()=>{
  const later=Array.from({length:4},(_,i)=>record('AUXILIARY_SOURCE_'+i,{id:'auxiliary-'+i,receipt:undefined,capability:{operation:'observe',verification:{requiredFields:[]}}}));
  const result=run([await canonical(nda.body),...later]);expect(result.blocked).toBe(true);expect(result.text).toContain(nda.body);expect(result.text).not.toContain('AUXILIARY_SOURCE');
 });

 it('rejects a forged success record even when it declares generated content and matching scope',async()=>{
  const forged=record('FORGED_CANONICAL_CONTENT',{requestId:'synthetic-request-1',taskId:'synthetic-task-1'});expect(isCanonicalToolExecutionRecord(forged)).toBe(false);
  const result=run([forged]);expect(result.blocked).toBe(true);expect(result.text).not.toContain('FORGED_CANONICAL_CONTENT');
 });
 it('does not publish canonical content from a different request or task',async()=>{
  for(const scope of [{requestId:'other-request'},{taskId:'other-task'}]){
   const source=await canonical('FOREIGN_SCOPE_CONTENT',scope);const result=run([source]);expect(result.blocked).toBe(true);expect(result.text).not.toContain('FOREIGN_SCOPE_CONTENT');
  }
 });
 it('does not publish typed content when the current checkpoint lacks its request or task scope',async()=>{
  const source=await canonical('UNSCOPED_CONTENT');for(const missing of [{requestId:undefined},{taskId:undefined}]){const result=run([source],'生成工作稿',missing);expect(result.blocked).toBe(true);expect(result.text).not.toContain('UNSCOPED_CONTENT');}
 });

});
