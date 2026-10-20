// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LegalKnowledgeSyncView } from '../src/components/org/legal_hub/knowledge_sync';
import { createEmptyLegalCase } from '../src/lib/legalCaseStore';
const fixture = vi.hoisted(() => ({ net: vi.fn(), uid: 'owner', domain: 'personal', orgId: 'org-a' }));
vi.mock('../src/services/apiClient', () => ({ apiJson: fixture.net }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: fixture.uid }, workDomain: fixture.domain, orgConnection: { orgId: fixture.orgId } }) }));
vi.mock('../src/components/org/LegalCaseContextBar', () => ({ LegalCaseContextBar: ({ state }: any) => <div data-testid="context-state">{state}</div> }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key.split('.')[1] }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const item = () => ({ ...createEmptyLegalCase(), id: 'case-a', title: '虚构案件' });
const entry = (domain = 'personal', orgId?: string) => ({ id: 'archive-a', name: 'legal-case-case-a.md', domain, orgId, updatedAt: '2026-10-15T04:00:00Z' });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { fixture.net.mockReset(); fixture.uid = 'owner'; fixture.domain = 'personal'; fixture.orgId = 'org-a'; });
afterEach(cleanup);
it('reads the exact saved case archive on reopen without replaying sync or claiming a new result', async () => {
  fixture.net.mockResolvedValue({ files: [entry()] });
  const first = render(<LegalKnowledgeSyncView caseFile={item()} />);
  await screen.findByText(/知识库已有此案件归档/);
  expect(screen.getByTestId('context-state').textContent).toBe('input');
  first.unmount(); render(<LegalKnowledgeSyncView caseFile={item()} />); await screen.findByText(/知识库已有此案件归档/);
  expect(fixture.net).toHaveBeenCalledTimes(2); expect(fixture.net.mock.calls.every(([url]) => url.startsWith('/api/files/list?domain=personal'))).toBe(true);
});
it('does not substitute another case or domain archive for the current case', async () => {
  fixture.net.mockResolvedValue({ files: [entry('work', 'org-a'), { ...entry(), name: 'legal-case-case-b.md' }] });
  render(<LegalKnowledgeSyncView caseFile={item()} />); await act(async () => { await Promise.resolve(); });
  expect(screen.queryByText(/知识库已有此案件归档/)).toBeNull(); expect(screen.getByTestId('context-state').textContent).toBe('input');
});
it('drops a late personal response after switching to another organization', async () => {
  const old = deferred(); fixture.net.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ files: [] });
  const view = render(<LegalKnowledgeSyncView caseFile={item()} />); const oldSignal = fixture.net.mock.calls[0][1].signal;
  fixture.domain = 'work'; fixture.orgId = 'org-b'; view.rerender(<LegalKnowledgeSyncView caseFile={item()} />);
  await act(async () => old.resolve({ files: [entry()] }));
  expect(oldSignal.aborted).toBe(true); expect(screen.queryByText(/知识库已有此案件归档/)).toBeNull(); expect(fixture.net.mock.calls[1][0]).toContain('domain=work&orgId=org-b');
});
it('keeps an archive lookup error distinct from a sync success', async () => {
  fixture.net.mockRejectedValueOnce(new Error('lookup unavailable'));
  render(<LegalKnowledgeSyncView caseFile={item()} />); await screen.findByText(/暂时无法核对知识库/);
  expect(screen.getByTestId('context-state').textContent).toBe('input');
  expect((screen.getByRole('button', { name: 'sync-to-kb' }) as HTMLButtonElement).disabled).toBe(false);
});
