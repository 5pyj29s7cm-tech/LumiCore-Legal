import React from 'react';
import {describe,expect,it,vi} from 'vitest';
const {marker}=vi.hoisted(()=>({marker:()=>null}));
vi.mock('../src/components/desktop/widget',()=>({LumiCoreAvatar:()=>null}));
vi.mock('motion/react',()=>({motion:new Proxy({}, {get:(_target,key)=>String(key)}),AnimatePresence:'div'}));
vi.mock('../src/components/VoicePicker',()=>({VoicePicker:()=>null}));
vi.mock('../src/components/DesktopShellAuxiliary',()=>({MeetingModeButton:marker}));
vi.mock('../src/components/SpriteAnimator',()=>({PetAvatar:()=>null}));
vi.mock('../src/components/biometrics/PresenceIndicator',()=>({PresenceIndicator:()=>null}));
import {renderDesktopCoreStage} from '../src/components/desktop/core_stage_view';
const source={renderDesktopCoreStage};
function meetingButton(input: any, pet: boolean) {
  const props = {t:{},lang:'en',selectedPet:pet?{name:'Synthetic pet'}:null,equippedAccessories:[],petReaction:null,facePresenceRequested:false,
    faceRecognition:{hasTemplates:false,result:{facePresent:false}},presence:{},voiceprint:{result:{}},wakeEnabled:false,wakeWord:{},
    callState:'idle',meetingPaused:true,operationMode:'meeting',meetingNotesOpen:false,openMeetingModeWithConfirm:vi.fn(),...input};
  const nodes:any[]=[];
  const visit=(node:any)=>{if(!React.isValidElement(node))return; const p:any=node.props;if(node.type===marker)nodes.push(p);React.Children.forEach(p.children,visit);};
  visit(source.renderDesktopCoreStage(props)); expect(nodes).toHaveLength(1); return nodes[0];
}
describe.each([false,true])('meeting indicator pet=%s', pet => {
  it.each([
    [{},false,false],
    [{operationMode:'assistant'},false,false],
    [{meetingNotesOpen:true},true,false],
    [{meetingPaused:false,callState:'connecting'},false,false],
    [{meetingPaused:false,callState:'idle'},false,false],
    [{meetingPaused:false,callState:'listening'},true,true],
    [{meetingPaused:true,callState:'listening'},false,false],
    [{operationMode:'assistant',callState:'speaking'},false,false],
  ])('uses the open surface and actual capture, not stale mode: %j', (input,active,live)=>{
    const button=meetingButton(input,pet);expect(button.active).toBe(active);expect(button.live).toBe(live);
  });
});
