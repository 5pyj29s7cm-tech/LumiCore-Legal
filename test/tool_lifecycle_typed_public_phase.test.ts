import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createToolLifecycleCallbacks } from '../server/socket/tool_lifecycle';
import * as projection from '../server/socket/public_agent_event_projection';
import type { ToolExecutionRecord } from '../server/tools/types';
const records=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/actual_packet_lifecycle_three_records.json',import.meta.url)),'utf8')) as ToolExecutionRecord[];
function actualAdapter(kind:'chat'|'voice'){
 const rel=kind==='chat'?'server/socket/chat/phases/prepare_chat_terminal_writers.ts':'server/socket/voice/turn/prepare_voice_receipts_and_tools.ts';
 const filename=path.join(fileURLToPath(new URL('../',import.meta.url)),rel);
 const source=fs.readFileSync(filename,'utf8'),ast=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true);let initializer:ts.Expression|undefined;
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='emitToolLifecycle')initializer=node.initializer;ts.forEachChild(node,visit);};visit(ast);
 if(!initializer)throw Error('Expected one existing lifecycle adapter');
 const emitted:any[]=[],progress=vi.fn(),session:any={isBackgroundWork:true,activeTurnText:'请继续当前工作',activeWorkToolCalls:0};
 const context={session,socket:{},requestId:'fixture-request',emitAgent:(event:string,payload:any)=>emitted.push({event,payload:projection.projectCustomerVisibleExecutionEvent(event,payload,{language:'zh'})})};
 const exports:any={};new Function('context','emitVoiceWorkProgress','inferPhase','projectCustomerVisibleExecutionEvent','exports',ts.transpileModule('exports.adapter = '+initializer.getText(ast)+';', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(context,progress,(projection as any).inferPhase,projection.projectCustomerVisibleExecutionEvent,exports);
 const callbacks=createToolLifecycleCallbacks({emit:exports.adapter,correlationPrefix:kind,formatResult:value=>(value||'').slice(0,500),includeFailedResult:kind==='chat'});
 return {callbacks,emitted,progress,session};
}
describe('typed canonical lifecycle outcome reaches actual chat and voice adapters',()=>{
 it.each(['chat','voice'] as const)('preserves the two actual partials and final success through %s without reading result keywords',kind=>{
  for(const [index,record] of records.entries()){
   const f=actualAdapter(kind),before=JSON.stringify(record);f.callbacks.onToolCall(record);
   expect(f.emitted).toHaveLength(2);for(const e of f.emitted){expect(e.payload.correlationId).toBe(record.id);expect(e.payload.publicText).toBe(index<2?'这一步没有完成。':'这一步已经处理完成。');expect(e.payload.phase).toBe(record.envelope!.status);expect(e.payload.publicText).not.toContain(record.name);}
   expect(JSON.stringify(record)).toBe(before);
   if(kind==='voice'){expect(f.progress.mock.calls.at(-1)?.[3]).toBe(index<2?'blocked':'step_completed');expect(f.session.activeWorkStep).toBe(f.emitted[0].payload.publicText);}
  }
 });
 it.each(['chat','voice'] as const)('keeps confirmation distinct from failure and completion in %s',kind=>{
  const base=records[0],record={...base,error:'Confirmation is required',envelope:{...base.envelope!,status:'waiting_confirmation' as const}};const f=actualAdapter(kind);f.callbacks.onToolCall(record);
  expect(f.emitted.every(e=>e.payload.publicText==='这一步正在等待你的确认。')).toBe(true);
  if(kind==='voice'){expect(f.session.activeWorkStatus).toBe('waiting_confirmation');expect(f.progress.mock.calls.at(-1)?.[3]).toBe('waiting_confirmation');}
 });
 it.each(['chat','voice'] as const)('keeps unknown outcome unverified with no retry recommendation in %s',kind=>{
  const base=records[0],record={...base,error:'Connection ended after accepted action',envelope:{...base.envelope!,status:'unknown_outcome' as const}};const f=actualAdapter(kind);f.callbacks.onToolCall(record);
  expect(f.emitted.every(e=>e.payload.publicText==='这一步的结果尚未核实。')).toBe(true);expect(f.emitted[0].payload.publicText).not.toMatch(/重试|retry|完成/);
  if(kind==='voice')expect(f.progress.mock.calls.at(-1)?.[3]).toBe('blocked');
 });
 it('keeps every remaining unsuccessful typed status out of completed even when a result exists',()=>{
  for(const status of ['failed','timeout','forbidden','target_mismatch'] as const){const f=actualAdapter('chat');f.callbacks.onToolCall({...records[0],envelope:{...records[0].envelope!,status}});expect(f.emitted[0].payload.publicText).not.toBe('这一步已经处理完成。');}
 });
 it('retains legacy start/result/error behavior without minting an envelope or changing arguments',()=>{
  const f=actualAdapter('chat'),record={id:'legacy',name:'read_file',arguments:{path:'unchanged'},result:'text'};f.callbacks.onToolStart(record);expect(f.emitted[0].payload.publicText).toBe('正在处理这一步。');f.callbacks.onToolCall(record);expect(f.emitted.at(-1).payload.publicText).toBe('这一步已经处理完成。');expect(f.emitted.at(-1).payload).not.toHaveProperty('phase');
  const g=actualAdapter('voice');g.callbacks.onToolCall({...record,error:'operation failed'});expect(g.progress.mock.calls.at(-1)?.[3]).toBe('blocked');expect(g.emitted[0].payload.publicText).toBe('这一步没有完成。');
 });
 it.each(['en','zh'] as const)('projects unknown and confirmation from typed phase in %s',language=>{
  for(const phase of ['waiting_confirmation','unknown_outcome']){const value=projection.projectCustomerVisibleExecutionEvent('agent:tool',{phase,result:'accepted',error:'diagnostic-only'},{language});expect(value.publicText).not.toMatch(/complete.|处理完成|diagnostic-only|accepted/);expect(value.phase).toBe(phase);}
 });
});
