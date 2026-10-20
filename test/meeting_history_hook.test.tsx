// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { EventEmitter } from 'node:events';
import { useMeetingTranscript } from '../src/components/desktop/useMeetingTranscript';
const mocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), caseId: 'case-a', title: 'Synthetic consultation', select: vi.fn(), clear: vi.fn() }));
vi.mock('sonner', () => ({ toast: mocks }));
vi.mock('../src/lib/legalCaseStore', () => ({
  getLegalConsultationCaseId: () => mocks.caseId,
  getLegalConsultationCase: () => ({ id: mocks.caseId, title: mocks.title }),
  getLegalCaseLabel: () => mocks.title,
  setLegalConsultationCaseId: (id: string) => { mocks.caseId = id; mocks.select(id); },
  clearLegalConsultationCaseId: () => { mocks.caseId = ''; mocks.clear(); },
}));
const keys = (scope: string) => ({ identity: 'audio-'+scope, startedAt: 'start-'+scope, notes: 'notes-'+scope, report: 'report-'+scope });
const input = (scope = 'personal_owner', domain: 'personal'|'work' = 'personal', socket: any = null) => ({ workDomain: domain, meetingStorageKeys: keys(scope), meetingPreferenceScopeKey: scope, operationMode: 'meeting' as const, lang: 'en' as const, socket });
const note = (id = 'n1', text = 'Complete synthetic transcript', time = 123) => ({ id, text, time });
const record = (id: string, text = 'Imported complete transcript') => ({ id, notes: [note(id, text)], report: 'Full synthetic report', startedAt: 123, caseId: 'case-import', caseTitle: 'Imported consultation', readOnly: false });
const saved = (scope = 'personal_owner') => JSON.parse(localStorage.getItem(keys(scope).notes+'_history')!);
const active = (scope = 'personal_owner') => { const data = saved(scope); return data.records.find((item: any) => item.id === data.activeId); };
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); mocks.caseId = 'case-a'; mocks.title = 'Synthetic consultation'; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('atomic scoped meeting history', () => {
  it('migrates complete legacy data only on explicit new, keeps it read-only and restores case metadata', () => {
    const legacy = keys('personal_owner');
    localStorage.setItem(legacy.notes, JSON.stringify([note()]));
    localStorage.setItem(legacy.report, 'Unabridged legacy report'); localStorage.setItem(legacy.startedAt, '123'); localStorage.setItem(legacy.identity, 'old-audio');
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const hook = renderHook(() => useMeetingTranscript(input()));
    const oldId = hook.result.current.meetingRecordId, oldIdentity = hook.result.current.meetingIdentityRef.current;
    expect(hook.result.current.meetingHistoryReadOnly).toBe(true);
    expect(hook.result.current.meetingReport).toBe('Unabridged legacy report');
    expect(writes).not.toHaveBeenCalled();
    let ok = false; act(() => { ok = hook.result.current.createMeetingRecord(); }); expect(ok).toBe(true);
    expect(writes.mock.calls.map(call => call[0])).toEqual([legacy.notes+'_history']);
    expect(hook.result.current.meetingIdentityRef.current).not.toBe(oldIdentity);
    expect(hook.result.current.meetingRecordId).not.toBe(hook.result.current.meetingIdentityRef.current.meetingId);
    expect(hook.result.current.meetingNotes).toEqual([]); expect(hook.result.current.meetingHistoryReadOnly).toBe(false);
    expect(saved().records.find((r: any) => r.id === oldId)).toMatchObject({ notes: [note()], report: 'Unabridged legacy report', startedAt: 123, caseId: '', caseTitle: '', readOnly: true });
    act(() => hook.result.current.setMeetingNotes([note('new', 'Second meeting')]));
    act(() => { ok = hook.result.current.selectMeetingRecord(oldId); }); expect(ok).toBe(true);
    expect(hook.result.current.meetingPaused).toBe(true); expect(hook.result.current.meetingHistoryReadOnly).toBe(true);
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled();
    act(() => { hook.result.current.setMeetingNotes([note('bad')]); hook.result.current.setMeetingReport('Must not overwrite'); });
    expect(hook.result.current.meetingNotes).toEqual([note()]); expect(hook.result.current.meetingReport).toBe('Unabridged legacy report');
    expect(writes.mock.calls.every(call => call[0] === legacy.notes+'_history')).toBe(true);
  });

  it('uses one authoritative envelope and preserves case association after archive clears its display caption', () => {
    const hook = renderHook(() => useMeetingTranscript(input()));
    act(() => { expect(hook.result.current.bindMeetingCase('case-a','Synthetic consultation')).toBe(true); hook.result.current.setMeetingNotes(previous => [...previous, note('one')]); hook.result.current.setMeetingNotes(previous => [...previous, note('two')]); hook.result.current.setMeetingReport('Full final report'); hook.result.current.setMeetingStartedAt(456); hook.result.current.setLegalMeetingCaseTitle(''); });
    expect(hook.result.current.legalMeetingCaseTitle).toBe('');
    expect(active()).toMatchObject({ startedAt:456, caseId:'case-a', caseTitle:'Synthetic consultation', report:'Full final report' });
    expect(active().notes.map((n: any) => n.id)).toEqual(['one','two']);
    hook.unmount(); localStorage.setItem(keys('personal_owner').notes, JSON.stringify([note('stale', 'STALE LEGACY')]));
    const restored = renderHook(() => useMeetingTranscript(input()));
    expect(restored.result.current.meetingNotes.map(n => n.id)).toEqual(['one','two']);
    expect(restored.result.current.meetingHistoryReadOnly).toBe(true); expect(restored.result.current.meetingPaused).toBe(true);
    expect(restored.result.current.meetingReport).toBe('Full final report');
  });

  it('retains unsaved new raw speech in RAM but makes failed new/select/import leave selection and identity unchanged', () => {
    const hook = renderHook(() => useMeetingTranscript(input()));
    act(() => hook.result.current.setMeetingNotes([note()]));
    const firstId = hook.result.current.meetingRecordId;
    act(() => hook.result.current.createMeetingRecord());
    act(() => hook.result.current.setMeetingPaused(false));
    const beforeBytes = localStorage.getItem(keys('personal_owner').notes+'_history');
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(key,value) { if(key === keys('personal_owner').notes+'_history') throw new DOMException('Synthetic quota', 'QuotaExceededError'); return original.call(this,key,value); });
    act(() => hook.result.current.appendMeetingTranscript('Unsaved last spoken words',true));
    expect(hook.result.current.meetingNotes.map(n => n.text)).toEqual(['Unsaved last spoken words']);
    expect(hook.result.current.meetingPaused).toBe(true); expect(mocks.error).toHaveBeenCalled();
    expect(localStorage.getItem(keys('personal_owner').notes+'_history')).toBe(beforeBytes);
    const id = hook.result.current.meetingRecordId, identity = hook.result.current.meetingIdentityRef.current, notes = hook.result.current.meetingNotes;
    const outcomes: boolean[] = []; act(() => { outcomes.push(hook.result.current.createMeetingRecord(), hook.result.current.selectMeetingRecord(firstId), hook.result.current.importMeetingRecords(JSON.stringify({scope:'personal_owner',records:[record('import')]}))); });
    expect(outcomes).toEqual([false,false,false]); expect(hook.result.current.meetingRecordId).toBe(id); expect(hook.result.current.meetingIdentityRef.current).toBe(identity); expect(hook.result.current.meetingNotes).toBe(notes);
    expect(hook.result.current.meetingHistory.some(r => r.id === 'import')).toBe(false);
  });

  it('isolates scope immediately and discards stale refinement when new/select rotates audio identity', async () => {
    const emitter = new EventEmitter(); const socket = Object.assign(emitter,{connected:true});
    const hook = renderHook(({scope,domain}) => useMeetingTranscript(input(scope,domain,socket)), {initialProps:{scope:'personal_owner',domain:'personal' as 'personal'|'work'}});
    act(() => hook.result.current.setMeetingNotes([note()]));
    const oldId = hook.result.current.meetingRecordId, oldSetter = hook.result.current.setMeetingNotes, oldIdentity = hook.result.current.meetingIdentityRef.current;
    oldIdentity.refinementId = 'refine-original';
    let pending!: Promise<any>; act(() => { pending = hook.result.current.waitForMeetingRefinement(oldIdentity); });
    act(() => hook.result.current.createMeetingRecord());
    await expect(pending).resolves.toBeNull();
    act(() => socket.emit('meeting:refined_transcript',{meetingId:oldIdentity.meetingId,refinementId:'refine-original',text:'Stale replacement'}));
    expect(hook.result.current.meetingNotes).toEqual([]);
    act(() => hook.result.current.selectMeetingRecord(oldId));
    const selectedIdentity = hook.result.current.meetingIdentityRef.current;
    expect(selectedIdentity).not.toBe(oldIdentity); expect(hook.result.current.meetingNotes).toEqual([note()]);
    hook.rerender({scope:'org_beta',domain:'work'});
    expect(hook.result.current.meetingNotes).toEqual([]); expect(hook.result.current.meetingReport).toBe('');
    act(() => oldSetter([note('leak','PRIVATE MUST NOT CROSS')]));
    expect(hook.result.current.meetingNotes).toEqual([]); expect(localStorage.getItem(keys('org_beta').notes+'_history')).toBeNull();
    act(() => hook.result.current.setMeetingNotes([note('org','ORG ONLY')]));
    hook.rerender({scope:'personal_owner',domain:'personal'});
    expect(hook.result.current.meetingNotes).toEqual([note()]); expect(hook.result.current.meetingIdentityRef.current).not.toBe(selectedIdentity);
    expect(hook.result.current.meetingHistoryReadOnly).toBe(true);
  });

  it('imports scoped complete records once without selecting, overwriting existing ids or opening capture', () => {
    const hook = renderHook(() => useMeetingTranscript(input()));
    act(() => hook.result.current.setMeetingNotes([note()]));
    const id = hook.result.current.meetingRecordId, identity = hook.result.current.meetingIdentityRef.current;
    const writes = vi.spyOn(Storage.prototype,'setItem');
    let ok = false; act(() => { ok = hook.result.current.importMeetingRecords(JSON.stringify({scope:'personal_owner',records:[record(id,'Do not overwrite current'),record('restored','Full restored tail'),record('restored','Duplicate must not replace')]})); });
    expect(ok).toBe(true); expect(writes).toHaveBeenCalledTimes(1);
    expect(hook.result.current.meetingRecordId).toBe(id); expect(hook.result.current.meetingIdentityRef.current).toBe(identity); expect(hook.result.current.meetingPaused).toBe(true);
    expect(hook.result.current.meetingNotes).toEqual([note()]); expect(hook.result.current.meetingHistory).toHaveLength(2);
    expect(hook.result.current.meetingHistory.find(r=>r.id==='restored')).toMatchObject({...record('restored','Full restored tail'),readOnly:true});
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled();
  });

  it.each([
    {scope:'other_owner',records:[record('bad')]},
    {scope:'personal_owner',records:[{...record('bad'),startedAt:'123'}]},
    {scope:'personal_owner',records:[{...record('bad'),notes:[{id:'bad',text:42,time:1}]}]},
    {scope:'personal_owner',records:[{...record('bad'),caseTitle:null}]},
    {scope:'personal_owner',records:[{...record('bad'),readOnly:1}]},
  ])('rejects malformed or cross-scope imports atomically: %#', data => {
    const hook = renderHook(() => useMeetingTranscript(input()));
    act(() => hook.result.current.setMeetingNotes([note()])); const before = localStorage.getItem(keys('personal_owner').notes+'_history');
    const id = hook.result.current.meetingRecordId, identity = hook.result.current.meetingIdentityRef.current;
    let ok = true; act(() => { ok = hook.result.current.importMeetingRecords(JSON.stringify(data)); });
    expect(ok).toBe(false); expect(localStorage.getItem(keys('personal_owner').notes+'_history')).toBe(before); expect(hook.result.current.meetingRecordId).toBe(id); expect(hook.result.current.meetingIdentityRef.current).toBe(identity); expect(mocks.error).toHaveBeenCalled();
  });


  it('rejects old record setters after creating another record in the same scope', () => {
    const hook = renderHook(() => useMeetingTranscript(input()));
    act(() => hook.result.current.setMeetingNotes([note()]));
    const oldNotes = hook.result.current.setMeetingNotes, oldReport = hook.result.current.setMeetingReport, oldStart = hook.result.current.setMeetingStartedAt;
    act(() => hook.result.current.createMeetingRecord());
    act(() => { oldNotes([note('late','OLD ASYNC RAW')]); oldReport('OLD ASYNC SUMMARY'); oldStart(999); });
    expect(hook.result.current.meetingNotes).toEqual([]); expect(hook.result.current.meetingReport).toBe(''); expect(hook.result.current.meetingStartedAt).toBeNull();
    expect(active()).toMatchObject({notes:[],report:'',startedAt:null});
    act(() => hook.result.current.setMeetingNotes([note('new','Fresh current raw')]));
    expect(hook.result.current.meetingNotes[0].id).toBe('new');
  });

  it('binds a case explicitly, rejects incompatible or stale bindings and never consults the global case mirror', () => {
    const hook = renderHook(() => useMeetingTranscript(input()));
    act(() => hook.result.current.setMeetingNotes([note()]));
    expect(hook.result.current.meetingCaseId).toBe('');
    let bound = false; act(() => { bound = hook.result.current.bindMeetingCase('case-a','Bound case'); });
    expect(bound).toBe(true); expect(hook.result.current.meetingCaseId).toBe('case-a'); expect(active().caseTitle).toBe('Bound case');
    act(() => { bound = hook.result.current.bindMeetingCase('case-other','Wrong replacement'); }); expect(bound).toBe(false);
    const oldBind = hook.result.current.bindMeetingCase;
    act(() => hook.result.current.createMeetingRecord());
    act(() => { bound = oldBind('case-a','Stale case'); }); expect(bound).toBe(false);
    act(() => hook.result.current.setMeetingNotes([note('new')]));
    expect(hook.result.current.meetingCaseId).toBe(''); expect(active().caseId).toBe('');
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('leaves case metadata and current identity unchanged when an explicit bind cannot be persisted', () => {
    const hook = renderHook(() => useMeetingTranscript(input()));
    act(() => hook.result.current.setMeetingNotes([note()]));
    const identity = hook.result.current.meetingIdentityRef.current, before = localStorage.getItem(keys('personal_owner').notes+'_history');
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(key,value) { if(key === keys('personal_owner').notes+'_history') throw new DOMException('Synthetic quota','QuotaExceededError'); return original.call(this,key,value); });
    let ok = true; act(() => { ok = hook.result.current.bindMeetingCase('case-new','New case'); });
    expect(ok).toBe(false); expect(hook.result.current.meetingCaseId).toBe(''); expect(hook.result.current.meetingIdentityRef.current).toBe(identity); expect(localStorage.getItem(keys('personal_owner').notes+'_history')).toBe(before);
  });

  it('never assigns ownerless legacy notes or reports to the currently signed-in user', () => {
    localStorage.setItem('lumi_meeting_notes',JSON.stringify([note('ownerless','MUST NOT AUTO-ASSIGN')])); localStorage.setItem('lumi_meeting_report','Owner unknown');
    const hook = renderHook(() => useMeetingTranscript(input()));
    expect(hook.result.current.meetingNotes).toEqual([]); expect(hook.result.current.meetingReport).toBe('');
    expect(localStorage.getItem('lumi_meeting_notes')).toContain('MUST NOT AUTO-ASSIGN');
  });

  it('does not attach an empty restored page to an old audio buffer identity', () => {
    localStorage.setItem(keys('personal_owner').identity,'discarded-old-pcm');
    const hook = renderHook(() => useMeetingTranscript(input()));
    expect(hook.result.current.meetingHistoryReadOnly).toBe(false); expect(hook.result.current.meetingIdentityRef.current.meetingId).not.toBe('discarded-old-pcm');
  });

  it('does not overwrite corrupt authoritative history or silently fall back to stale legacy notes', () => {
    const key = keys('personal_owner').notes+'_history'; localStorage.setItem(key,'{broken json'); localStorage.setItem(keys('personal_owner').notes,JSON.stringify([note('legacy')]));
    const hook = renderHook(() => useMeetingTranscript(input()));
    expect(hook.result.current.meetingNotes).toEqual([]); expect(hook.result.current.meetingHistoryReadOnly).toBe(true); expect(mocks.error).toHaveBeenCalled();
    const identity = hook.result.current.meetingIdentityRef.current; let created = true, imported = true;
    act(() => { created = hook.result.current.createMeetingRecord(); imported = hook.result.current.importMeetingRecords(JSON.stringify({scope:'personal_owner',records:[record('recover')]})); });
    expect(created).toBe(false); expect(imported).toBe(false); expect(localStorage.getItem(key)).toBe('{broken json'); expect(hook.result.current.meetingIdentityRef.current).toBe(identity);
  });
});


