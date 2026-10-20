// @vitest-environment jsdom
import React from 'react';
import { LegalVerifyView } from '../src/components/org/legal_hub/verification';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLegalCaseWorkspaceState } from '../src/components/org/legal_hub/useLegalCaseWorkspaceState';
import { createEmptyLegalCase, type LegalCaseFile } from '../src/lib/legalCaseStore';
const mocks = vi.hoisted(() => ({ api: vi.fn(), sync: vi.fn(), tool: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ workDomain: 'personal', orgConnection: null, user: { uid: 'material-review-ui' } }) }));
vi.mock('../src/services/apiClient', () => ({ apiJson: mocks.api }));
vi.mock('../src/lib/legalCaseStore', async original => ({ ...await original<typeof import('../src/lib/legalCaseStore')>(), syncPersonalLegalCaseToRuntime: mocks.sync }));
vi.mock('../src/lib/legalToolClient', () => ({ runLegalTool: mocks.tool }));
const text = 'Complete synthetic document. '.repeat(1200) + 'FULL-TEXT-TAIL-712';
function fixture(): LegalCaseFile { return { ...createEmptyLegalCase(), id: 'review-ui-case', title: 'Synthetic', factDate: '2026-09-01', materials: [{ id: 'draft-ui', type: 'pleading', title: 'Synthetic draft', source: 'tool', createdAt: '2026-09-01', content: text }] }; }
function props(activeCase: LegalCaseFile) { return { activeCase, cases: [activeCase], caseFilter: '', setCaseFilter: vi.fn(), onCreateCase: vi.fn(), onDeleteCase: vi.fn(), onSelectCase: vi.fn(), onUpdateCase: vi.fn(() => true), onSetView: vi.fn(), onStartConsultation: vi.fn(), onOpenMeetingNotes: vi.fn(), onCreateReminder: vi.fn(), onCreatePlan: vi.fn(), onAddMaterial: vi.fn(() => true), onRefreshCases: vi.fn(), orgBacked: false, canDeleteCases: false, refreshing: false }; }
beforeEach(() => { mocks.api.mockReset(); mocks.sync.mockReset().mockResolvedValue(undefined); mocks.tool.mockReset().mockResolvedValue('Synthetic result');
  mocks.api.mockImplementation(async (_url: string, init?: RequestInit) => ({ revision: 'a'.repeat(64), status: init?.method === 'POST' ? JSON.parse(String(init.body)).decision : 'pending', scope: 'archived_text', reviewedAt: '2026-10-13T12:00:00Z', content: text })); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('material review interface ownership', () => {
  it('exports the complete selected document including the tail beyond 24000 characters', async () => {
    render(<LegalVerifyView caseFile={fixture()} />);
    fireEvent.change(screen.getByRole('combobox', { name: /^(?:文书来源|Document source)$/ }), { target: { value: 'draft-ui' } });
    fireEvent.click(screen.getByRole('button', { name: /^(?:文书核验|Document review)$/ }));
    await waitFor(() => expect(mocks.tool).toHaveBeenCalledTimes(1));
    expect(mocks.tool).toHaveBeenCalledTimes(1);
    expect(mocks.tool.mock.calls[0][0]).toBe('legal_finalize_delivery_package');
    expect(mocks.tool.mock.calls[0][1].content).toBe(text);
    expect(mocks.tool.mock.calls[0][1].content).toContain('FULL-TEXT-TAIL-712');
  });
  it('requires the explicit confirmation and does not cancel on timestamp-only refresh', async () => {
    const c = fixture(); const hook = renderHook(p => useLegalCaseWorkspaceState(props(p)), { initialProps: c }); act(() => hook.result.current.setSelectedMaterialId('draft-ui'));
    let pending: Promise<unknown>; act(() => { pending = hook.result.current.recordMaterialReview('confirmed'); });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(mocks.api.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
    hook.rerender({ ...c, updatedAt: '2099-01-01' });
    fireEvent.click(screen.getByRole('button', { name: '确认已复核本版本' }));
    await act(async () => { await pending!; });
    const writes = mocks.api.mock.calls.filter(c => c[1]?.method === 'POST'); expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1].body))).toEqual({ expectedRevision: 'a'.repeat(64), decision: 'confirmed' });
    expect(hook.result.current.materialReview?.status).toBe('confirmed'); expect(hook.result.current.reviewDocument.busy).toBe('');
  });
  it.each(['document', 'factDate', 'case'] as const)('cancels a pending confirmation after changing %s', async change => {
    const c = fixture(); const hook = renderHook(p => useLegalCaseWorkspaceState(props(p)), { initialProps: c }); act(() => hook.result.current.setSelectedMaterialId('draft-ui'));
    let pending: Promise<unknown>; act(() => { pending = hook.result.current.recordMaterialReview('confirmed'); });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    const changed = change === 'document' ? { ...c, materials: [{ ...c.materials[0], content: text + ' changed' }] } : change === 'factDate' ? { ...c, factDate: '2020-01-01' } : { ...c, id: 'other-case' };
    hook.rerender(changed); await act(async () => { await pending!; });
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(mocks.api.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
    expect(hook.result.current.reviewDocument.busy).toBe('');
  });
  it('does not confirm a backend document different from the displayed document', async () => {
    mocks.api.mockResolvedValue({ revision: 'a'.repeat(64), status: 'pending', scope: 'archived_text', content: 'Different draft' });
    const hook = renderHook(() => useLegalCaseWorkspaceState(props(fixture()))); act(() => hook.result.current.setSelectedMaterialId('draft-ui'));
    await act(async () => { await hook.result.current.recordMaterialReview('confirmed'); });
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(mocks.api.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
    expect(hook.result.current.reviewDocument.result).toContain('当前显示的正文与后台版本不一致');
  });
});
