import { setLegalCaseAccount } from '../src/lib/legalCaseStore';
// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLegalCaseWorkspaceState } from '../src/components/org/legal_hub/useLegalCaseWorkspaceState';
import { LegalCaseWorkspace } from '../src/components/org/legal_hub/workspace';
import { createEmptyLegalCase, getActiveLegalCaseId, mergePersonalLegalCaseRuntimeSnapshot, readLegalCaseFiles, writeLegalCaseFiles, updateLegalCase, type LegalCaseFile } from '../src/lib/legalCaseStore';
const mocks = vi.hoisted(() => ({ api: vi.fn(), sync: vi.fn(), tool: vi.fn(), domain: 'personal', orgId: '' }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ workDomain: mocks.domain, orgConnection: mocks.orgId ? { orgId: mocks.orgId } : null, user: { uid: 'material-remove-ui' } }) }));
vi.mock('../src/services/apiClient', () => ({ apiJson: mocks.api }));
vi.mock('../src/lib/legalCaseStore', async original => ({ ...await original<typeof import('../src/lib/legalCaseStore')>(), syncPersonalLegalCaseToRuntime: mocks.sync }));
vi.mock('../src/lib/legalToolClient', () => ({ runLegalTool: mocks.tool }));
function fixture(): LegalCaseFile { return { ...createEmptyLegalCase(), id: 'remove-ui-case', title: 'Synthetic unlink UI', factDate: '2026-09-01', materials: Array.from({ length: 10 }, (_,i) => ({ id: 'material-'+i, type: 'evidence', title: 'Synthetic source '+i, source: 'import', createdAt: '2026-09-01', content: 'ORIGINAL-'+i+'-TAIL' })) }; }
function props(activeCase: LegalCaseFile, onRemoveMaterial = vi.fn().mockResolvedValue(true)) { return { activeCase, cases: [activeCase], caseFilter: '', setCaseFilter: vi.fn(), onCreateCase: vi.fn(), onDeleteCase: vi.fn(), onSelectCase: vi.fn(), onUpdateCase: vi.fn(() => true), onSetView: vi.fn(), onStartConsultation: vi.fn(), onOpenMeetingNotes: vi.fn(), onCreateReminder: vi.fn(), onCreatePlan: vi.fn(), onAddMaterial: vi.fn(() => true), onRemoveMaterial, onRefreshCases: vi.fn(), orgBacked: false, canDeleteCases: false, refreshing: false }; }
beforeEach(() => { localStorage.clear(); setLegalCaseAccount('focused-legal-owner'); mocks.domain = 'personal'; mocks.orgId = ''; mocks.api.mockReset(); mocks.sync.mockReset().mockResolvedValue(undefined); mocks.tool.mockReset();
  mocks.api.mockImplementation(async (url: string) => { const id = decodeURIComponent(url.split('/materials/')[1]?.split('/')[0] || 'material-0'); return { revision: 'a'.repeat(64), status: 'pending', scope: 'archived_text', content: fixture().materials.find(m => m.id === id)?.content }; }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('case material removal interface', () => {
  it('shows all ten actual material controls in a scrollable list instead of hiding records after eight', () => {
    const mounted = render(<LegalCaseWorkspace {...props(fixture())} />);
    const last = screen.getByRole('button', { name: /Synthetic source 9/ }); expect(last).toBeTruthy(); expect(last.parentElement?.className).toContain('overflow-y-auto');
    fireEvent.click(last); expect(mounted.container.querySelector('pre')?.textContent).toBe('ORIGINAL-9-TAIL');
    expect(screen.getByRole('button', { name: '从案件移除' })).toBeTruthy();
  });
  it('requires explicit case-only impact confirmation and sends the current exact revision once', async () => {
    const p = props(fixture()); const hook = renderHook(() => useLegalCaseWorkspaceState(p)); act(() => hook.result.current.setSelectedMaterialId('material-0'));
    let pending: Promise<unknown>; act(() => { pending = hook.result.current.removeSelectedMaterial(); });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(screen.getByRole('alertdialog').textContent).toContain('知识库、磁盘原文件及已导出的文书会保留');
    expect(screen.getByRole('alertdialog').textContent).toContain('引用和人工复核需重新核验'); expect(p.onRemoveMaterial).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '从案件移除' })); await act(async () => { await pending!; });
    expect(p.onRemoveMaterial).toHaveBeenCalledTimes(1); expect(p.onRemoveMaterial.mock.calls[0].slice(0,3)).toEqual([p.activeCase.id, 'material-0', 'a'.repeat(64)]);
    expect(hook.result.current.reviewDocument.result).toContain('已从案件移除'); expect(mocks.sync).toHaveBeenCalledTimes(1);
  });
  it('keeps selection and materials when cancelled or removal fails', async () => {
    const p = props(fixture()); const hook = renderHook(() => useLegalCaseWorkspaceState(p)); act(() => hook.result.current.setSelectedMaterialId('material-0'));
    act(() => hook.result.current.setSelectedMaterialId('material-9'));
    let pending: Promise<unknown>; act(() => { pending = hook.result.current.removeSelectedMaterial(); });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy()); fireEvent.click(screen.getByRole('button', { name: '取消' })); await act(async () => { await pending!; });
    expect(p.onRemoveMaterial).not.toHaveBeenCalled(); expect(hook.result.current.selectedMaterialId).toBe('material-9');
    p.onRemoveMaterial.mockResolvedValue(false); act(() => { pending = hook.result.current.removeSelectedMaterial(); });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy()); fireEvent.click(screen.getByRole('button', { name: '从案件移除' })); await act(async () => { await pending!; });
    expect(hook.result.current.selectedMaterialId).toBe('material-9'); expect(p.activeCase.materials).toHaveLength(10); expect(hook.result.current.reviewDocument.result).toContain('当前记录已保留');
  });
  it.each(['case', 'domain', 'content'] as const)('cancels a pending confirmation on %s change', async change => {
    const p = props(fixture()); const hook = renderHook(value => useLegalCaseWorkspaceState(value), { initialProps: p }); act(() => hook.result.current.setSelectedMaterialId('material-0'));
    let pending: Promise<unknown>; act(() => { pending = hook.result.current.removeSelectedMaterial(); });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    if (change === 'domain') { mocks.domain = 'work'; mocks.orgId = 'other-org'; }
    hook.rerender(change === 'case' ? { ...p, activeCase: { ...p.activeCase, id: 'another-case' } } : change === 'content' ? { ...p, activeCase: { ...p.activeCase, materials: p.activeCase.materials.map((m,i) => i ? m : { ...m, content: 'CHANGED' }) } } : { ...p });
    await act(async () => { await pending!; }); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(p.onRemoveMaterial).not.toHaveBeenCalled();
  });
  it('does not expose removal without a write callback or remove a different backend revision', async () => {
    const p = props(fixture()); render(<LegalCaseWorkspace {...p} onRemoveMaterial={undefined} />); expect(screen.queryByRole('button', { name: '从案件移除' })).toBeNull(); cleanup();
    mocks.api.mockResolvedValue({ revision: 'b'.repeat(64), content: 'A DIFFERENT SOURCE' }); const hook = renderHook(() => useLegalCaseWorkspaceState(p)); act(() => hook.result.current.setSelectedMaterialId('material-0'));
    await act(async () => { await hook.result.current.removeSelectedMaterial(); }); expect(p.onRemoveMaterial).not.toHaveBeenCalled(); expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('unions server and local tombstones without reviving old text or switching the active case', () => {
    const c = fixture(), b = { ...fixture(), id: 'selected-other-case' }; const stale = { ...c, workflowRuns: [{ tool: 'synthetic', ok: true, status: 'generated', checkedAt: '2026-01-01', basis: 'old', materialIds: ['material-0'], artifacts: ['old.docx'], displayText: 'REMOVED-OLD-RESULT' }] };
    writeLegalCaseFiles([stale, b], b.id); const saved = mergePersonalLegalCaseRuntimeSnapshot({ ...c, materials: c.materials.slice(1), removedMaterialIds: ['material-0'], updatedAt: '2099-01-01' })!;
    expect(saved.materials.some(m => m.id === 'material-0')).toBe(false); expect(saved.workflowRuns || []).toEqual([]);
    for (const incoming of [stale, { ...stale, updatedAt: '2199-01-01', removedMaterialIds: [] }]) { const merged = mergePersonalLegalCaseRuntimeSnapshot(incoming)!; expect(merged.materials.some(m => m.id === 'material-0')).toBe(false); expect(merged.workflowRuns || []).toEqual([]); }
    expect(readLegalCaseFiles().find(item => item.id === c.id)?.removedMaterialIds).toEqual(['material-0']); expect(getActiveLegalCaseId()).toBe(b.id);
    const patched = updateLegalCase(c.id, { materials: stale.materials, removedMaterialIds: [], workflowRuns: stale.workflowRuns })!;
    expect(patched.materials.some(m => m.id === 'material-0')).toBe(false); expect(patched.workflowRuns || []).toEqual([]); expect(patched.removedMaterialIds).toEqual(['material-0']);
    localStorage.setItem('lumi_work_domain', 'work'); expect(mergePersonalLegalCaseRuntimeSnapshot(stale)).toBeNull(); localStorage.removeItem('lumi_work_domain'); expect(readLegalCaseFiles().find(item => item.id === c.id)?.removedMaterialIds).toEqual(['material-0']);
  });
});
