import './helpers';
import { beforeAll, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerProductVariantTools } from '../server/tools/definitions';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
const original = {"text":"仅查询已经提交的原视频任务结果，不创建、不重试、不重新生成任何视频。调用现有 get_video_generation_status，recoveryId 为 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa。告诉我原任务是否仍处理中、已失败或已保存成片，给出真实可打开文件；如果未取回，明确保留原任务继续查询，禁止再次调用 generate_video。"};
const registry = new ToolRegistry();registerProductVariantTools(registry);
const calls = { count:0 };
function add(name:string, operation:any, sideEffects:any[], reconcile=false) { registry.register({ name, description:'Synthetic capability-only boundary sentinel. Never a real network call.', parameters:{type:'object',properties:{}},permission:'user',securityLevel:'safe',handler:async()=>{calls.count++;return '{}'},capability:{ id:'test.'+name,family:'test-boundary',lane:'general',operation,risk:'low',sideEffects,verification:{strategy:reconcile?'artifact':'terminal_receipt',required:true,requiredFields:['ok'],requiredArtifactCollections:reconcile?['artifacts']:undefined,successSignals:[],limitations:[]},...(reconcile?{reconciliation:{reconcilesCapabilityIds:['synthetic.original.generate'],outcomeField:'reconciliationStatus',committedValues:['committed'],notCommittedValues:[]}}:{})} }); }
add('observe_remote', 'observe', [{type:'network_read',scope:'fixed status endpoint',reversible:true}]);
add('irreversible_observe_remote', 'observe', [{type:'network_read',scope:'declared not reversible',reversible:false}]);
add('fake_observe_commit', 'observe', [{type:'external_state_change',scope:'must remain forbidden',reversible:false}],true);
add('fake_observe_message', 'observe', [{type:'external_communication',scope:'must remain forbidden',reversible:false}],true);
add('arbitrary_observe_write', 'observe', [{type:'local_write',scope:'not an original artifact reconciler',reversible:true}]);
add('original_artifact_reconcile','observe',[{type:'network_read',scope:'original task',reversible:true},{type:'local_write',scope:'verified original artifact',reversible:true}],true);
const build = () => buildLumiExecutionPipeline({ dispatch:{userId:'synthetic-video-status-readonly',channel:'chat',source:'chat',operationMode:'assistant',text:original.text,targetIsLumi:true},executionBoundary:'trusted_local',registry });
beforeAll(async()=>{await initDatabase()});
it('retains the actual registered video recovery capability without granting a new generation',()=>{
 const p=build(), status=registry.getCapabilityManifestEntry('get_video_generation_status');
 expect(status?.operation).toBe('observe');expect(status?.reconciliation?.reconcilesCapabilityIds).toContain('media.video.generate');
 expect(p.authorizationPolicy.allowedTools).toContain('get_video_generation_status');
 expect(p.authorizationPolicy.forbiddenTools).not.toContain('get_video_generation_status');
 expect(p.authorizationPolicy.forbiddenTools).toContain('generate_video');expect(calls.count).toBe(0);
});
it('the existing exact capability directory can expose the authorized status tool',async()=>{
 const p=build();const result=JSON.parse(await registry.execute('client_capability_manifest',{query:'get_video_generation_status',source:'builtin',executableOnly:true},{userId:'synthetic-video-status-readonly',authenticated:true,localExecution:true,executionBoundary:'trusted_local',domain:'personal',toolPolicy:p.authorizationPolicy}));
 expect(result.capabilities.map((x:any)=>x.toolName)).toContain('get_video_generation_status');expect(calls.count).toBe(0);
});
it('keeps pure declared network observation available',()=>{expect(build().authorizationPolicy.allowedTools).toContain('observe_remote');expect(calls.count).toBe(0)});
it('keeps verified original artifact reconciliation available without a tool-name exception',()=>{expect(build().authorizationPolicy.allowedTools).toContain('original_artifact_reconcile');expect(calls.count).toBe(0)});
it.each(['fake_observe_commit','fake_observe_message','arbitrary_observe_write','irreversible_observe_remote'])('still forbids %s despite its observe label',async name=>{const p=build();expect(p.authorizationPolicy.forbiddenTools).toContain(name);await expect(registry.execute(name,{}, {userId:'synthetic-video-status-readonly',authenticated:true,localExecution:true,executionBoundary:'trusted_local',domain:'personal',toolPolicy:p.authorizationPolicy})).rejects.toThrow(/forbidden/i);expect(calls.count).toBe(0)});
it('preserves remote host isolation independently of the no-mutation predicate',()=>{
 const p=buildLumiExecutionPipeline({dispatch:{userId:'synthetic-remote',channel:'chat',source:'rest_chat',operationMode:'assistant',text:original.text,targetIsLumi:true},executionBoundary:'remote_restricted',registry});
 expect(p.authorizationPolicy.allowedTools).not.toContain('get_video_generation_status');expect(p.authorizationPolicy.allowedTools.every(name=>name==='web_search')).toBe(true);expect(calls.count).toBe(0);
});
