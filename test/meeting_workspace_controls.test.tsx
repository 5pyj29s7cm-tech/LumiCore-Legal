// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useMeetingTranscript } from '../src/components/desktop/useMeetingTranscript';
import { useMeetingWorkflow } from '../src/components/desktop/useMeetingWorkflow';
import { renderMeetingWorkspace } from '../src/components/desktop/meeting_workspace_view';
const m = vi.hoisted(() => ({ invoke: vi.fn(), native: vi.fn(() => true), toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, caseId: '', cases: [] as any[] }));
vi.mock('sonner', () => ({ toast: m.toast }));
vi.mock('../src/services/apiClient', () => ({ apiJson: async (url: string, options?: RequestInit) => { const response = await fetch(url, options); if (!response.ok) throw new Error('Request failed'); return response.json(); } }));
vi.mock('../src/services/apiBridge', () => ({ isTauriRuntime: m.native }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
vi.mock('@tauri-apps/api/path', () => ({ downloadDir: async () => 'D:/Downloads', join: async (...p: string[]) => p.join('/'), dirname: async (p: string) => p.slice(0, p.lastIndexOf('/')) }));
vi.mock('../src/lib/legalCaseStore', () => ({ getLegalCaseLabel: (item: any) => item?.title || '', getLegalConsultationCase: () => null, getLegalCaseById: (id: string) => m.cases.find(item => item.id === id) || null, readLegalCaseFiles: () => m.cases, syncPersonalLegalCaseToRuntime: vi.fn(async () => {}), mergePersonalLegalCaseRuntimeSnapshot: vi.fn((data: any) => data), getLegalConsultationCaseId: () => m.caseId, setLegalConsultationCaseId: (id: string) => { m.caseId = id; }, clearLegalConsultationCaseId: () => { m.caseId = ''; }, archiveLegalMeetingToConsultationCase: vi.fn() }));
const keys = (scope: string) => ({ identity: scope+'-identity', startedAt: scope+'-started', notes: scope+'-notes', report: scope+'-report' });
function useHarness(scope: string) {
  const [mode, setMode] = useState<any>('assistant');
  const [pending, setPending] = useState<any>(null);
  const transcript = useMeetingTranscript({ workDomain: scope === 'personal' ? 'personal' : 'work', meetingStorageKeys: keys(scope), meetingPreferenceScopeKey: scope, operationMode: mode, lang: 'zh', socket: null as any });
  const workflow = useMeetingWorkflow({ ...transcript, meetingStorageKeys: keys(scope), lang: 'zh', workDomain: scope === 'personal' ? 'personal' : 'work', orgConnection: null, aiConfig: {}, user: { uid: 'synthetic' }, stopMeetingAudio: () => { transcript.setMeetingPaused(true); setMode('assistant'); }, operationMode: mode, endCall: vi.fn(), callState: 'idle', setOperationMode: setMode, meetingStartAttemptRef: { current: 0 }, pendingOperationMode: pending, setPendingOperationMode: setPending } as any);
  return { ...transcript, ...workflow, mode };
}
const saved = Array.from({ length: 125 }, (_, i) => ({ id: 'n'+i, time: 1000+i, text: 'Synthetic original '+i }));
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); m.caseId = ''; m.cases = []; m.native.mockReturnValue(true); m.invoke.mockImplementation(async (command: string, args: any) => command === 'write_text_file' ? { success: true, path: args.path, readBackMatched: true } : { success: true }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('explicit meeting preparation and preservation', () => {
  it('opens ready without capture or resetting an existing report, and starts only on the explicit control', () => {
    localStorage.setItem(keys('personal').notes, JSON.stringify(saved)); localStorage.setItem(keys('personal').report, 'Original summary');
    const hook = renderHook(() => useHarness('personal'));
    act(() => hook.result.current.openMeetingModeWithConfirm());
    expect(hook.result.current.mode).toBe('meeting'); expect(hook.result.current.meetingPaused).toBe(true); expect(hook.result.current.meetingNotes).toHaveLength(125); expect(hook.result.current.meetingReport).toBe('Original summary');
    act(() => hook.result.current.appendMeetingTranscript('Not authorized by entry', true)); expect(hook.result.current.meetingNotes).toHaveLength(125);
    act(() => { hook.result.current.setMeetingNotesOpen(false); hook.result.current.openMeetingModeWithConfirm(); });
    expect(hook.result.current.meetingReport).toBe('Original summary'); expect(hook.result.current.meetingNotes).toHaveLength(125);
    vi.spyOn(window, 'confirm').mockReturnValue(true); act(() => hook.result.current.clearMeetingNotes());
    expect(hook.result.current.meetingHistory.some(record => record.notes.length === 125 && record.report === 'Original summary')).toBe(true);
    act(() => hook.result.current.toggleMeetingCapturePaused()); expect(hook.result.current.meetingPaused).toBe(false);
    act(() => hook.result.current.appendMeetingTranscript('Explicitly started capture', true)); expect(hook.result.current.meetingNotes.map(note => note.text)).toEqual(['Explicitly started capture']);
  });
  it('ignores legacy resetNotes and preserves the old record when opening a different case', () => {
    m.caseId = 'old-case';
    const hook = renderHook(() => useHarness('personal')); act(() => { hook.result.current.bindMeetingCase('old-case', 'Stored case'); }); act(() => hook.result.current.setMeetingNotes(saved)); const respond = vi.fn(), reject = vi.fn();
    act(() => window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode', { detail: { confirmed: true, resetNotes: true, legalCaseId: 'old-case', respond, reject } })));
    expect(hook.result.current.meetingPaused).toBe(true); expect(hook.result.current.meetingNotes).toHaveLength(125); expect(respond).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
    act(() => window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode', { detail: { confirmed: true, legalCaseId: 'another-case', legalCaseTitle: 'Another case', reject } })));
    expect(reject).not.toHaveBeenCalled(); expect(hook.result.current.meetingCaseId).toBe('another-case'); expect(hook.result.current.meetingNotes).toHaveLength(0); expect(hook.result.current.meetingHistory.some(record => record.caseId === 'old-case' && record.notes.length === 125)).toBe(true);
  });
  it('does not erase anything when new-record confirmation is cancelled', () => {
    localStorage.setItem(keys('personal').notes, JSON.stringify(saved)); localStorage.setItem(keys('personal').report, 'Keep this report');
    const hook = renderHook(() => useHarness('personal')); const identity = hook.result.current.meetingIdentityRef.current;
    vi.spyOn(window, 'confirm').mockReturnValue(false); act(() => hook.result.current.clearMeetingNotes());
    expect(hook.result.current.meetingIdentityRef.current).toBe(identity); expect(hook.result.current.meetingNotes).toHaveLength(125); expect(hook.result.current.meetingReport).toBe('Keep this report');
  });
});
describe('empty recording can finish honestly', () => {
  it('stops an active recording with no ASR text, keeps an honest empty report and does not call a model', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const hook = renderHook(() => useHarness('personal'));
    act(() => { hook.result.current.openMeetingModeWithConfirm(); }); act(() => hook.result.current.toggleMeetingCapturePaused());
    await act(async () => hook.result.current.endMeetingAndReport());
    expect(hook.result.current.mode).toBe('assistant'); expect(hook.result.current.meetingPaused).toBe(true); expect(hook.result.current.meetingReportGenerating).toBe(false); expect(hook.result.current.meetingNotes).toEqual([]); expect(hook.result.current.meetingReport).toBe(''); expect(hook.result.current.meetingReportError).toContain('未生成会议总结'); expect(fetch).not.toHaveBeenCalled();
  });
});
describe('honest missing meeting analysis', () => {
  it.each([false, true])('preserves originals without a keyword or sampled pseudo-summary when HTTP success=%s but no report exists', async httpOk => {
    localStorage.setItem(keys('personal').notes, JSON.stringify(saved)); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(httpOk ? {} : { error: 'INTERNAL_PROVIDER_DIAGNOSTIC' }), { status: httpOk ? 200 : 400 })));
    const hook = renderHook(() => useHarness('personal')); act(() => hook.result.current.createMeetingRecord()); act(() => hook.result.current.setMeetingNotes(saved)); await act(async () => hook.result.current.endMeetingAndReport());
    expect(hook.result.current.meetingNotes).toHaveLength(125); expect(hook.result.current.meetingReport).toBe(''); expect(hook.result.current.meetingReportError).toContain('会议分析未完成，已保留125条原始转写'); expect(hook.result.current.meetingReportError).not.toContain('INTERNAL_PROVIDER_DIAGNOSTIC'); expect(hook.result.current.meetingReport).not.toContain('Synthetic original'); expect(hook.result.current.meetingReport).not.toContain('##'); expect(hook.result.current.meetingReport).not.toContain('INTERNAL_PROVIDER_DIAGNOSTIC'); expect(m.toast.success).not.toHaveBeenCalled(); expect(hook.result.current.meetingReportGenerating).toBe(false);
  });
});
describe('verified native meeting export', () => {
  it('writes the complete transcript and summary and exposes only the verified exact location', async () => {
    localStorage.setItem(keys('personal').notes, JSON.stringify(saved)); localStorage.setItem(keys('personal').report, 'Actual summary text'); const hook = renderHook(() => useHarness('personal'));
    await act(async () => hook.result.current.downloadMeetingNotes());
    const args = m.invoke.mock.calls.find(x => x[0] === 'write_text_file')![1]; expect(args.content).toContain('Synthetic original 0'); expect(args.content).toContain('Synthetic original 124'); expect(args.content).toContain('Actual summary text'); expect(args.overwritePolicy).toBe('fail_if_exists');
    expect(args.content.indexOf('Synthetic original 0')).toBeLessThan(args.content.indexOf('Synthetic original 124')); expect(hook.result.current.meetingExportPath).toBe(args.path); expect(m.toast.success).toHaveBeenCalledWith(expect.stringContaining('回读'));
    await act(async () => hook.result.current.openMeetingExport()); expect(m.invoke).toHaveBeenLastCalledWith('open_item', { target: args.path });
    await act(async () => hook.result.current.openMeetingExport(true)); expect(m.invoke).toHaveBeenLastCalledWith('open_item', { target: 'D:/Downloads' });
  });
  it.each([{ success: false, readBackMatched: false }, { success: true, readBackMatched: false }])('does not claim or display a successful save when native write/readback fails: %j', async result => {
    localStorage.setItem(keys('personal').notes, JSON.stringify(saved)); m.invoke.mockResolvedValue({ ...result, path: 'D:/wrong.md' }); const hook = renderHook(() => useHarness('personal'));
    await act(async () => hook.result.current.downloadMeetingNotes()); expect(hook.result.current.meetingExportPath).toBe(''); expect(hook.result.current.meetingExportError).toContain('保存失败'); expect(m.toast.success).not.toHaveBeenCalled(); expect(hook.result.current.meetingNotes).toHaveLength(125);
  });
  it('reports only a browser download request without inventing a saved path', async () => {
    localStorage.setItem(keys('personal').notes, JSON.stringify(saved)); m.native.mockReturnValue(false); vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fixture'), revokeObjectURL: vi.fn() }); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const hook = renderHook(() => useHarness('personal')); await act(async () => hook.result.current.downloadMeetingNotes());
    expect(m.invoke).not.toHaveBeenCalled(); expect(m.toast.success).not.toHaveBeenCalled(); expect(m.toast.info).toHaveBeenCalledWith(expect.stringContaining('浏览器决定')); expect(hook.result.current.meetingExportPath).toBe('');
  });
  it('fences late export completion after switching from personal to organization scope', async () => {
    localStorage.setItem(keys('personal').notes, JSON.stringify(saved)); let finish!: (r: any) => void; m.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(({ scope }) => useHarness(scope), { initialProps: { scope: 'personal' } }); let pending!: Promise<void>;
    act(() => { pending = hook.result.current.downloadMeetingNotes(); }); await waitFor(() => expect(m.invoke).toHaveBeenCalled());
    hook.rerender({ scope: 'org-isolated' }); await act(async () => { finish({ success: true, path: 'D:/Downloads/private.md', readBackMatched: true }); await pending; });
    expect(hook.result.current.meetingExportPath).toBe(''); expect(hook.result.current.meetingExportBusy).toBe(false); expect(hook.result.current.meetingNotes).toEqual([]); expect(m.toast.success).not.toHaveBeenCalled();
  });
});
describe('full meeting workspace', () => {
  function props(theme: 'light' | 'dark' = 'light') { return { meetingNotesOpen: true, resolvedAppearanceMode: theme, operationMode: 'meeting', meetingPaused: true, callState: 'idle', callError: '', t: { thinking: '思考中', speaking: '播报中', passive: '待机' }, lang: 'zh', legalMeetingCaseTitle: 'Synthetic case', copyMeetingNotes: vi.fn(), downloadMeetingNotes: vi.fn(), setMeetingNotesOpen: vi.fn(), meetingNotes: [...saved].reverse(), meetingSpeakerCount: 0, meetingReportGenerating: false, meetingReport: 'Separate complete summary', formatMeetingTime: (n: number) => String(n), meetingNoteHasSpeakerInfo: () => false, meetingSpeakerLabel: () => '', toggleMeetingCapturePaused: vi.fn(), endMeetingAndReport: vi.fn(), clearMeetingNotes: vi.fn(), meetingExportPath: 'D:/Downloads/meeting.md', meetingExportBusy: false, meetingExportError: '', openMeetingExport: vi.fn() } as any; }
  it.each(['light', 'dark'] as const)('shows every entry in chronological order beside an independent summary in %s theme', theme => {
    render(renderMeetingWorkspace(props(theme))); const items = screen.getAllByRole('listitem'); expect(items).toHaveLength(125); expect(items[0].textContent).toContain('Synthetic original 0'); expect(items[124].textContent).toContain('Synthetic original 124'); expect(screen.getByText('Separate complete summary')).toBeTruthy(); expect(screen.getByRole('dialog').getAttribute('data-theme')).toBe(theme); expect(screen.getByText(/D:\/Downloads\/meeting.md/)).toBeTruthy();
  });
  it('selects a historical record by an accessible control and leaves it readable and exportable', () => {
    const p = props(); p.meetingHistory = [{id:'old-a',startedAt:1000,notes:saved,report:'Stored summary',caseId:'',caseTitle:'Saved meeting',readOnly:true}]; p.meetingRecordId = 'old-a'; p.meetingHistoryReadOnly = true; p.selectMeetingHistoryRecord = vi.fn(); p.importMeetingHistoryFile = vi.fn();
    render(renderMeetingWorkspace(p)); const select = screen.getByLabelText('会议记录') as HTMLSelectElement; expect(select.value).toBe('old-a'); fireEvent.change(select,{target:{value:'old-a'}}); expect(p.selectMeetingHistoryRecord).toHaveBeenCalledWith('old-a');
    expect((screen.getByText('继续录音') as HTMLButtonElement).disabled).toBe(true); expect((screen.getByText('结束录音并整理') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('保存记录与总结') as HTMLButtonElement).disabled).toBe(false); expect((screen.getByText('新建记录') as HTMLButtonElement).disabled).toBe(false); expect(screen.getByLabelText('导入恢复记录')).toBeTruthy();
  });
  it('leaves the finish control available during an active recording with no recognized text', () => {
    const p = props(); p.meetingNotes = []; p.meetingReport = ''; p.meetingPaused = false; p.callState = 'listening'; render(renderMeetingWorkspace(p));
    const finish = screen.getByText('结束录音并整理') as HTMLButtonElement; expect(finish.disabled).toBe(false); fireEvent.click(finish); expect(p.endMeetingAndReport).toHaveBeenCalledOnce();
  });
  it.each([['connecting','正在连接麦克风'],['idle','正在连接麦克风'],['thinking','思考中'],['speaking','播报中'],['passive','待机']])('does not call %s recording', (callState, label) => {
    const p = props(); p.meetingPaused = false; p.callState = callState; p.meetingReport = ''; render(renderMeetingWorkspace(p)); expect(screen.getByText(label)).toBeTruthy(); expect(screen.queryByText('录音中')).toBeNull();
  });
  it('shows the existing capture error instead of recording success', () => {
    const p = props(); p.meetingPaused = true; p.callState = 'idle'; p.callError = 'Synthetic microphone denied'; render(renderMeetingWorkspace(p)); expect(screen.getByText('录音未连接')).toBeTruthy(); expect(screen.getByRole('alert').textContent).toContain('Synthetic microphone denied'); expect(screen.queryByText('录音中')).toBeNull();
  });
  it('keeps close-page, recording, save and opening actions distinct', () => {
    const p = props(); render(renderMeetingWorkspace(p)); fireEvent.click(screen.getByText('关闭会议页面')); expect(p.setMeetingNotesOpen).toHaveBeenCalledWith(false); expect(p.toggleMeetingCapturePaused).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('继续录音')); expect(p.toggleMeetingCapturePaused).toHaveBeenCalledOnce(); fireEvent.click(screen.getByText('打开文件夹')); expect(p.openMeetingExport).toHaveBeenCalledWith(true); expect((screen.getByText('结束录音并整理') as HTMLButtonElement).disabled).toBe(true);
  });
});


