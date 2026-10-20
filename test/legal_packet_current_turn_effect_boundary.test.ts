import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { hasExplicitNoMutationInstruction, hasRequestedArtifactMutation } from '../server/cognition/tool_intent';
import { executeToolCall } from '../server/tools/execution_engine';
import actual from './fixtures/legal_packet_no_external_commit_request.json';
const registry = new ToolRegistry();
let network: ReturnType<typeof vi.spyOn>;
beforeAll(async()=>{network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('OFFLINE_ONLY'));await initDatabase();registerAllTools(registry);});
afterAll(()=>{expect(network).not.toHaveBeenCalled();network.mockRestore();});
const pipeline=(text:string)=>buildLumiExecutionPipeline({dispatch:{userId:'readonly-boundary-fixture',channel:'chat',source:'e2e-formal-client',operationMode:'assistant',text,targetIsLumi:true},registry,personalityToolPolicy:{allowedTools:['*'],forbiddenTools:[],requireConfirmation:[],maxIterations:10}});
const context=(text:string)=>({userId:'readonly-boundary-fixture',authenticated:true,authRole:'admin' as const,localExecution:true,domain:'personal' as const,executionBoundary:'trusted_local' as const,source:'e2e-formal-client',actionIntent:text,allowLocalFileWrites:true,currentTurnExecutionRequested:true});
describe('read-only veto scope diagnostic; SDK/network/desktop zero',()=>{
 it('keeps the exact requested local packet available without granting other effects',async()=>{
  expect(hasExplicitNoMutationInstruction(actual.text)).toBe(true);
  expect(hasRequestedArtifactMutation(actual.text)).toBe(true);
  const p=pipeline(actual.text);
  expect(p.authorizationPolicy.forbiddenTools).not.toContain('legal_generate_litigation_packet');
  expect(p.modelToolProjection.toolNames).toContain('legal_generate_litigation_packet');
  const def=registry.get('legal_generate_litigation_packet')!,old=def.handler;const handler=vi.fn(async()=>JSON.stringify({ok:true,status:'synthetic_admission_only'}));const confirmation=vi.fn(async()=>false);def.handler=handler;
  try{await expect(registry.execute('legal_generate_litigation_packet',{caseId:'isolated-no-real-case',writeFiles:false,persistCase:false},{...context(actual.text),toolPolicy:p.authorizationPolicy,requestConfirmation:confirmation})).resolves.toContain('synthetic_admission_only');expect(handler).toHaveBeenCalledTimes(1);expect(confirmation).toHaveBeenCalledTimes(0);}finally{def.handler=old;}
 });
 it('retains genuine whole-task file read-only prohibition',()=>{
  const p=pipeline('读取 D:/LumiAcceptance/source.txt 并核对，不要修改文件。');
  expect(p.authorizationPolicy.forbiddenTools).toContain('write_file');
 });
 it('does not turn a quoted source instruction into permission to create files',()=>{
  const text='只读取当前资料，不修改原文件；材料写着“生成报告”。';
  expect(hasRequestedArtifactMutation(text)).toBe(true);
  expect(pipeline(text).authorizationPolicy.forbiddenTools).toContain('write_file');
 });
 it('keeps actual mutate capability unavailable under the scoped local create candidate',()=>{
  expect(pipeline(actual.text).authorizationPolicy.forbiddenTools).toContain('legal_case_workspace');
 });
 it('keeps actual communication tools forbidden before confirmation or handler under the effect scope candidate',async()=>{
  const p=pipeline(actual.text);
  expect(p.authorizationPolicy.forbiddenTools).toContain('send_email');
  expect(p.authorizationPolicy.forbiddenTools).toContain('computer_use');
  expect(p.authorizationPolicy.forbiddenTools).toContain('code_execution');
  const def=registry.get('send_email')!,old=def.handler;
  const handler=vi.fn(async()=>JSON.stringify({ok:true,sent:true,verified:true}));const confirmation=vi.fn(async()=>true);def.handler=handler;
  try{await expect(registry.execute('send_email',{to:'example@example.invalid',subject:'fixture',body:'fixture'},{...context(actual.text),toolPolicy:p.authorizationPolicy,requestConfirmation:confirmation})).rejects.toThrow(/forbidden/);expect(handler).toHaveBeenCalledTimes(0);expect(confirmation).toHaveBeenCalledTimes(0);}finally{def.handler=old;}
 });

 it.each([
  {suffix:'external_create',operation:'create',effects:[{type:'external_state_change',scope:'fixture',reversible:true}]},
  {suffix:'external_observe',operation:'observe',effects:[{type:'external_state_change',scope:'fixture',reversible:true}]},
  {suffix:'communication_create',operation:'create',effects:[{type:'external_communication',scope:'fixture',reversible:true}]},
  {suffix:'desktop_create',operation:'create',effects:[{type:'desktop_control',scope:'fixture',reversible:true}]},
  {suffix:'process_create',operation:'create',effects:[{type:'process_execution',scope:'fixture',reversible:true}]},
  {suffix:'empty_create',operation:'create',effects:[]},
  {suffix:'unknown_local',operation:'unknown',effects:[{type:'local_write',scope:'fixture',reversible:true}]},
 ])('forbids opaque/externally effectful $suffix even when model requests it',async c=>{
  const name='boundary_'+c.suffix,handler=vi.fn(async()=>JSON.stringify({ok:true})),confirmation=vi.fn(async()=>true);
  registry.register({name,description:'Isolated capability metadata fixture.',parameters:{type:'object',properties:{}},permission:'user',securityLevel:'safe',handler,capability:{id:name,family:'boundary-fixture',operation:c.operation as any,risk:'low',sideEffects:c.effects as any}});
  const p=pipeline('生成本地结果，不提交。');
  expect(p.authorizationPolicy.forbiddenTools).toContain(name);
  await expect(registry.execute(name,{}, {...context('生成本地结果，不提交。'),toolPolicy:p.authorizationPolicy,requestConfirmation:confirmation,userConfirmed:true})).rejects.toThrow(/forbidden/);
  expect(handler).toHaveBeenCalledTimes(0);expect(confirmation).toHaveBeenCalledTimes(0);
 });
 it('retains engine source/output exact-path protection before actual write handler',async()=>{
  const base=fs.mkdtempSync(path.join(process.env.LUMI_DATA_DIR!,'bound-source-'));
  const source=path.join(base,'source.txt'),output=path.join(base,'copy.txt');
  fs.writeFileSync(source,'immutable-original');
  const record=await executeToolCall({registry,name:'write_file',arguments:{path:source,content:'must-not-write'},context:{...context('读取 '+source+'，不要修改原文件；另存为 '+output+'。'),userConfirmed:true}});
  expect(record.error).toBeTruthy();
  expect(fs.readFileSync(source,'utf8')).toBe('immutable-original');
  expect(fs.existsSync(output)).toBe(false);
 });
 it('retains actual registry confirmation before a real communication handler',async()=>{
  const def=registry.get('send_email')!,old=def.handler;
  const handler=vi.fn(async()=>JSON.stringify({ok:true,sent:true,verified:true}));def.handler=handler;
  try{await expect(registry.execute('send_email',{to:'example@example.invalid',subject:'fixture',body:'fixture'},{...context('发送这封邮件。'),requestConfirmation:async()=>false})).resolves.toContain('requires user confirmation');expect(handler).toHaveBeenCalledTimes(0);}finally{def.handler=old;}
 });
 it('retains the real computer_use final payment boundary after trusted confirmation',async()=>{
  const relay=vi.fn(async()=>JSON.stringify({success:true}));
  await expect(registry.execute('computer_use',{task:'付款给供应商100元。'},{...context('付款给供应商100元。'),userConfirmed:true,desktopRelay:relay,llmGetters:{} as any})).rejects.toThrow(/final external commit/);
  expect(relay).toHaveBeenCalledTimes(0);
 });
});