describe('record-owned meeting archive metadata', () => {
  it('records an explicit successful destination on a read-only unassociated history in one write without changing source data', () => {
    const original = record('old-unbound','Original complete transcript tail'); original.caseId = ''; original.caseTitle = ''; original.readOnly = true;
    localStorage.setItem(keys('personal_owner').notes+'_history',JSON.stringify({activeId:original.id,records:[original]}));
    const hook = renderHook(() => useMeetingTranscript(input())); const identity = hook.result.current.meetingIdentityRef.current;
    expect(hook.result.current.meetingArchiveReceipt).toBeNull(); const writes = vi.spyOn(Storage.prototype,'setItem');
    let ok = false; act(() => { ok = hook.result.current.recordMeetingArchive('case-verified','Server-confirmed destination',{notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport}); });
    expect(ok).toBe(true); expect(writes).toHaveBeenCalledTimes(1); expect(hook.result.current.meetingHistoryReadOnly).toBe(true);
    expect(hook.result.current.meetingNotes).toEqual(original.notes); expect(hook.result.current.meetingReport).toBe(original.report); expect(hook.result.current.meetingIdentityRef.current).toBe(identity);
    expect(active()).toMatchObject({...original,caseId:'case-verified',caseTitle:'Server-confirmed destination',archiveReceipt:{caseId:'case-verified',at:expect.any(Number)}});
    hook.unmount(); const reloaded = renderHook(() => useMeetingTranscript(input()));
    expect(reloaded.result.current.meetingArchiveReceipt).toEqual({caseId:'case-verified',at:expect.any(Number)}); expect(reloaded.result.current.meetingCaseId).toBe('case-verified');
  });

  it('invalidates the receipt only for actual transcript or report changes', () => {
    const hook = renderHook(() => useMeetingTranscript(input()));
    act(() => hook.result.current.setMeetingNotes([note()])); act(() => hook.result.current.setMeetingReport('Final report'));
    act(() => hook.result.current.recordMeetingArchive('case-a','Verified case A',{notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport}));
    const receipt = hook.result.current.meetingArchiveReceipt;
    const writes = vi.spyOn(Storage.prototype,'setItem');
    act(() => { hook.result.current.setMeetingNotes(prev=>prev.map(n=>({...n}))); hook.result.current.setMeetingReport(prev=>prev); });
    expect(hook.result.current.meetingArchiveReceipt).toEqual(receipt); expect(hook.result.current.meetingReport).toBe('Final report'); expect(writes).not.toHaveBeenCalled();
    act(() => hook.result.current.setMeetingReport('Amended report'));
    expect(hook.result.current.meetingArchiveReceipt).toBeNull(); expect(active().archiveReceipt).toBeUndefined();
    act(() => hook.result.current.recordMeetingArchive('case-a','Verified case A',{notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport}));
    act(() => hook.result.current.setMeetingNotes(prev=>[...prev,note('later','New actual spoken content')]));
    expect(hook.result.current.meetingArchiveReceipt).toBeNull(); expect(hook.result.current.meetingReport).toBe(''); expect(hook.result.current.meetingNotes).toHaveLength(2);
  });

  it('never imports a claimed archive receipt even when the imported destination matches', () => {
    const hook = renderHook(() => useMeetingTranscript(input())); const imported = {...record('claimed'),archiveReceipt:{caseId:'case-import',at:123}};
    let ok=false; act(()=> { ok=hook.result.current.importMeetingRecords(JSON.stringify({scope:'personal_owner',records:[imported]})); }); expect(ok).toBe(true);
    expect(saved().records.find((r:any)=>r.id==='claimed').archiveReceipt).toBeUndefined();
    act(()=>hook.result.current.selectMeetingRecord('claimed')); expect(hook.result.current.meetingArchiveReceipt).toBeNull(); expect(hook.result.current.meetingNotes).toEqual(imported.notes);
  });

  it('rejects cross-case, cross-scope and stale-record archive callbacks', () => {
    const hook = renderHook(({scope})=>useMeetingTranscript(input(scope)),{initialProps:{scope:'personal_owner'}});
    act(()=>hook.result.current.setMeetingNotes([note()])); act(()=>hook.result.current.bindMeetingCase('case-a','Case A'));
    let ok=true; act(()=>{ok=hook.result.current.recordMeetingArchive('case-b','Case B',{notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport});}); expect(ok).toBe(false); expect(hook.result.current.meetingArchiveReceipt).toBeNull();
    const oldMark=hook.result.current.recordMeetingArchive;
    act(()=>hook.result.current.createMeetingRecord()); act(()=>{ok=oldMark('case-a','Late previous case',{notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport});}); expect(ok).toBe(false); expect(hook.result.current.meetingCaseId).toBe('');
    const previousScopeMark=hook.result.current.recordMeetingArchive; hook.rerender({scope:'personal_other'});
    act(()=>{ok=previousScopeMark('case-a','Wrong actor',{notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport});}); expect(ok).toBe(false); expect(hook.result.current.meetingCaseId).toBe(''); expect(localStorage.getItem(keys('personal_other').notes+'_history')).toBeNull();
  });

  it('does not claim or bind archive metadata when the atomic receipt write fails', () => {
    const hook=renderHook(()=>useMeetingTranscript(input())); act(()=>hook.result.current.setMeetingNotes([note()]));
    const before=localStorage.getItem(keys('personal_owner').notes+'_history'), identity=hook.result.current.meetingIdentityRef.current;
    const original=Storage.prototype.setItem; vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(key,value){if(key===keys('personal_owner').notes+'_history')throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,key,value);});
    let ok=true;act(()=>{ok=hook.result.current.recordMeetingArchive('case-a','Destination A',{notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport});});
    expect(ok).toBe(false);expect(hook.result.current.meetingCaseId).toBe('');expect(hook.result.current.meetingArchiveReceipt).toBeNull();expect(hook.result.current.meetingNotes).toEqual([note()]);expect(hook.result.current.meetingIdentityRef.current).toBe(identity);expect(localStorage.getItem(keys('personal_owner').notes+'_history')).toBe(before);expect(hook.result.current.meetingPaused).toBe(true);
  });

  it('atomically opens a new bound consultation and preserves the complete old record and receipt',()=>{
    const hook=renderHook(()=>useMeetingTranscript(input())); act(()=>hook.result.current.setMeetingNotes([note()]));act(()=>hook.result.current.setMeetingReport('Full previous report'));act(()=>hook.result.current.recordMeetingArchive('case-old','Previous destination',{notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport}));
    const oldId=hook.result.current.meetingRecordId,oldIdentity=hook.result.current.meetingIdentityRef.current,oldReceipt=hook.result.current.meetingArchiveReceipt;
    const writes=vi.spyOn(Storage.prototype,'setItem');let ok=false;act(()=>{ok=hook.result.current.createMeetingRecord({id:'case-new',title:'Selected actual new case'});});
    expect(ok).toBe(true);expect(writes).toHaveBeenCalledTimes(1);expect(hook.result.current.meetingCaseId).toBe('case-new');expect(hook.result.current.legalMeetingCaseTitle).toBe('Selected actual new case');expect(hook.result.current.meetingArchiveReceipt).toBeNull();expect(hook.result.current.meetingHistoryReadOnly).toBe(false);expect(hook.result.current.meetingPaused).toBe(true);expect(hook.result.current.meetingNotes).toEqual([]);expect(hook.result.current.meetingIdentityRef.current).not.toBe(oldIdentity);
    expect(saved().records.find((r:any)=>r.id===oldId)).toMatchObject({notes:[note()],report:'Full previous report',caseId:'case-old',archiveReceipt:oldReceipt,readOnly:true});
  });

  it('keeps current history and identity when opening a bound consultation cannot be saved',()=>{
    const hook=renderHook(()=>useMeetingTranscript(input()));act(()=>hook.result.current.setMeetingNotes([note()]));
    const id=hook.result.current.meetingRecordId,identity=hook.result.current.meetingIdentityRef.current,before=localStorage.getItem(keys('personal_owner').notes+'_history');
    const original=Storage.prototype.setItem;vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(key,value){if(key===keys('personal_owner').notes+'_history')throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,key,value);});
    let ok=true;act(()=>{ok=hook.result.current.createMeetingRecord({id:'case-new',title:'New consultation'});});expect(ok).toBe(false);expect(hook.result.current.meetingRecordId).toBe(id);expect(hook.result.current.meetingIdentityRef.current).toBe(identity);expect(hook.result.current.meetingCaseId).toBe('');expect(localStorage.getItem(keys('personal_owner').notes+'_history')).toBe(before);
  });


  it('rejects a successful late server receipt for an older version of the same meeting record',()=>{
    const hook=renderHook(()=>useMeetingTranscript(input()));act(()=>hook.result.current.setMeetingNotes([note()]));act(()=>hook.result.current.setMeetingReport('First submitted report'));
    const submitted={notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport}; const mark=hook.result.current.recordMeetingArchive;
    act(()=>hook.result.current.setMeetingReport('Report changed while request pending'));
    let ok=true;act(()=>{ok=mark('case-a','Real destination',submitted);});expect(ok).toBe(false);expect(hook.result.current.meetingArchiveReceipt).toBeNull();expect(hook.result.current.meetingCaseId).toBe('');
    const second={notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport};act(()=>hook.result.current.setMeetingNotes(prev=>[...prev,note('new-speech','New speech while saving')]));
    act(()=>{ok=mark('case-a','Real destination',second);});expect(ok).toBe(false);expect(hook.result.current.meetingArchiveReceipt).toBeNull();expect(active().archiveReceipt).toBeUndefined();
  });

  it('does not overwrite malformed authoritative archive receipt metadata',()=>{
    const old={...record('bad-receipt'),archiveReceipt:{caseId:'different-case',at:123}};const key=keys('personal_owner').notes+'_history';const before=JSON.stringify({activeId:old.id,records:[old]});localStorage.setItem(key,before);
    const hook=renderHook(()=>useMeetingTranscript(input()));expect(hook.result.current.meetingHistoryReadOnly).toBe(true);expect(hook.result.current.meetingArchiveReceipt).toBeNull();let ok=true;act(()=>{ok=hook.result.current.recordMeetingArchive('case-import','Destination',{notes:hook.result.current.meetingNotes,report:hook.result.current.meetingReport});});expect(ok).toBe(false);expect(localStorage.getItem(key)).toBe(before);expect(mocks.error).toHaveBeenCalled();
  });
});
