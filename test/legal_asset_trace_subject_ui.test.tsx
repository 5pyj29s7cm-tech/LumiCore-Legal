// @vitest-environment jsdom
import fs from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LegalAssetTrace } from '../src/components/org/LegalAssetTrace';
import { chinaLegalCopy } from '../src/i18n/regions/cn/legal';
import { setLocale } from '../src/i18n/runtime';
import { createAssetTraceWorkflow, getNextAssetTraceStep, normalizeAssetTraceWorkflow, patchAssetTraceStep, type AssetTraceWorkflow } from '../src/lib/legalAssetTraceWorkflow';

vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ workDomain: 'personal', orgConnection: null, user: { uid: 'subject-query-owner' } }) }));
const key = 'lumi_legal_asset_trace_workflow_v1';
const copy = chinaLegalCopy('zh').assetTraceWorkflow;
const capturePath = process.env.LUMI_ASSET_TRACE_WORKFLOW_FIXTURE;
const title = (id: string) => copy.steps[id as keyof typeof copy.steps].title;
const action = (template: string, id: string) => template.replace('{step}', title(id));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); setLocale('zh'); vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External request is forbidden')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function syntheticSaved(): AssetTraceWorkflow {
  let workflow = createAssetTraceWorkflow({ subjectName: 'Synthetic Asset Query Enterprise', subjectType: 'enterprise', runMode: 'deep' });
  for (const id of ['quick-scan', 'enterprise-company-profile', 'enterprise-judicial-cases', 'enterprise-web-footprint']) workflow = patchAssetTraceStep(workflow, id, {
    status: 'completed', output: 'Synthetic original source for ' + id, note: 'Synthetic user note for ' + id,
  });
  workflow.steps = workflow.steps.map(step => step.id === 'enterprise-judicial-cases' ? { ...step, tool: 'legal_search_case', output: 'Synthetic unrelated semantic material; retained only in the old stored workflow' } : step);
  workflow = patchAssetTraceStep(workflow, 'enterprise-related-parties', { status: 'needs_action', output: 'Synthetic external source unavailable', note: 'Synthetic pending lawyer task' });
  return workflow;
}
function checkOtherSteps(original: AssetTraceWorkflow, restored: AssetTraceWorkflow, changed = 'enterprise-judicial-cases') {
  for (const step of original.steps.filter(step => step.id !== changed)) expect(clone(restored.steps.find(next => next.id === step.id))).toEqual(clone(step));
}
function success() {
  return new Response(JSON.stringify({ text: '# Synthetic subject query source', receipt: { ok: true, status: 'observed' }, verification: { status: 'verified' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

it.each([
  ['enterprise', 'enterprise-judicial-cases'],
  ['individual', 'individual-enforcement-rewards'],
] as const)('uses the subject-query tool for %s rather than semantic case similarity', (subjectType, id) => {
  const workflow = createAssetTraceWorkflow({ subjectName: 'Different Synthetic Subject', subjectType, runMode: 'deep' });
  expect(workflow.steps.find(step => step.id === id)).toMatchObject({ tool: 'legal_search_subject_cases', executionMode: 'automatic', status: 'pending' });
});

it.each(['completed', 'needs_action', 'failed'] as const)('invalidates only a legacy semantic case step with %s status while keeping its user note', status => {
  const original = syntheticSaved();
  const oldStep = original.steps.find(step => step.id === 'enterprise-judicial-cases')!;
  oldStep.status = status; oldStep.error = 'Synthetic old tool error';
  const before = JSON.stringify(original);
  const restored = normalizeAssetTraceWorkflow(original)!;
  expect(restored.steps.find(step => step.id === oldStep.id)).toMatchObject({ tool: 'legal_search_subject_cases', status: 'pending', note: oldStep.note });
  expect(restored.steps.find(step => step.id === oldStep.id)?.output).toBeUndefined();
  expect(restored.steps.find(step => step.id === oldStep.id)?.error).toBeUndefined();
  expect(restored.steps.find(step => step.id === oldStep.id)?.updatedAt).toBeUndefined();
  checkOtherSteps(original, restored);
  expect(restored.status).toBe('ready'); expect(getNextAssetTraceStep(restored)?.id).toBe(oldStep.id);
  expect(JSON.stringify(original)).toBe(before);
});

it('resumes the earlier pending subject query before a later pending action and returns to that action afterwards', () => {
  const original = syntheticSaved(); const restored = normalizeAssetTraceWorkflow(original)!;
  const related = clone(original.steps.find(step => step.id === 'enterprise-related-parties'));
  expect(getNextAssetTraceStep(restored)?.id).toBe('enterprise-judicial-cases');
  const completed = patchAssetTraceStep(restored, 'enterprise-judicial-cases', { status: 'completed', output: 'Synthetic own-subject result' });
  expect(completed.status).toBe('needs_action'); expect(getNextAssetTraceStep(completed)).toBeNull();
  expect(clone(completed.steps.find(step => step.id === 'enterprise-related-parties'))).toEqual(related);
  checkOtherSteps(original, completed);
});

async function replaySubjectWorkflow(original: AssetTraceWorkflow) {
  const normalizedOriginal = normalizeAssetTraceWorkflow(original)!;
  const related = normalizedOriginal.steps.find(step => step.id === 'enterprise-related-parties')!;
  const nextTemplate = related.status === 'pending' ? copy.executeNext : copy.retryStep;
  const originalStored = JSON.stringify(original); localStorage.setItem(key, originalStored);
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<LegalAssetTrace />);
  const next = await screen.findByRole('button', { name: action(copy.executeNext, 'enterprise-judicial-cases') });
  const controls = screen.getByTestId('asset-trace-controls');
  expect(within(controls).getAllByRole('button')).toEqual([next]);
  expect(screen.getByRole('heading', { name: title('enterprise-judicial-cases') })).toBeTruthy();
  expect(screen.queryByRole('button', { name: action(copy.reviewStep, 'enterprise-related-parties') })).toBeNull();
  expect(fetch).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(originalStored);
  fireEvent.click(next); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const call = vi.mocked(fetch).mock.calls[0];
  expect(new URL(String(call[0]), 'http://localhost').pathname).toBe('/api/legal/tool/legal_search_subject_cases');
  const args = JSON.parse(String(call[1]?.body)).args;
  expect(args).toEqual({ persistCase: false, name: original.subjectName, subjectType: 'enterprise', scope: 'cases' });
  expect(args).not.toHaveProperty('query');
  const running = JSON.parse(localStorage.getItem(key)!); checkOtherSteps(normalizedOriginal, running);
  expect(running.steps.find((step: any) => step.id === 'enterprise-judicial-cases').status).toBe('running');
  await act(async () => finish(success()));
  await waitFor(() => expect(screen.getByRole('button', { name: action(nextTemplate, 'enterprise-related-parties') })).toBeTruthy());
  const saved = JSON.parse(localStorage.getItem(key)!); checkOtherSteps(normalizedOriginal, saved);
  expect(saved.status).toBe(related.status === 'pending' ? 'ready' : 'needs_action');
  expect(saved.steps.find((step: any) => step.id === 'enterprise-judicial-cases')).toMatchObject({ tool: 'legal_search_subject_cases', status: 'completed', output: '# Synthetic subject query source' });
  const relatedStep = screen.getAllByRole('button').find(button => button.textContent?.startsWith(title('enterprise-related-parties')))!;
  expect(relatedStep).toBeTruthy(); fireEvent.click(relatedStep);
  expect(screen.getByRole('heading', { name: title('enterprise-related-parties') })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
}
it('replays the saved synthetic workflow without rewriting storage or rerunning successful unrelated steps', async () => { await replaySubjectWorkflow(syntheticSaved()); });
it.skipIf(!capturePath)('replays the exact captured native workflow from the supplied evidence path without source rewrites', async () => {
  const original = JSON.parse(fs.readFileSync(capturePath!, 'utf8')) as AssetTraceWorkflow;
  const before = JSON.stringify(original);
  const restored = normalizeAssetTraceWorkflow(original)!;
  for (const step of original.steps.filter(step => !['enterprise-judicial-cases', 'enterprise-related-parties'].includes(step.id))) expect(clone(restored.steps.find(next => next.id === step.id))).toEqual(clone(step));
  const oldController = original.steps.find(step => step.id === 'enterprise-related-parties')!;
  const restoredController = restored.steps.find(step => step.id === 'enterprise-related-parties')!;
  if (oldController.tool === 'legal_equity_penetration') {
    expect(restoredController).toMatchObject({ tool: 'legal_company_database_lookup', status: 'pending', note: oldController.note });
    expect(restoredController.output).toBeUndefined(); expect(restoredController.error).toBeUndefined();
  } else expect(clone(restoredController)).toEqual(clone(oldController));
  expect(getNextAssetTraceStep(restored)?.id).toBe('enterprise-judicial-cases');
  await replaySubjectWorkflow(original);
  expect(JSON.stringify(JSON.parse(fs.readFileSync(capturePath!, 'utf8')))).toBe(before);
});

it('passes an exact individual subject and enforcement scope without rerunning any earlier completed step', async () => {
  let workflow = createAssetTraceWorkflow({ subjectName: 'Synthetic Person for Enforcement', subjectType: 'individual', runMode: 'deep' });
  const index = workflow.steps.findIndex(step => step.id === 'individual-enforcement-rewards');
  for (const step of workflow.steps.slice(0, index)) workflow = patchAssetTraceStep(workflow, step.id, { status: 'completed', output: 'Synthetic source ' + step.id });
  workflow.steps[index] = { ...workflow.steps[index], tool: 'legal_search_case', status: 'completed', output: 'Old unrelated semantic result', note: 'Keep individual review note' };
  const before = clone(workflow); localStorage.setItem(key, JSON.stringify(workflow)); vi.mocked(fetch).mockResolvedValue(success());
  render(<LegalAssetTrace />); fireEvent.click(await screen.findByRole('button', { name: action(copy.executeNext, 'individual-enforcement-rewards') }));
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).steps[index].status).toBe('completed'));
  expect(fetch).toHaveBeenCalledTimes(1); const call = vi.mocked(fetch).mock.calls[0];
  expect(new URL(String(call[0]), 'http://localhost').pathname).toBe('/api/legal/tool/legal_search_subject_cases');
  expect(JSON.parse(String(call[1]?.body)).args).toEqual({ persistCase: false, name: workflow.subjectName, subjectType: 'individual', scope: 'enforcement' });
  checkOtherSteps(before, JSON.parse(localStorage.getItem(key)!), 'individual-enforcement-rewards');
});
