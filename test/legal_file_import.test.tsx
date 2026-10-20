// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LegalImportView } from '../src/components/org/legal_hub/material_import';
import { LegalContractReview } from '../src/components/org/LegalContractReview';
import { LegalBidWorkbench } from '../src/components/org/LegalBidWorkbench';
import { KnowledgeBase } from '../src/components/KnowledgeBase';
import { KnowledgeBaseBrowser } from '../src/components/org/KnowledgeBaseBrowser';
import { importKnowledgeFiles } from '../src/lib/knowledgeFileImport';
import { toast } from 'sonner';

const fixture = vi.hoisted(() => ({ net: vi.fn(), domain: 'personal', org: 'org-a', uid: 'local' }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: fixture.uid }, workDomain: fixture.domain, orgConnection: { orgId: fixture.org } }) }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en', legalImportJudgment: 'Import judgment', legalContractReviewReview: 'Review', legalBidGenGenerate: 'Generate' }) }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('../src/components/MemoryTree', () => ({ MemoryTreeScene: () => null, layoutTree3D: () => ({ nodes: [], curves: [] }) }));
vi.mock('../src/components/NodeDetailPanel', () => ({ NodeDetailPanel: () => null }));
vi.mock('../src/services/apiClient', async () => ({ apiFetch: fixture.net, apiJson: (await import('./source_expression')).extractSourceExpression('src/services/apiClient.ts', 'apiJson', { apiFetch: fixture.net }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
const reply = (data: any, status = 200) => ({ ok: status < 400, status, json: async () => data });
function deferred() { let resolve!: (data: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { resolve, promise }; }
const text = 'Synthetic judgment. '.repeat(1200) + 'END-OF-ORIGINAL';
const file = () => new File(['synthetic'], 'judgment.docx');
const zone = () => document.querySelector('[data-lumi-file-drop]') as HTMLDivElement;
const choose = () => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file()] } });
const dropFile = () => fireEvent.drop(zone(), { dataTransfer: { types: ['Files'], files: [file()] } });
const uploads = () => fixture.net.mock.calls.filter(([url]) => /\/files\/(upload|import-paths)/.test(String(url)));
beforeEach(() => {
  fixture.domain = 'personal'; fixture.uid = 'local'; fixture.org = 'org-a'; localStorage.clear();
  fixture.net.mockImplementation(async (url: string) => {
    if (/\/files\/(upload|import-paths)/.test(url)) return reply({ files: [{ id: 'source.docx', name: 'judgment.docx', preview: 'PREVIEW-ONLY' }] });
    if (url.includes('/files/text/')) return reply({ text, truncated: false });
    if (url.includes('/legal/tool/')) return reply({ text: 'Imported', receipt: { ok: true }, verification: { status: 'verified' } });
    if (url.endsWith('/org/kb/articles')) return reply([]);
    if (url.endsWith('/org/kb/stats')) return reply(null);
    return reply({ files: [], tree: [], vaults: [] });
  });
  vi.stubGlobal('fetch', fixture.net);
});
afterEach(() => { cleanup(); document.querySelectorAll('[data-lumi-file-drop]').forEach(node => node.remove()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); });

it.each(['chooser', 'drop-zone', 'drop-textarea'])('imports judgment through %s and sends full original text to the existing tool and case archive', async kind => {
  const archived = vi.fn(async () => true);
  render(<StrictMode><LegalImportView caseFile={{ id: 'case-a', title: 'Synthetic', materials: [] } as any} onAddMaterial={archived} /></StrictMode>);
  if (kind === 'chooser') choose();
  else if (kind === 'drop-zone') dropFile();
  else fireEvent.drop(document.querySelector('textarea')!, { dataTransfer: { types: ['Files'], files: [file()] } });
  expect(uploads()[0][1].body).toBeInstanceOf(FormData);
  expect(uploads()[0][1].body.getAll('files').map((entry: File) => entry.name)).toEqual(['judgment.docx']);
  expect(uploads()[0][0]).not.toContain('import-paths');
  await waitFor(() => expect(document.querySelector('textarea')!.value).toBe('# judgment.docx\n' + text));
  expect(uploads()).toHaveLength(1); expect(uploads()[0][0]).toContain('domain=personal');
  fireEvent.click(screen.getByRole('button', { name: 'Import judgment' }));
  await waitFor(() => expect(archived).toHaveBeenCalledOnce());
  const tool = fixture.net.mock.calls.find(([url]) => url.includes('/legal/tool/'))!;
  expect(JSON.parse(tool[1].body).args.content).toBe('# judgment.docx\n' + text);
  expect(archived.mock.calls[0]).toEqual(['judgment', expect.any(String), '# judgment.docx\n' + text, 'import']);
});

it.each(['contract', 'bid'])('supports file drop into the %s source pane without using its preview', async kind => {
  fixture.domain = 'work'; render(kind === 'contract' ? <LegalContractReview /> : <LegalBidWorkbench />);
  fireEvent.drop(document.querySelector('textarea')!, { dataTransfer: { types: ['Files'], files: [file()] } });
  await waitFor(() => expect(document.querySelector('textarea')!.value).toContain('END-OF-ORIGINAL'));
  expect(uploads()[0][0]).toContain('domain=work&orgId=org-a');
  expect(document.querySelector('textarea')!.value).not.toContain('PREVIEW-ONLY');
});

it('does not let background chat or another pane receive a document-zone drop', async () => {
  const chatImports = vi.fn(), otherImports = vi.fn();
  render(<div onDrop={chatImports}><LegalImportView /><div data-testid="other-pane" onDrop={otherImports} /></div>);
  fireEvent.drop(document.querySelector('textarea')!, { dataTransfer: { types: ['Files'], files: [file()] } });
  await waitFor(() => expect(uploads()).toHaveLength(1));
  expect(chatImports).not.toHaveBeenCalled(); expect(otherImports).not.toHaveBeenCalled();
});

it.each(['case', 'account', 'organization', 'domain', 'close'])('cancels old import work after changing %s and does not append or archive stale content', async change => {
  if (change === 'organization') fixture.domain = 'work';
  const pending = deferred(); fixture.net.mockImplementationOnce(() => pending.promise);
  const archived = vi.fn(async () => true), props = { caseFile: { id: 'a', materials: [] } as any, onAddMaterial: archived };
  const view = render(<LegalImportView {...props} />); act(() => { dropFile(); choose(); }); expect(uploads()).toHaveLength(1);
  const signal = uploads()[0][1].signal;
  if (change === 'close') view.unmount();
  else { if (change === 'account') fixture.uid = 'new'; if (change === 'organization') fixture.org = 'new'; if (change === 'domain') fixture.domain = 'work'; view.rerender(<LegalImportView {...props} caseFile={{ ...props.caseFile, id: change === 'case' ? 'b' : 'a' }} />); }
  await act(async () => pending.resolve(reply({ files: [{ id: 'old.docx', name: 'old.docx' }] })));
  expect(signal.aborted).toBe(true); expect(archived).not.toHaveBeenCalled(); expect(fixture.net.mock.calls.some(([url]) => url.includes('/files/text/'))).toBe(false);
  if (change !== 'close') expect(document.querySelector('textarea')!.value).toBe('');
});

it.each(['truncated', 'empty', 'partial-upload'])('does not pass %s content as a complete document', async kind => {
  fixture.net.mockImplementation(async url => url.includes('/files/text/') ? reply({ text: kind === 'empty' ? '' : 'partial text', truncated: kind === 'truncated' }) : reply({ success: kind !== 'partial-upload', files: [{ id: 'good', name: 'good.docx', preview: 'PREVIEW' }], failed: kind === 'partial-upload' ? [{ fileName: 'bad.docx', error: 'upload failed' }] : [] }));
  render(<LegalImportView />); dropFile(); await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(document.querySelector('textarea')!.value).toBe(''); expect((screen.getByRole('button', { name: 'Import judgment' }) as HTMLButtonElement).disabled).toBe(true);
});

it('retains successfully uploaded contracts but blocks review until failed files are reselected', async () => {
  fixture.net.mockImplementationOnce(async () => reply({ success: false, partial: true, files: [{ id: 'good', name: 'good.docx' }], failed: [{ fileName: 'bad.docx', error: 'upload failed' }] }));
  render(<LegalContractReview />); dropFile(); await waitFor(() => expect(document.querySelector('textarea')!.value).toContain('END-OF-ORIGINAL'));
  expect(screen.getByText(/bad.docx/)).toBeTruthy(); expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true);
  fixture.net.mockImplementationOnce(async () => reply({ files: [{ id: 'bad', name: 'bad.docx' }] }));
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['retry'], 'bad.docx')] } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(false));
});

