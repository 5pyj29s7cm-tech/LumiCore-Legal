// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMeetingTranscript } from '../src/components/desktop/useMeetingTranscript';
import { useMeetingWorkflow } from '../src/components/desktop/useMeetingWorkflow';
const fixture = vi.hoisted(() => ({ cases: [] as any[], stop: vi.fn(), merge: vi.fn(), archive: vi.fn(), toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('sonner', () => ({ toast: fixture.toast }));
vi.mock('../src/services/apiBridge', () => ({ isTauriRuntime: () => false }));
vi.mock('../src/services/apiClient', () => ({ apiJson: async (url: string, options?: RequestInit) => { const result = await fetch(url, options); if (!result.ok) throw new Error('Request failed'); return result.json(); } }));
vi.mock('../src/lib/legalCaseStore', () => ({ getLegalCaseLabel: (item: any) => item?.title || '', getLegalCaseById: (id: string) => fixture.cases.find(item => item.id === id) || null, readLegalCaseFiles: () => fixture.cases, syncPersonalLegalCaseToRuntime: vi.fn(async () => {}), mergePersonalLegalCaseRuntimeSnapshot: fixture.merge }));
const keys = (scope: string) => ({ identity: scope + '-identity', startedAt: scope + '-started', notes: scope + '-notes', report: scope + '-report' });
function useHarness(scope: string) {
  const [mode, setMode] = useState<any>('assistant'), [pending, setPending] = useState<any>(null);
  const transcript = useMeetingTranscript({ workDomain: 'personal', meetingStorageKeys: keys(scope), meetingPreferenceScopeKey: scope, operationMode: mode, lang: 'zh', socket: null as any });
  const workflow = useMeetingWorkflow({ ...transcript, meetingStorageKeys: keys(scope), lang: 'zh', workDomain: 'personal', orgConnection: null, aiConfig: {}, stopMeetingAudio: fixture.stop, operationMode: mode, endCall: vi.fn(), callState: 'idle', setOperationMode: setMode, meetingStartAttemptRef: { current: 0 }, pendingOperationMode: pending, setPendingOperationMode: setPending } as any);
  return { ...transcript, ...workflow };
}
const notes = [{ id: 'original', time: 1000, text: '未经核实的虚构会议原句。' }];
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); fixture.cases = []; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(['scope', 'unmount'] as const)('cancels analysis on %s change without writing a late report or stopping another recording', async change => {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>(finish => { resolve = finish; })); vi.stubGlobal('fetch', fetchMock);
  const hook = renderHook(({ scope }) => useHarness(scope), { initialProps: { scope: 'personal-a' } }); act(() => hook.result.current.setMeetingNotes(notes));
  let pending!: Promise<void>; act(() => { pending = hook.result.current.endMeetingAndReport(); });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); const signal = (fetchMock.mock.calls[0] as any)[1].signal as AbortSignal;
  expect(signal).toBeInstanceOf(AbortSignal); expect(signal.aborted).toBe(false);
  if (change === 'scope') hook.rerender({ scope: 'personal-b' }); else hook.unmount();
  expect(signal.aborted).toBe(true); await act(async () => { resolve(new Response(JSON.stringify({ report: 'LATE-OLD-REPORT' }))); await pending; });
  expect(fixture.stop).toHaveBeenCalledTimes(1); expect(fixture.merge).not.toHaveBeenCalled(); expect(localStorage.getItem(keys('personal-a').notes + '_history')).toContain(notes[0].text);
  expect(localStorage.getItem(keys('personal-a').notes + '_history')).not.toContain('LATE-OLD-REPORT');
  if (change === 'scope') { expect(hook.result.current.meetingReport).toBe(''); expect(hook.result.current.meetingNotes).toEqual([]); }
});
it('keeps the same meeting alive when the panel closes and lets its subsequent archive use a fresh uncancelled owner', async () => {
  fixture.cases = [{ id: 'case-a', title: '虚构案件' }]; let resolve!: (response: Response) => void;
  const fetchMock = vi.fn((url: string, _options: RequestInit) => url === '/api/meeting/analyze' ? new Promise<Response>(finish => { resolve = finish; })
    : Promise.resolve(new Response(JSON.stringify({ ok: true, caseId: 'case-a', caseFile: { id: 'case-a', materials: [{ id: 'source' }, { id: 'minutes' }] }, materialIds: { transcript: 'source', minutes: 'minutes' }, summaryPresent: true })))); vi.stubGlobal('fetch', fetchMock);
  const hook = renderHook(() => useHarness('personal-a')); act(() => { hook.result.current.bindMeetingCase('case-a', '虚构案件'); }); act(() => hook.result.current.setMeetingNotes(notes));
  let pending!: Promise<void>; act(() => { pending = hook.result.current.endMeetingAndReport(); }); await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const analysisSignal = fetchMock.mock.calls[0][1].signal as AbortSignal; act(() => hook.result.current.setMeetingNotesOpen(false)); expect(analysisSignal.aborted).toBe(false);
  await act(async () => { resolve(new Response(JSON.stringify({ report: '已有完整总结，仍待律师核对。' }))); await pending; });
  expect(fetchMock).toHaveBeenCalledTimes(2); expect(fetchMock.mock.calls[1][0]).toBe('/api/meeting/archive'); const archiveSignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
  expect(archiveSignal).not.toBe(analysisSignal); expect(archiveSignal.aborted).toBe(false); expect(fixture.merge).toHaveBeenCalledTimes(1); expect(hook.result.current.meetingArchiveReceipt?.caseId).toBe('case-a'); expect(fixture.stop).toHaveBeenCalledTimes(1);
});
