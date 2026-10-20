import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { createOrg, addMember } from '../server/org/db';
import { processWithPersonality } from '../server/regions/packs/cn/messaging_routes';
import { encodeToolResult } from '../server/tools/result_envelope';
const mocked=vi.hoisted(()=>({result:''}));
vi.mock('../server/regions/packs/cn/legal_notice_intake',async original=>({...await original<typeof import('../server/regions/packs/cn/legal_notice_intake')>(),handleRemoteLegalNoticeIntake:async()=>null}));
vi.mock('../server/regions/packs/cn/remote_org_commands',async original=>({...await original<typeof import('../server/regions/packs/cn/remote_org_commands')>(),handleRemoteOrgCommand:async()=>mocked.result}));
let orgId='';const owner='result-projection-owner';let sequence=0;
beforeAll(async()=>{await initDatabase();orgId=createOrg('Synthetic result organization','synthetic-result',owner).id;addMember(orgId,owner,'owner');});
describe('structured organization result delivery',()=>{
 it.each([{name:'unknown legacy reply',reply:'Synthetic message with no completion receipt',verified:false},{name:'blocked business result',reply:encodeToolResult('Source material could not be archived.',{ok:false,verified:false,status:'blocked'}),verified:false},{name:'completed local query',reply:encodeToolResult('The synthetic local query returned its stored result.',{ok:true,verified:true,status:'completed'}),verified:true}])('projects $name without forging successful receipts or leaking protocol',async sample=>{
  mocked.result=sample.reply;const messageId='result-projection-'+(++sequence);const result=await processWithPersonality({platform:'feishu',userId:'ou-'+owner,userName:'Synthetic owner',chatId:'private-'+messageId,chatType:'private',messageId,text:'查询组织知识库 Synthetic',boundUserId:owner,boundOrgId:orgId,raw:{},timestamp:new Date().toISOString()},{llmGetters:{getDeepSeek:()=>{throw new Error('No paid model');},getGemini:()=>{throw new Error('No paid model');}}});
  const receipts=readDB().conversationActionReceipts.filter((receipt:any)=>receipt.externalMessageId===messageId&&receipt.toolName==='organization_business_command');expect(receipts).toHaveLength(1);expect(receipts[0].outcome==='verified_success').toBe(sample.verified);expect(result).not.toMatch(/LUMI_TOOL_RECEIPT|organization_business_command|"verified"|"status"/);
 });
});