it.each(['personal', 'organization'])('imports files in the %s knowledge page and reports partial success accurately', async kind => {
  render(kind === 'personal' ? <KnowledgeBase isOpen t={{ langCode: 'en' }} onClose={() => {}} /> : <KnowledgeBaseBrowser />);
  await act(async () => {});
  const pending = deferred(); fixture.net.mockImplementationOnce(() => pending.promise);
  act(() => { dropFile(); choose(); }); expect(uploads()).toHaveLength(1);
  await act(async () => pending.resolve(reply({ success: false, partial: true, files: [{ id: 'good', name: 'good.docx' }], failed: [{ fileName: 'bad.docx', error: 'failed' }] })));
  await waitFor(() => expect(toast.warning).toHaveBeenCalled()); expect(toast.success).not.toHaveBeenCalled();
  expect(vi.mocked(toast.warning).mock.calls[0][0]).toMatch(/1/); expect(vi.mocked(toast.warning).mock.calls[0][0]).toContain('bad.docx');
  expect(uploads()[0][0]).toContain(kind === 'personal' ? 'domain=personal' : 'domain=work');
});

it.each(['personal', 'organization'])('routes a file drop to the %s knowledge page and cancels it on closure', async kind => {
  const props = { isOpen: true, t: { langCode: 'en' }, onClose: () => {} };
  const view = render(kind === 'personal' ? <KnowledgeBase {...props} /> : <KnowledgeBaseBrowser />);
  await act(async () => {});
  const pending = deferred(); fixture.net.mockImplementationOnce(() => pending.promise);
  dropFile();
  expect(uploads()).toHaveLength(1); const signal = uploads()[0][1].signal;
  if (kind === 'personal') view.rerender(<KnowledgeBase {...props} isOpen={false} />); else view.unmount();
  await act(async () => pending.resolve(reply({ files: [{ id: 'stale', name: 'stale.docx' }] })));
  expect(signal.aborted).toBe(true); expect(toast.success).not.toHaveBeenCalled(); expect(toast.warning).not.toHaveBeenCalled();
});

