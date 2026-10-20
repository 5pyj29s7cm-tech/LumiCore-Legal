import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { createOrg, addMember } from '../server/org/db';
import { createOrganizationPosition, createOrganizationWorkRoutingRule, listOrganizationWorkItems } from '../server/org/work_routing';
import { createBindingCode, authorizeMessagingGroup } from '../server/messaging/bindings';
import { consumeFixtureBindingCode } from './messaging_binding_fixture';
import { processWithPersonality } from '../server/regions/packs/cn/messaging_routes';
import type { IncomingMessage } from '../server/messaging/types';
import { observedMessagingOptions } from './organization_model_observer_fixture';
import * as modelExecution from '../server/regions/packs/cn/messaging_turn/model_execution';
import { withRemoteOrganizationAction } from '../server/regions/packs/cn/remote_org_commands';
import { closeConversation } from '../server/conversation/manager';
import { conversationForMessagingTurn } from '../server/regions/packs/cn/messaging_persistence';
let orgId='';const owner='rule-owner',memberA='rule-a',memberB='rule-b';let seq=0,modelCalls=0;
const noModel={llmGetters:{getDeepSeek:()=>{modelCalls++;throw new Error('No model expected');},getGemini:()=>{modelCalls++;throw new Error('No model expected');}}};
function incoming(text:string,mentionedUserIds:string[]=[]):IncomingMessage{return{platform:'feishu',userId:'ou-'+memberA,userName:'Synthetic A',chatId:'oc-rule',chatType:'group',botMentioned:true,mentionedUserIds,messageId:'rule-'+(++seq),text,boundUserId:memberA,boundOrgId:orgId,raw:{},timestamp:new Date().toISOString()};}
beforeAll(async()=>{await initDatabase();orgId=createOrg('Synthetic rule organization','synthetic-rule',owner).id;for(const user of [owner,memberA,memberB]){addMember(orgId,user,user===owner?'owner':'member');const code=createBindingCode('feishu',user,orgId,'work');expect(consumeFixtureBindingCode('feishu',code.code,'ou-'+user,'private-'+user,'private')).toBeTruthy();}authorizeMessagingGroup({platform:'feishu',chatId:'oc-rule',orgId,createdBy:owner,allowedPlatformUserIds:[owner,memberA,memberB].map(user=>'ou-'+user)});const position=createOrganizationPosition({orgId,actorUserId:owner,name:'Synthetic contract reviewers',memberIds:[memberA,memberB],skillTags:['contract-review']});createOrganizationWorkRoutingRule({orgId,actorUserId:owner,name:'Synthetic exact keyword route',priority:100,keywords:['contract-review'],platforms:['feishu'],positionId:position.id,approvalMode:'none'});});
let selectedRuleAdapterEntries=0;
afterEach(()=>expect(selectedRuleAdapterEntries).toBe(0));
async function admittedSelectedRuleTurn(input:IncomingMessage,options:NonNullable<Parameters<typeof processWithPersonality>[1]>):Promise<string>{
 const intercepted=vi.spyOn(modelExecution,'prepareMessagingModelTurn').mockImplementationOnce(async context=>{
  try {
   await withRemoteOrganizationAction(context.msg, context.remoteToolContext, 'observe', { action: 'synthetic_contract_review' }, async()=>{
    selectedRuleAdapterEntries++;
    throw new Error('Assigned human ownership must prevent this synthetic adapter.');
   });
  } catch(error) {
   if(!context.organizationAdmissionBlocker)throw error;
  }
  if(!context.organizationAdmissionBlocker)throw new Error('The existing organization admission owner did not produce its human/approval boundary.');
  return{terminal:context.organizationAdmissionBlocker,data:undefined,deliver:undefined};
 });
 try{return await processWithPersonality(input,options);}finally{
  intercepted.mockRestore();
  // The unit fixture inspects only the real admission boundary, never whole-request success.
  const conversation=conversationForMessagingTurn(input);
  if(conversation)closeConversation(conversation.id,'Selected admission unit fixture finished.',input.boundUserId);
 }
}
describe('server-owned organization routing admission',()=>{
 it('applies a configured English routing rule without a callback or model task classification',async()=>{const msg=incoming('Please complete contract-review for the organization.');const reply=await admittedSelectedRuleTurn(msg,noModel);expect(reply).toContain('任务已交给组织成员');const item=listOrganizationWorkItems(orgId).find(item=>item.requestId==='feishu_bot:'+msg.messageId)!;expect(item).toMatchObject({status:'waiting_human',assignedMemberId:memberA});expect(modelCalls).toBe(0);});
 it('uses exact active member mentions without an English intent rule or callback',async()=>{const msg=incoming('Please handle the document with these members.',['ou-'+memberB,'ou-'+owner,'ou-unbound-outsider']);const reply=await admittedSelectedRuleTurn(msg,noModel);expect(reply).toContain(memberB);const item=listOrganizationWorkItems(orgId).find(item=>item.requestId==='feishu_bot:'+msg.messageId)!;expect(item).toMatchObject({status:'waiting_human',assignedMemberId:memberB});expect(item.collaboratorMemberIds).toContain(owner);expect(item.collaboratorMemberIds).not.toContain('ou-unbound-outsider');expect(modelCalls).toBe(0);});
 it('does not turn ordinary conversation with a callback into an organization action',async()=>{const msg=incoming('Hello');const reply=await processWithPersonality(msg,observedMessagingOptions({onMessage:async()=>({platform:'feishu',text:'Hello synthetic member.'})}));expect(reply).toContain('Hello');expect(listOrganizationWorkItems(orgId).some(item=>item.requestId==='feishu_bot:'+msg.messageId)).toBe(false);expect(readDB().conversationActionTasks.some((task:any)=>task.requestId==='feishu_bot:'+msg.messageId)).toBe(false);});
 it('keeps an explicit explanation of a routing keyword out of the action ledger',async()=>{const msg=incoming('请只解释 contract-review 的意思，不要执行任何操作');const reply=await processWithPersonality(msg,observedMessagingOptions({onMessage:async()=>({platform:'feishu',text:'This is a synthetic explanation.'})}));expect(reply).toContain('explanation');expect(listOrganizationWorkItems(orgId).some(item=>item.requestId==='feishu_bot:'+msg.messageId)).toBe(false);});
});
