// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legalCaseDraftContext } from '../src/components/org/legal_hub/case_values';
import { LegalPacketView } from '../src/components/org/legal_hub/packet';
import { LegalTwoPaneTool } from '../src/components/org/legal_hub/two_pane_tool';
import { LegalBidWorkbench } from '../src/components/org/LegalBidWorkbench';
import { LegalContractReview } from '../src/components/org/LegalContractReview';
import { LegalCaseSearch } from '../src/components/org/LegalCaseSearch';
import { LegalAssetTrace } from '../src/components/org/LegalAssetTrace';
import { LegalHub } from '../src/components/org/LegalHub';
import { createEmptyLegalCase, readLegalCaseFiles, writeLegalCaseFiles, getActiveLegalCaseId, LEGAL_CASES_CHANGED_EVENT, ACTIVE_LEGAL_CASE_STORAGE, type LegalCaseFile } from '../src/lib/legalCaseStore';
import { toast } from 'sonner';
import { chinaLegalCopy } from '../src/i18n/regions/cn/legal';
import { legalReviewQualityCopy } from '../src/i18n/regions/cn/legalReviewQuality';
const fixture = vi.hoisted(() => ({ net: vi.fn(), user: 'owner', domain: 'work', org: 'org-a', language: 'en', connected: true }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: fixture.user }, workDomain: fixture.domain, orgConnection: { orgId: fixture.org, connected: fixture.connected, orgRole: 'owner' } }) }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: fixture.language, legalContractReview: 'contract-review', legalCaseStrategy: 'strategy', legalCaseStrategyAnalyze: 'analyze-strategy', legalCaseStrategyPlaceholder: 'strategy-facts', legalCaseStrategyTitle: 'Strategy', legalCaseStrategyDesc: 'Description', legalVerifyCitation: 'citations', legalVerifyCitationVerify: 'verify-citations', legalVerifyCitationPlaceholder: 'citation-text', legalVerifyCitationTitle: 'Citation verification', legalImportJudgment: 'import-judgment', legalImportJudgmentTitle: 'Import judgment' }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key.split('.')[1], formatUiMessage: (key: string, values: any) => key.split('.')[1] + ' ' + Object.values(values).join(' ') }));
vi.mock('../src/services/apiClient', async () => ({ apiFetch: fixture.net, apiJson: (await import('./source_expression')).extractSourceExpression('src/services/apiClient.ts', 'apiJson', { apiFetch: fixture.net }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
const reply = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body && typeof body.text === 'string' ? { verification: { status: 'verified' }, ...body } : body });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
const caseFile = (id = 'a', title = id) => ({ id, title, clientRole: 'plaintiff', cause: 'contract', court: 'court', stage: 'trial', materials: [] } as any);
beforeEach(() => { localStorage.clear(); fixture.connected = true; fixture.user = 'owner'; fixture.domain = 'work'; fixture.org = 'org-a'; fixture.language = 'en'; fixture.net.mockResolvedValue(reply({ text: 'Completed document' })); vi.stubGlobal('fetch', fixture.net); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe.each(['bid'])('%s document workbench', kind => {
  const page = (file = caseFile()) => <StrictMode>{kind === 'bid' ? <LegalBidWorkbench caseFile={file} orgId={fixture.org} /> : <LegalContractReview caseFile={file} />}</StrictMode>;
  const text = () => document.querySelector('textarea')!;
  const start = () => fireEvent.click(screen.getByRole('button', { name: kind === 'bid' ? 'generate' : 'review' }));
  const upload = () => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['source'], 'source.txt')] } });

  it('accepts both CSV source files and sends their complete named originals through the bid workbench', async () => {
    const quote = '项目,含税金额\n服务,254400', schedule = '阶段,期限\n启动,5个工作日';
    fixture.net.mockResolvedValueOnce(reply({ files: [{ id: 'quote-id', name: 'quote.csv' }, { id: 'schedule-id', name: 'schedule.csv' }] }))
      .mockResolvedValueOnce(reply({ text: quote, truncated: false })).mockResolvedValueOnce(reply({ text: schedule, truncated: false }));
    render(page());
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    expect(input.accept.split(',')).toContain('.csv');
    fireEvent.change(input, { target: { files: [new File([quote], 'quote.csv', { type: 'text/csv' }), new File([schedule], 'schedule.csv', { type: 'text/csv' })] } });
    await waitFor(() => expect(text().value).toBe('# quote.csv\n' + quote + '\n\n# schedule.csv\n' + schedule));
    expect(fixture.net.mock.calls[0][1].body.getAll('files').map((file: File) => file.name)).toEqual(['quote.csv', 'schedule.csv']);
    expect(fixture.net.mock.calls[1][0]).toContain('/api/files/text/quote-id');
    expect(fixture.net.mock.calls[2][0]).toContain('/api/files/text/schedule-id');
    start(); await screen.findByText('result-ready');
    const call = fixture.net.mock.calls.find(([url]) => url === '/api/legal/tool/legal_generate_bid')!;
    expect(JSON.parse(call[1].body).args.requirements).toBe('# quote.csv\n' + quote + '\n\n# schedule.csv\n' + schedule);
  });

  it('imports in order, serializes upload and generation, and keeps drafts during metadata refresh', async () => {
    const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(reply({ text: 'first', truncated: false })).mockResolvedValueOnce(reply({ text: 'second', truncated: false })); const view = render(page()); fireEvent.change(text(), { target: { value: 'draft' } });
    act(() => { upload(); upload(); start(); }); expect(fixture.net).toHaveBeenCalledTimes(1);
    expect(fixture.net.mock.calls[0][0]).toBe('/api/files/upload?domain=work&orgId=org-a'); expect(fixture.net.mock.calls[0][1].body.getAll('files').map((file: File) => file.name)).toEqual(['source.txt']);
    await act(async () => pending.resolve(reply({ files: [{ id: 'first', name: 'first.txt', preview: 'wrong preview' }, { id: 'second', name: 'second.txt', preview: 'wrong preview' }] }))); expect(text().value).toBe('draft\n\n# first.txt\nfirst\n\n# second.txt\nsecond');
    view.rerender(page(caseFile('a', 'renamed'))); expect(text().value).toBe('draft\n\n# first.txt\nfirst\n\n# second.txt\nsecond'); expect(toast.success).toHaveBeenCalledTimes(1);
    const output = deferred(); fixture.net.mockReturnValueOnce(output.promise); act(() => { start(); start(); upload(); }); expect(fixture.net).toHaveBeenCalledTimes(4);
    const [url, init] = fixture.net.mock.calls[3], body = JSON.parse(init.body), args = body.args || body;
    expect(url).toBe(kind === 'bid' ? '/api/legal/tool/legal_generate_bid' : '/api/legal/contract-review'); expect(args).toMatchObject({ caseId: 'a', orgId: 'org-a', persistCase: true });
    const changed = vi.spyOn(window, 'dispatchEvent'); await act(async () => output.resolve(reply({ text: 'Completed document' })));
    expect(screen.getAllByText('Completed document').length).toBeGreaterThan(0); expect(changed.mock.calls.filter(([event]) => event.type === 'lumi:org-legal-cases-changed')).toHaveLength(1);
  });

  it.each(['case', 'account', 'organization', 'domain', 'close'])('drops late upload and generated results after %s changes', async change => {
    const old = deferred(); fixture.net.mockReturnValueOnce(old.promise); const view = render(page()); upload(); const signal = fixture.net.mock.calls[0][1].signal;
    if (change === 'close') view.unmount(); else { if (change === 'account') fixture.user = 'other'; if (change === 'organization') fixture.org = 'org-b'; if (change === 'domain') fixture.domain = 'personal'; view.rerender(page(caseFile(change === 'case' ? 'b' : 'a'))); }
    await act(async () => old.resolve(reply({ files: [{ content: 'stale material' }] }))); expect(toast.success).not.toHaveBeenCalled(); expect(signal?.aborted).toBe(true);
    if (change === 'close') return; expect(text().value).toBe(''); fireEvent.change(text(), { target: { value: 'new draft' } });
    const generation = deferred(); fixture.net.mockReturnValueOnce(generation.promise); start(); const generatedSignal = fixture.net.mock.calls.at(-1)![1].signal;
    view.rerender(page(caseFile('c'))); const changed = vi.spyOn(window, 'dispatchEvent'); await act(async () => generation.resolve(reply({ text: 'stale result' })));
    expect(generatedSignal?.aborted).toBe(true); expect(screen.queryByText('stale result')).toBeNull(); expect(changed).not.toHaveBeenCalled(); expect(text().value).toBe('');
    fireEvent.change(text(), { target: { value: 'current draft' } }); start(); await screen.findByText('result-ready');
  });

  it('does not flatten a structured partial bid into successful hook output or export actions', async () => {
    render(page()); fireEvent.change(text(), { target: { value: 'Virtual requirements' } });
    fixture.net.mockResolvedValueOnce(reply({ text: 'Technical chapter is incomplete.', receipt: { ok: false, status: 'partial' }, verification: { status: 'failed' }, artifacts: ['incomplete.docx'] }));
    start(); await screen.findByText('error: Technical chapter is incomplete.');
    expect(screen.queryByText('result-ready')).toBeNull(); expect(screen.queryByRole('button', { name: 'export' })).toBeNull();
    expect((screen.getByRole('button', { name: 'generate' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('shows failed/empty imports and failed generation without marking or exporting a completed result', async () => {
    render(page()); fixture.net.mockResolvedValueOnce(reply({ error: 'denied' }, 403)); upload(); await waitFor(() => expect(toast.error).toHaveBeenCalledWith('denied'));
    fixture.net.mockResolvedValueOnce(reply({ files: [] })); upload(); await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2)); expect(text().value).toBe('');
    fireEvent.change(text(), { target: { value: 'draft' } }); fixture.net.mockResolvedValueOnce(reply({ error: 'generation failed' }, 500)); start(); await screen.findByText('error: generation failed');
    expect(screen.queryByText('result-ready')).toBeNull(); expect(screen.queryByRole('button', { name: 'export' })).toBeNull();
    fixture.net.mockResolvedValueOnce(reply({})); start(); await screen.findByText(`error: ${kind === 'bid' ? 'legal_generate_bid' : 'legal_review_contract'} failed`); expect(screen.queryByText('result-ready')).toBeNull();
    start(); await screen.findByText('result-ready');
  });
});

const hubCase = (id: string) => ({ ...createEmptyLegalCase(), id, title: id, clientRole: 'plaintiff' });
it('keeps evidence supplementation labeled and empty instead of flattening archived originals into editable input', async () => {
  const file = { ...hubCase('Source case'), materials: [{ id: 'actual-original-id', type: 'evidence' as const, source: 'import' as const,
    title: 'Archived original', content: 'Original first line\nOriginal final line', createdAt: '' }] };
  render(<LegalPacketView caseFile={file} orgId={fixture.org} />);
  const input = screen.getByRole('textbox', { name: 'evidence-opponent-materials-gaps' }) as HTMLTextAreaElement;
  expect(input.value).toBe('');
  fireEvent.change(input, { target: { value: 'New uncompiled original\nSupplement tail' } });
  fireEvent.click(screen.getByRole('button', { name: 'generate-packet' }));
  await screen.findByText('result-ready');
  const call = fixture.net.mock.calls.find(([url]) => url === '/api/legal/tool/legal_generate_litigation_packet')!;
  expect(JSON.parse(call[1].body).args).toMatchObject({ caseId: file.id, evidence: 'New uncompiled original\nSupplement tail' });
  expect(JSON.parse(call[1].body).args).not.toHaveProperty('sourceCase');
});
const hubEvent = () => act(() => window.dispatchEvent(new Event('lumi:org-legal-cases-changed')));
const hubPage = () => { localStorage.setItem('lumi_work_domain', fixture.domain); localStorage.setItem('lumi_org_connection', JSON.stringify({ orgId: fixture.org })); return <LegalHub />; };
const workspaceCopy = () => chinaLegalCopy(fixture.language === 'en' ? 'en' : 'zh').workspace;
const hubNav = (name: string) => fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', {
  name: name === 'citations' ? workspaceCopy().documentCheck : name === 'strategy' ? workspaceCopy().strategyAnalysis : name === 'Case overview' ? workspaceCopy().caseOverview : name,
}));
const selectAdvancedLegalTool = (tool: string) => {
  const summary = screen.getByText(workspaceCopy().advancedOptions, { selector: 'summary' });
  const advanced = summary.closest('details')!;
  if (!advanced.open) fireEvent.click(summary);
  expect(advanced.open).toBe(true);
  const selector = within(advanced).getByRole('combobox', { name: workspaceCopy().toolMode });
  expect(selector.closest('details')).toBe(advanced);
  fireEvent.change(selector, { target: { value: tool } });
};
it('keeps this local installation case list available across account changes without an ownership migration', () => {
  fixture.domain = 'personal'; localStorage.setItem('lumi_legal_cases_v1', JSON.stringify([hubCase('Local case')]));
  const view = render(hubPage()); expect(screen.getByRole('heading', { name: 'Local case' })).toBeTruthy();
  fixture.user = 'other'; view.rerender(hubPage()); expect(screen.getByRole('heading', { name: 'Local case' })).toBeTruthy();
  expect(readLegalCaseFiles()).toHaveLength(1);
});
it.each(['organization', 'account', 'domain', 'disconnect', 'close'])('isolates the actual legal hub and late writes on %s', async change => {
  fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case A')] })); const view = render(hubPage()); await screen.findByRole('heading', { name: 'Case A' });
  const old = deferred(); fixture.net.mockReturnValueOnce(old.promise); hubEvent(); const readSignal = fixture.net.mock.calls.at(-1)![1]?.signal;
  if (change === 'close') view.unmount(); else { if (change === 'organization') fixture.org = 'org-b'; if (change === 'account') fixture.user = 'other'; if (change === 'domain') fixture.domain = 'personal'; if (change === 'disconnect') fixture.connected = false; fixture.net.mockResolvedValue(reply({ error: 'new scope unavailable' }, 403)); view.rerender(hubPage()); }
  expect(screen.queryByRole('heading', { name: 'Case A' })).toBeNull(); await act(async () => old.resolve(reply({ cases: [hubCase('Stale A')] })));
  expect(screen.queryAllByText('Stale A')).toHaveLength(0); expect(readSignal?.aborted).toBe(true);
  if (change === 'close' || change === 'disconnect' || change === 'domain') return;
  fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case B')] })); hubEvent(); await screen.findByRole('heading', { name: 'Case B' });
  fireEvent.click(screen.getByRole('button', { name: 'new-case' })); fireEvent.change(screen.getByPlaceholderText('example-alpha-v-beta-sales'), { target: { value: 'Created in B' } });
  const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); fireEvent.click(screen.getByRole('button', { name: 'create-case' })); const writeSignal = fixture.net.mock.calls.at(-1)![1].signal;
  fixture.org = 'org-c'; fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case C')] })); view.rerender(hubPage()); await screen.findByRole('heading', { name: 'Case C' });
  await act(async () => pending.resolve(reply(hubCase('Created in B')))); expect(toast.success).not.toHaveBeenCalled(); expect(writeSignal?.aborted).toBe(true); expect(screen.queryByText('Created in B')).toBeNull(); expect(getActiveLegalCaseId()).toBe('');
});

