// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegalAssetTrace } from '../src/components/org/LegalAssetTrace';
import { chinaLegalCopy } from '../src/i18n/regions/cn/legal';
import { setLocale } from '../src/i18n/runtime';
import { createAssetTraceWorkflow, patchAssetTraceStep, type AssetTraceWorkflow } from '../src/lib/legalAssetTraceWorkflow';

vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ workDomain: 'personal', orgConnection: null, user: { uid: 'asset-progression-owner' } }) }));

const storageKey = 'lumi_legal_asset_trace_workflow_v1';
const copy = chinaLegalCopy('zh').assetTraceWorkflow;
const subject = 'Synthetic Progression Enterprise';
const originalQuickOutput = '# Preserved quick source\n\n' + 'Existing source text remains unchanged.\n'.repeat(160);
const originalNote = 'Synthetic original note';
const originalQuickTimestamp = '2026-10-24T12:34:56.000Z';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setLocale('zh');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function stepTitle(id: string) {
  return copy.steps[id as keyof typeof copy.steps].title;
}
function savedWorkflow(runMode: 'quick' | 'deep' = 'quick') {
  const workflow = patchAssetTraceStep(createAssetTraceWorkflow({ subjectName: subject, subjectType: 'enterprise', runMode }), 'quick-scan', {
    status: 'completed', output: originalQuickOutput, note: originalNote,
  });
  workflow.steps[0].updatedAt = originalQuickTimestamp;
  return workflow;
}
function openWorkflow(workflow: AssetTraceWorkflow) {
  localStorage.setItem(storageKey, JSON.stringify(workflow));
  render(<LegalAssetTrace />);
}
function currentSaved(): AssetTraceWorkflow {
  return JSON.parse(localStorage.getItem(storageKey)!);
}
function successfulResponse(text = '# Synthetic next-step output') {
  return new Response(JSON.stringify({ text, receipt: { ok: true, status: 'observed' }, verification: { status: 'verified' } }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
function formatted(template: string, id: string) {
  return template.replace('{step}', stepTitle(id));
}
function expectQuickSourcePreserved(workflow: AssetTraceWorkflow) {
  expect(workflow.steps.find(step => step.id === 'quick-scan')).toMatchObject({
    status: 'completed', output: originalQuickOutput, note: originalNote, updatedAt: originalQuickTimestamp,
  });
}
function expectPrimaryBeforeResult(button: HTMLElement) {
  const controls = screen.getByTestId('asset-trace-controls');
  const tabs = screen.getByTestId('asset-trace-result-tabs');
  expect(controls.contains(button)).toBe(true);
  expect(controls.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(controls.classList.contains('sticky')).toBe(true);
  expect(controls.classList.contains('top-0')).toBe(true);
  expect(within(controls).getAllByRole('button')).toHaveLength(1);
}

describe('asset trace progression stays with its visible stage and result controls', () => {
  it('puts the single quick-scan continuation before tabs and the long report, rather than below its contents', async () => {
    const workflow = savedWorkflow();
    const original = JSON.stringify(workflow);
    openWorkflow(workflow);
    const action = await screen.findByRole('button', { name: copy.startDeep });
    expect(screen.getByRole('status').textContent).toContain('快速扫描已完成');
    expect(screen.getByText(copy.quickProgress + ': 1/1')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: copy.startDeep })).toHaveLength(1);
    expectPrimaryBeforeResult(action);
    const outputHeading = screen.getByRole('heading', { name: 'Preserved quick source' });
    expect(screen.getByTestId('asset-trace-controls').compareDocumentPosition(outputHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: '进入深度调查' })).toBeNull();
    expect(localStorage.getItem(storageKey)).toBe(original);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a ready deep investigation as steps remaining, rather than a blocked workflow', async () => {
    const workflow = savedWorkflow('deep');
    const original = JSON.stringify(workflow);
    openWorkflow(workflow);
    fireEvent.click(await screen.findByRole('button', { name: copy.report }));
    const report = screen.getByRole('heading', { name: copy.reportLabels.title }).closest('article')!;
    expect(within(report).getByText(copy.readyToContinue)).toBeTruthy();
    expect(within(report).getByText(stepTitle('enterprise-company-profile') + ': ' + copy.statusLabels.pending)).toBeTruthy();
    expect(within(report).queryByText(copy.stepBlocked)).toBeNull();
    expect(within(report).queryByText(copy.workflowComplete)).toBeNull();
    expect(report.textContent).not.toContain('上方');
    expect(localStorage.getItem(storageKey)).toBe(original);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the quick-scan report limited to that stage and names deep investigation as the next action', async () => {
    const workflow = savedWorkflow();
    const original = JSON.stringify(workflow);
    openWorkflow(workflow);
    fireEvent.click(await screen.findByRole('button', { name: copy.report }));
    const report = screen.getByRole('heading', { name: copy.reportLabels.title }).closest('article')!;
    expect(within(report).getByText(copy.quickComplete)).toBeTruthy();
    expect(within(report).getByText(copy.startDeep, { selector: 'li' })).toBeTruthy();
    expect(within(report).queryByText(copy.workflowComplete)).toBeNull();
    expect(within(report).queryByText(copy.stepBlocked)).toBeNull();
    expect(report.textContent).not.toContain('上方');
    expect(localStorage.getItem(storageKey)).toBe(original);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('promotes once and executes the first deep step from a result tab, without rerunning the quick scan or altering its source', async () => {
    let resolveResponse!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { resolveResponse = resolve; }));
    openWorkflow(savedWorkflow());
    fireEvent.click(await screen.findByRole('button', { name: copy.company }));
    expect(screen.queryByRole('heading', { name: stepTitle('enterprise-company-profile') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.startDeep }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/api/legal/tool/legal_company_database_lookup');
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).args).toMatchObject({ name: subject, persistCase: false });
    expect(currentSaved().runMode).toBe('deep');
    expect(currentSaved().steps.find(step => step.id === 'enterprise-company-profile')?.status).toBe('running');
    expect(screen.getByRole('heading', { name: stepTitle('enterprise-company-profile') })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(stepTitle('enterprise-company-profile'));
    expectQuickSourcePreserved(currentSaved());
    await act(async () => { resolveResponse(successfulResponse()); });
    await waitFor(() => expect(currentSaved().steps.find(step => step.id === 'enterprise-company-profile')?.status).toBe('completed'));
    expectQuickSourcePreserved(currentSaved());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: formatted(copy.executeNext, 'enterprise-judicial-cases') })).toBeTruthy();
  });

  it('names and runs the next pending deep step while preserving every earlier completed output', async () => {
    const profileOutput = '# Existing company profile\nSynthetic baseline evidence';
    const workflow = patchAssetTraceStep(savedWorkflow('deep'), 'enterprise-company-profile', { status: 'completed', output: profileOutput });
    const priorProfile = { ...workflow.steps.find(step => step.id === 'enterprise-company-profile')! };
    vi.mocked(fetch).mockResolvedValue(successfulResponse('# Synthetic case search result'));
    openWorkflow(workflow);
    const action = await screen.findByRole('button', { name: formatted(copy.executeNext, 'enterprise-judicial-cases') });
    expectPrimaryBeforeResult(action);
    fireEvent.click(action);
    await waitFor(() => expect(currentSaved().steps.find(step => step.id === 'enterprise-judicial-cases')?.status).toBe('completed'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/api/legal/tool/legal_search_subject_cases');
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).args).toMatchObject({ name: subject, subjectType: 'enterprise', scope: 'cases', persistCase: false });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).args).not.toHaveProperty('query');
    expect(currentSaved().steps.find(step => step.id === 'enterprise-company-profile')).toEqual(priorProfile);
    expectQuickSourcePreserved(currentSaved());
  });

  it('opens a manual step as a pending action without an API call, and keeps review on the same step across result tabs', async () => {
    let workflow = savedWorkflow('deep');
    for (const id of ['enterprise-company-profile', 'enterprise-judicial-cases', 'enterprise-web-footprint', 'enterprise-related-parties']) {
      workflow = patchAssetTraceStep(workflow, id, { status: 'completed', output: '# Earlier completed ' + id });
    }
    const earlier = workflow.steps.filter(step => step.status === 'completed');
    openWorkflow(workflow);
    fireEvent.click(await screen.findByRole('button', { name: formatted(copy.executeNext, 'enterprise-finance-tax') }));
    await waitFor(() => expect(currentSaved().steps.find(step => step.id === 'enterprise-finance-tax')?.status).toBe('needs_action'));
    expect(currentSaved().steps.filter(step => earlier.some(prior => prior.id === step.id))).toEqual(earlier);
    expect(screen.getByRole('heading', { name: stepTitle('enterprise-finance-tax') })).toBeTruthy();
    expect(screen.getByPlaceholderText(copy.manualNotePlaceholder)).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.markComplete }).hasAttribute('disabled')).toBe(true);
    const blockedSaved = localStorage.getItem(storageKey);
    fireEvent.click(screen.getByRole('button', { name: copy.company }));
    const review = screen.getByRole('button', { name: formatted(copy.reviewStep, 'enterprise-finance-tax') });
    expectPrimaryBeforeResult(review);
    fireEvent.click(review);
    expect(screen.getByRole('heading', { name: stepTitle('enterprise-finance-tax') })).toBeTruthy();
    expect(localStorage.getItem(storageKey)).toBe(blockedSaved);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('locates an existing assisted pending action without re-requesting its already returned output', async () => {
    let workflow = savedWorkflow('deep');
    for (const id of ['enterprise-company-profile', 'enterprise-judicial-cases', 'enterprise-web-footprint', 'enterprise-related-parties', 'enterprise-finance-tax']) workflow = patchAssetTraceStep(workflow, id, { status: 'completed' });
    workflow = patchAssetTraceStep(workflow, 'enterprise-bids-receivables', { status: 'needs_action', output: '# Existing handoff output', note: 'Existing lawyer task' });
    const original = JSON.stringify(workflow);
    openWorkflow(workflow);
    fireEvent.click(await screen.findByRole('button', { name: copy.report }));
    fireEvent.click(screen.getByRole('button', { name: formatted(copy.reviewStep, 'enterprise-bids-receivables') }));
    expect(screen.getByRole('heading', { name: stepTitle('enterprise-bids-receivables') })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Existing handoff output' })).toBeTruthy();
    expect((screen.getByPlaceholderText(copy.manualNotePlaceholder) as HTMLTextAreaElement).value).toBe('Existing lawyer task');
    expect(localStorage.getItem(storageKey)).toBe(original);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['completed', 'skipped'] as const)('updates the next action after a manual step is %s without silently executing the next query', async resolution => {
    let workflow = savedWorkflow('deep');
    for (const id of ['enterprise-company-profile', 'enterprise-judicial-cases', 'enterprise-web-footprint', 'enterprise-related-parties']) {
      workflow = patchAssetTraceStep(workflow, id, { status: 'completed', output: '# Already checked ' + id });
    }
    workflow = patchAssetTraceStep(workflow, 'enterprise-finance-tax', { status: 'needs_action', note: 'Synthetic existing review note' });
    openWorkflow(workflow);
    await screen.findByRole('heading', { name: stepTitle('enterprise-finance-tax') });
    if (resolution === 'completed') fireEvent.change(screen.getByPlaceholderText(copy.manualNotePlaceholder), { target: { value: 'Synthetic lawyer confirmation' } });
    fireEvent.click(screen.getByRole('button', { name: resolution === 'completed' ? copy.markComplete : copy.skip }));
    await waitFor(() => expect(currentSaved().steps.find(step => step.id === 'enterprise-finance-tax')?.status).toBe(resolution));
    expect(screen.getByRole('button', { name: formatted(copy.executeNext, 'enterprise-bids-receivables') })).toBeTruthy();
    expect(screen.getByRole('heading', { name: stepTitle('enterprise-bids-receivables') })).toBeTruthy();
    expect(currentSaved().steps.find(step => step.id === 'enterprise-bids-receivables')?.status).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();
    expectQuickSourcePreserved(currentSaved());
  });

  it('retries only the failed step from the top controls, instead of exposing a blocked next action', async () => {
    let workflow = patchAssetTraceStep(savedWorkflow('deep'), 'enterprise-company-profile', { status: 'failed', error: 'Synthetic temporary source failure' });
    vi.mocked(fetch).mockResolvedValue(successfulResponse('# Retried company source'));
    openWorkflow(workflow);
    fireEvent.click(await screen.findByRole('button', { name: copy.company }));
    const retry = screen.getByRole('button', { name: formatted(copy.retryStep, 'enterprise-company-profile') });
    expectPrimaryBeforeResult(retry);
    expect(screen.getAllByRole('button', { name: formatted(copy.retryStep, 'enterprise-company-profile') })).toHaveLength(1);
    fireEvent.click(retry);
    await waitFor(() => expect(currentSaved().steps.find(step => step.id === 'enterprise-company-profile')?.status).toBe('completed'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/api/legal/tool/legal_company_database_lookup');
    expect(screen.getByRole('heading', { name: stepTitle('enterprise-company-profile') })).toBeTruthy();
    expect(currentSaved().steps.find(step => step.id === 'enterprise-judicial-cases')?.status).toBe('pending');
    expect(currentSaved().steps.find(step => step.id === 'enterprise-company-profile')?.error).toBeUndefined();
    expectQuickSourcePreserved(currentSaved());
  });

  it('disables the single progression control while the selected request is running and does not duplicate that request', async () => {
    let resolveResponse!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { resolveResponse = resolve; }));
    openWorkflow(savedWorkflow());
    const startDeep = await screen.findByRole('button', { name: copy.startDeep });
    act(() => { fireEvent.click(startDeep); fireEvent.click(startDeep); });
    const running = await screen.findByRole('button', { name: formatted(copy.executingStep, 'enterprise-company-profile') });
    expectPrimaryBeforeResult(running);
    expect(running.hasAttribute('disabled')).toBe(true);
    fireEvent.click(running);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { resolveResponse(successfulResponse()); });
    await waitFor(() => expect(screen.getByRole('button', { name: formatted(copy.executeNext, 'enterprise-judicial-cases') }).hasAttribute('disabled')).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(1);
    expectQuickSourcePreserved(currentSaved());
  });
});
