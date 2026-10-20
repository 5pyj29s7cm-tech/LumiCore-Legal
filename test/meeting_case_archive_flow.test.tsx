// @vitest-environment jsdom
import React, { useRef, useState } from 'react';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { makeApp, JWT_SECRET } from './helpers';
import { extractSourceExpression } from './source_expression';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { mountOrgRoutes } from '../server/org/routes';
import { makeLLMCall } from '../server/llm/providers';
import { createOrg, addMember } from '../server/org/db';
import { createCase, getCase, legalWorkspaceNamespace } from '../server/org/legal_cases';
import { isLegalSourceMaterial } from '../shared/legal_workflow_receipts';
import { useMeetingTranscript } from '../src/components/desktop/useMeetingTranscript';
import { useMeetingWorkflow } from '../src/components/desktop/useMeetingWorkflow';
import { createEmptyLegalCase, getActiveLegalCaseId, getLegalCaseById, writeLegalCaseFiles, setLegalCaseAccount, type LegalCaseFile } from '../src/lib/legalCaseStore';
import { desktopWorkflowCopy } from '../src/i18n/locales/desktopWorkflows';
import { uiMessage } from '../src/i18n/uiMessages';
const mock = vi.hoisted(() => ({ toast: {success:vi.fn(),error:vi.fn(),info:vi.fn()} }));
vi.mock('sonner',()=>({toast:mock.toast}));
vi.mock('../server/llm/providers',async original=>({...await original<typeof import('../server/llm/providers')>(),makeLLMCall:vi.fn()}));
// This adapter only supplies the isolated app origin/auth; every success and body comes from real routes.
vi.mock('../src/services/apiClient',()=>({apiJson:async(url:string,init?:RequestInit)=>{const response=await fetch(url,init);const data=await response.json();if(!response.ok)throw new Error(data.error||'HTTP '+response.status);return data;}}));
const nativeFetch=globalThis.fetch;
let app:Awaited<ReturnType<typeof makeApp>>;
const owner='synthetic-meeting-flow-owner';
let token='',orgId='';
const requests:Array<{path:string;body:any;status:number;data:any}>=[];
let holdArchive:Promise<void>|null=null;
let archiveReceived:(()=>void)|null=null;
const report='Fixed simulated report for lawyer review. Payment remains unverified; internal reminder is not a court deadline.';
const notes=[{id:'raw-1',text:'Synthetic party A: payment screenshot is unverified.',time:1791960000000,speakerLabel:'Party A'},{id:'raw-tail',text:'Synthetic party B: deadline evidence has not been provided. COMPLETE_RAW_TAIL',time:1791960001000,speakerLabel:'Party B'}];
const keys=(scope:string)=>({identity:'integration-audio-'+scope,notes:'integration-notes-'+scope,report:'integration-report-'+scope,startedAt:'integration-start-'+scope});
const unavailable=()=>null;
beforeAll(async()=>{app=await makeApp();mountChatRoutes(app.apiRouter,JWT_SECRET,{getDeepSeek:unavailable,getGemini:unavailable,getOpenAI:unavailable,getAnthropic:unavailable,getQwen:unavailable});mountOrgRoutes(app.apiRouter);const org=createOrg('Synthetic meeting flow organization','synthetic-meeting-flow-org',owner);orgId=org.id;addMember(orgId,owner,'owner');});
afterAll(()=>app.cleanup());
beforeEach(()=>{localStorage.clear();setLegalCaseAccount(owner);vi.clearAllMocks();holdArchive=null;archiveReceived=null;requests.length=0;token=jwt.sign({uid:owner,username:owner,role:'admin'},JWT_SECRET);vi.mocked(makeLLMCall).mockResolvedValue({text:report,toolCalls:[],finishReason:'stop'} as any);
  vi.stubGlobal('fetch',async(url:string|URL|Request,init?:RequestInit)=>{const path=typeof url==='string'?url:String(url);const headers=new Headers(init?.headers);headers.set('Authorization','Bearer '+token);const response=await nativeFetch(path.startsWith('http')?path:app.url+path,{...init,headers});const data=await response.clone().json().catch(()=>null);requests.push({path:new URL(path,app.url).pathname,body:typeof init?.body==='string'?JSON.parse(init.body):undefined,status:response.status,data});if(path.endsWith('/meeting/archive')){archiveReceived?.();if(holdArchive)await holdArchive;}return response;});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function useFlow(scope:string,domain:'personal'|'work') {
  const [mode,setMode]=useState<any>('assistant');const [pending,setPending]=useState<any>(null);const start=useRef(0);
  const transcript=useMeetingTranscript({workDomain:domain,meetingStorageKeys:keys(scope),meetingPreferenceScopeKey:scope,operationMode:mode,lang:'en',socket:null as any});
  const workflow=useMeetingWorkflow({...transcript,meetingStorageKeys:keys(scope),lang:'en',workDomain:domain,orgConnection:domain==='work'?{connected:true,orgId,orgRole:'owner'}:null,aiConfig:{},user:{uid:owner},stopMeetingAudio:()=>{transcript.setMeetingPaused(true);setMode('assistant');},operationMode:mode,endCall:vi.fn(),callState:'idle',setOperationMode:setMode,meetingStartAttemptRef:start,pendingOperationMode:pending,setPendingOperationMode:setPending} as any);
  return {...transcript,...workflow,mode};
}
function enterCase(activeCase:Pick<LegalCaseFile,'id'|'title'>) {
  const start=extractSourceExpression('src/components/org/legal_hub/scope.tsx','startConsultation',{isCurrent:()=>true,activeCase,window,CustomEvent,toast:mock.toast,desktopWorkflowCopy,uiMessage,lifetime:{current:{signal:new AbortController().signal}}});
  act(()=>start());
}
function assertSeparate(saved:any) {
  expect(saved.materials).toHaveLength(2);const originals=saved.materials.filter(isLegalSourceMaterial);expect(originals).toHaveLength(1);expect(originals[0]).toMatchObject({type:'consultation',source:'import'});expect(originals[0].content).toContain(notes[0].text);expect(originals[0].content).toContain('COMPLETE_RAW_TAIL');expect(originals[0].content).not.toContain(report);
  const generated=saved.materials.filter((m:any)=>m.source==='tool');expect(generated).toHaveLength(1);expect(generated[0]).toMatchObject({type:'note'});expect(generated[0].content).toContain(report);expect(generated[0].content).not.toContain('COMPLETE_RAW_TAIL');
}
describe('case entry to actual meeting HTTP archive without paid providers',()=>{
  it('runs personal entry, report-only analyze, real runtime sync/archive and merges exactly two materials without changing selected case B',async()=>{
    const first={...createEmptyLegalCase(),title:'Synthetic consultation case A',notes:'Original case facts remain unverified.'};const second={...createEmptyLegalCase(),title:'Selected separate case B'};writeLegalCaseFiles([first,second],second.id);
    const hook=renderHook(()=>useFlow('personal_'+owner,'personal'));enterCase(first);
    await waitFor(()=>expect(hook.result.current.meetingCaseOptions.some(c=>c.id===first.id)).toBe(true));
    expect(hook.result.current.meetingCaseId).toBe(first.id);expect(hook.result.current.meetingPaused).toBe(true);expect(makeLLMCall).not.toHaveBeenCalled();
    act(()=>hook.result.current.setMeetingNotes(notes));
    await act(async()=>hook.result.current.endMeetingAndReport());
    expect(hook.result.current.meetingReport).toBe(report);expect(hook.result.current.meetingArchiveError).toBe('');expect(hook.result.current.meetingArchiveReceipt?.caseId).toBe(first.id);expect(getActiveLegalCaseId()).toBe(second.id);
    assertSeparate(getLegalCaseById(first.id));assertSeparate(getCase(legalWorkspaceNamespace(owner),first.id,owner));expect(getLegalCaseById(second.id)?.materials).toHaveLength(0);const merged=getLegalCaseById(first.id)!;const original=merged.materials.find(m=>m.source==='import')!,minutes=merged.materials.find(m=>m.source==='tool')!;expect(merged.notes).toBe(first.notes);expect(merged.notes).not.toContain(report);expect(merged.notes).not.toContain('COMPLETE_RAW_TAIL');
    const analysis=requests.find(r=>r.path==='/api/meeting/analyze')!;expect(analysis.status).toBe(200);expect(analysis.data).toMatchObject({report});expect(analysis.data).not.toHaveProperty('legalCaseArchived');
    expect(requests.some(r=>r.path==='/api/legal/client-case-sync'&&r.body.activate===false)).toBe(true);
    const archive=requests.find(r=>r.path==='/api/meeting/archive')!;expect(archive.status).toBe(200);expect(archive.data).toMatchObject({ok:true,caseId:first.id,materialIds:{transcript:expect.any(String),minutes:expect.any(String)}});expect(archive.body.meetingId).toBe(hook.result.current.meetingRecordId);
    await act(async()=>{await hook.result.current.saveMeetingToCase();await hook.result.current.saveMeetingToCase();});expect(requests.filter(r=>r.path==='/api/meeting/archive')).toHaveLength(1);assertSeparate(getLegalCaseById(first.id));
    const replay=await fetch('/api/meeting/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(archive.body)});expect(replay.status).toBe(200);expect((await replay.json()).materialIds).toEqual(archive.data.materialIds);assertSeparate(getCase(legalWorkspaceNamespace(owner),first.id,owner));expect(makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('uses the organization case selected by the real entry and archives once through authenticated organization routes',async()=>{
    token=jwt.sign({uid:owner,username:owner,role:'admin',orgId},JWT_SECRET);localStorage.setItem('lumi_work_domain','work');localStorage.setItem('lumi_org_connection',JSON.stringify({orgId}));
    const item=createCase(orgId,owner,{title:'Synthetic organization consultation A',party:'Synthetic organization client',notes:'Original organization case facts.'});
    const hook=renderHook(()=>useFlow('work_'+orgId,'work'));enterCase(item);
    await waitFor(()=>expect(hook.result.current.meetingCaseOptions.some(c=>c.id===item.id)).toBe(true));act(()=>hook.result.current.setMeetingNotes(notes));
    await act(async()=>hook.result.current.endMeetingAndReport());
    expect(hook.result.current.meetingArchiveError).toBe('');expect(hook.result.current.meetingArchiveReceipt?.caseId).toBe(item.id);assertSeparate(getCase(orgId,item.id,owner));
    expect(requests.filter(r=>r.path==='/api/meeting/archive')).toHaveLength(1);expect(requests.some(r=>r.path==='/api/legal/client-case-sync')).toBe(false);
    const analysis=requests.find(r=>r.path==='/api/meeting/analyze')!;expect(analysis.body.legalCase).toMatchObject({id:item.id,title:item.title,party:item.party});expect(analysis.data).not.toHaveProperty('legalCaseArchived');
    await act(async()=>hook.result.current.saveMeetingToCase());assertSeparate(getCase(orgId,item.id,owner));expect(makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('archives a newly generated report after the same meeting was already saved with originals only',async()=>{
    const item={...createEmptyLegalCase(),title:'Synthetic raw-first then report case'};writeLegalCaseFiles([item],item.id);
    const hook=renderHook(()=>useFlow('personal_raw_first','personal'));enterCase(item);await waitFor(()=>expect(hook.result.current.meetingCaseOptions.some(c=>c.id===item.id)).toBe(true));act(()=>hook.result.current.setMeetingNotes(notes));
    await act(async()=>hook.result.current.saveMeetingToCase());
    const first=requests.find(r=>r.path==='/api/meeting/archive')!;expect(first.status).toBe(200);expect(first.data.summaryPresent).toBe(false);expect(hook.result.current.meetingArchiveReceipt?.caseId).toBe(item.id);expect(makeLLMCall).not.toHaveBeenCalled();
    await act(async()=>hook.result.current.endMeetingAndReport());
    expect(hook.result.current.meetingReport).toBe(report);expect(hook.result.current.meetingReportError).toBe('');expect(hook.result.current.meetingArchiveError).toBe('');
    const archives=requests.filter(r=>r.path==='/api/meeting/archive');expect(archives).toHaveLength(2);expect(archives[1].data).toMatchObject({ok:true,caseId:item.id,summaryPresent:true});expect(archives[1].data.materialIds.transcript).toBe(first.data.materialIds.transcript);expect(archives[1].data.materialIds.minutes).not.toBe(first.data.materialIds.minutes);
    const saved=getCase(legalWorkspaceNamespace(owner),item.id,owner)!;expect(saved.materials.filter(isLegalSourceMaterial)).toHaveLength(1);expect(saved.materials.filter(isLegalSourceMaterial)[0].content).toContain('COMPLETE_RAW_TAIL');
    const generated=saved.materials.filter(m=>m.source==='tool');expect(generated.filter(m=>m.content.includes(report))).toHaveLength(1);for(const material of generated)expect(material.content).not.toContain('COMPLETE_RAW_TAIL');
    expect(getLegalCaseById(item.id)?.materials.map(m=>m.id).sort()).toEqual(saved.materials.map(m=>m.id).sort());expect(makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('keeps an actual analysis failure out of the report while archiving complete originals with summaryPresent false',async()=>{
    const item={...createEmptyLegalCase(),title:'Synthetic failed-analysis original-only case'};writeLegalCaseFiles([item],item.id);vi.mocked(makeLLMCall).mockRejectedValueOnce(new Error('PRIVATE_MODEL_DIAGNOSTIC_NOT_A_MEETING_SUMMARY'));
    const hook=renderHook(()=>useFlow('personal_failed_analysis','personal'));enterCase(item);await waitFor(()=>expect(hook.result.current.meetingCaseOptions.some(c=>c.id===item.id)).toBe(true));act(()=>hook.result.current.setMeetingNotes(notes));
    await act(async()=>hook.result.current.endMeetingAndReport());
    expect(hook.result.current.meetingReport).toBe('');expect(hook.result.current.meetingReportError).not.toBe('');expect(hook.result.current.meetingReportError).not.toContain('PRIVATE_MODEL_DIAGNOSTIC');expect(hook.result.current.meetingReportGenerating).toBe(false);expect(hook.result.current.meetingArchiveError).toBe('');
    const analysis=requests.find(r=>r.path==='/api/meeting/analyze')!;expect(analysis.status).toBeGreaterThanOrEqual(400);const archive=requests.find(r=>r.path==='/api/meeting/archive')!;expect(archive.status).toBe(200);expect(archive.body.report).toBe('');expect(archive.data).toMatchObject({ok:true,caseId:item.id,summaryPresent:false});
    const saved=getCase(legalWorkspaceNamespace(owner),item.id,owner)!;expect(saved.materials).toHaveLength(2);const source=saved.materials.filter(isLegalSourceMaterial);expect(source).toHaveLength(1);expect(source[0].content).toContain(notes[0].text);expect(source[0].content).toContain('COMPLETE_RAW_TAIL');const generated=saved.materials.find(m=>m.source==='tool')!;
    expect(generated.content).not.toContain(report);expect(generated.content).not.toContain(hook.result.current.meetingReportError);expect(generated.content).not.toContain('PRIVATE_MODEL_DIAGNOSTIC');expect(generated.content).not.toContain('COMPLETE_RAW_TAIL');expect(generated.content).toContain('尚未生成总结');expect(hook.result.current.meetingArchiveReceipt?.caseId).toBe(item.id);expect(makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('ignores an old-scope successful archive response after the real server has saved the old meeting',async()=>{
    const item={...createEmptyLegalCase(),title:'Synthetic old personal case'};writeLegalCaseFiles([item],item.id);
    const hook=renderHook(({scope,domain})=>useFlow(scope,domain),{initialProps:{scope:'personal_'+owner,domain:'personal' as 'personal'|'work'}});enterCase(item);await waitFor(()=>expect(hook.result.current.meetingCaseOptions.some(c=>c.id===item.id)).toBe(true));
    act(()=>hook.result.current.setMeetingNotes(notes));act(()=>hook.result.current.setMeetingReport(report));
    let release!:()=>void,arrived!:()=>void;holdArchive=new Promise<void>(resolve=>{release=resolve;});const seen=new Promise<void>(resolve=>{arrived=resolve;});archiveReceived=arrived;
    let pending!:Promise<void>;act(()=>{pending=hook.result.current.saveMeetingToCase();});await seen;
    expect(requests.find(r=>r.path==='/api/meeting/archive')?.status).toBe(200);assertSeparate(getCase(legalWorkspaceNamespace(owner),item.id,owner));
    token=jwt.sign({uid:owner,username:owner,role:'admin',orgId},JWT_SECRET);localStorage.setItem('lumi_work_domain','work');localStorage.setItem('lumi_org_connection',JSON.stringify({orgId}));hook.rerender({scope:'work_'+orgId,domain:'work'});
    const newId=hook.result.current.meetingRecordId;await act(async()=>{release();await pending;});
    expect(hook.result.current.meetingRecordId).toBe(newId);expect(hook.result.current.meetingCaseId).toBe('');expect(hook.result.current.meetingArchiveReceipt).toBeNull();expect(hook.result.current.meetingNotes).toEqual([]);expect(makeLLMCall).not.toHaveBeenCalled();
    const history=JSON.parse(localStorage.getItem(keys('personal_'+owner).notes+'_history')!);expect(history.records.find((r:any)=>r.id===history.activeId).archiveReceipt).toBeUndefined();
  });
});