it('uses only the latest organization refresh, preserves edits from older reads, and releases listeners', async () => {
  fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case A')] })); const view = render(<StrictMode>{hubPage()}</StrictMode>); await screen.findByRole('heading', { name: 'Case A' });
  const old = deferred(), current = deferred(); fixture.net.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); hubEvent(); hubEvent();
  fixture.language = 'zh'; view.rerender(<StrictMode>{hubPage()}</StrictMode>); await act(async () => current.resolve(reply({ cases: [hubCase('Latest')] })));
  await act(async () => old.resolve(reply({ error: 'obsolete error' }, 500))); expect(toast.error).not.toHaveBeenCalled(); expect(screen.getByRole('heading', { name: 'Latest' })).toBeTruthy();
  const beforeEdit = deferred(); fixture.net.mockReturnValueOnce(beforeEdit.promise); hubEvent(); fixture.net.mockResolvedValue(reply({ ...hubCase('Latest'), title: 'Edited' })); fireEvent.change(screen.getByLabelText('case-name'), { target: { value: 'Edited' } });
  await act(async () => beforeEdit.resolve(reply({ cases: [hubCase('Latest')] }))); expect(screen.getByRole('heading', { name: 'Edited' })).toBeTruthy();
  view.unmount(); const calls = fixture.net.mock.calls.length; hubEvent(); act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'lumi_legal_cases_v1' }))); expect(fixture.net).toHaveBeenCalledTimes(calls);
});

it('shares personal list and active-case synchronization across local and storage events', () => {
  fixture.domain = 'personal'; writeLegalCaseFiles([hubCase('Personal A'), hubCase('Personal B')], 'missing'); const view = render(hubPage());
  expect(screen.getByRole('heading', { name: 'Personal A' })).toBeTruthy(); expect(localStorage.getItem(ACTIVE_LEGAL_CASE_STORAGE)).toBe('Personal A');
  act(() => writeLegalCaseFiles([hubCase('Personal B')], 'Personal B')); expect(screen.getByRole('heading', { name: 'Personal B' })).toBeTruthy();
  localStorage.setItem('lumi_legal_cases_v1', '[]'); act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'lumi_legal_cases_v1' }))); expect(screen.queryByRole('heading', { name: 'Personal B' })).toBeNull(); expect(getActiveLegalCaseId()).toBe('');
  act(() => window.dispatchEvent(new Event(LEGAL_CASES_CHANGED_EVENT))); expect(fixture.net).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'new-case' })); fireEvent.change(screen.getByPlaceholderText('example-alpha-v-beta-sales'), { target: { value: 'Personal draft' } });
  fixture.connected = false; view.rerender(hubPage()); expect(screen.getByDisplayValue('Personal draft')).toBeTruthy();
});