describe('meeting history controls use the real mounted workflow', () => {
  it('keeps the complete previous meeting selectable after New record and restores it read-only', () => {
    localStorage.setItem(keys('personal').notes, JSON.stringify(saved)); localStorage.setItem(keys('personal').report, 'Original full summary');
    const hook = renderHook(() => useHarness('personal')); const previousId = hook.result.current.meetingRecordId;
    vi.spyOn(window, 'confirm').mockReturnValue(true); act(() => hook.result.current.clearMeetingNotes());
    expect(hook.result.current.meetingNotes).toEqual([]); expect(hook.result.current.meetingRecordId).not.toBe(previousId);
    expect(hook.result.current.meetingHistory.find(record => record.id === previousId)?.notes).toHaveLength(125);
    act(() => hook.result.current.selectMeetingHistoryRecord(previousId));
    expect(hook.result.current.meetingNotes[0].text).toBe('Synthetic original 0'); expect(hook.result.current.meetingNotes.at(-1)?.text).toBe('Synthetic original 124'); expect(hook.result.current.meetingReport).toBe('Original full summary');
    expect(hook.result.current.meetingHistoryReadOnly).toBe(true); expect(hook.result.current.meetingPaused).toBe(true);
    act(() => hook.result.current.toggleMeetingCapturePaused()); expect(hook.result.current.meetingPaused).toBe(true);
  });
  it('does not replace a record or allow a second summary while it is still organizing', async () => {
    localStorage.setItem(keys('personal').notes, JSON.stringify(saved)); const hook = renderHook(() => useHarness('personal'));
    act(() => hook.result.current.setMeetingReportGenerating(true)); const id = hook.result.current.meetingRecordId;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true); act(() => hook.result.current.clearMeetingNotes());
    expect(confirm).not.toHaveBeenCalled(); expect(hook.result.current.meetingRecordId).toBe(id); expect(hook.result.current.meetingNotes).toHaveLength(125);
  });
  it('does not import a late file into a different owner or organization scope', async () => {
    let finish!: (text: string) => void; const file = { text: () => new Promise<string>(resolve => { finish = resolve; }) } as File;
    const hook = renderHook(({scope}) => useHarness(scope), {initialProps:{scope:'personal'}});
    let pending!: Promise<void>; act(() => { pending = hook.result.current.importMeetingHistoryFile(file); });
    hook.rerender({scope:'organization'}); await act(async () => { finish(JSON.stringify({scope:'personal',records:[]})); await pending; });
    expect(hook.result.current.meetingNotes).toEqual([]); expect(m.toast.success).not.toHaveBeenCalled();
  });
});


