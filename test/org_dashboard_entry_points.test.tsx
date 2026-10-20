// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrgHub } from '../src/components/org/OrgHub';
const fixture = vi.hoisted(() => ({role:'owner',api:vi.fn()}));
vi.mock('../src/contexts/AppContext',()=>({useApp:()=>({user:{uid:'dashboard-user',role:'user'},workDomain:'work',switchDomain:vi.fn(),orgConnection:{connected:true,orgId:'dashboard-org',orgName:'Test organization',orgRole:fixture.role}})}));
vi.mock('../src/lib/useT',()=>({useT:()=>({langCode:'en',back:'Back',backToKB:'Back to KB',orgDashboard:'Dashboard',orgKB:'Knowledge base',orgMembers:'Members',messaging:'Message connections',orgAudit:'Audit log',orgSettings:'Organization settings',orgWorkSpace:'Organization',orgWorkDomain:'Work',orgRoleOwner:'Owner',orgRoleAdmin:'Administrator',orgRoleMember:'Member',orgRoleViewer:'Viewer',legalContractReview:'Contract review',legalVerifyCitation:'Citation verification'})}));
vi.mock('../src/services/apiClient',()=>({apiJson:(...args:any[])=>fixture.api(...args)}));
vi.mock('../src/components/org/KnowledgeBaseBrowser',()=>({KnowledgeBaseBrowser:()=> <h1>Knowledge destination</h1>}));
vi.mock('../src/components/org/KnowledgeBaseEditor',()=>({KnowledgeBaseEditor:()=> <h1>Knowledge editor</h1>}));
vi.mock('../src/components/org/LegalHub',()=>({LegalHub:()=> <h1>Legal destination</h1>}));
vi.mock('../src/components/MessagingHub',()=>({MessagingHub:()=> <h1>Messaging destination</h1>}));
vi.mock('../src/components/org/OrgMembers',()=>({OrgMembers:()=> <h1>Members destination</h1>}));
vi.mock('../src/components/org/AuditLogViewer',()=>({AuditLogViewer:()=> <h1>Audit destination</h1>}));
vi.mock('../src/components/org/OrganizationSettingsWorkspace',()=>({OrganizationSettingsWorkspace:()=> <h1>Settings destination</h1>}));
beforeEach(()=>{sessionStorage.clear();fixture.role='owner';fixture.api.mockImplementation(async(url:string)=>url==='/api/org/status'?{connected:true,orgId:'dashboard-org'}:[]);});
afterEach(()=>{cleanup();vi.clearAllMocks();});
const entries=[
 ['kb','Browse, search, and maintain organization knowledge.','Knowledge destination'],
 ['messaging','Connect team message channels and manage message routing.','Messaging destination'],
 ['members','Review members, roles, and access boundaries.','Members destination'],
 ['audit','Inspect organization operations and security records.','Audit destination'],
 ['settings','Manage organization settings and branch connections.','Settings destination'],
];
it.each([['owner',['kb','messaging','members','audit','settings']],['admin',['kb','messaging','members','audit','settings']],['member',['kb','messaging','settings']],['viewer',['kb','settings']]])('opens authorized homepage entries through the existing workspace for %s',async(role,allowed)=>{
 fixture.role=role as string;const events:any[]=[],listener=(e:Event)=>events.push((e as CustomEvent).detail);window.addEventListener('lumi:navigate',listener);
 try{render(<OrgHub/>);await screen.findByRole('heading',{name:'Organization workspace'});
  const nav=within(screen.getByRole('navigation'));for(const name of ['Message connections','Audit log','Organization settings'])expect(nav.queryByRole('button',{name})).toBeNull();expect(nav.getByRole('button',{name:'Case workspace'})).toBeTruthy();
  for(const [view,description,destination]of entries){
   if(!(allowed as string[]).includes(view)){expect(screen.queryByText(description)).toBeNull();continue;}
   const card=screen.getByText(description).closest('button')!;fireEvent.click(card);await screen.findByRole('heading',{name:destination});expect(events.at(-1)).toEqual({tab:'org',sub:view});
   fireEvent.click(screen.getByRole('button',{name:'Back Dashboard'}));await screen.findByRole('heading',{name:'Organization workspace'});expect(screen.queryByRole('button',{name:'Back Dashboard'})).toBeNull();
  }
  expect(screen.queryByText('Organization LumiCore')).toBeNull();
 }finally{window.removeEventListener('lumi:navigate',listener);}
});

it('returns knowledge editing to its list before returning home, and leaves legal tools through the same context button',async()=>{
 render(<OrgHub/>);await screen.findByRole('heading',{name:'Organization workspace'});
 fireEvent.click(screen.getByRole('button',{name:'Case workspace'}));await screen.findByRole('heading',{name:'Legal destination'});
 fireEvent.click(screen.getByRole('button',{name:'Back Dashboard'}));await screen.findByRole('heading',{name:'Organization workspace'});
 fireEvent.click(screen.getByText(entries[0][1]).closest('button')!);await screen.findByRole('heading',{name:'Knowledge destination'});
 window.dispatchEvent(new CustomEvent('lumi:navigate',{detail:{tab:'org',sub:'kb-edit',articleId:'example'}}));await screen.findByRole('heading',{name:'Knowledge editor'});
 fireEvent.click(screen.getByRole('button',{name:'Back to KB'}));await screen.findByRole('heading',{name:'Knowledge destination'});
 fireEvent.click(screen.getByRole('button',{name:'Back Dashboard'}));await screen.findByRole('heading',{name:'Organization workspace'});
});