describe.each([
  ['packet', 'generate-packet', 'legal_generate_litigation_packet', 'facts-timeline-parties'],
  ['research', 'generate-plan', 'legal_external_research_plan', 'facts-and-research-context'],
  ['strategy', 'analyze-strategy', 'legal_case_strategy', 'strategy-facts'],
])('%s embedded legal tool', (nav, action, tool, placeholder) => {
  const open = () => hubNav(nav);
  const start = () => fireEvent.click(screen.getByRole('button', { name: action }));
  const text = () => screen.getByPlaceholderText(placeholder) as HTMLTextAreaElement;
  it('serializes generation, rejects failed output, and merges the single server archive without a manual duplicate', async () => {
    fixture.domain = 'personal'; writeLegalCaseFiles([hubCase('Case A')], 'Case A'); render(<StrictMode>{hubPage()}</StrictMode>); open();
    const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); act(() => { start(); start(); }); expect(fixture.net).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(reply({ error: 'generation denied' }, 403))); await screen.findByText('Error: generation denied'); expect(screen.queryByText('result-ready')).toBeNull(); expect(screen.queryByRole('button', { name: 'archive-to-case' })).toBeNull();
    const archived = { ...readLegalCaseFiles()[0], updatedAt: new Date().toISOString(), materials: [{ id: 'server-archive', type: nav === 'packet' ? 'pleading' : 'note', title: 'Server archived result', content: 'Completed document', source: 'tool', createdAt: new Date().toISOString() }] };
    fixture.net.mockResolvedValueOnce(reply({ text: 'Completed document', receipt: { ok: true, status: 'generated' }, caseUpdates: [archived] }));
    start(); await screen.findByText('result-ready'); expect(screen.queryByRole('button', { name: 'archive-to-case' })).toBeNull();
    expect(readLegalCaseFiles()[0].materials).toEqual([expect.objectContaining({ id: 'server-archive', content: 'Completed document', source: 'tool', type: nav === 'packet' ? 'pleading' : 'note' })]);
  });
  it('shows HTTP200 partial text without allowing case archive or claiming a completed result', async () => {
    fixture.domain = 'personal'; writeLegalCaseFiles([hubCase('Case A')], 'Case A'); render(hubPage()); open();
    fixture.net.mockResolvedValueOnce(reply({ text: 'Unfinished document body remains available.', receipt: { ok: false, status: 'partial' }, verification: { status: 'failed' } }));
    start(); await screen.findByText('Error: Unfinished document body remains available.');
    expect(screen.queryByText('result-ready')).toBeNull(); expect(screen.queryByRole('button', { name: 'archive-to-case' })).toBeNull();
    expect((screen.getByRole('button', { name: action }) as HTMLButtonElement).disabled).toBe(false); expect(readLegalCaseFiles()[0].materials).toHaveLength(0);
    start(); await screen.findByText('result-ready');
  });
  it('keeps edits on metadata/language refresh but drops an old result when the case changes', async () => {
    fixture.domain = 'personal'; writeLegalCaseFiles([hubCase('Case A')], 'Case A'); const view = render(hubPage()); open(); fireEvent.change(text(), { target: { value: 'My draft' } });
    const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); start(); const signal = fixture.net.mock.calls.at(-1)![1].signal;
    fixture.language = 'zh'; view.rerender(hubPage()); act(() => writeLegalCaseFiles([{ ...hubCase('Case A'), title: 'Renamed A' }], 'Case A')); expect(text().value).toBe('My draft'); expect(signal?.aborted ?? false).toBe(false);
    act(() => writeLegalCaseFiles([hubCase('Case B')], 'Case B')); expect(text().value).toContain('Case B'); await act(async () => pending.resolve(reply({ text: 'Old A output' })));
    expect(screen.queryByText('Old A output')).toBeNull(); expect(screen.queryByText('result-ready')).toBeNull(); expect(signal?.aborted).toBe(true); fixture.net.mockResolvedValueOnce(reply({ text: 'New B output' })); start(); await screen.findByText('New B output');
  });
  it('retains organization persistence arguments and avoids a duplicate manual archive after refresh', async () => {
    fixture.net.mockImplementation(async (_url, init) => reply(init?.method === 'POST' ? { text: 'Organization output' } : { cases: [hubCase('Case A')] })); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); open(); start();
    await screen.findByText('Organization output'); expect(screen.getByText('result-ready')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'archive-to-case' })).toBeNull();
    const call = fixture.net.mock.calls.find(([url]) => url === `/api/legal/tool/${tool}`)!; expect(JSON.parse(call[1].body).args).toMatchObject({ caseId: 'Case A', orgId: 'org-a', persistCase: true });
  });
});

describe.each([
  ['citations', 'verify-citations', 'legal_verify_citation'],
  ['import-judgment', 'import-judgment', 'legal_import_judgment'],
])('%s remaining legal tool', (nav, action, tool) => {
  const open = () => { hubNav(nav); if (nav === 'citations') selectAdvancedLegalTool('legal_verify_citation'); };
  const start = () => fireEvent.click(screen.getAllByRole('button', { name: action }).at(-1)!);
  const text = () => screen.getByRole('textbox') as HTMLTextAreaElement;
  it('prevents duplicate execution and never archives an error or marks it complete', async () => {
    fixture.domain = 'personal'; writeLegalCaseFiles([hubCase('Case A')], 'Case A'); render(<StrictMode>{hubPage()}</StrictMode>); open(); fireEvent.change(text(), { target: { value: 'Judgment source' } });
    const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); act(() => { start(); start(); }); expect(fixture.net).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(reply({ error: 'request denied' }, 403))); await screen.findByText('Error: request denied'); expect(screen.queryByText('result-ready')).toBeNull(); expect(screen.queryByRole('button', { name: 'archive-to-case' })).toBeNull(); expect(readLegalCaseFiles()[0].materials).toHaveLength(0);
    start(); await screen.findByText('result-ready'); if (nav === 'citations') fireEvent.click(screen.getByRole('button', { name: 'archive-to-case' }));
    expect(readLegalCaseFiles()[0].materials).toEqual([expect.objectContaining({ type: nav === 'citations' ? 'note' : 'judgment', content: nav === 'citations' ? 'Completed document' : 'Judgment source' })]);
  });
  it('keeps drafts on metadata refresh and never applies a late reply or archive to another case', async () => {
    fixture.domain = 'personal'; writeLegalCaseFiles([{ ...hubCase('Case A'), materials: [{ id: 'initial', title: 'Contract', type: 'contract', content: 'Prefilled contract', createdAt: '' }] }], 'Case A'); const view = render(hubPage()); open(); expect(text().value).toBe(nav === 'citations' ? 'Prefilled contract' : '');
    fireEvent.change(text(), { target: { value: 'Private A draft' } }); const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); start(); const signal = fixture.net.mock.calls.at(-1)![1].signal;
    fixture.language = 'zh'; view.rerender(hubPage()); act(() => writeLegalCaseFiles([{ ...hubCase('Case A'), title: 'Renamed' }], 'Case A')); expect(text().value).toBe('Private A draft');
    act(() => writeLegalCaseFiles([hubCase('Case B')], 'Case B')); await act(async () => pending.resolve(reply({ text: 'Old A output' }))); expect(screen.queryAllByText('Old A output')).toHaveLength(0); expect(text().value).toBe(''); if (nav === 'citations') selectAdvancedLegalTool('legal_verify_citation'); expect(signal?.aborted).toBe(true); expect(readLegalCaseFiles().map(item => [item.id, item.materials.length])).toEqual([['Case B', 0]]);
    fireEvent.change(text(), { target: { value: 'New B draft' } }); start(); await screen.findByText('result-ready');
  });
  it('retains the separate organization case-material write and does not claim that a failed archive succeeded', async () => {
    fixture.net.mockImplementation(async (url, init) => reply(String(url).endsWith('/materials') ? { error: 'archive denied' } : init?.method === 'POST' ? { text: 'Tool output' } : { cases: [hubCase('Case A')] }, String(url).endsWith('/materials') ? 403 : 200)); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); open(); fireEvent.change(text(), { target: { value: 'Organization source' } }); start();
    if (nav === 'citations') { await screen.findByText(/^Tool output/); fireEvent.click(screen.getByRole('button', { name: 'archive-to-case' })); } else { await screen.findByText(/Error: failed-to-archive-material/); expect(screen.queryByText('result-ready')).toBeNull(); } await waitFor(() => expect(toast.error).toHaveBeenCalledWith('archive denied')); expect(toast.success).not.toHaveBeenCalled(); expect(screen.queryByText(/archived-to-the-current-case/)).toBeNull();
    expect(fixture.net.mock.calls.filter(([url]) => url === '/api/org/legal/cases/Case%20A/materials')).toHaveLength(1); expect(JSON.parse(fixture.net.mock.calls.find(([url]) => url === `/api/legal/tool/${tool}`)![1].body).args).toMatchObject({ caseId: 'Case A', orgId: 'org-a' });
  });
});