it('starts a new case-B consultation without retitling the saved case-A record', async () => {
  const hook = renderHook(() => useHarness('personal')); act(() => hook.result.current.bindMeetingCase('case-A', 'Case A original title')); act(() => hook.result.current.setMeetingNotes(saved)); const firstId = hook.result.current.meetingRecordId;
  act(() => hook.result.current.selectMeetingRecord(firstId)); const reject = vi.fn();
  act(() => window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode', {detail:{confirmed:true,legalCaseId:'case-B',legalCaseTitle:'Case B title',reject}})));
  expect(reject).not.toHaveBeenCalled(); expect(hook.result.current.meetingCaseId).toBe('case-B'); expect(hook.result.current.meetingNotes).toEqual([]);
  expect(hook.result.current.meetingHistory.find(record => record.id === firstId)).toMatchObject({caseId:'case-A',caseTitle:'Case A original title',notes:saved});
  act(() => hook.result.current.selectMeetingRecord(firstId)); await act(async () => hook.result.current.downloadMeetingNotes()); const args = m.invoke.mock.calls.find(x => x[0] === 'write_text_file')![1]; expect(args.content).toContain('Case A original title'); expect(args.content).not.toContain('Case B title');
});

describe('explicit history-to-case archive uses actual acknowledgement', () => {
  it('archives a previously unlinked read-only record to the selected case without another model call', async () => {
    m.cases = [{id:'target-case',title:'Target case'}]; localStorage.setItem(keys('personal').notes,JSON.stringify(saved)); localStorage.setItem(keys('personal').report,'Existing real summary');
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ok:true,caseId:'target-case',caseFile:{id:'target-case',materials:[{id:'raw',source:'import'},{id:'summary',source:'tool'}]},materialIds:{transcript:'raw',minutes:'summary'}}),{status:200})); vi.stubGlobal('fetch',fetchMock);
    const hook = renderHook(() => useHarness('personal')); await act(async () => hook.result.current.openMeetingModeWithConfirm()); act(() => hook.result.current.setMeetingArchiveTargetId('target-case'));
    expect(hook.result.current.meetingCaseId).toBe(''); await act(async () => hook.result.current.saveMeetingToCase());
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][0]).toBe('/api/meeting/archive'); const body=JSON.parse((fetchMock.mock.calls[0] as any)[1].body); expect(body.notes).toHaveLength(125); expect(body.report).toBe('Existing real summary'); expect(body.legalCase.id).toBe('target-case');
    expect(hook.result.current.meetingArchiveReceipt?.caseId).toBe('target-case'); expect(hook.result.current.meetingHistoryReadOnly).toBe(true); expect(hook.result.current.meetingNotes).toHaveLength(125);
    await act(async () => hook.result.current.saveMeetingToCase()); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not claim that the selected case was saved when the response belongs to another case', async () => {
    m.cases = [{id:'target-case',title:'Target case'}]; localStorage.setItem(keys('personal').notes,JSON.stringify(saved)); vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({ok:true,caseId:'wrong-case',caseFile:{id:'wrong-case',materials:[]},materialIds:{transcript:'raw',minutes:'summary'}}),{status:200})));
    const hook = renderHook(() => useHarness('personal')); await act(async () => hook.result.current.openMeetingModeWithConfirm()); act(() => hook.result.current.setMeetingArchiveTargetId('target-case')); await act(async () => hook.result.current.saveMeetingToCase());
    expect(hook.result.current.meetingArchiveReceipt).toBeNull(); expect(hook.result.current.meetingCaseId).toBe(''); expect(hook.result.current.meetingArchiveError).toContain('尚未确认入案成功');
  });
});

