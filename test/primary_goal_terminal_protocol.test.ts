import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { inspectPublicExecutionReferences, sanitizeUserFacingExecutionOutput } from '../server/cognition/user_output_protection';
import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => vi.fn());
const playbackMock = vi.hoisted(() => vi.fn());
vi.mock('../server/agents/computer_use',()=>({computerUseLoop:playbackMock}));
vi.mock('../server/llm/providers', async original => ({...await original<any>(), makeLLMCall: model, makeLLMCallStreaming: model}));
import { initDatabase, closeDatabase, readDB, readDatabaseTables, commitDatabaseTables } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { recoverOrphanedConversationActionExecutions } from '../server/conversation/manager/recovery';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { runLumiEntryTurn } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import type { ToolDefinition } from '../server/tools/types';
import { registerExternalCliTools } from '../server/tools/definitions/external_cli_tools';
import { registerComputerUseTool } from '../server/tools/definitions/computer_use_tool';
import { executeConfirmedToolStep } from '../server/tools/confirmed_step';
import { recordPendingConfirmationDurably } from '../server/tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import { createConversationReceiptObserver } from '../server/conversation/execution_receipt_archive';
import { saveStoredDesktopExecutionPreference } from '../server/cognition/operation_mode_store';
import { registerVideoTools } from '../server/tools/definitions/video_tools';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
beforeAll(()=>initDatabase());
beforeEach(()=>{model.mockReset();playbackMock.mockReset();vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('OUTSIDE_FIXTURE_NETWORK_FORBIDDEN'));});
function fixture(iterations: number, tail = ''){
 const userId='outside-terminal-'+randomUUID();
 const conversationId=getOrCreateActiveConversation(userId,'lumi','personal','').id;
 const requestId=randomUUID();
 const filePath=path.join(String(process.env.LUMI_DATA_DIR),'source-'+requestId+'.txt');
 const original='ISOLATED_SOURCE_CONTENT\nSOURCE_TAIL_86751';fs.writeFileSync(filePath,original);
 const text='Read the file '+filePath+' and show its complete contents.'+tail;
 const registry=new ToolRegistry();registerFileOpsTools(registry);
 const read=registry.get('read_file')!; const handler=vi.fn(read.handler);read.handler=handler; const chunks:string[]=[];
 const identity={userId,conversationId,requestId,agentId:'lumi',domain:'personal' as const,orgId:''};
 const input:any={entry:{source:'isolated-terminal-boundary',channel:'chat',historyLimit:10,failureText:'The request did not finish.',failureReason:'isolated'},identity,userText:text,authorization:captureRequestAuthorization(()=>true,'Revoked'),controller:new AbortController(),planning:{dispatch:{...identity,text,source:'isolated-terminal-boundary',channel:'chat',operationMode:'assistant',targetIsLumi:true},registry,personalityToolPolicy:{allowedTools:['*'],forbiddenTools:[],requireConfirmation:[],maxIterations:iterations},executionBoundary:'trusted_local'},assemble:()=>({systemPrompt:'Use the actual source.',model:{registry,config:{provider:'deepseek',model:'isolated-no-network',userId,requestId},getters:{},maxIterations:iterations,onStreamChunk:(chunk:string)=>chunks.push(chunk),context:{authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',actionIntent:input.userText,routedTaskText:input.userText}}}),deliver:r=>r};
 return {input,identity,filePath,original,handler,chunks,readGoal:'Read the file '+filePath+' and show its complete contents.'};
}


const observations:any[]=[];
function reply(answer:string){return answer;}
function expectReadPhases(f: ReturnType<typeof fixture>, phases: { requestId: string; path: string }[]) {
 expect(f.handler.mock.calls.map(([args, context]) => ({ requestId: context.requestId, path: args.path }))).toEqual(phases);
}
function recordObservation(name:string,f:any,r:any){const row=readDB().conversationActionTasks.find((t:any)=>t.id===r.taskId);observations.push({name,rawChunks:f.chunks,finalized:r.finalized,taskStatus:row?.status,taskFinalization:row?JSON.parse(row.context).taskFinalization:null,unfinished:row?JSON.parse(row.context).actionState?.unfinished:null,modelCalls:model.mock.calls.length,modelResult:{text:r.modelResult?.text,completionGuard:r.modelResult?.completionGuard},direct:r.direct,readCalls:f.handler.mock.calls.length,records:r.toolRecords.map((x:any)=>({id:x.id,name:x.name,status:x.envelope?.status,error:x.error||null,operation:x.capability?.operation,sideEffects:x.capability?.sideEffects?.map((s:any)=>s.type)}))});}
describe('current canonical execution and full-body delivery, real driver and database',()=>{
 it('keeps a complete read body and records the unperformed signature goal as incomplete',async()=>{
  const f=fixture(2,' Then sign the contract.');const answer=f.original+'\nThe signature step is not complete and requires confirmation.';
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(answer),toolCalls:[]});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('read-plus-sign-partial',f,r);
  expect(model).toHaveBeenCalledTimes(2);expect(f.handler).toHaveBeenCalledTimes(1);expect(r.finalized.text).toContain(f.original);expect(r.finalized.text).toMatch(/not complete|incomplete/i);expect(r.finalized.text).toMatch(/sign(?:ature)?(?: the)? contract/i);expect(r.finalized.text).not.toContain('evidenceIds');expect(r.finalized.blocked).toBe(true);expect(fs.readFileSync(f.filePath,'utf8')).toBe(f.original);expect(readDB().conversationActionTasks.find((t:any)=>t.id===r.taskId)?.status).toBe('blocked');
 });
 it('cannot use a verified read to claim a completed external mutation goal',async()=>{
  const f=fixture(2,' Then sign the contract.');
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(f.original+'\nThe contract has been signed.'),toolCalls:[]});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('read-does-not-prove-commit',f,r);expect(r.finalized.blocked).toBe(true);expect(r.finalized.text).not.toContain('The contract has been signed.');expect(fs.readFileSync(f.filePath,'utf8')).toBe(f.original);expect(r.finalized.text).toMatch(/sign(?:ature)?(?: the)? contract/i);expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(2);expect(readDB().conversationActionTasks.find((t:any)=>t.id===r.taskId)?.status).toBe('blocked');
 });
 it('completed exact reading retains the entire original including a quoted incomplete phrase',async()=>{
  const f=fixture(2);f.original+='\nQuoted source: not complete';fs.writeFileSync(f.filePath,f.original);
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(f.original),toolCalls:[]});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('completed-read-original-bytes',f,r);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toBe(f.original);expect(fs.readFileSync(f.filePath,'utf8')).toBe(f.original);expect(readDB().conversationActionTasks.find((t:any)=>t.id===r.taskId)?.status).toBe('completed');expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(2);
 });
 it('streams the normal full body without private call identifiers',async()=>{
  const f=fixture(2);const raw=reply(f.original);
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'internal-record-dont-display',name:'read_file',arguments:{path:f.filePath}}]}).mockImplementationOnce(async(...args:any[])=>{args[3]?.(raw.slice(0,20));args[3]?.(raw.slice(20));return {text:raw,toolCalls:[]};});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('stream-private-goals',f,r);expect(f.chunks.join('')).toBe(f.original);expect(r.finalized.text).toBe(f.original);expect(r.finalized.text).not.toContain('internal-record-dont-display');expect(r.finalized.text).not.toContain('goals');expect(r.finalized.blocked).toBe(false);
 });
 it('ordinary conversation keeps its original streaming path and needs no goal protocol',async()=>{
  const f=fixture(2);const chat='Hello. I can help you think this through.';f.input.userText='Hello, how are you?';f.input.planning.dispatch.text=f.input.userText;
  model.mockImplementationOnce(async(...args:any[])=>{args[3]?.(chat);return {text:chat,toolCalls:[]};});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('ordinary-conversation',f,r);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toBe(chat);expect(f.chunks.join('')).toBe(chat);expect(f.handler).toHaveBeenCalledTimes(0);expect(model).toHaveBeenCalledTimes(1);
 });
 it('a complete read plus actual local creation and independent readback remains callable and complete',async()=>{
  const f=fixture(4);const output=path.join(path.dirname(f.filePath),'created-'+f.identity.requestId+'.txt');const created='LOCAL_CREATED_VALUE_4242';
  f.readGoal='Read the file "'+f.filePath+'" and show its complete contents.';const createGoal='Then create the file "'+output+'" containing "'+created+'" and read it back.';const text=f.readGoal+' '+createGoal;
  f.input.userText=text;f.input.planning.dispatch.text=text;const assemble=f.input.assemble;f.input.assemble=()=>{const data=assemble();data.model.context.actionIntent=text;data.model.context.routedTaskText=text;data.model.context.requestConfirmation=async()=>true;return data;};
  let calls=0;model.mockImplementation(async(...args:any[])=>{calls++;if(calls===1)return {text:'',toolCalls:[{id:'source-read',name:'read_file',arguments:{path:f.filePath}},{id:'local-create',name:'write_file',arguments:{path:output,content:created}}]};
   const receipts:any[]=(readDB().conversationActionReceipts||[]).filter((x:any)=>x.requestId===f.identity.requestId);const readback=receipts.find((x:any)=>x.toolName==='read_file'&&x.targetIdentity?.includes('created-'));
   if(!readback)return {text:'',toolCalls:[{id:'output-readback',name:'read_file',arguments:{path:output}}]};
   return {text:reply(f.original+'\nCreated local output:\n'+created),toolCalls:[]};});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('actual-local-create-readback',f,r);
  expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toContain(f.original);expect(fs.readFileSync(output,'utf8')).toBe(created);expect(r.toolRecords.some((x:any)=>x.name==='write_file'&&x.envelope?.status==='verified_success')).toBe(true);expect(r.toolRecords.filter((x:any)=>x.name==='read_file').some((x:any)=>x.arguments.path===output&&x.envelope?.status==='verified_success')).toBe(true);expect(model.mock.calls.length).toBe(1);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('completed');
 });
 it('a current read record cannot be re-scoped to another request after canonical settlement',async()=>{
  const f=fixture(2);const assemble=f.input.assemble;f.input.assemble=()=>{const data=assemble();data.model.onToolCall=(record:any)=>{record.requestId='foreign-request';};return data;};
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(f.original),toolCalls:[]});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('cross-request-rejected',f,r);expect(r.finalized.blocked).toBe(true);expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(3);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('blocked');
 });
 it('changing canonical arguments after execution invalidates a goal reference without replay',async()=>{
  const f=fixture(2);const assemble=f.input.assemble;f.input.assemble=()=>{const data=assemble();data.model.onToolCall=(record:any)=>{record.arguments={...record.arguments,path:record.arguments.path+'.different'};};return data;};
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(f.original),toolCalls:[]});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('arguments-tampering-rejected',f,r);expect(r.finalized.blocked).toBe(true);expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(2);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('blocked');
 });
 it('ordinary model-selected routing metadata is bound before the canonical brand',async()=>{
  const f=fixture(2);model.mockResolvedValueOnce({text:'',routingReceiptId:'private-routing-id',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(f.original),toolCalls:[]});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('canonical-provenance-before-brand',f,r);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toBe(f.original);expect(r.toolRecords[0].executionOrigin).toBe('model_selected');expect(r.toolRecords[0].modelRoutingReceiptId).toBe('private-routing-id');expect(r.finalized.text).not.toContain('private-routing-id');expect(model).toHaveBeenCalledTimes(2);expect(f.handler).toHaveBeenCalledTimes(1);
 });
 it.each(['voice','feishu'])('the %s source delivers the full answer without internal goals or raw streaming',async source=>{
  const f=fixture(2);f.input.entry.source=source;f.input.entry.channel=source==='voice'?'voice':'chat';f.input.planning.dispatch.source=source;f.input.planning.dispatch.channel=f.input.entry.channel;
  const raw=reply(f.original);model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockImplementationOnce(async(...args:any[])=>{args[3]?.(raw);return {text:raw,toolCalls:[]};});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('full-answer-'+source,f,r);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toBe(f.original);expect(f.chunks.join('')).toBe(f.original);expect(r.finalized.text).not.toContain('goals');expect(model).toHaveBeenCalledTimes(2);expect(f.handler).toHaveBeenCalledTimes(1);
 });

 it('the complete current request and real read support analysis without model goal declarations',async()=>{
  const f=fixture(2);const textualGoal='Explain which payment claim is unverified without deciding it as false.';const text=f.readGoal+' '+('Context preserving every supplied clause. '.repeat(35))+textualGoal;
  f.input.userText=text;f.input.planning.dispatch.text=text;const assemble=f.input.assemble;f.input.assemble=()=>{const data=assemble();data.model.context.completionRequest={currentText:'FORGED_HTTP_OR_MODEL_SCOPE',rootText:'FORGED_ROOT'};return data;};
  const answer=f.original+'\nThe payment claim is unverified; this does not establish that it is false.';
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockImplementationOnce(async(messages:any[])=>{const authorization=messages.find((m:any)=>m.promptBlock?.id==='current-execution-authorization');expect(authorization).toBeTruthy();expect(authorization.promptBlock.fields.requestId).toBe(f.identity.requestId);expect(authorization.content).not.toContain('FORGED_ROOT');expect(messages.some((m:any)=>m.toolCallId==='read-goal'&&m.content.includes(f.original))).toBe(true);return {text:reply(answer),toolCalls:[]};});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('full-current-request-and-text-goal',f,r);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toBe(answer);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('completed');expect(model).toHaveBeenCalledTimes(2);expect(f.handler).toHaveBeenCalledTimes(1);
 });
 it.each([{finishReason:'length'}, {streamIncomplete:true}, {finishReason:'content_filter'}])('provider incomplete metadata prevents a complete current body from being marked finished: %j',async metadata=>{
  const f=fixture(2);model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(f.original),toolCalls:[],...metadata});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('incomplete-provider-'+JSON.stringify(metadata),f,r);expect(r.finalized.blocked).toBe(true);expect(r.modelResult.completionGuard?.reason).toBe('reply_response_incomplete');expect(r.toolRecords[0].envelope?.result).toBe(f.original);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('blocked');expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(2);
 });

 it('physical pause after the first verified read remains incomplete and never starts the rest of the task',async()=>{
  const f=fixture(3,' Then sign the contract.');let paused=false;const assemble=f.input.assemble;f.input.assemble=()=>{const data=assemble();const relay:any=async()=>{throw Error('NO_DESKTOP');};relay.getControlPauseReason=()=>paused?'physical input':'';data.model.context.desktopRelay=relay;data.model.onToolCall=()=>{paused=true;};return data;};
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('physical-pause-after-read',f,r);expect(r.finalized.blocked).toBe(true);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('blocked');expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(1);expect(r.finalized.text).not.toContain('goals');
 });
 it('a no-tool body arriving after a physical pause retains the completed current read',async()=>{
  const f=fixture(3);let paused=false;const assemble=f.input.assemble;f.input.assemble=()=>{const data=assemble();const relay:any=async()=>{throw Error('NO_DESKTOP');};relay.getControlPauseReason=()=>paused?'physical input':'';data.model.context.desktopRelay=relay;return data;};
  const raw=reply(f.original);model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockImplementationOnce(async()=>{paused=true;return{text:raw,toolCalls:[]};});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('physical-pause-before-final-delivery',f,r);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toBe(f.original);expect(r.finalized.text).not.toContain('evidenceIds');expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(2);
 });
 it('a verified read cannot complete the same request whose explicitly requested local creation is waiting for confirmation',async()=>{
  const f=fixture(3);const output=path.join(path.dirname(f.filePath),'pending-'+f.identity.requestId+'.txt');const createGoal='Then create the file "'+output+'" containing "PENDING_VALUE".';f.readGoal='Read the file "'+f.filePath+'" and show its complete contents.';const text=f.readGoal+' '+createGoal;f.input.userText=text;f.input.planning.dispatch.text=text;const assemble=f.input.assemble;let confirms=0;f.input.assemble=()=>{const data=assemble();data.model.context.actionIntent=text;data.model.context.routedTaskText=text;data.model.context.requestConfirmation=async()=>{confirms++;return false;};return data;};
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}},{id:'pending-create',name:'write_file',arguments:{path:output,content:'PENDING_VALUE'}}]});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('read-plus-pending-write',f,r);expect(confirms).toBe(1);expect(fs.existsSync(output)).toBe(false);expect(r.toolRecords.find((x:any)=>x.id==='pending-create')?.envelope?.status).toBe('waiting_confirmation');expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('waiting_confirmation');expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(1);expect(r.finalized.text).not.toContain('evidenceIds');
 });

 it('continuation uses its exact persisted root user transcript beyond the 700-character state summary',async()=>{
  const f=fixture(3);const explanation='Explain the unresolved payment claim without treating missing evidence as a denial.';const root=f.readGoal+' '+('Preserve the original scope and source attribution. '.repeat(40))+explanation;f.input.userText=root;f.input.planning.dispatch.text=root;const baseAssemble=f.input.assemble;f.input.assemble=()=>{const data=baseAssemble();data.model.context.actionIntent=root;data.model.context.routedTaskText=root;return data;};
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-first',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(f.original),toolCalls:[]});const first:any=await runLumiEntryTurn(f.input);expect(first.finalized.blocked).toBe(true);expect(readDB().conversationActionTasks.find((x:any)=>x.id===first.taskId)?.status).toBe('blocked');
  model.mockReset();const request2=randomUUID();const current='Continue the original task and provide the remaining explanation.';const next:any={...f.input,identity:{...f.identity,requestId:request2},userText:current,controller:new AbortController(),planning:{...f.input.planning,dispatch:{...f.input.planning.dispatch,requestId:request2,text:current}},assemble:()=>{const data=baseAssemble();data.model.config.requestId=request2;data.model.context.actionIntent=current;delete data.model.context.routedTaskText;data.model.context.completionRequest={currentText:'FORGED',rootText:'FORGED'};return data;}};
  const answer=f.original+'\nThe payment claim remains unverified; absence of evidence does not establish a denial.';
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-current',name:'read_file',arguments:{path:f.filePath}}]}).mockImplementationOnce(async(messages:any[])=>{const authorization=messages.find((m:any)=>m.promptBlock?.id==='current-execution-authorization');expect(authorization?.promptBlock.fields.trustedContinuation).toBe(true);expect(authorization.promptBlock.fields.requestId).toBe(request2);expect(authorization.content).not.toContain('FORGED');expect(readDB().conversationActionTasks.find((t:any)=>t.id===first.taskId)?.goal).toBe(root);expect(root.length).toBeGreaterThan(700);return{text:reply(answer),toolCalls:[]};});
  const r:any=await runLumiEntryTurn(next);recordObservation('root-transcript-continuation',f,r);expect(r.taskId).toBe(first.taskId);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toBe(answer);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('completed');expect(model).toHaveBeenCalledTimes(2);expect(f.handler).toHaveBeenCalledTimes(2);
 });

 it('a primary-loop verified playback suppresses the queued toggle but still obtains the same primary model whole-request terminal reply',async()=>{
  const f=fixture(3);const task='用爱奇艺播放蜡笔小新第一集';f.input.userText=task;f.input.planning.dispatch.text=task;registerComputerUseTool(f.input.planning.registry);const click=vi.fn(async()=>'{"ok":true}');f.input.planning.registry.register({name:'desktop_mouse_click_at',description:'Isolated desktop click sentinel',parameters:{type:'object',properties:{}},permission:'public',securityLevel:'safe',handler:click});await saveStoredDesktopExecutionPreference(f.identity.userId,'external');
  const assemble=f.input.assemble;f.input.assemble=()=>{const data=assemble();data.model.context.actionIntent=task;data.model.context.routedTaskText=task;data.model.context.desktopRelay=Object.assign(vi.fn(async()=>''),{getControlPauseReason:()=>''});data.model.context.llmGetters={getDeepSeek:()=>null,getGemini:()=>null,getOpenAI:()=>({})};data.model.context.requestConfirmation=async()=>true;return data;};const message='爱奇艺正在播放蜡笔小新第一集，正片进度00:37。';playbackMock.mockResolvedValue(JSON.stringify({ok:true,status:'verified',completionVerified:true,observations:2,applicationIdentity:'',applicationMatched:true,message}));
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'play-once',name:'computer_use',arguments:{task,target_application:'爱奇艺',max_steps:2}},{id:'must-not-click',name:'desktop_mouse_click_at',arguments:{x:30,y:30}}]}).mockImplementationOnce(async(messages:any[])=>{expect(messages.some((m:any)=>m.toolCallId==='must-not-click'&&m.content.includes('not executed'))).toBe(true);return{text:reply(message),toolCalls:[]};});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('primary-playback-terminal',f,r);expect(model).toHaveBeenCalledTimes(2);expect(playbackMock).toHaveBeenCalledTimes(1);expect(click).not.toHaveBeenCalled();expect(r.toolRecords).toHaveLength(1);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toContain('蜡笔小新');expect(r.finalized.text).not.toContain('evidenceIds');expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('completed');
 });

 it.each(['I opened the file in WPS.','I saved the file to disk.'])('a primary goal report cannot bypass independent open/save evidence: %s',async claim=>{
  const f=fixture(2);model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValue({text:reply(f.original+'\n'+claim),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('independent-extra-claim-'+claim,f,r);expect(r.finalized.blocked).toBe(true);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('blocked');expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(3);
 });

 it('unknown canonical external outcome stays incomplete without a program-forced replanning or a second side effect',async()=>{
  const f=fixture(4);const task='Send the message "SYNTHETIC_ONLY" to the isolated recipient.';f.input.userText=task;f.input.planning.dispatch.text=task;const action=vi.fn(async()=>{throw Error('ISOLATED_UNCERTAIN_ADAPTER');});f.input.planning.registry.register({name:'synthetic_external_action',description:'Test-only uncertain external sentinel; no network',parameters:{type:'object',properties:{target:{type:'string'},payload:{type:'string'}},required:['target','payload']},permission:'public',securityLevel:'confirm',capability:{id:'fixture.messaging.uncertain',family:'messaging',lane:'messaging',operation:'mutate',risk:'high',sideEffects:[{type:'external_communication',scope:'test recipient',reversible:false}],verification:{strategy:'terminal_receipt',required:true,requiredFields:['verified'],requiredValues:{verified:true},successSignals:['provider receipt'],limitations:[]}},handler:action});const assemble=f.input.assemble;f.input.assemble=()=>{const data=assemble();data.model.context.actionIntent=task;data.model.context.routedTaskText=task;data.model.context.requestConfirmation=async()=>true;return data;};
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'unknown-commit',name:'synthetic_external_action',arguments:{target:'Isolated Recipient',payload:'SYNTHETIC_ONLY'}}]}).mockResolvedValue({text:reply('The adapter started, but its result is not confirmed. No resend was performed.'),toolCalls:[]});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('unknown-outcome-no-replay',f,r);expect(action).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(2);expect(r.toolRecords).toHaveLength(1);expect(r.toolRecords[0].envelope?.status).toBe('unknown_outcome');expect(r.finalized.blocked).toBe(true);expect(r.finalized.text).toMatch(/not confirmed|did not finish|没有完成|未取得/);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('blocked');
 });
 it.each(['chat','voice'])('the %s confirmed step is exactly once and its current canonical result supports the full primary continuation',async channel=>{
  await ensurePendingConfirmationPersistenceInitialized();
  const f=fixture(3),output=path.join(path.dirname(f.filePath),'confirmed-'+f.identity.requestId+'.txt'),payload='CONFIRMED_LOCAL_ONLY_573';
  const task='Read the file "'+f.filePath+'" and show its complete contents. Then create the file "'+output+'" containing "'+payload+'".';
  f.input.userText=task;f.input.planning.dispatch.text=task;f.input.entry.channel=channel;f.input.entry.source=channel+'_confirmation';f.input.planning.dispatch.channel=channel;
  const base=f.input.assemble,registry=f.input.planning.registry,writer=registry.get('write_file')!,writeHandler=vi.fn(writer.handler);writer.handler=writeHandler;
  f.input.assemble=()=>{const data=base();data.model.context.requestConfirmation=async()=>false;return data;};
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'initial-source',name:'read_file',arguments:{path:f.filePath}},{id:'waiting-create',name:'write_file',arguments:{path:output,content:payload}}]});
  const waiting:any=await runLumiEntryTurn(f.input);
  expect(readDB().conversationActionTasks.find((r:any)=>r.id===waiting.taskId)?.status).toBe('waiting_confirmation');expect(writeHandler).not.toHaveBeenCalled();expect(fs.existsSync(output)).toBe(false);
  const scope={domain:'personal',orgId:'',channelId:'conversation:'+f.identity.conversationId,taskId:waiting.taskId};
  const pending=await recordPendingConfirmationDurably(f.identity.userId,'write_file',{path:output,content:payload},channel,scope);
  model.mockReset();const requestId=randomUUID(),identity={...f.identity,requestId};let ctx:any;
  const next:any={...f.input,identity,userText:'确认，继续原任务。',controller:new AbortController(),planning:{...f.input.planning,dispatch:{...f.input.planning.dispatch,requestId,text:'确认，继续原任务。'}},assemble:async(execution:any)=>{
   const data=base();data.model.config.requestId=requestId;
   const row=readDB().conversationActionTasks.find((r:any)=>r.conversationId===identity.conversationId&&r.activeRequestId===requestId)!;expect(row?.id).toBe(waiting.taskId);
   const turn=readDB().conversationActionTurns.find((r:any)=>r.requestId===requestId)!,observer=createConversationReceiptObserver({...identity,taskId:row.id,turnRowId:turn.id},f.input.authorization.isCurrent);
   ctx={...data.model.context,...identity,taskId:row.id,turnRowId:turn.id,currentTurnExecutionRequested:true,source:channel+'_confirmation',actionIntent:task,routedTaskText:task,toolPolicy:execution.authorizationPolicy,onToolRecord:observer.onToolRecord};
   const confirmed=await executeConfirmedToolStep({registry,id:'confirmed-create',userId:identity.userId,pending,scope,context:ctx});
   expect(confirmed.envelope?.status).toBe('verified_success');expect(confirmed.executionOrigin).toBe('confirmed_action_resume');
   data.model.context={...data.model.context,priorToolRecords:[confirmed],actionIntent:task,routedTaskText:task};return data;
  }};
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}},{id:'confirm-readback',name:'read_file',arguments:{path:output}}]}).mockResolvedValueOnce({text:reply(f.original+'\nThe confirmed local file contains '+payload+'.'),toolCalls:[]});
  const r:any=await runLumiEntryTurn(next);recordObservation('confirmed-current-'+channel,f,r);
  expect(r.taskId).toBe(waiting.taskId);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toContain(f.original);expect(r.finalized.fileArtifacts.some((a:any)=>a.path===output)).toBe(true);expect(r.finalized.text).not.toContain('evidenceIds');
  // The reader spy spans both requests; the confirmed writer must still run only once.
  expectReadPhases(f,[{requestId:f.identity.requestId,path:f.filePath},{requestId,path:f.filePath},{requestId,path:output}]);
  expect(writeHandler).toHaveBeenCalledTimes(1);expect(writeHandler.mock.calls[0][0]).toMatchObject({path:output,content:payload});expect(writeHandler.mock.calls[0][1]).toMatchObject({requestId,taskId:waiting.taskId});
  expect(r.toolRecords.filter((x:any)=>x.name==='write_file'&&x.envelope?.status==='verified_success')).toEqual([expect.objectContaining({id:'confirmed-create',requestId,taskId:waiting.taskId,executionOrigin:'confirmed_action_resume'})]);
  expect(model).toHaveBeenCalledTimes(1);expect(fs.readFileSync(output,'utf8')).toBe(payload);expect(fs.readFileSync(f.filePath,'utf8')).toBe(f.original);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('completed');
  const replay=await executeConfirmedToolStep({registry,id:'never-replay',userId:identity.userId,pending,scope,context:ctx});expect(replay.error).toContain('one-time confirmation');expect(replay.adapterStarted).not.toBe(true);expect(writeHandler).toHaveBeenCalledTimes(1);
 });

 it.each([12000,56000])('a valid whole answer of %i characters is neither silently summarized nor falsely completed',async size=>{
  const f=fixture(2);f.original='FULL_REQUESTED_SOURCE_BEGIN\n'+('Visible source paragraph. '.repeat(Math.ceil(size/26)))+'\nFULL_REQUESTED_SOURCE_TAIL'+(size>50000?'\n':'');fs.writeFileSync(f.filePath,f.original);model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-goal',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(f.original),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('long-complete-source-'+size,f,r);expect(model).toHaveBeenCalledTimes(2);expect(f.handler).toHaveBeenCalledTimes(1);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toBe(f.original.trim());expect(fs.readFileSync(f.filePath,'utf8')).toBe(f.original);expect(r.finalized.text).toContain('FULL_REQUESTED_SOURCE_TAIL');expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('completed');
  if(size>50000){
   const options={task:f.input.userText,toolRecords:r.toolRecords,requestId:f.identity.requestId,taskId:r.taskId};
   // Presentation trims its outer whitespace; the prose sanitizer preserves harmless source bytes.
   expect(sanitizeUserFacingExecutionOutput(f.original,options)).toBe(f.original);
   expect(sanitizeUserFacingExecutionOutput(f.original+'\n'+f.original,options)).toBe(f.original+'\n'+f.original);
   const finalize=(scope:Omit<typeof options, 'requestId'> & {requestId:string},responseText=f.original)=>finalizeLumiResponse({taskText:scope.task,responseText,toolRecords:scope.toolRecords,requestId:scope.requestId,taskId:scope.taskId,source:'isolated-terminal-boundary',flow:r.execution.turnIntent.flow});
   expect(inspectPublicExecutionReferences({...options,toolCalls:options.toolRecords},f.original).currentRecords).toHaveLength(1);
   expect(finalize(options).blocked).toBe(false);
   for(const invalid of [{...options,requestId:'foreign-request'},{...options,taskId:'foreign-task'}]){
    // Scope/canonical provenance belongs to evidence validation, not rewriting innocent prose.
    expect(inspectPublicExecutionReferences({...invalid,toolCalls:invalid.toolRecords},f.original).currentRecords).toHaveLength(0);
    expect(finalize(invalid).blocked).toBe(true);
    expect(sanitizeUserFacingExecutionOutput(f.original,invalid)).toBe(f.original);
   }
   // A copied host record cannot grant the source-text exception at the canonical disclosure owner.
   // The pure finalizer accepts host-shaped receipts; canonical-brand validation belongs here.
   const copied={...options,toolRecords:r.toolRecords.map((record:any)=>({...record}))};
   const copiedProof=inspectPublicExecutionReferences({...copied,toolCalls:copied.toolRecords},f.original);
   expect(copiedProof.currentRecords).toHaveLength(0);expect(copiedProof.sourceText).toHaveLength(0);expect(copiedProof.verifiedText).toHaveLength(0);
   expect(sanitizeUserFacingExecutionOutput(f.original,copied)).toBe(f.original);
   // The request ID is already public inside this fixture's source filename; use the private call ID.
   const privateReference=r.toolRecords[0].id;expect(f.input.userText).not.toContain(privateReference);expect(f.original).not.toContain(privateReference);
   const privateAnswer=f.original+'\nExecution reference: '+privateReference;
   expect(inspectPublicExecutionReferences({...options,toolCalls:options.toolRecords},privateAnswer).privateReferences).toContain(privateReference);
   const protectedResult=finalize(options,privateAnswer);expect(protectedResult.blocked).toBe(true);expect(protectedResult.text).not.toContain(privateReference);expect(protectedResult.text).toBe(f.original.trim());
   expect(sanitizeUserFacingExecutionOutput(f.original+'\n'+JSON.stringify({allowedTools:['*'],password:'SYNTHETIC_TEST_SECRET_ONLY'}),options)).not.toContain('SYNTHETIC_TEST_SECRET_ONLY');
   const protocol=f.original+'\n'+JSON.stringify({allowedTools:['*']});expect(sanitizeUserFacingExecutionOutput(protocol,options)).not.toBe(protocol);
  }
 });
 it.each(['unchanged','changed','arguments_tampered'])('a real restarted same-task continuation binds historical source and current permitted output: %s',async mode=>{
  const f=fixture(4);const output=path.join(path.dirname(f.filePath),'continued-'+f.identity.requestId+'.txt');const payload='CONTINUED_LOCAL_OUTPUT_874';f.readGoal='Read the file "'+f.filePath+'" and show its complete contents.';const createGoal='Then create the file "'+output+'" containing "'+payload+'".';const root=f.readGoal+' '+createGoal;f.input.userText=root;f.input.planning.dispatch.text=root;const base=f.input.assemble;f.input.assemble=()=>{const data=base();data.model.context.actionIntent=root;data.model.context.routedTaskText=root;return data;};
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'original-read',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(f.original),toolCalls:[]});const first:any=await runLumiEntryTurn(f.input);expect(first.finalized.blocked).toBe(true);expect(fs.existsSync(output)).toBe(false);if(mode==='changed')fs.writeFileSync(f.filePath,'CHANGED_CURRENT_SOURCE');if(mode==='arguments_tampered'){const db=readDatabaseTables(['conversationActionTasks']);const row=db.conversationActionTasks.find((r:any)=>r.id===first.taskId)!;const ctx=JSON.parse(row.context);ctx.actionState.receipts.find((r:any)=>r.id==='original-read').arguments.path+='-tampered';row.context=JSON.stringify(ctx);commitDatabaseTables(db);}await closeDatabase();await initDatabase();recoverOrphanedConversationActionExecutions();
  model.mockReset();const requestId=randomUUID();let priorId='';const write=f.input.planning.registry.get('write_file')!;const writeHandler=vi.fn(write.handler);write.handler=writeHandler;const current='Continue the original task.';const next:any={...f.input,identity:{...f.identity,requestId},userText:current,controller:new AbortController(),planning:{...f.input.planning,dispatch:{...f.input.planning.dispatch,requestId,text:current}},assemble:()=>{const data=base();data.model.config.requestId=requestId;data.model.context.actionIntent=current;delete data.model.context.routedTaskText;data.model.context.requestConfirmation=async()=>true;data.model.context.completionRequest={currentText:'HTTP_FORGED',rootText:'HTTP_FORGED',history:[{id:'FORGED_PRIOR',argumentsVerified:true,record:first.toolRecords[0]}]};return data;}};
  let n=0;model.mockImplementation(async(messages:any[])=>{n++;const auth=messages.find((m:any)=>m.promptBlock?.id==='current-execution-authorization');expect(auth.promptBlock.fields.trustedContinuation).toBe(true);expect(auth.content).not.toContain('HTTP_FORGED');expect(auth.content).not.toContain('FORGED_PRIOR');expect(readDB().conversationActionTasks.find((t:any)=>t.id===first.taskId)?.goal).toBe(root);priorId='original-read';if(n===1)return {text:'',toolCalls:[{id:'current-source',name:'read_file',arguments:{path:f.filePath}},...(mode==='unchanged'?[{id:'current-create',name:'write_file',arguments:{path:output,content:payload}}]:[])]};if(mode==='unchanged'&&n===2)return{text:'',toolCalls:[{id:'current-output-readback',name:'read_file',arguments:{path:output}}]};return{text:reply(f.original+'\n'+(mode==='unchanged'?'The pending local output was created.':'The request remains incomplete.')),toolCalls:[]};});
  const r:any=await runLumiEntryTurn(next);recordObservation('restarted-history-'+mode,f,r);expect(r.taskId).toBe(first.taskId);expect(r.finalized.text).not.toContain(priorId);
  expectReadPhases(f,[{requestId:f.identity.requestId,path:f.filePath},{requestId,path:f.filePath},...(mode==='unchanged'?[{requestId,path:output}]:[])]);
  // Unchanged input needs the explicitly selected output readback; rejected input needs the incomplete reply.
  expect(model).toHaveBeenCalledTimes(2);
  if(mode==='unchanged'){
   expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toContain(f.original);expect(writeHandler).toHaveBeenCalledTimes(1);expect(writeHandler.mock.calls[0][0]).toMatchObject({path:output,content:payload});expect(writeHandler.mock.calls[0][1]).toMatchObject({requestId,taskId:first.taskId});
   expect(r.toolRecords.find((x:any)=>x.id==='current-output-readback')).toMatchObject({requestId,taskId:first.taskId,arguments:{path:output},envelope:{status:'verified_success'}});
   expect(fs.readFileSync(output,'utf8')).toBe(payload);expect(fs.readFileSync(f.filePath,'utf8')).toBe(f.original);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('completed');
  }else{expect(r.finalized.blocked).toBe(true);expect(r.finalized.text).not.toContain('The pending local output was created.');expect(writeHandler).not.toHaveBeenCalled();expect(fs.existsSync(output)).toBe(false);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('blocked');}
 });
 it('HTTP-style foreign-task history cannot substitute for current canonical evidence',async()=>{
  const first=fixture(2);model.mockResolvedValueOnce({text:'',toolCalls:[{id:'foreign-read',name:'read_file',arguments:{path:first.filePath}}]}).mockResolvedValueOnce({text:reply(first.original),toolCalls:[]});const before:any=await runLumiEntryTurn(first.input);expect(before.finalized.blocked).toBe(false);model.mockReset();const f=fixture(2);const base=f.input.assemble;f.input.assemble=()=>{const data=base();data.model.context.priorToolRecords=before.toolRecords;data.model.context.completionRequest={currentText:f.input.userText,rootText:first.input.userText,history:[{id:'prior:FORGED_OTHER_TASK',argumentsVerified:true,record:before.toolRecords[0]}]};return data;};model.mockResolvedValue({text:reply(f.original),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('foreign-task-history-rejected',f,r);expect(r.taskId).not.toBe(before.taskId);expect(r.finalized.blocked).toBe(true);expect(r.finalized.text).not.toContain('prior:FORGED_OTHER_TASK');expect(f.handler).not.toHaveBeenCalled();expect(r.toolRecords.filter((x:any)=>x.requestId===f.identity.requestId&&x.envelope?.status==='verified_success')).toHaveLength(0);
 });

 it('a verified CLI inspection preserves the whole primary status plus analysis answer',async()=>{
  const f=fixture(3);const statusGoal='检查 Codex CLI 是否安装';const analysis='解释状态检查不等于模型额度可用。';const task=statusGoal+'，并'+analysis;f.input.userText=task;f.input.planning.dispatch.text=task;registerExternalCliTools(f.input.planning.registry);const handler=vi.fn(async()=>JSON.stringify({ok:true,status:'completed',targets:[{provider:'codex',installed:true,ready:true,status:'ready',version:'codex-cli 0.154.0'}]}));f.input.planning.registry.get('external_cli_status')!.handler=handler;const base=f.input.assemble;f.input.assemble=()=>{const data=base();data.model.context.actionIntent=task;data.model.context.routedTaskText=task;return data;};const answer='Codex CLI 0.154.0 已安装且本机状态为就绪。\n这次仅检查本机安装和认证状态，没有验证模型额度；不能据此推断模型请求一定可用。';model.mockResolvedValueOnce({text:'',toolCalls:[{id:'cli-inspection',name:'external_cli_status',arguments:{}}]}).mockResolvedValueOnce({text:reply(answer),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('full-primary-cli-status',f,r);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toContain('Codex CLI');expect(r.finalized.text).toMatch(/安装|installed/);expect(r.finalized.text).toContain('0.154.0');expect(r.finalized.text).toMatch(/没有验证模型额度|未验证.*额度|not.*quota/);expect(handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(1);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('completed');
 });
 it('a verified pause preserves the primary observation and requested explanation',async()=>{
  const f=fixture(3);const pauseGoal='帮我暂停爱奇艺正在播放的视频';const analysis='说明当前观察到的状态。';const task=pauseGoal+'，然后'+analysis;f.input.userText=task;f.input.planning.dispatch.text=task;registerComputerUseTool(f.input.planning.registry);await saveStoredDesktopExecutionPreference(f.identity.userId,'external');const base=f.input.assemble;f.input.assemble=()=>{const data=base();data.model.context.actionIntent=task;data.model.context.routedTaskText=task;data.model.context.desktopRelay=Object.assign(vi.fn(async()=>''),{getControlPauseReason:()=>''});data.model.context.llmGetters={getDeepSeek:()=>null,getGemini:()=>null,getOpenAI:()=>({})};data.model.context.requestConfirmation=async()=>true;return data;};const answer='爱奇艺视频当前已经暂停，窗口仍保持打开。\n暂停只停止媒体继续播放，关闭窗口则会退出当前可见窗口；这次没有关闭窗口。';playbackMock.mockResolvedValue(JSON.stringify({ok:true,status:'verified',completionVerified:true,observations:2,application:'爱奇艺',applicationIdentity:'爱奇艺',applicationMatched:true,playbackState:'paused',isPlaying:false,message:'爱奇艺视频当前已经暂停。'}));model.mockResolvedValueOnce({text:'',toolCalls:[{id:'pause-once',name:'computer_use',arguments:{task:pauseGoal,target_application:'爱奇艺',max_steps:2}}]}).mockResolvedValueOnce({text:reply(answer),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('full-primary-pause',f,r);expect(r.execution.executionRequested).toBe(true);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toContain(answer);expect(playbackMock).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(2);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('completed');
 });

 it('a valid report cannot publish a private current-call identifier inside answer text',async()=>{
  const f=fixture(2);const id='private-call-reference-827513';model.mockResolvedValueOnce({text:'',toolCalls:[{id,name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(f.original+'\nExecution reference: '+id),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('private-reference-in-answer',f,r);expect(r.finalized.blocked).toBe(true);expect(r.finalized.text).not.toContain(id);expect(r.finalized.text).not.toContain('evidenceIds');expect(model).toHaveBeenCalledTimes(2);expect(f.handler).toHaveBeenCalledTimes(1);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('blocked');
 });
 it.each(['user','source'] as const)('an identifier already present in the %s is source text rather than a private disclosure',async mode=>{
  const f=fixture(2);const id='source-reference-827514';if(mode==='user'){f.input.userText+=' Reference: '+id;f.input.planning.dispatch.text=f.input.userText;} else {f.original+='\nOriginal reference: '+id;fs.writeFileSync(f.filePath,f.original);}
  const answer=mode==='source'?f.original:f.original+'\nReference: '+id;model.mockResolvedValueOnce({text:'',toolCalls:[{id,name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:reply(answer),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('literal-reference-'+mode,f,r);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toBe(answer);expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(2);
 });

 it('writer admission: a completed single output refuses the queued overwrite and still reaches the primary final reply',async()=>{
 const f=fixture(4);const output=path.join(path.dirname(f.filePath),'queued-'+f.identity.requestId+'.txt');const content='EXACT_USER_TEXT_731';const text='在 '+output+' 新建文本文件，只写入“'+content+'”。';f.input.userText=text;f.input.planning.dispatch.text=text;const base=f.input.assemble;f.input.assemble=()=>{const data=base();data.model.context.actionIntent=text;data.model.context.routedTaskText=text;data.model.context.requestConfirmation=async()=>true;return data;};const writer:ToolDefinition=f.input.planning.registry.get('write_file')!;const write=vi.fn(writer.handler);writer.handler=write;model.mockResolvedValueOnce({text:'',toolCalls:[{id:'first-write',name:'write_file',arguments:{path:output,content}},{id:'unrequested-overwrite',name:'write_file',arguments:{path:output,content:'UNREQUESTED_DIFFERENT_TEXT'}}]}).mockResolvedValue({text:reply('本地文件已按原文保存。'),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('actual-queued-exact-write',f,r);expect(write).toHaveBeenCalledTimes(1);expect(fs.readFileSync(output,'utf8')).toBe(content);expect(r.toolRecords.find((x:any)=>x.id==='unrequested-overwrite')?.adapterStarted).not.toBe(true);expect(r.toolRecords.find((x:any)=>x.id==='unrequested-overwrite')?.envelope?.status).not.toBe('verified_success');expect(r.finalized.blocked).toBe(false);expect(model).toHaveBeenCalledTimes(1);
 });

 it('writer admission: a verified content repair remains writable',async()=>{
 const f=fixture(5);const output=path.join(path.dirname(f.filePath),'repair-'+f.identity.requestId+'.txt');const content='REQUIRED_REPAIRED_CONTENT_856';const text='在 '+output+' 新建文本文件，只写入“'+content+'”，写完回读并告诉我全文。';f.input.userText=text;f.input.planning.dispatch.text=text;const base=f.input.assemble;f.input.assemble=()=>{const data=base();data.model.context.actionIntent=text;data.model.context.routedTaskText=text;data.model.context.requestConfirmation=async()=>true;return data;};const writer:ToolDefinition=f.input.planning.registry.get('write_file')!;const write=vi.fn(writer.handler);writer.handler=write;model.mockResolvedValueOnce({text:'',toolCalls:[{id:'bad-initial-write',name:'write_file',arguments:{path:output,content:'MISSING_REQUIRED_CONTENT'}}]}).mockResolvedValueOnce({text:'',toolCalls:[{id:'repair-write',name:'write_file',arguments:{path:output,content}}]}).mockResolvedValue({text:reply(content),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('writer-admission-real-repair',f,r);expect(write).toHaveBeenCalledTimes(2);expect(fs.readFileSync(output,'utf8')).toBe(content);expect(r.toolRecords.filter((x:any)=>x.name==='read_file'&&x.arguments.path===output)).toHaveLength(2);expect(r.finalized.blocked).toBe(false);expect(model).toHaveBeenCalledTimes(2);
 });
 it('writer admission: two explicit independent outputs both execute and the primary finishes both goals',async()=>{
 const f=fixture(4);const a=path.join(path.dirname(f.filePath),'first-'+f.identity.requestId+'.txt'),b=path.join(path.dirname(f.filePath),'second-'+f.identity.requestId+'.txt');const ga='Create file \"'+a+'\" with content \"ALPHA_VALUE_927\".';const gb='Create file \"'+b+'\" with content \"BETA_VALUE_928\".';const text=ga+' '+gb;f.input.userText=text;f.input.planning.dispatch.text=text;const base=f.input.assemble;f.input.assemble=()=>{const data=base();data.model.context.actionIntent=text;data.model.context.routedTaskText=text;data.model.context.requestConfirmation=async()=>true;return data;};const writer:ToolDefinition=f.input.planning.registry.get('write_file')!;const write=vi.fn(writer.handler);writer.handler=write;model.mockResolvedValueOnce({text:'',toolCalls:[{id:'first-output-write',name:'write_file',arguments:{path:a,content:'ALPHA_VALUE_927'}},{id:'second-output-write',name:'write_file',arguments:{path:b,content:'BETA_VALUE_928'}}]}).mockResolvedValue({text:reply('Both requested local outputs are saved.'),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);r.direct=finalizeLumiResponse({taskText:text,responseText:r.modelResult.text,completionGuard:r.modelResult.completionGuard,toolRecords:r.toolRecords,source:'isolated-terminal-boundary',flow:r.execution.turnIntent.flow,requestId:f.identity.requestId,taskId:r.taskId});recordObservation('writer-admission-two-outputs',f,r);expect(write).toHaveBeenCalledTimes(2);expect(fs.readFileSync(a,'utf8')).toBe('ALPHA_VALUE_927');expect(fs.readFileSync(b,'utf8')).toBe('BETA_VALUE_928');expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toContain(path.basename(a));expect(r.finalized.text).toContain(path.basename(b));expect(r.toolRecords.filter((x:any)=>x.name==='write_file'&&x.envelope?.status==='verified_success')).toHaveLength(2);
 // Each destination has its own current receipt; this composite has no readback shortcut.
 expect(write.mock.calls.map(([args,context])=>({path:args.path,content:args.content,requestId:context.requestId,taskId:context.taskId}))).toEqual([
  {path:a,content:'ALPHA_VALUE_927',requestId:f.identity.requestId,taskId:r.taskId},
  {path:b,content:'BETA_VALUE_928',requestId:f.identity.requestId,taskId:r.taskId},
 ]);
 expect(r.toolRecords.filter((x:any)=>x.name==='write_file').map((x:any)=>({path:x.arguments.path,requestId:x.requestId,taskId:x.taskId}))).toEqual([
  {path:a,requestId:f.identity.requestId,taskId:r.taskId},{path:b,requestId:f.identity.requestId,taskId:r.taskId},
 ]);
 expect(f.handler).not.toHaveBeenCalled();expect(model).toHaveBeenCalledTimes(2);expect(r.direct.blocked).toBe(false);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('completed');
 });
 it('writer admission: a new independently admitted request may overwrite its explicitly selected output',async()=>{
 const f=fixture(3);const output=path.join(path.dirname(f.filePath),'new-request-'+f.identity.requestId+'.txt');fs.writeFileSync(output,'PREVIOUS_REQUEST_VALUE');const content='NEW_CURRENT_REQUEST_VALUE_829';const text='在 '+output+' 新建文本文件，只写入“'+content+'”。';f.input.userText=text;f.input.planning.dispatch.text=text;const base=f.input.assemble;f.input.assemble=()=>{const data=base();data.model.context.actionIntent=text;data.model.context.routedTaskText=text;data.model.context.requestConfirmation=async()=>true;return data;};const writer:ToolDefinition=f.input.planning.registry.get('write_file')!;const write=vi.fn(writer.handler);writer.handler=write;model.mockResolvedValueOnce({text:'',toolCalls:[{id:'new-request-write',name:'write_file',arguments:{path:output,content}}]}).mockResolvedValue({text:reply('本次明确选择的文件已写入新原文。'),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('writer-admission-new-request',f,r);expect(write).toHaveBeenCalledTimes(1);expect(fs.readFileSync(output,'utf8')).toBe(content);expect(r.finalized.blocked).toBe(false);expect(model).toHaveBeenCalledTimes(1);
 });

 it('writer admission: a true current WPS save requirement with no save evidence remains incomplete',async()=>{
 const f=fixture(2);const text='请保存当前WPS文档，并确认已经在WPS中保存。';f.input.userText=text;f.input.planning.dispatch.text=text;const base=f.input.assemble;f.input.assemble=()=>{const data=base();data.model.context.actionIntent=text;data.model.context.routedTaskText=text;return data;};model.mockResolvedValueOnce({text:reply('I saved the current WPS document.'),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('actual-wps-save-no-proof',f,r);expect(r.execution.executionRequested).toBe(true);expect(r.finalized.blocked).toBe(true);expect(r.finalized.text).not.toContain('I saved the current WPS document.');expect(r.toolRecords).toHaveLength(0);
 // No tool candidate goes straight to the shared finalizer; there is no mandatory second model rewrite.
 expect(model).toHaveBeenCalledTimes(1);expect(f.handler).not.toHaveBeenCalled();expect(r.finalized.text.trim()).not.toBe('');
 // Task admission upgrades lazily only when a tool is selected; refusal must not persist fake completion.
 expect(r.taskId).toBeUndefined();expect(readDB().conversationActionTasks.filter((x:any)=>x.activeRequestId===f.identity.requestId)).toHaveLength(0);
 });
 it.each(['truncated-private','private-reference','incomplete-false-save','incomplete-false-video'] as const)('terminal early exit preserves neither private references nor false evidence claims: %s',async mode=>{
  const f=fixture(2);const privateCall='private-call-'+randomUUID();let answer=f.original;
  const partial=mode==='truncated-private';
  if(mode==='truncated-private'||mode==='private-reference')answer+='\nInternal reference: '+privateCall;
  if(mode==='incomplete-false-save')answer+='\nI saved the file to disk.';
  if(mode==='incomplete-false-video')answer+='\nThe requested video is generated.';
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:privateCall,name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValue({text:reply(answer),...(partial?{finishReason:'length'}:{}),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('terminal-early-'+mode,f,r);expect(r.finalized.blocked).toBe(true);expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(mode.startsWith('incomplete')?3:2);
  if(mode==='truncated-private'||mode==='private-reference')expect(r.finalized.text).not.toContain(privateCall);
  else expect(r.finalized.text).not.toContain(mode==='incomplete-false-save'?'I saved the file to disk.':'The requested video is generated.');
 });

 it('an actual canonical DOCX cannot satisfy a completed video goal from the primary report',async()=>{
  const f=fixture(3);const output=path.join(path.dirname(f.filePath),'wrong-video-'+f.identity.requestId+'.docx');const text='请立即生成一个15秒、720p、有原生音频的原创双机器人演唱视频。另创建 DOCX 文件 '+output+' 保存制作说明，不能用说明文档替代视频。';
  f.input.userText=text;f.input.planning.dispatch.text=text;registerDocumentTools(f.input.planning.registry);registerVideoTools(f.input.planning.registry);const original=f.input.planning.registry.get('create_docx')!;const docx=vi.fn(original.handler);original.handler=docx;const assemble=f.input.assemble;f.input.assemble=()=>{const data=assemble();data.model.context.actionIntent=text;data.model.context.routedTaskText=text;data.model.context.requestConfirmation=async()=>true;return data;};
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'wrong-docx-output',name:'create_docx',arguments:{title:'Wrong artifact',outputPath:output,content:'This is a document and contains no video or audio.'}}]}).mockResolvedValue({text:reply('The requested singing video is generated.'),toolCalls:[]});
  const r:any=await runLumiEntryTurn(f.input);recordObservation('video-goal-docx-mismatch',f,r);expect(docx).toHaveBeenCalledTimes(1);expect(fs.statSync(output).size).toBeGreaterThan(0);const record=r.toolRecords.find((x:any)=>x.id==='wrong-docx-output');expect(record?.envelope?.status).toBe('verified_success');expect(record?.capability?.capabilityId).toBe('office.docx.create');expect(r.finalized.blocked).toBe(true);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('blocked');expect(model).toHaveBeenCalledTimes(3);expect(r.finalized.text).not.toContain('The requested singing video is generated.');
 });

 it('retains the accurate saved file and the unfinished analysis without repeating the writer',async()=>{
  const f=fixture(3);const output=path.join(path.dirname(f.filePath),'partial-saved-'+f.identity.requestId+'.txt');const content='EXACT_SAVED_VALUE_946';const create='Create the file "'+output+'" with content "'+content+'".';const explain='Then explain the project risk using the supplied facts.';const text=create+' '+explain;
  f.input.userText=text;f.input.planning.dispatch.text=text;const base=f.input.assemble;f.input.assemble=()=>{const data=base();data.model.context.actionIntent=text;data.model.context.routedTaskText=text;data.model.context.requestConfirmation=async()=>true;return data;};const writer:ToolDefinition=f.input.planning.registry.get('write_file')!;const write=vi.fn(writer.handler);writer.handler=write;
  const answer='The local file is saved with '+content+'. The requested project risk explanation is not complete.';model.mockResolvedValueOnce({text:'',toolCalls:[{id:'partial-saved-write',name:'write_file',arguments:{path:output,content}}]}).mockResolvedValue({text:reply(answer),toolCalls:[]});const r:any=await runLumiEntryTurn(f.input);recordObservation('canonical-saved-plus-incomplete-analysis',f,r);
  expect(write).toHaveBeenCalledTimes(1);expect(fs.readFileSync(output,'utf8')).toBe(content);expect(r.toolRecords.filter((x:any)=>x.name==='write_file'&&x.envelope?.status==='verified_success')).toHaveLength(1);expect(r.finalized.text).toContain(answer);expect(r.finalized.text).toContain('requested project risk explanation is not complete');expect(r.finalized.blocked).toBe(true);expect(readDB().conversationActionTasks.find((x:any)=>x.id===r.taskId)?.status).toBe('blocked');expect(model).toHaveBeenCalledTimes(2);
 });
});