it('knowledge sync confirms the current workspace and emits exactly one successful update', async () => {
  fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case A')] })); const view = render(<StrictMode>{hubPage()}</StrictMode>); await screen.findByRole('heading', { name: 'Case A' }); hubNav('sync-to-kb'); const start = () => fireEvent.click(screen.getAllByRole('button', { name: 'sync-to-kb' }).at(-1)!); const events = vi.spyOn(window, 'dispatchEvent');
  for (const response of [reply({ error: 'denied' }, 403), reply({ success: false, error: 'denied' }), reply({}), reply({ success: true, entry: { id: 'wrong-domain', domain: 'personal' } }), reply({ success: true, entry: { id: 'wrong-org', domain: 'work', orgId: 'org-b' } })]) { fixture.net.mockResolvedValueOnce(response); start(); await screen.findByText(/denied|failed-to-sync-to-knowledge/); expect(screen.queryByText('result-ready')).toBeNull(); }
  expect(events.mock.calls.filter(([event]) => ['lumi:knowledge-updated', 'lumi:client-state-refresh'].includes(event.type))).toHaveLength(0); expect(toast.success).not.toHaveBeenCalled();
  const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); const before = fixture.net.mock.calls.length; act(() => { start(); start(); }); expect(fixture.net).toHaveBeenCalledTimes(before + 1); const request = fixture.net.mock.calls.at(-1)!;
  expect(request[0]).toBe('/api/files/save?domain=work');
  fixture.language = 'zh'; view.rerender(<StrictMode>{hubPage()}</StrictMode>); expect(request[1].signal.aborted).toBe(false); await act(async () => pending.resolve(reply({ success: true, entry: { id: 'case-archive.md', name: 'case-archive.md', domain: 'work', orgId: 'org-a' } }))); await screen.findByText('result-ready'); expect(toast.success).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request[1].body)).toMatchObject({ name: 'legal-case-Case A.md' }); expect(JSON.parse(request[1].body).content).toContain('Case A'); expect(events.mock.calls.filter(([event]) => event.type === 'lumi:knowledge-updated').map(([event]) => (event as CustomEvent).detail)).toEqual([expect.objectContaining({ domain: 'work', orgId: 'org-a', files: [expect.objectContaining({ id: 'case-archive.md' })] })]); expect(events.mock.calls.filter(([event]) => event.type === 'lumi:client-state-refresh')).toHaveLength(1);
});

it('updates a stable personal case archive through the shared save pipeline and opens current-workspace surfaces', async () => {
  fixture.domain = 'personal'; fixture.connected = false; writeLegalCaseFiles([hubCase('Personal case')], 'Personal case');
  fixture.net.mockResolvedValue(reply({ success: true, entry: { id: 'personal-case.md', name: 'personal-case.md', domain: 'personal', status: 'ready' } }));
  render(hubPage()); hubNav('sync-to-kb'); const events = vi.spyOn(window, 'dispatchEvent');
  for (let attempt = 0; attempt < 2; attempt++) { fireEvent.click(screen.getAllByRole('button', { name: 'sync-to-kb' }).at(-1)!); await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(attempt + 1)); }
  expect(fixture.net.mock.calls.filter(([url]) => String(url).startsWith('/api/files/list')).map(([url]) => url)).toEqual(['/api/files/list?domain=personal']);
  const saves = fixture.net.mock.calls.filter(([url]) => String(url).startsWith('/api/files/save'));
  expect(saves.map(([url]) => url)).toEqual(['/api/files/save?domain=personal', '/api/files/save?domain=personal']);
  expect(saves.map(([, init]) => JSON.parse(init.body).name)).toEqual(['legal-case-Personal case.md', 'legal-case-Personal case.md']);
  expect(events.mock.calls.filter(([event]) => event.type === 'lumi:knowledge-updated').map(([event]) => (event as CustomEvent).detail.domain)).toEqual(['personal', 'personal']);
  fireEvent.click(screen.getByRole('button', { name: 'open-knowledge-base' })); fireEvent.click(screen.getAllByRole('button', { name: 'ask-lumi-in-work-workspace' }).at(-1)!);
  expect(events.mock.calls.filter(([event]) => event.type === 'lumi:client-action').map(([event]) => (event as CustomEvent).detail.action)).toEqual(['show_knowledge_base', 'open_chat']);
  fireEvent.click(screen.getAllByRole('button', { name: 'ask-lumi-in-work-workspace' })[0]);
  expect(events.mock.calls.filter(([event]) => event.type === 'lumi:client-action').at(-1)?.[0]).toMatchObject({ detail: { action: 'open_chat' } });
  expect(events.mock.calls.filter(([event]) => event.type === 'lumi:navigate')).toHaveLength(0);
});

it.each(['case', 'organization', 'account', 'domain', 'close'])('drops late knowledge-sync notifications after %s changes', async change => {
  fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case A')] })); const view = render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); hubNav('sync-to-kb'); const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); fireEvent.click(screen.getAllByRole('button', { name: 'sync-to-kb' }).at(-1)!); const signal = fixture.net.mock.calls.at(-1)![1].signal;
  if (change === 'close') view.unmount(); else { fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case B')] })); if (change === 'case') hubEvent(); else { if (change === 'organization') fixture.org = 'org-b'; else if (change === 'domain') { fixture.domain = 'personal'; writeLegalCaseFiles([hubCase('Case B')], 'Case B'); } else fixture.user = 'other'; view.rerender(hubPage()); } if (change !== 'domain') await waitFor(() => expect(screen.queryAllByText('Case B').length).toBeGreaterThan(0)); }
  const events = vi.spyOn(window, 'dispatchEvent'); await act(async () => pending.resolve(reply({ success: true, entry: { id: 'old-case.md', domain: 'work', orgId: 'org-a' } }))); expect(toast.success).not.toHaveBeenCalled(); expect(signal?.aborted).toBe(true); expect(events.mock.calls.filter(([event]) => ['lumi:knowledge-updated', 'lumi:client-state-refresh'].includes(event.type))).toHaveLength(0); expect(screen.queryByText('result-ready')).toBeNull();
});

const workspaceCase = (id = 'Case A') => ({ ...hubCase(id), materials: [{ id: 'draft', type: 'pleading' as const, title: 'Source draft', content: 'Source draft text', createdAt: '' }] });
it.each([false, true])('judgment import waits for archive confirmation and drops completion after case changes (%s)', async changeCase => {
  const pending = deferred(); fixture.net.mockImplementation(async (url, init) => String(url).endsWith('/materials') ? pending.promise : reply(init?.method === 'POST' ? { text: 'Knowledge import accepted' } : { cases: [hubCase('Case A'), hubCase('Case B')] })); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); hubNav('import-judgment'); fireEvent.change(screen.getByPlaceholderText('paste-judgment-document-content-here'), { target: { value: 'Judgment source' } }); fireEvent.click(screen.getAllByRole('button', { name: 'import-judgment' }).at(-1)!);
  await waitFor(() => expect(fixture.net.mock.calls.some(([url]) => String(url).endsWith('/materials'))).toBe(true)); expect(screen.queryByText('result-ready')).toBeNull(); expect(screen.queryByText('Knowledge import accepted')).toBeNull();
  if (changeCase) { hubNav('Case overview'); fireEvent.click(screen.getByRole('button', { name: /^Case B / })); hubNav('import-judgment'); }
  await act(async () => pending.resolve(reply({ id: 'confirmed-material', title: 'Archived judgment', content: 'Judgment source', type: 'judgment', createdAt: '' })));
  if (changeCase) { expect(screen.queryByText('result-ready')).toBeNull(); expect((screen.getByPlaceholderText('paste-judgment-document-content-here') as HTMLTextAreaElement).value).toBe(''); } else expect(screen.getByText('result-ready')).toBeTruthy();
});
describe.each(['search'])('%s research ownership and archive', kind => {
  const writer = vi.fn(), text = () => document.querySelector('input')!;
  const page = (file = hubCase('Case A')) => <StrictMode>{kind === 'search' ? <LegalCaseSearch caseFile={file} onAddMaterial={writer} /> : <LegalAssetTrace caseFile={file} onAddMaterial={writer} />}</StrictMode>;
  const start = () => fireEvent.keyDown(text(), { key: 'Enter' });
  const archive = () => fireEvent.click(screen.getByRole('button', { name: 'archive-to-case' }));
  it('locks duplicate searches, rejects failed reports and retries with the original request scope', async () => {
    render(page()); fireEvent.change(text(), { target: { value: 'Research subject' } }); const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); act(() => { start(); start(); }); expect(fixture.net).toHaveBeenCalledTimes(1);
    const args = JSON.parse(fixture.net.mock.calls[0][1].body).args; expect(args).toMatchObject({ caseId: 'Case A', persistCase: true, [kind === 'search' ? 'query' : 'name']: 'Research subject' }); if (kind === 'search') expect(args.orgId).toBe('org-a');
    await act(async () => pending.resolve(reply({ error: 'research denied' }, 403))); expect(screen.queryByText('result-ready')).toBeNull(); expect(screen.queryByRole('button', { name: 'archive-to-case' })).toBeNull(); expect(fixture.net).toHaveBeenCalledTimes(1);
    start(); await screen.findByText('result-ready'); expect(fixture.net.mock.calls.filter(([url]) => String(url).includes('legal_equity_penetration'))).toHaveLength(kind === 'trace' ? 1 : 0);
  });
  it.each(['case', 'organization', 'account', 'close'])('drops old reports and stops remaining tools on %s changes', async change => {
    const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); const view = render(page()); fireEvent.change(text(), { target: { value: 'Private draft' } }); start(); const signal = fixture.net.mock.calls[0][1].signal;
    fixture.language = 'zh'; view.rerender(page({ ...hubCase('Case A'), party: 'Changed party' })); expect(text().value).toBe('Private draft'); expect(signal?.aborted ?? false).toBe(false);
    if (change === 'close') view.unmount(); else { if (change === 'organization') fixture.org = 'org-b'; if (change === 'account') fixture.user = 'other'; view.rerender(page(hubCase(change === 'case' ? 'Case B' : 'Case A'))); }
    await act(async () => pending.resolve(reply({ text: 'Old private report' }))); expect(signal?.aborted).toBe(true); expect(screen.queryByText('Old private report')).toBeNull(); expect(fixture.net).toHaveBeenCalledTimes(1); expect(writer).not.toHaveBeenCalled(); if (change !== 'close') expect(text().value).toBe('');
  });
  it('confirms one archive, retains output after failure and suppresses notifications after close', async () => {
    const view = render(page()); fireEvent.change(text(), { target: { value: 'Research subject' } }); start(); await screen.findByText('result-ready'); const pending = deferred(); writer.mockReturnValueOnce(pending.promise); act(() => { archive(); archive(); start(); }); expect(writer).toHaveBeenCalledTimes(1); expect(toast.success).not.toHaveBeenCalled();
    await act(async () => pending.resolve(false)); await waitFor(() => expect(toast.error).toHaveBeenCalledWith('failed-to-archive-material')); expect(screen.getByText('result-ready')).toBeTruthy(); expect(toast.success).not.toHaveBeenCalled();
    writer.mockResolvedValueOnce(true); archive(); await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1)); expect(writer.mock.calls[1]).toEqual(['note', expect.any(String), expect.stringContaining('Completed document'), 'tool']);
    const closed = deferred(); writer.mockReturnValueOnce(closed.promise); archive(); view.unmount(); await act(async () => closed.resolve(true)); expect(toast.success).toHaveBeenCalledTimes(1);
  });
});

