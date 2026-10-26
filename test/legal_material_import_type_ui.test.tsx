// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LegalImportView } from '../src/components/org/legal_hub/material_import';
import { createEmptyLegalCase, readLegalCaseFiles, setLegalCaseAccount, writeLegalCaseFiles } from '../src/lib/legalCaseStore';

const fixture = vi.hoisted(() => ({ api: vi.fn(), lang: 'en' }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: 'import-owner' }, workDomain: 'personal', orgConnection: null }) }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: fixture.lang }) }));
vi.mock('../src/services/apiClient', () => ({ apiJson: fixture.api }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
const edit = (body: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value: body } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Import materials' }));
const lastArgs = () => JSON.parse(fixture.api.mock.calls.at(-1)![1].body).args;
beforeEach(() => {
  fixture.api.mockReset(); fixture.lang = 'en'; localStorage.clear(); setLegalCaseAccount('import-owner');
  fixture.api.mockResolvedValue({ text: 'Saved by intake', receipt: { ok: true }, verification: { status: 'verified' }, caseUpdates: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch is forbidden'); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  ['Deployment service proposal.pdf', 'Voice interface and desktop automation. No court content.'],
  ['Printer operating guide.txt', 'Press the power button. The separate appendix mentions a judgment sample.'],
  ['Quarterly expense review.docx', 'Budget 42000. This is a business worksheet and remains ordinary material.'],
])('keeps %s and complete text as general material without inferring judgment', async (name, original) => {
  const body = '# ' + name + '\n' + original + '\nEND-OF-ORIGINAL';
  render(<LegalImportView />); edit(body);
  expect((screen.getByRole('combobox', { name: 'Material type' }) as HTMLSelectElement).value).toBe('case_material');
  submit(); await screen.findByText('Saved by intake');
  expect(fixture.api).toHaveBeenCalledTimes(1);
  expect(fixture.api.mock.calls[0][0]).toBe('/api/legal/tool/legal_import_materials_to_kb');
  expect(lastArgs()).toEqual({ title: name, materialType: 'case_material', content: body });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['judgment', '# (2024) Jing 0101 Min Chu 815 judgment.pdf\nCourt judgment original text.\n判决如下：被告支付货款。'],
  ['contract', '# Equipment supply agreement.docx\nParty A and B original agreement.\nEND-AGREEMENT'],
])('uses the explicitly selected %s type and preserves its original filename and text', async (type, body) => {
  render(<LegalImportView />); edit(body);
  fireEvent.change(screen.getByRole('combobox', { name: 'Material type' }), { target: { value: type } });
  submit(); await screen.findByText('Saved by intake');
  expect(lastArgs()).toEqual({ title: body.split('\n')[0].slice(2), materialType: type, content: body });
  expect(fixture.api).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});

it('preserves a long supplied filename even when a later line contains a case number', async () => {
  const name = 'Complete original filename '.repeat(7) + '.pdf';
  const body = '# ' + name + '\nReference appendix: （2020）京0101民初321号\nFull text ends here.';
  render(<LegalImportView />); edit(body); submit(); await screen.findByText('Saved by intake');
  expect(lastArgs().title).toBe(name); expect(lastArgs().content).toBe(body); expect(lastArgs().materialType).toBe('case_material');
});

it('merges the single backend case update and sends persistence arguments without a duplicate material write', async () => {
  const current = { ...createEmptyLegalCase(), id: 'source-case', title: 'Current source case', updatedAt: '2026-10-25T01:00:00.000Z' };
  writeLegalCaseFiles([current]);
  const body = '# Procurement source.pdf\nOriginal procurement text.\nEND-SOURCE';
  const material = { id: 'server-owned-material', type: 'evidence' as const, title: 'Procurement source.pdf', content: body, source: 'manual' as const, createdAt: '2026-10-26T01:00:00.000Z' };
  fixture.api.mockResolvedValue({ text: 'Saved by intake', receipt: { ok: true }, verification: { status: 'verified' }, caseUpdates: [{ ...current, updatedAt: '2026-10-26T01:00:00.000Z', materials: [material] }] });
  const events = vi.spyOn(window, 'dispatchEvent');
  render(<LegalImportView caseFile={current} orgId="org-archive" />); edit(body); submit();
  await screen.findByText('Saved by intake');
  expect(lastArgs()).toMatchObject({ caseId: 'source-case', orgId: 'org-archive', persistCase: true, materialType: 'case_material', title: 'Procurement source.pdf', content: body });
  expect(readLegalCaseFiles()[0].materials).toEqual([material]);
  expect(fixture.api).toHaveBeenCalledTimes(1);
  expect(events.mock.calls.filter(([event]) => event.type === 'lumi:org-legal-cases-changed')).toHaveLength(1);
  events.mockRestore();
});

it.each(['legal_import_materials_to_kb', 'legal_import_judgment'])('restores %s history without executing, changing classification, or rewriting saved material', async tool => {
  const body = 'Original saved import receipt';
  const current: any = { ...createEmptyLegalCase(), id: 'saved-import', materials: [{ id: 'old-source', type: 'judgment', title: 'Original title', source: 'manual', content: 'Original body', createdAt: '2026-10-20T00:00:00.000Z' }], workflowRuns: [{ tool, displayText: body, status: 'imported', ok: true, checkedAt: '2026-10-20T00:00:00.000Z', materialIds: [], artifacts: [] }] };
  writeLegalCaseFiles([current]); const before = JSON.stringify(readLegalCaseFiles());
  const view = render(<LegalImportView caseFile={current} />);
  expect(screen.getByText(body)).toBeTruthy(); view.unmount(); render(<LegalImportView caseFile={current} />);
  expect(screen.getByText(body)).toBeTruthy(); expect(fixture.api).not.toHaveBeenCalled();
  expect(JSON.stringify(readLegalCaseFiles())).toBe(before); expect(fetch).not.toHaveBeenCalled();
});

it('keeps the editor and selected type on a metadata refresh and resets them when the owning case changes', () => {
  const current = { ...createEmptyLegalCase(), id: 'case-a' };
  const view = render(<LegalImportView caseFile={current} />); edit('Current original');
  fireEvent.change(screen.getByRole('combobox', { name: 'Material type' }), { target: { value: 'contract' } });
  view.rerender(<LegalImportView caseFile={{ ...current, title: 'Metadata refresh' }} />);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Current original');
  expect((screen.getByRole('combobox', { name: 'Material type' }) as HTMLSelectElement).value).toBe('contract');
  view.rerender(<LegalImportView caseFile={{ ...current, id: 'case-b' }} />);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  expect((screen.getByRole('combobox', { name: 'Material type' }) as HTMLSelectElement).value).toBe('case_material');
  expect(fixture.api).not.toHaveBeenCalled();
});