describe('meeting entry with an optional case title', () => {
  it('resolves a personal case ID before preserving a history and preparing its new meeting', () => {
    m.cases = [{id:'case-id-only',title:'Known title'}]; localStorage.setItem(keys('personal').notes,JSON.stringify(saved)); localStorage.setItem(keys('personal').report,'Preserve report');
    const hook=renderHook(()=>useHarness('personal')); const previous=hook.result.current.meetingRecordId,respond=vi.fn(),reject=vi.fn();
    act(()=>window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode',{detail:{confirmed:true,legalCaseId:'case-id-only',respond,reject}})));
    expect(reject).not.toHaveBeenCalled(); expect(respond).toHaveBeenCalledWith(expect.objectContaining({caseId:'case-id-only',status:'ready'})); expect(hook.result.current.legalMeetingCaseTitle).toBe('Known title'); expect(hook.result.current.meetingHistory.find(item=>item.id===previous)?.report).toBe('Preserve report');
  });
  it('resolves a work case from the authenticated case endpoint when the page was closed',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({id:'work-id-only',title:'Work known title'}),{status:200})));
    const hook=renderHook(()=>useHarness('work')),respond=vi.fn(),reject=vi.fn();
    await act(async()=>{window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode',{detail:{confirmed:true,legalCaseId:'work-id-only',respond,reject}}));});
    expect(reject).not.toHaveBeenCalled(); expect(hook.result.current.meetingCaseId).toBe('work-id-only'); expect(hook.result.current.legalMeetingCaseTitle).toBe('Work known title'); expect(hook.result.current.meetingPaused).toBe(true); expect(fetch).toHaveBeenCalledWith('/api/org/legal/cases/work-id-only',undefined);
  });
  it('reports missing case metadata explicitly without opening or changing the record',()=>{
    const hook=renderHook(()=>useHarness('personal')),record=hook.result.current.meetingRecordId,reject=vi.fn();
    act(()=>window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode',{detail:{confirmed:true,legalCaseId:'unknown',reject}})));
    expect(reject).toHaveBeenCalledWith(expect.stringContaining('未找到该案件的名称')); expect(hook.result.current.meetingRecordId).toBe(record); expect(hook.result.current.meetingNotesOpen).toBe(false);
  });
  it('shows analysis failure as an alert rather than a completed summary',()=>{
    const p:any={meetingNotesOpen:true,resolvedAppearanceMode:'light',operationMode:'assistant',meetingPaused:true,callState:'idle',callError:'',lang:'zh',t:{},meetingNotes:saved,meetingHistory:[],meetingReport:'',meetingReportError:'会议分析未完成，原文保留',meetingReportGenerating:false,formatMeetingTime:String,meetingNoteHasSpeakerInfo:()=>false,meetingSpeakerLabel:()=>'',meetingCaseOptions:[],setMeetingArchiveTargetId:vi.fn()};
    render(renderMeetingWorkspace(p)); expect(screen.getByRole('alert').textContent).toContain('会议分析未完成'); expect(screen.getByText('未生成整理')).toBeTruthy(); expect(screen.queryByText('已整理')).toBeNull();
  });
});