it.each([['packet', 'generate-packet'], ['research', 'generate-plan'], ['strategy', 'analyze-strategy']])('%s autoarchive snapshot failure is explicit and cannot trigger a second manual archive', async (nav, action) => {
  fixture.domain = 'personal'; writeLegalCaseFiles([hubCase('Case A')], 'Case A'); render(hubPage()); hubNav(nav);
  const archived = { ...readLegalCaseFiles()[0], updatedAt: new Date().toISOString(), materials: [{ id: 'server-only-result', type: 'note', title: 'Server result', content: 'Server archived body', source: 'tool', createdAt: new Date().toISOString() }] };
  fixture.net.mockResolvedValue(reply({ text: 'Server archived body', receipt: { ok: true, status: 'generated' }, caseUpdates: [archived] }));
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disk full'); });
  act(() => { fireEvent.click(screen.getByRole('button', { name: action })); fireEvent.click(screen.getByRole('button', { name: action })); });
  await screen.findByText('Error: disk full'); expect(fixture.net).toHaveBeenCalledTimes(1); expect(storage).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'archive-to-case' })).toBeNull(); expect(readLegalCaseFiles()[0].materials).toHaveLength(0);
  storage.mockRestore(); fireEvent.click(screen.getByRole('button', { name: action })); await screen.findByText('result-ready');
  expect(readLegalCaseFiles()[0].materials).toEqual([expect.objectContaining({ id: 'server-only-result', content: 'Server archived body' })]);
  expect(screen.queryByRole('button', { name: 'archive-to-case' })).toBeNull();
});

it.each([['citations', 'verify-citations', 'citation-text']])('%s manual archive retains output and stops duplicate writes when local storage fails', async (nav, action, placeholder) => {
  fixture.domain = 'personal'; writeLegalCaseFiles([hubCase('Case A')], 'Case A'); render(hubPage()); hubNav(nav); selectAdvancedLegalTool('legal_verify_citation'); fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: 'Source' } }); fireEvent.click(screen.getByRole('button', { name: action })); await screen.findByText('result-ready');
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disk full'); }); const archive = () => fireEvent.click(screen.getByRole('button', { name: 'archive-to-case' })); act(() => { archive(); archive(); }); await waitFor(() => expect(toast.error).toHaveBeenCalledWith('disk full')); expect(storage).toHaveBeenCalledTimes(1); expect(toast.success).not.toHaveBeenCalled(); expect(screen.getByText('result-ready')).toBeTruthy();
  storage.mockRestore(); archive(); await waitFor(() => expect(readLegalCaseFiles()[0].materials).toHaveLength(1));
});

it.each([false, true])('orders rapid edits, protects newer input and rolls back only failed writes (first fails: %s)', async fails => {
  const first = deferred(), second = deferred(); let saved = hubCase('Case A');
  fixture.net.mockImplementation(async (_url, init) => init?.method === 'PUT' ? first.promise : reply({ cases: [saved] }));
  render(<StrictMode>{hubPage()}</StrictMode>); await screen.findByRole('heading', { name: 'Case A' });
  act(() => { fireEvent.change(screen.getByLabelText('case-name'), { target: { value: 'First title' } }); for (const value of ['L', 'Latest', 'Latest party ']) fireEvent.change(screen.getByLabelText('party'), { target: { value } }); fireEvent.change(screen.getByLabelText('case-number'), { target: { value: '2026-1' } }); });
  expect(screen.getByDisplayValue('First title')).toBeTruthy(); expect((screen.getByLabelText('party') as HTMLInputElement).value).toBe('Latest party '); expect(fixture.net.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  fixture.net.mockImplementation(async (_url, init) => init?.method === 'PUT' ? second.promise : reply({ cases: [saved] })); hubEvent(); const reads = fixture.net.mock.calls.filter(([, init]) => !init?.method).length;
  await act(async () => first.resolve(fails ? reply({ error: 'first denied' }, 403) : reply(saved = { ...saved, title: 'First title' })));
  expect(fixture.net.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2); expect((screen.getByLabelText('party') as HTMLInputElement).value).toBe('Latest party '); expect(fixture.net.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(reads);
  expect(JSON.parse(fixture.net.mock.calls.filter(([, init]) => init?.method === 'PUT')[1][1].body)).toEqual({ party: 'Latest party ', caseNumber: '2026-1' });
  await act(async () => second.resolve(reply(saved = { ...saved, party: 'Latest party', caseNumber: '2026-1' }))); expect((screen.getByLabelText('case-name') as HTMLInputElement).value).toBe(fails ? 'Case A' : 'First title'); expect((screen.getByLabelText('party') as HTMLInputElement).value).toBe('Latest party'); expect((screen.getByLabelText('case-number') as HTMLInputElement).value).toBe('2026-1'); expect(fixture.net.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
  expect(toast.error).toHaveBeenCalledTimes(fails ? 1 : 0);
});

it.each(['organization', 'account', 'close'])('never sends queued case writes after %s changes', async change => {
  fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case A')] })); const view = render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise);
  for (const value of ['First', 'Second', 'Third']) fireEvent.change(screen.getByLabelText('case-name'), { target: { value } }); const signal = fixture.net.mock.calls.find(([, init]) => init?.method === 'PUT')![1].signal;
  if (change === 'close') view.unmount(); else { if (change === 'organization') fixture.org = 'org-b'; else fixture.user = 'other'; fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case B')] })); view.rerender(hubPage()); await screen.findByRole('heading', { name: 'Case B' }); }
  await act(async () => pending.resolve(reply({ ...hubCase('Case A'), title: 'First' }))); expect(signal.aborted).toBe(true); expect(fixture.net.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1); expect(toast.error).not.toHaveBeenCalled(); expect(screen.queryByDisplayValue('Second')).toBeNull();
});

it('keeps server material IDs and does not show an archive until its write is confirmed', async () => {
  const pending = deferred(); const file = hubCase('Case A');
  fixture.net.mockImplementation(async (url, init) => String(url).endsWith('/materials') ? pending.promise : reply(init?.method === 'POST' ? { text: 'Verified citation' } : { cases: [file] })); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); hubNav('citations'); selectAdvancedLegalTool('legal_verify_citation'); fireEvent.change(screen.getByPlaceholderText('citation-text'), { target: { value: 'Source citation' } }); fireEvent.click(screen.getByRole('button', { name: 'verify-citations' })); await screen.findByText('result-ready'); fireEvent.click(screen.getByRole('button', { name: 'archive-to-case' })); hubNav('Case overview');
  expect(screen.queryByRole('button', { name: /Server material/ })).toBeNull(); const body = JSON.parse(fixture.net.mock.calls.find(([url]) => String(url).endsWith('/materials'))![1].body); expect(body).not.toHaveProperty('id');
  await act(async () => pending.resolve(reply({ id: 'server-material', type: 'note', title: 'Server material', content: 'Confirmed content', createdAt: '2026-10-02' })));
  expect(screen.getByRole('button', { name: /Server material/ })).toBeTruthy(); expect(screen.queryByText('Confirmed content')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Server material/ })); expect(screen.getByText('Confirmed content')).toBeTruthy();
  await waitFor(() => expect(fixture.net.mock.calls.some(([url]) => url === '/api/legal/cases/Case%20A/materials/server-material/review')).toBe(true));
});

it.each(['create', 'delete'])('orders %s after edits without losing another case selection or saved fields', async action => {
  const pending = deferred(); fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case A'), hubCase('Case B')] })); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); fixture.net.mockReturnValueOnce(pending.promise);
  fireEvent.change(screen.getByLabelText('party'), { target: { value: 'Saved party' } });
  if (action === 'create') { fireEvent.click(screen.getByRole('button', { name: 'new-case' })); fireEvent.change(screen.getByPlaceholderText('example-alpha-v-beta-sales'), { target: { value: 'Case C' } }); }
  else fireEvent.click(screen.getByRole('button', { name: 'delete-case-value0 Case A' }));
  act(() => { const submit = screen.getByRole('button', { name: action === 'create' ? 'create-case' : 'delete' }); fireEvent.click(submit); fireEvent.click(submit); });
  if (action === 'delete') fireEvent.click(screen.getByRole('button', { name: /^Case B / }));
  expect(fixture.net.mock.calls.filter(([, init]) => ['POST', 'DELETE'].includes(init?.method))).toHaveLength(0); fixture.net.mockResolvedValue(reply(action === 'create' ? hubCase('Case C') : { success: true, caseId: 'Case A' }));
  await act(async () => pending.resolve(reply({ ...hubCase('Case A'), party: 'Saved party' }))); await screen.findByRole('heading', { name: action === 'create' ? 'Case C' : 'Case B' }); expect(fixture.net.mock.calls.filter(([, init]) => ['POST', 'DELETE'].includes(init?.method))).toHaveLength(1);
  if (action === 'create') { fireEvent.click(screen.getByRole('button', { name: /^Case A / })); expect((screen.getByLabelText('party') as HTMLInputElement).value).toBe('Saved party'); } else expect(screen.queryByRole('button', { name: /^Case A / })).toBeNull();
});

it('rejects an empty successful response, restores the saved field and allows the next write', async () => {
  fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case A')] })); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' });
  fixture.net.mockResolvedValueOnce(reply({})); fireEvent.change(screen.getByLabelText('case-name'), { target: { value: 'Unsaved' } }); await waitFor(() => expect(toast.error).toHaveBeenCalled()); expect((screen.getByLabelText('case-name') as HTMLInputElement).value).toBe('Case A');
  fixture.net.mockResolvedValueOnce(reply({ ...hubCase('Case A'), title: 'Recovered' })); fireEvent.change(screen.getByLabelText('case-name'), { target: { value: 'Recovered' } }); await act(async () => {}); expect((screen.getByLabelText('case-name') as HTMLInputElement).value).toBe('Recovered');
});

