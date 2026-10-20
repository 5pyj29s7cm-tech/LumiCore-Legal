import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({verify:vi.fn(()=>({status:'verified',message:'Prepared'}))}));
vi.mock('../server/client/self_model',()=>({getClientState:()=>null,getClientStateDigest:()=>null,getClientActionExpectation:()=>({target:'meeting'}),verifyClientActionResult:state.verify}));
vi.mock('../server/tools/definitions/client_self_shared',()=>({ACTIONS:['start_meeting_mode'],ACTIONS_WITH_INTERNAL_REFRESH:new Set(['start_meeting_mode']),delay:async()=>{},parseRelayOutput:(text:string)=>JSON.parse(text),waitForClientStateAfter:async()=>null}));
import {ToolRegistry} from '../server/tools/registry';
import {registerClientActionTools} from '../server/tools/definitions/client_action_tools';
it('forwards the selected case ID and title through the real chat client-action handler',async()=>{
 const registry=new ToolRegistry();registerClientActionTools(registry);const relay=vi.fn(async()=>JSON.stringify({ok:true,status:'ready'}));
 const tool=registry.get('client_action')!;await tool.handler({action:'start_meeting_mode',legalCaseId:'known-case-A',legalCaseTitle:'Case A'}, {userId:'synthetic-owner',userConfirmed:true,desktopRelay:relay} as any);
 expect(relay).toHaveBeenCalledWith('client_action',expect.objectContaining({action:'start_meeting_mode',legalCaseId:'known-case-A',legalCaseTitle:'Case A',confirmed:true}));
 expect(state.verify).toHaveBeenCalled();
});