it('reports a failed dropped file once and clears the contract failure when the same file is reselected', async () => {
  render(<LegalContractReview />);
  fixture.net.mockImplementationOnce(async () => reply({ success: false, partial: true, files: [{ id: 'good', name: 'good.docx' }], failed: [{ fileName: 'bad.docx', error: 'failed' }], skipped: [{ path: 'D:/synthetic/bad.docx', error: 'failed' }] }));
  fireEvent.drop(zone(), { dataTransfer: { types: ['Files'], files: [new File(['good'], 'good.docx'), new File(['bad'], 'bad.docx')] } });
  await waitFor(() => expect(document.querySelector('textarea')!.value).toContain('END-OF-ORIGINAL'));
  expect(screen.getByText(/bad.docx/).textContent!.match(/bad.docx/g)).toHaveLength(1);
  choose(); // another file does not dismiss the unresolved failure
  await waitFor(() => expect(uploads()).toHaveLength(2));
  await act(async () => {}); expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['retry'], 'bad.docx')] } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement).disabled).toBe(false));
});

it('rejects an empty success receipt instead of inventing an imported file count', async () => {
  fixture.net.mockResolvedValueOnce(reply({ success: true, files: [] }));
  await expect(importKnowledgeFiles([file()], path => path)).rejects.toThrow('File import failed');
});

it('does not archive an imported judgment when the server has not verified the result', async () => {
  const transport = fixture.net.getMockImplementation()!;
  fixture.net.mockImplementation((url: string, init?: RequestInit) => url.includes('/legal/tool/')
    ? Promise.resolve(reply({ text: 'Unverified draft', receipt: { ok: true }, verification: { status: 'unknown' } }))
    : transport(url, init));
  const archived = vi.fn(async () => true);
  render(<LegalImportView caseFile={{ id: 'unverified-case', materials: [] } as any} onAddMaterial={archived} />);
  dropFile();
  await waitFor(() => expect(document.querySelector('textarea')!.value).toContain('END-OF-ORIGINAL'));
  fireEvent.click(screen.getByRole('button', { name: 'Import judgment' }));
  await screen.findByText('Error: Unverified draft');
  expect(archived).not.toHaveBeenCalled();
});