it('reports a failed merged edit once, keeps confirmed fields, and accepts a retry', async () => {
  const first = deferred(); let saved = hubCase('Case A'); fixture.net.mockResolvedValue(reply({ cases: [saved] })); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); fixture.net.mockReturnValueOnce(first.promise).mockResolvedValue(reply({ error: 'save denied' }, 403));
  fireEvent.change(screen.getByLabelText('case-name'), { target: { value: 'Saved title' } }); for (const value of ['a', 'ab', 'abc']) fireEvent.change(screen.getByLabelText('party'), { target: { value } });
  await act(async () => first.resolve(reply(saved = { ...saved, title: 'Saved title' }))); expect(toast.error).toHaveBeenCalledTimes(1); expect(toast.error).toHaveBeenCalledWith('save denied'); expect(fixture.net.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2); expect((screen.getByLabelText('party') as HTMLInputElement).value).toBe(''); expect(screen.getByDisplayValue('Saved title')).toBeTruthy();
  fixture.net.mockResolvedValueOnce(reply({ ...saved, party: 'Retry' })); fireEvent.change(screen.getByLabelText('party'), { target: { value: 'Retry ' } }); await act(async () => {}); expect((screen.getByLabelText('party') as HTMLInputElement).value).toBe('Retry');
});

it('preserves case boundaries and edit order when returning to an earlier case', async () => {
  const first = deferred(); const saved = [hubCase('Case A'), hubCase('Case B')]; fixture.net.mockResolvedValue(reply({ cases: saved })); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); fixture.net.mockReturnValueOnce(first.promise).mockImplementation(async (url, init) => { const file = saved.find(item => String(url).endsWith(encodeURIComponent(item.id)))!; return reply(Object.assign(file, JSON.parse(init.body))); });
  const edit = (value: string) => fireEvent.change(screen.getByLabelText('party'), { target: { value } }); const select = (id: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${id} `) }));
  edit('A1'); edit('A2'); edit('A3'); select('Case B'); edit('B1'); edit('B2'); select('Case A'); edit('A4'); edit('A5');
  await act(async () => first.resolve(reply(Object.assign(saved[0], { party: 'A1' })))); expect(fixture.net.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url, init]) => [decodeURIComponent(String(url).split('/').at(-1)!), JSON.parse(init.body)])).toEqual([['Case A', { party: 'A1' }], ['Case A', { party: 'A3' }], ['Case B', { party: 'B2' }], ['Case A', { party: 'A5' }]]);
  expect((screen.getByLabelText('party') as HTMLInputElement).value).toBe('A5'); select('Case B'); expect((screen.getByLabelText('party') as HTMLInputElement).value).toBe('B2');
});

it('releases a timed-out write so the latest queued edit can still save', async () => {
  const deadline = new AbortController(); const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal); fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case A')] })); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' });
  fixture.net.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))).mockImplementation(async (_url, init) => reply({ ...hubCase('Case A'), ...JSON.parse(init.body) }));
  for (const value of ['First', 'Second', 'Latest']) fireEvent.change(screen.getByLabelText('party'), { target: { value } }); expect(timeout).toHaveBeenCalledWith(15_000);
  await act(async () => deadline.abort(new DOMException('Save timed out', 'TimeoutError'))); expect(toast.error).toHaveBeenCalledTimes(1); expect(toast.error).toHaveBeenCalledWith('Save timed out'); expect(fixture.net.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2); expect((screen.getByLabelText('party') as HTMLInputElement).value).toBe('Latest');
});
const noticeInput = () => screen.getByPlaceholderText('paste-sms-or-court-notice') as HTMLTextAreaElement;
const noticeText = '(2026)测试民初1号，测试人民法院，开庭日期：2026年10月12日 https://court.invalid/notice';
describe.each([
  ['packet', 'generate-packet', 'legal_generate_litigation_packet', ''],
  ['strategy', 'reasoning-matrix', 'legal_case_reasoning_matrix', 'legal_case_reasoning_matrix'],
  ['citations', 'Document review', 'legal_finalize_delivery_package', 'legal_finalize_delivery_package'],
])('%s dedicated business-page action', (nav, action, tool, mode) => {
  const open = () => {
    hubNav(nav);
    if (mode === 'legal_case_reasoning_matrix') selectAdvancedLegalTool(mode);
    if (mode === 'legal_finalize_delivery_package') {
      expect(within(document.querySelector('.lumi-legal-content') as HTMLElement).getByRole('button', { name: workspaceCopy().documentCheck })).toBeTruthy();
      const advanced = screen.getByText(workspaceCopy().advancedOptions, { selector: 'summary' }).closest('details')!;
      expect(advanced.open).toBe(false);
      expect(screen.getByRole('combobox', { name: workspaceCopy().toolMode }).closest('details')).toBe(advanced);
    }
  };
  const start = () => fireEvent.click(within(document.querySelector('.lumi-legal-content') as HTMLElement).getByRole('button', { name: action }));
  const toolCalls = () => fixture.net.mock.calls.filter(([url]) => url === '/api/legal/tool/' + tool);
  const withArchivedResult = (file: LegalCaseFile = workspaceCase(), content = 'Verified tool output') => ({ ...file, materials: [
    { id: 'exact-server-' + tool, type: 'note' as const, title: 'Server result', content, source: 'tool' as const, createdAt: '2026-10-15' }, ...file.materials,
  ] });
  it('serializes duplicate generation, merges one exact server archive, and preserves prior material on failure', async () => {
    fixture.domain = 'personal'; const original = workspaceCase(); writeLegalCaseFiles([original], original.id);
    render(<StrictMode>{hubPage()}</StrictMode>); open();
    const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise);
    act(() => { start(); start(); }); expect(toolCalls()).toHaveLength(1);
    const archived = withArchivedResult(original);
    await act(async () => pending.resolve(reply({ text: 'Verified tool output', receipt: { ok: true, status: 'generated' }, caseUpdates: [archived] })));
    await screen.findByText('result-ready');
    expect(readLegalCaseFiles()[0].materials.map(material => [material.id, material.content])).toEqual([
      ['exact-server-' + tool, 'Verified tool output'], ['draft', 'Source draft text'],
    ]);
    expect(screen.queryByRole('button', { name: 'archive-to-case' })).toBeNull();
    expect(fixture.net.mock.calls.some(([url]) => String(url).endsWith('/materials'))).toBe(false);
    fixture.net.mockResolvedValueOnce(reply({ error: 'model unavailable' }, 503)); start(); await screen.findByText(/model unavailable/);
    expect(toolCalls()).toHaveLength(2);
    expect(readLegalCaseFiles()[0].materials.map(material => material.id)).toEqual(['exact-server-' + tool, 'draft']);
    expect(screen.queryByText('result-ready')).toBeNull(); expect(screen.queryByText(/completed-and-archived|generated-and-archived/)).toBeNull();
  });
  it('drops late replies on case change and close while preserving the case search filter', async () => {
    fixture.domain = 'personal'; writeLegalCaseFiles([workspaceCase()], 'Case A'); const view = render(hubPage());
    fireEvent.change(screen.getByPlaceholderText('search-case-number-party'), { target: { value: 'Case' } });
    fireEvent.change(noticeInput(), { target: { value: 'Private A notice' } }); open();
    const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); start(); const signal = toolCalls().at(-1)![1].signal;
    act(() => writeLegalCaseFiles([workspaceCase('Case B')], 'Case B'));
    await act(async () => pending.resolve(reply({ text: 'Old A output', receipt: { ok: true, status: 'generated' }, caseUpdates: [withArchivedResult(workspaceCase(), 'Old A output')] })));
    expect(readLegalCaseFiles().map(file => [file.id, file.materials.length])).toEqual([['Case B', 1]]);
    expect(screen.queryAllByText('Old A output')).toHaveLength(0); expect(signal?.aborted).toBe(true);
    hubNav('Case overview'); expect(noticeInput().value).toBe(''); expect(screen.getByDisplayValue('Case')).toBeTruthy(); open();
    const closed = deferred(); fixture.net.mockReturnValueOnce(closed.promise); start(); const closeSignal = toolCalls().at(-1)![1].signal;
    view.unmount(); await act(async () => closed.resolve(reply({ text: 'Closed output', receipt: { ok: true, status: 'generated' }, caseUpdates: [withArchivedResult(workspaceCase('Case B'), 'Closed output')] })));
    expect(closeSignal.aborted).toBe(true); expect(readLegalCaseFiles()[0].materials).toHaveLength(1);
    expect(readLegalCaseFiles()[0].materials[0].id).toBe('draft'); expect(screen.queryByText('Closed output')).toBeNull();
  });
  it('retains organization arguments and complete source tails without a second material write', async () => {
    let file: LegalCaseFile = workspaceCase(); file.materials[0].content = 'x'.repeat(25000) + 'FULL-ORGANIZATION-TAIL';
    fixture.net.mockImplementation(async (url, init) => {
      if (url === '/api/legal/tool/' + tool) {
        file = withArchivedResult(file, 'Backend archived result');
        return reply({ text: 'Backend archived result', receipt: { ok: true, status: 'generated' }, caseUpdates: [file] });
      }
      return reply({ cases: [file] });
    });
    render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); open(); start(); await screen.findByText('Backend archived result');
    const args = JSON.parse(toolCalls()[0][1].body).args;
    expect(args).toMatchObject({ caseId: 'Case A', orgId: 'org-a', persistCase: true });
    expect(fixture.net.mock.calls.some(([url]) => String(url).endsWith('/materials'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'archive-to-case' })).toBeNull();
    if (mode === 'legal_finalize_delivery_package') {
      expect(args.content).toBe(file.materials.find(material => material.id === 'draft')!.content);
      expect(args.content.endsWith('FULL-ORGANIZATION-TAIL')).toBe(true);
      expect(args).toMatchObject({ includeDocx: true, includePdf: false });
    } else if (mode === 'legal_case_reasoning_matrix') {
      expect(args.writeFiles).toBe(true); expect(args.facts).toContain('FULL-ORGANIZATION-TAIL'); expect(args.materials).toBe(args.facts);
    } else {
      expect(args.facts).toContain('Source draft'); expect(args.facts).toContain('FULL-ORGANIZATION-TAIL'); expect(args.evidence).toBe('');
    }
    hubNav('Case overview');
    expect(screen.getByRole('button', { name: /Server result/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Server result/ })).toHaveLength(1);
  });
});

it('notice extraction preserves parsed fields and source material together without duplicate clicks', async () => {
  fixture.domain = 'personal'; writeLegalCaseFiles([hubCase('Case A')], 'Case A'); render(<StrictMode>{hubPage()}</StrictMode>); fireEvent.change(noticeInput(), { target: { value: noticeText } }); act(() => { fireEvent.click(screen.getByRole('button', { name: 'extract' })); fireEvent.click(screen.getByRole('button', { name: 'extract' })); }); await screen.findByText('notice-extracted-review-case-number');
  expect(readLegalCaseFiles()[0]).toMatchObject({ caseNumber: '(2026)测试民初1号', court: '测试人民法院', hearingDate: '2026-10-12', materials: [expect.objectContaining({ content: noticeText, source: 'notice' })] }); expect(fixture.net).not.toHaveBeenCalled();
});

it.each(['fields', 'material'])('stops notice processing when %s persistence fails', async phase => {
  fixture.net.mockImplementation(async (url, init) => reply(init?.method === (phase === 'fields' ? 'PUT' : 'POST') ? { error: 'write denied' } : init?.method === 'PUT' ? { ...hubCase('Case A'), ...JSON.parse(init.body) } : { cases: [hubCase('Case A')] }, init?.method === (phase === 'fields' ? 'PUT' : 'POST') ? 403 : 200)); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); fireEvent.change(noticeInput(), { target: { value: noticeText } }); fireEvent.click(screen.getByRole('button', { name: 'process-link' })); await waitFor(() => expect(toast.error).toHaveBeenCalledWith('write denied'));
  expect(fixture.net.mock.calls.some(([url]) => String(url).includes('/api/legal/tool/'))).toBe(false); expect(screen.queryByText(/notice-link-processed-and-archived/)).toBeNull(); await screen.findByText(/^Error:/);
});

it('waits for source-material persistence and displays browser handoff without inventing download completion', async () => {
  const saved = deferred(); fixture.net.mockImplementation(async (url, init) => String(url).endsWith('/materials') ? saved.promise : reply(String(url).includes('/api/legal/tool/') ? { text: 'Authorized browser login still required' } : init?.method === 'PUT' ? { ...hubCase('Case A'), ...JSON.parse(init.body) } : { cases: [hubCase('Case A')] })); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); fireEvent.change(noticeInput(), { target: { value: noticeText } }); fireEvent.click(screen.getByRole('button', { name: 'process-link' })); await waitFor(() => expect(fixture.net.mock.calls.some(([url]) => String(url).endsWith('/materials'))).toBe(true)); expect(fixture.net.mock.calls.some(([url]) => String(url).includes('/api/legal/tool/'))).toBe(false);
  await act(async () => saved.resolve(reply({ id: 'source-material' }))); await screen.findByText('Authorized browser login still required'); expect(fixture.net.mock.calls.filter(([url]) => String(url).endsWith('/materials'))).toHaveLength(1); expect(screen.queryByText('notice-link-processed-and-archived')).toBeNull(); const args = JSON.parse(fixture.net.mock.calls.find(([url]) => String(url).includes('/api/legal/tool/'))![1].body).args; expect(args).toMatchObject({ confirmedForKb: false, includeExtractedText: true, extractedTextLimit: 8000, message: noticeText, noticeText });
});

it('does not continue an old notice workflow after changing cases during field persistence', async () => {
  const saved = deferred(); fixture.net.mockImplementation(async (_url, init) => init?.method === 'PUT' ? saved.promise : reply({ cases: [hubCase('Case A'), hubCase('Case B')] })); render(hubPage()); await screen.findByRole('heading', { name: 'Case A' }); fireEvent.change(noticeInput(), { target: { value: noticeText } }); fireEvent.click(screen.getByRole('button', { name: 'process-link' })); fireEvent.click(screen.getByRole('button', { name: /^Case B / })); await screen.findByRole('heading', { name: 'Case B' }); await act(async () => saved.resolve(reply(hubCase('Case A'))));
  expect(fixture.net.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false); expect(noticeInput().value).toBe(''); expect(screen.queryByText(/notice-link-processed-and-archived/)).toBeNull();
});

it('prefills the original contract without feeding a generated review back into the model', () => {
  const file = { ...caseFile(), materials: [
    { type: 'contract', source: 'tool', title: '合同审查报告', content: 'Generated review' },
    { type: 'contract', source: 'import', title: '原始合同', content: 'Original contract' },
  ] };
  const view = render(<LegalContractReview caseFile={file} />);
  expect(document.querySelector('textarea')!.value).toBe('Original contract');
  view.rerender(<LegalContractReview caseFile={{ ...file, id: 'b', materials: [file.materials[0]] }} />);
  expect(document.querySelector('textarea')!.value).toBe('');
});

it('shows the complete contract review instead of hiding its body behind a parsed risk, and preserves active work on a language change', async () => {
  const file = { ...caseFile(), materials: [{ type: 'contract', content: 'x'.repeat(10001) }] };
  const view = render(<LegalContractReview caseFile={file} />); expect(document.querySelector('textarea')!.value).toHaveLength(10001);
  const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); fireEvent.click(screen.getByRole('button', { name: 'review' }));
  const init = fixture.net.mock.calls[0][1]; expect(JSON.parse(init.body).args.contract).toHaveLength(10001); fixture.language = 'zh'; view.rerender(<LegalContractReview caseFile={file} />); expect(init.signal?.aborted ?? false).toBe(false);
  const report = '## 审查覆盖范围\n已覆盖输入。\n\n## 风险点\n验收标准缺失。\n违约金每逾期一日按合同总价5%。\n\n## 修改建议\n补齐技术标准和验收程序；重新约定违约金基数及上限。\n\n## 待确认事项\n法院及附件待核实。';
  await act(async () => pending.resolve(reply({ text: report })));
  expect((await screen.findByText(/验收标准缺失/)).textContent).toContain('违约金每逾期一日按合同总价5%');
  expect(screen.getByRole('heading', { name: '审查覆盖范围' })).toBeTruthy();
  expect(screen.getByText(/补齐技术标准和验收程序/)).toBeTruthy();
  expect(screen.getByText('法院及附件待核实。')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'review' })).not.toHaveProperty('disabled', true);
  const revised = '## 审查结果\nNew issue\nNew reason';
  fixture.net.mockResolvedValueOnce(reply({ text: revised })); fireEvent.click(screen.getByRole('button', { name: 'review' }));
  expect((await screen.findByText(/New reason/)).textContent).toContain('New issue'); expect(screen.queryByText(/验收标准缺失/)).toBeNull();
});

it('reads the whole uploaded contract rather than a preview, and prevents duplicate review while reading', async () => {
  const fullText = 'Complete contract clause '.repeat(700);
  fixture.net.mockResolvedValueOnce(reply({ files: [{ id: 'contract-full', name: 'full.docx', preview: 'short preview' }] }));
  const full = deferred(); fixture.net.mockReturnValueOnce(full.promise); render(<StrictMode><LegalContractReview /></StrictMode>);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['source'], 'full.docx')] } });
  await waitFor(() => expect(fixture.net).toHaveBeenCalledTimes(2));
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'review' })); fireEvent.click(screen.getByRole('button', { name: 'review' })); }); expect(fixture.net).toHaveBeenCalledTimes(2);
  expect(fixture.net.mock.calls[1][0]).toBe('/api/files/text/contract-full?domain=work&orgId=org-a');
  await act(async () => full.resolve(reply({ text: fullText, truncated: false })));
  expect(document.querySelector('textarea')!.value).toBe('# full.docx\n' + fullText);
  fireEvent.click(screen.getByRole('button', { name: 'review' })); await act(async () => {});
  expect(JSON.parse(fixture.net.mock.calls[2][1].body).args.contract).toBe('# full.docx\n' + fullText);
});
it('keeps an encrypted contract pending until a transient password succeeds', async () => {
  const copy = legalReviewQualityCopy.en;
  fixture.net.mockResolvedValueOnce(reply({ files: [{ id: 'encrypted', name: 'protected.pdf', preview: 'incomplete preview' }] })).mockResolvedValueOnce(reply({ error: 'PDF_PASSWORD_REQUIRED' }, 422));
  render(<LegalContractReview />); fireEvent.change(document.querySelector('textarea')!, { target: { value: 'Existing contract' } });
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['pdf'], 'protected.pdf')] } });
  await screen.findByText(copy.pending); expect((screen.getByRole('button', { name: 'review' }) as HTMLButtonElement).disabled).toBe(true);
  const password = document.querySelector('input[type=password]') as HTMLInputElement; fireEvent.change(password, { target: { value: 'temporary-secret' } });
  fixture.net.mockResolvedValueOnce(reply({ text: 'Complete protected contract', truncated: false })); fireEvent.click(screen.getByRole('button', { name: copy.retry }));
  await waitFor(() => expect(document.querySelector('textarea')!.value).toContain('Complete protected contract'));
  expect(JSON.parse(fixture.net.mock.calls[2][1].body)).toEqual({ password: 'temporary-secret' }); expect(password.value).toBe(''); expect(JSON.stringify(localStorage)).not.toContain('temporary-secret');
  expect((screen.getByRole('button', { name: 'review' }) as HTMLButtonElement).disabled).toBe(false);
});
it.each(['case', 'close'])('cancels a pending full-contract read on %s without appending stale text', async change => {
  fixture.net.mockResolvedValueOnce(reply({ files: [{ id: 'full', name: 'old.pdf', preview: 'old preview' }] })); const full = deferred(); fixture.net.mockReturnValueOnce(full.promise);
  const view = render(<LegalContractReview caseFile={caseFile()} />); fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['pdf'], 'old.pdf')] } });
  await waitFor(() => expect(fixture.net).toHaveBeenCalledTimes(2)); const signal = fixture.net.mock.calls[1][1].signal;
  if (change === 'close') view.unmount(); else view.rerender(<LegalContractReview caseFile={caseFile('b')} />);
  await act(async () => full.resolve(reply({ text: 'Stale full contract', truncated: false }))); expect(signal.aborted).toBe(true); expect(screen.queryByText('Stale full contract')).toBeNull();
  if (change === 'case') expect(document.querySelector('textarea')!.value).toBe('');
});
it.each(['case', 'close'])('serializes asset preflight and stops its continuation after %s', async change => {
  const copy = chinaLegalCopy('en').assetTraceWorkflow, preflight = deferred(), update = vi.fn(); fixture.net.mockReturnValueOnce(preflight.promise);
  const view = render(<StrictMode><LegalAssetTrace caseFile={caseFile()} onUpdateCase={update} /></StrictMode>);
  fireEvent.change(screen.getByPlaceholderText(copy.subjectPlaceholder), { target: { value: 'Synthetic company' } });
  act(() => { fireEvent.click(screen.getByRole('button', { name: copy.start })); fireEvent.click(screen.getByRole('button', { name: copy.start })); }); expect(fixture.net).toHaveBeenCalledTimes(1);
  expect(fixture.net.mock.calls[0][0]).toBe('/api/legal/tool/legal_external_source_status'); const signal = fixture.net.mock.calls[0][1].signal, writes = update.mock.calls.length;
  if (change === 'close') view.unmount(); else view.rerender(<LegalAssetTrace caseFile={caseFile('b')} onUpdateCase={update} />);
  await act(async () => preflight.resolve(reply({ text: 'Source is ready', receipt: { ok: true, status: 'ready' } })));
  expect(signal.aborted).toBe(true); expect(fixture.net).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(writes);
});

it('makes generated legal files reachable through the existing preview, save and folder controls', async () => {
  const filePath = 'C:\\LumiLegalTest\\generated\\packet.docx';
  const report = '# 文书包\n| 文件 | 状态 |\n| --- | --- |\n| ' + filePath + ' | 已生成 |\n\nDOCX: ' + filePath;
  fixture.net.mockImplementation(async (_url, init) => reply(init?.method === 'POST' ? { success: true, path: filePath } : { kind: 'text', text: 'Synthetic generated document preview' }));
  render(<LegalTwoPaneTool icon={null} accent="blue" title="Documents" desc="Synthetic test" left={<div />} result={report} successfulResult={report} emptyText="Empty" />);
  expect(screen.getAllByRole('button', { name: 'packet.docx' })).toHaveLength(1);
  expect(screen.getByRole('table')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'packet.docx' }));
  const dialog = await screen.findByRole('dialog', { name: 'Preview: packet.docx' });
  await within(dialog).findByText('Synthetic generated document preview');
  expect(within(dialog).getByRole('button', { name: 'Save file' })).toBeTruthy();
  expect(fixture.net.mock.calls.some(([url, init]) => String(url).includes('/api/files/generated?') && String(url).includes('preview=1') && init.redirect === 'error')).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: /folder/i }));
  await waitFor(() => expect(fixture.net.mock.calls.some(([url, init]) => url === '/api/files/open' && JSON.parse(init.body).path === filePath && JSON.parse(init.body).reveal === true)).toBe(true));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close preview' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps original facts available and references server evidence by case ID after many archived model reports', async () => {
  const file = caseFile('source-case', 'Synthetic source case');
  file.notes = 'USER_FACTS: total 800000, paid 200000';
  file.materials = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: 'report-' + i, type: 'evidence', source: 'tool', title: 'Generated analysis ' + i, content: 'MODEL_INFERENCE_' + i })),
    { id: 'original-contract', type: 'contract', source: 'import', title: 'Original supply contract', content: 'ORIGINAL_CONTRACT: delivery in 30 days' },
    { id: 'original-receipt', type: 'evidence', source: 'manual', title: 'Original payment receipt', content: 'ORIGINAL_RECEIPT: payment 200000' },
  ];
  const context = legalCaseDraftContext(file);
  expect(context).toContain('USER_FACTS');
  expect(context).toContain('ORIGINAL_CONTRACT');
  expect(context).toContain('ORIGINAL_RECEIPT');
  expect(context).not.toContain('MODEL_INFERENCE');
  render(<LegalPacketView caseFile={file} orgId={fixture.org} />);
  fireEvent.click(screen.getByRole('button', { name: 'generate-packet' }));
  await screen.findByText('Completed document');
  const args = JSON.parse(fixture.net.mock.calls[0][1].body).args;
  expect(args.facts).toBe(context);
  expect(args.evidence).toBe('');
  expect(args).not.toHaveProperty('sourceCase');
  expect(args).toMatchObject({ caseId: 'source-case', orgId: 'org-a', persistCase: true });
});

it('keeps the original horizontal case workflow without a second data-source form', async () => {
  fixture.net.mockResolvedValue(reply({ cases: [hubCase('Case with original workflow')] }));
  render(hubPage());
  await screen.findByRole('heading', { name: 'Case with original workflow' });
  const nav = screen.getByRole('navigation');
  expect(nav.className).toContain('overflow-x-auto');
  expect(within(nav).getAllByRole('button')).toHaveLength(10);
  expect(within(nav).queryByRole('button', { name: 'data-sources' })).toBeNull();
  expect(document.getElementById('legal-data-sources')).toBeNull();
  hubNav('contract-review');
  expect(screen.getByRole('button', { name: 'review' })).toBeTruthy();
});

it('keeps standalone legal tools separate and returns the original case entry to its first step', async () => {
  fixture.net.mockImplementation(async (url) => reply(String(url).includes('/api/org/legal/cases') ? { cases: [hubCase('Original case')] } : { text: 'Review complete' }));
  const view = render(<LegalHub initialView="contract-review" />);
  expect(screen.queryByRole('navigation')).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Synthetic standalone contract' } });
  fireEvent.click(screen.getByRole('button', { name: 'review' }));
  await screen.findByText('Review complete');
  const standalone = JSON.parse(fixture.net.mock.calls.find(([url]) => String(url).includes('legal_review_contract'))![1].body).args;
  expect(standalone.caseId).toBeUndefined(); expect(standalone.persistCase).toBe(false);
  view.rerender(<LegalHub initialView="workspace" workspaceResetKey={1} />);
  await screen.findByRole('heading', { name: 'Original case' });
  hubNav('contract-review');
  expect(screen.getByRole('button', { name: 'review' })).toBeTruthy();
  view.rerender(<LegalHub initialView="workspace" workspaceResetKey={2} />);
  await screen.findByRole('heading', { name: 'Original case' });
});
