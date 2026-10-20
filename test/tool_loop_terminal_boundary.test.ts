import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => vi.fn());
vi.mock('../server/llm/providers', async original => ({...await original<any>(), makeLLMCall: model, makeLLMCallStreaming: model}));
import { initDatabase, readDB } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { runLumiEntryTurn } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
beforeAll(()=>initDatabase());
beforeEach(()=>{model.mockReset();vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('OUTSIDE_FIXTURE_NETWORK_FORBIDDEN'));});
function fixture(iterations: number){
 const userId='outside-terminal-'+randomUUID();
 const conversationId=getOrCreateActiveConversation(userId,'lumi','personal','').id;
 const requestId=randomUUID();
 const filePath=path.join(String(process.env.LUMI_DATA_DIR),'source-'+requestId+'.txt');
 const original='ISOLATED_SOURCE_CONTENT\nSOURCE_TAIL_86751';fs.writeFileSync(filePath,original);
 const text='Read the file '+filePath+' and show its complete contents.';
 const registry=new ToolRegistry();registerFileOpsTools(registry);
 const read=registry.get('read_file')!; const handler=vi.fn(read.handler);read.handler=handler;
 const identity={userId,conversationId,requestId,agentId:'lumi',domain:'personal' as const,orgId:''};
 const input:any={entry:{source:'isolated-terminal-boundary',channel:'chat',historyLimit:10,failureText:'The request did not finish.',failureReason:'isolated'},identity,userText:text,authorization:captureRequestAuthorization(()=>true,'Revoked'),controller:new AbortController(),planning:{dispatch:{...identity,text,source:'isolated-terminal-boundary',channel:'chat',operationMode:'assistant',targetIsLumi:true},registry,personalityToolPolicy:{allowedTools:['*'],forbiddenTools:[],requireConfirmation:[],maxIterations:iterations},executionBoundary:'trusted_local'},assemble:()=>({systemPrompt:'Use the actual source.',model:{registry,config:{provider:'deepseek',model:'isolated-no-network',userId,requestId},getters:{},maxIterations:iterations,context:{authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',actionIntent:text,routedTaskText:text}}}),deliver:r=>r};
 return {input,identity,filePath,original,handler};
}
describe('tool-loop terminal boundary with real driver and isolated database',()=>{
 it('the existing per-step archive already preserves the active task until the main model ends',async()=>{
  const f=fixture(2);let release!:()=>void;const held=new Promise<void>(done=>release=done);
  model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-held',name:'read_file',arguments:{path:f.filePath}}]}).mockImplementationOnce(async()=>{await held;return {text:f.original,toolCalls:[]};});
  const pending=runLumiEntryTurn(f.input);
  try{await vi.waitFor(()=>expect(model).toHaveBeenCalledTimes(2));
   const row=readDB().conversationActionTasks.find((t:any)=>t.conversationId===f.identity.conversationId)!;
   expect(row.status).not.toBe('completed');expect(row.activeRequestId).toBe(f.identity.requestId);
   expect(readDB().conversationActionReceipts.some((r:any)=>r.requestId===f.identity.requestId&&r.outcome==='verified_success')).toBe(true);
  }finally{release();}
  const r:any=await pending;expect(r.finalized.blocked).toBe(false);expect(f.handler).toHaveBeenCalledTimes(1);
 });
 it('iteration exhaustion preserves a verified step but does not declare whole-task completion',async()=>{
  const f=fixture(1);model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-once',name:'read_file',arguments:{path:f.filePath}}]});
  const r:any=await runLumiEntryTurn(f.input);
  expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(1);
  expect(r.toolRecords[0].envelope.status).toBe('verified_success');
  expect(r.modelResult.completionGuard?.blocked).toBe(true);expect(r.finalized.blocked).toBe(true);
  const row=readDB().conversationActionTasks.find((t:any)=>t.id===r.taskId)!;expect(row.status).toBe('blocked');expect(JSON.parse(row.context).actionState.unfinished).toBe(true);
  expect(row.activeRequestId).toBe('');expect(fs.readFileSync(f.filePath,'utf8')).toBe(f.original);
 });
 it('a normal main-model terminal answer after the verified read still completes exactly once',async()=>{
  const f=fixture(2);model.mockResolvedValueOnce({text:'',toolCalls:[{id:'read-normal',name:'read_file',arguments:{path:f.filePath}}]}).mockResolvedValueOnce({text:f.original,toolCalls:[]});
  const r:any=await runLumiEntryTurn(f.input);expect(f.handler).toHaveBeenCalledTimes(1);expect(model).toHaveBeenCalledTimes(2);expect(r.finalized.blocked).toBe(false);expect(r.finalized.text).toContain('SOURCE_TAIL_86751');
  expect(readDB().conversationActionTasks.find((t:any)=>t.id===r.taskId)?.status).toBe('completed');
 });
});
