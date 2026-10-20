import { setLegalCaseAccount } from '../src/lib/legalCaseStore';
// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegalCaseWorkspace } from '../src/components/org/legal_hub/workspace';
import { useLegalCaseWorkspaceState } from '../src/components/org/legal_hub/useLegalCaseWorkspaceState';
import { buildLegalCaseKnowledgeMarkdown, legalCaseDraftContext, legalCaseToolArgs } from '../src/components/org/legal_hub/case_values';
import { createEmptyLegalCase, getLegalCaseById, mergePersonalLegalCaseRuntimeSnapshot, readLegalCaseFiles, syncPersonalLegalCaseToRuntime, updateLegalCase, writeLegalCaseFiles, type LegalCaseFile } from '../src/lib/legalCaseStore';
import { setLocale } from '../src/i18n/runtime';

vi.mock('../src/contexts/AppContext', () => ({
  useApp: () => ({ workDomain: 'personal', orgConnection: null, user: { uid: 'fact-date-ui-test' } }),
}));

type WorkspaceProps = Parameters<typeof LegalCaseWorkspace>[0];
function propsFor(activeCase: LegalCaseFile): WorkspaceProps {
  return {
    caseFilter: '', setCaseFilter: vi.fn(), cases: [activeCase], activeCase,
    onCreateCase: vi.fn(), onDeleteCase: vi.fn(), onSelectCase: vi.fn(),
    onUpdateCase: vi.fn(() => true), onSetView: vi.fn(), onStartConsultation: vi.fn(),
    onOpenMeetingNotes: vi.fn(), onCreateReminder: vi.fn(), onCreatePlan: vi.fn(),
    onAddMaterial: vi.fn(() => true), onRefreshCases: vi.fn(),
    orgBacked: false, canDeleteCases: false, refreshing: false,
  };
}

beforeEach(() => {
  localStorage.clear(); setLegalCaseAccount('focused-legal-owner'); sessionStorage.clear(); setLocale('en');
  localStorage.setItem('lumi_work_domain', 'personal');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests are forbidden in this regression'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('legal case fact date UI', () => {
  it('accepts the fact date through the existing date field and saves, reloads and syncs it', async () => {
    const initial = { ...createEmptyLegalCase(), id: 'date-ui', title: 'Date regression' };
    writeLegalCaseFiles([initial], initial.id);
    function WorkspaceHarness() {
      const [activeCase, setActiveCase] = useState(readLegalCaseFiles()[0]);
      return <LegalCaseWorkspace {...propsFor(activeCase)} onUpdateCase={(id, patch) => {
        const updated = updateLegalCase(id, patch);
        if (updated) setActiveCase(updated);
        return Boolean(updated);
      }} />;
    }
    const view = render(<WorkspaceHarness />);
    const input = screen.getByLabelText('Key fact occurrence date') as HTMLInputElement;
    expect(input.type).toBe('date');
    fireEvent.change(input, { target: { value: '2019-01-01' } });
    expect(input.value).toBe('2019-01-01');
    const saved = getLegalCaseById(initial.id)!;
    expect(saved.factDate).toBe('2019-01-01');
    expect(saved.hearingDate).toBe('');
    view.unmount();
    render(<WorkspaceHarness />);
    expect((screen.getByLabelText('Key fact occurrence date') as HTMLInputElement).value).toBe('2019-01-01');

    const request = vi.mocked(fetch).mockImplementationOnce(async (url, init) => {
      expect(String(url)).toContain('/api/legal/client-case-sync');
      expect(JSON.parse(String(init?.body)).case.factDate).toBe('2019-01-01');
      return new Response(JSON.stringify({ case: { ...saved, updatedAt: '2099-01-01', factDate: '2019-01-01' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await syncPersonalLegalCaseToRuntime(saved);
    expect(request).toHaveBeenCalledTimes(1);
    const reloaded = readLegalCaseFiles()[0];
    expect(reloaded.factDate).toBe('2019-01-01');
    expect(buildLegalCaseKnowledgeMarkdown(reloaded)).toContain('Key fact occurrence date: 2019-01-01');
    expect(legalCaseDraftContext(reloaded)).toContain('Key fact occurrence date: 2019-01-01');
    expect(legalCaseToolArgs(reloaded).factDate).toBe('2019-01-01');
  });

  it('normalizes legacy cases and preserves the fact date when a runtime snapshot omits it', () => {
    expect(createEmptyLegalCase().factDate).toBe('');
    const saved = { ...createEmptyLegalCase(), id: 'date-merge', factDate: '2019-01-01', updatedAt: '2026-01-01' };
    writeLegalCaseFiles([saved], saved.id);
    const { factDate: _ignored, ...legacy } = saved;
    expect(mergePersonalLegalCaseRuntimeSnapshot({ ...legacy, updatedAt: '2026-02-01' })?.factDate).toBe('2019-01-01');
    expect(mergePersonalLegalCaseRuntimeSnapshot({ ...saved, factDate: '', updatedAt: '2026-03-01' })?.factDate).toBe('');
    writeLegalCaseFiles([legacy as LegalCaseFile]);
    expect(readLegalCaseFiles()[0].factDate).toBe('');
  });

  it('does not turn an ordinary payment date into the hearing date', async () => {
    const activeCase = { ...createEmptyLegalCase(), id: 'payment-date', hearingDate: '2026-11-01', factDate: '2019-01-01' };
    const props = propsFor(activeCase);
    const hook = renderHook(() => useLegalCaseWorkspaceState(props));
    act(() => hook.result.current.setNoticeText('付款凭据：2020年1月1日支付价款，双方约定按期交货。'));
    await act(async () => { await hook.result.current.extractNotice(new AbortController().signal); });
    expect(props.onUpdateCase).not.toHaveBeenCalled();
    expect(activeCase.hearingDate).toBe('2026-11-01');
    expect(activeCase.factDate).toBe('2019-01-01');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    '本院定于2026年10月21日9时30分在第三法庭开庭审理。',
    '开庭日期：2026-10-21。付款日期为2020-01-01。',
    '请于2026年10月21日09时30分开庭。',
    '付款凭据：2020年1月1日支付价款；本院定于2026年10月21日开庭。',
  ])('extracts the date from an explicit hearing statement: %s', async text => {
    const props = propsFor({ ...createEmptyLegalCase(), id: 'hearing-date' });
    const hook = renderHook(() => useLegalCaseWorkspaceState(props));
    act(() => hook.result.current.setNoticeText(text));
    await act(async () => { await hook.result.current.extractNotice(new AbortController().signal); });
    expect(vi.mocked(props.onUpdateCase).mock.calls[0][1].hearingDate).toBe('2026-10-21');
    expect(fetch).not.toHaveBeenCalled();
  });
});
