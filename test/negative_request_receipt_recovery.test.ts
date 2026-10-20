import './helpers';
import {randomUUID} from 'node:crypto';
import {beforeAll,describe,expect,it} from 'vitest';
import {initDatabase,closeDatabase,readDatabaseTables,commitDatabaseTables} from '../db_layer';
import {acceptConversationActionTurn,bindConversationActionTurnTask} from '../server/conversation/action_turn_ledger';
import {getOrCreateActiveConversation,addMessageIdempotent} from '../server/conversation/manager';
import {normalizeConversationActionState} from '../server/cognition/action_continuation';
import {taskCompletionFromReceipts} from '../server/cognition/task_execution_ledger';
import {inspectPersistedToolExecutionReceipt} from '../server/tools/persisted_execution_receipt';
import {syncConversationActionTaskLedger,finalizeConversationActionTask} from '../server/conversation/ledger/task_lifecycle';
import {repairContradictoryConversationActionReceipts} from '../server/conversation/ledger/recovery';
const tables=['conversations','interactions','conversationActionTasks','conversationActionReceipts','conversationActionTurns'] as const;
const session=()=>readDatabaseTables([...tables]);
const goal='进入壁纸模式';
const result=JSON.stringify({ok:true,action:'set_wallpaper_mode',verification:{status:'verified',matched:['surface:wallpaper:open']},health:{failed:0}});
const task=(db:any,id:string)=>db.conversationActionTasks.find((value:any)=>value.id===id);
const state=(row:any)=>normalizeConversationActionState(JSON.parse(row.context).actionState)!;
async function reopen(){await closeDatabase();await initDatabase();return {db:session()};}
function bind(scope:any,requestId=scope.requestId){
  const userMessageId=addMessageIdempotent({userId:scope.userId,agentId:'lumi',conversationId:scope.conversationId,role:'user',content:goal,requestId,deferActionPreparation:true,domain:'personal',source:'test',channel:'voice'});
  (scope.messageIds ||= {})[requestId]=userMessageId;
  expect(acceptConversationActionTurn({conversationId:scope.conversationId,userId:scope.userId,requestId,userMessageId,domain:'personal',source:'test',channel:'voice'}).accepted).toBe(true);
  expect(bindConversationActionTurnTask({conversationId:scope.conversationId,userId:scope.userId,requestId,taskId:scope.taskId}).bound).toBe(true);
}
function contradictory(scope:any,requestId=scope.requestId){return{id:'receipt-'+requestId,idempotencyKey:'idem-'+requestId,key:'client_action:'+JSON.stringify({action:'set_wallpaper_mode',enabled:true}),name:'client_action',arguments:{action:'set_wallpaper_mode',enabled:true},result,error:result,outcome:'failure' as const,terminalVerification:{status:'verified' as const,strategy:'state_diff' as const,reason:'Verified post-action state with historical failed-zero contradiction.'},taskId:scope.taskId,requestId,turnId:scope.messageIds[requestId],recordedAt:new Date().toISOString()};}
async function seed(outcome?:'blocked'|'cancelled'|'failed'|'persistence_unknown'){
  const nonce=randomUUID();const userId='synthetic-user-'+nonce;const created=getOrCreateActiveConversation(userId,'lumi','personal','');const scope={conversationId:created.id,userId,taskId:'task-'+nonce,requestId:'request-'+nonce,messageIds:{} as Record<string,string>};
  bind(scope);let db=session();const conversation:any=db.conversations.find((v:any)=>v.id===scope.conversationId)!;
  const initial=normalizeConversationActionState({version:2,taskId:scope.taskId,status:'blocked',receipts:[contradictory(scope)],revision:1,goal,latestInstruction:goal,appTarget:'',sourcePaths:[],latestBlocker:'Historical tool envelope was marked failed.',unfinished:true,evidenceTools:[],assistantState:'',toolSummaries:[],activeRequestId:scope.requestId,updatedAt:new Date().toISOString()})!;
  conversation.actionContinuationState=initial;syncConversationActionTaskLedger(db,{conversation,state:initial,currentUserMessageId:scope.messageIds[scope.requestId]});commitDatabaseTables(db);bind(scope);
  if(outcome){db=session();const conv=db.conversations.find((v:any)=>v.id===scope.conversationId)!;const done=finalizeConversationActionTask(db,{conversation:conv,state:state(task(db,scope.taskId)),outcome,requestId:scope.requestId,blocker:'Explicit '+outcome+' for current request.'});expect(done).not.toBeNull();commitDatabaseTables(db)}
  db=(await reopen()).db;const row=db.conversationActionReceipts.find((v:any)=>v.taskId===scope.taskId);expect(row.outcome).toBe('failed');expect(inspectPersistedToolExecutionReceipt(row)).toMatchObject({valid:true,explicitlyTerminalVerified:true});
  return scope;
}
async function repairAndRead(){const db=session();const count=repairContradictoryConversationActionReceipts(db);commitDatabaseTables(db);return{db:(await reopen()).db,count};}
beforeAll(async()=>{await initDatabase()});
describe.sequential('real SQLite recovery preserves exact-request negative finalization',()=>{
  it.each(['blocked','cancelled','failed','persistence_unknown'] as const)('repairs only the historical step row and preserves explicit %s across close/reopen',async outcome=>{
    const scope=await seed(outcome);let db=session();const before=structuredClone(task(db,scope.taskId));const context=JSON.parse(before.context);expect(context.taskFinalization).toMatchObject({outcome,requestId:scope.requestId});
    const repaired=await repairAndRead();db=repaired.db;expect(repaired.count).toBeGreaterThanOrEqual(1);const after=task(db,scope.taskId);expect(db.conversationActionReceipts.find((v:any)=>v.taskId===scope.taskId).outcome).toBe('verified_success');
    expect(after.status).toBe(outcome==='persistence_unknown'?'blocked':outcome);expect(after.completionSource).toBe('');expect(after.completedAt).toBe(before.completedAt);
    expect(JSON.parse(after.context).taskFinalization).toEqual(context.taskFinalization);
    expect(state(after).completionSource).toBeUndefined();expect(state(after).unfinished).toBe(outcome==='blocked'||outcome==='persistence_unknown');
    if(outcome==='blocked'||outcome==='persistence_unknown')expect(after.blocker).toBe(before.blocker);
    if(outcome==='persistence_unknown'){expect(JSON.parse(after.context).terminalPersistence).toEqual(context.terminalPersistence);expect(state(after).terminalPersistence).toEqual(state(before).terminalPersistence)}
  });
  it('keeps the legacy no-finalization failed-zero correction completed',async()=>{
    const scope=await seed();const {db}=await repairAndRead();const row=task(db,scope.taskId);
    expect(row).toMatchObject({status:'completed',blocker:'',completionSource:'tool_receipt'});expect(state(row).unfinished).toBe(false);expect(JSON.parse(row.context).taskFinalization).toBeUndefined();
  });
  it('does not let the old blocked request repaired receipt complete a newer active request',async()=>{
    const scope=await seed('blocked');const nextRequest='next-'+scope.requestId;bind(scope,nextRequest);let db=session();const conversation=db.conversations.find((v:any)=>v.id===scope.conversationId)!;
    const resumed=normalizeConversationActionState({...state(task(db,scope.taskId)),status:'executing',unfinished:true,activeRequestId:nextRequest,latestBlocker:'',revision:5,updatedAt:new Date().toISOString()})!;
    syncConversationActionTaskLedger(db,{conversation,state:resumed,currentUserMessageId:scope.messageIds[nextRequest]});commitDatabaseTables(db);
    db=(await repairAndRead()).db;expect(task(db,scope.taskId)).toMatchObject({status:'executing',activeRequestId:nextRequest,completionSource:'',completedAt:''});expect(state(task(db,scope.taskId)).unfinished).toBe(true);
  });
  it('does not make an old negative marker a permanent lock on a different request legacy inference',async()=>{
    const scope=await seed('blocked');await repairAndRead();const nextRequest='fresh-'+scope.requestId;bind(scope,nextRequest);let db=session();const conversation=db.conversations.find((v:any)=>v.id===scope.conversationId)!;
    const resumed=normalizeConversationActionState({...state(task(db,scope.taskId)),status:'executing',unfinished:true,activeRequestId:nextRequest,latestBlocker:'',receipts:[contradictory(scope,nextRequest)],revision:7,updatedAt:new Date().toISOString()})!;
    syncConversationActionTaskLedger(db,{conversation,state:resumed,currentUserMessageId:scope.messageIds[nextRequest]});commitDatabaseTables(db);db=(await reopen()).db;expect(JSON.parse(task(db,scope.taskId).context).taskFinalization.requestId).toBe(scope.requestId);
    db=(await repairAndRead()).db;expect(task(db,scope.taskId)).toMatchObject({status:'completed',completionSource:'tool_receipt'});expect(db.conversationActionReceipts.find((v:any)=>v.taskId===scope.taskId&&v.requestId===nextRequest).outcome).toBe('verified_success');
  });
  it('permits a real new-request foreground completed finalization to supersede the old blocked marker',async()=>{
    const scope=await seed('blocked');await repairAndRead();const nextRequest='final-'+scope.requestId;bind(scope,nextRequest);let db=session();const conversation=db.conversations.find((v:any)=>v.id===scope.conversationId)!;
    const resumed=normalizeConversationActionState({...state(task(db,scope.taskId)),status:'executing',unfinished:true,activeRequestId:nextRequest,latestBlocker:'',receipts:[{...contradictory(scope,nextRequest),outcome:'success',error:''}],revision:8,updatedAt:new Date().toISOString()})!;
    syncConversationActionTaskLedger(db,{conversation,state:resumed,currentUserMessageId:scope.messageIds[nextRequest]});expect(finalizeConversationActionTask(db,{conversation,state:resumed,outcome:'completed',requestId:nextRequest,completionSource:'tool_receipt'})).not.toBeNull();commitDatabaseTables(db);
    db=(await repairAndRead()).db;expect(task(db,scope.taskId).status).toBe('completed');expect(JSON.parse(task(db,scope.taskId).context).taskFinalization).toMatchObject({outcome:'completed',requestId:nextRequest});
  });
});
