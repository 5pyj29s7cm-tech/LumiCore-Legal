// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useMeetingTranscript } from '../src/components/desktop/useMeetingTranscript';
import { addDays } from '../src/components/org/legal_hub/case_values';
const messages = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: messages }));
vi.mock('../src/lib/legalCaseStore', () => ({ getLegalCaseLabel: () => '', getLegalConsultationCase: () => null, getLegalConsultationCaseId: () => '', setLegalConsultationCaseId: vi.fn(), clearLegalConsultationCaseId: vi.fn() }));
const keys = (scope: string) => ({ identity: 'meeting-identity-'+scope, startedAt: 'meeting-started-'+scope, notes: 'meeting-notes-'+scope, report: 'meeting-report-'+scope });
const stored = (scope: string) => { const history = JSON.parse(localStorage.getItem(keys(scope).notes+'_history')!); return history.records.find((record: any) => record.id === history.activeId); };
const input = (scope: string, workDomain: 'personal' | 'work' = 'personal') => ({ workDomain, meetingStorageKeys: keys(scope), meetingPreferenceScopeKey: scope, operationMode: 'meeting' as const, lang: 'en' as const, socket: null as any });
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('complete scoped meeting persistence', () => {
  it('preserves early notes and every speaker through a reload after more than 300 turns', () => {
    const first = renderHook(() => useMeetingTranscript(input('owner')));
    act(() => first.result.current.setMeetingPaused(false));
    act(() => { for (let i=0;i<360;i++) first.result.current.appendMeetingTranscript('Synthetic turn '+i, true, {speakerLabel: i % 2 ? 'Speaker B' : 'Speaker A', speakerMatched: true}); });
    expect(first.result.current.meetingNotes).toHaveLength(360);
    expect(stored('owner').notes).toHaveLength(360);
    first.unmount();
    const resumed = renderHook(() => useMeetingTranscript(input('owner')));
    expect(resumed.result.current.meetingNotes[0].text).toBe('Synthetic turn 0');
    expect(resumed.result.current.meetingNotes.at(-1)?.text).toBe('Synthetic turn 359');
    expect(resumed.result.current.meetingSpeakerCount).toBe(2);
  });
  it('retains the complete saved prefix and pauses instead of dropping transcript when storage fails', () => {
    const meeting = renderHook(() => useMeetingTranscript(input('quota')));
    act(() => meeting.result.current.setMeetingPaused(false));
    act(() => meeting.result.current.appendMeetingTranscript('Saved complete first turn', true));
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) { if (key === keys('quota').notes+'_history') throw new DOMException('Test quota exceeded', 'QuotaExceededError'); return originalSetItem.call(this, key, value); });
    act(() => meeting.result.current.appendMeetingTranscript('Unsaved last turn kept in memory', true));
    expect(meeting.result.current.meetingNotes.map(note => note.text)).toEqual(['Saved complete first turn', 'Unsaved last turn kept in memory']);
    expect(stored('quota').notes).toHaveLength(1);
    expect(meeting.result.current.meetingPaused).toBe(true);
    expect(messages.error).toHaveBeenCalledWith(expect.stringMatching(/paused.*export/i));
    act(() => meeting.result.current.appendMeetingTranscript('Must not capture after pause', true));
    expect(meeting.result.current.meetingNotes).toHaveLength(2);
  });
  it('does not restore a personal meeting into an organization scope', () => {
    localStorage.setItem(keys('private').notes, JSON.stringify([{id:'p',text:'PRIVATE',time:1}]));
    const hook = renderHook(({scope,domain}) => useMeetingTranscript(input(scope,domain)), {initialProps:{scope:'private',domain:'personal' as 'personal'|'work'}});
    expect(hook.result.current.meetingNotes[0].text).toBe('PRIVATE');
    hook.rerender({scope:'org-a',domain:'work'});
    expect(hook.result.current.meetingNotes).toEqual([]);
    act(() => hook.result.current.setMeetingPaused(false));
    act(() => hook.result.current.appendMeetingTranscript('ORG ONLY',true));
    expect(localStorage.getItem(keys('private').notes)).toContain('PRIVATE');
    expect(stored('org-a').notes.map((note: any) => note.text)).toEqual(['ORG ONLY']);
  });
});
describe('calendar date suggestions', () => {
  it.each(['Asia/Shanghai','America/New_York','UTC'])('adds calendar days without timezone drift in %s', zone => {
    const previous = process.env.TZ;
    try { process.env.TZ = zone; expect(addDays('2026-10-13',15)).toBe('2026-10-28'); expect(addDays('2026-03-01',15)).toBe('2026-03-16'); expect(addDays('2024-02-28',1)).toBe('2024-02-29'); expect(addDays('2026-12-31',1)).toBe('2027-01-01'); }
    finally { if(previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('keeps missing or invalid dates unfilled', () => { expect(addDays('',15)).toBe(''); expect(addDays('not-a-date',15)).toBe(''); });
});
