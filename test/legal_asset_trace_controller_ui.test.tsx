// @vitest-environment jsdom
import fs from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LegalAssetTrace } from '../src/components/org/LegalAssetTrace';
import { chinaLegalCopy } from '../src/i18n/regions/cn/legal';
import { setLocale } from '../src/i18n/runtime';
import { uiMessage } from '../src/i18n/uiMessages';
import { createAssetTraceWorkflow, getNextAssetTraceStep, normalizeAssetTraceWorkflow, patchAssetTraceStep, type AssetTraceWorkflow } from '../src/lib/legalAssetTraceWorkflow';

vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ workDomain: 'personal', orgConnection: null, user: { uid: 'controller-query-owner' } }) }));
const key = 'lumi_legal_asset_trace_workflow_v1';
const copy = chinaLegalCopy('zh').assetTraceWorkflow;
const target = 'enterprise-related-parties';
const following = 'enterprise-finance-tax';
const capturePath = process.env.LUMI_ASSET_TRACE_CONTROLLER_WORKFLOW_FIXTURE;
const title = (id: string) => copy.steps[id as keyof typeof copy.steps].title;
const action = (template: string, id = target) => template.replace('{step}', title(id));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); setLocale('zh'); vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function savedWorkflow(legacy = true, status: 'completed' | 'needs_action' | 'failed' = 'needs_action'): AssetTraceWorkflow {
  let workflow = createAssetTraceWorkflow({ subjectName: 'Synthetic Controller Source Company', subjectType: 'enterprise', runMode: 'deep' });
  for (const id of ['quick-scan', 'enterprise-company-profile', 'enterprise-judicial-cases', 'enterprise-web-footprint']) workflow = patchAssetTraceStep(workflow, id, { status: 'completed', output: 'Synthetic complete original ' + id, note: 'User source note ' + id });
  workflow = patchAssetTraceStep(workflow, target, { status, output: 'Synthetic old controller source output', note: 'User supplied controller note', error: status === 'failed' ? 'Synthetic old tool failure' : undefined });
  if (legacy) workflow.steps = workflow.steps.map(step => step.id === target ? { ...step, tool: 'legal_equity_penetration' } : step);
  return workflow;
}
function otherStepsUnchanged(original: AssetTraceWorkflow, actual: AssetTraceWorkflow) {
  for (const step of original.steps.filter(step => step.id !== target)) expect(clone(actual.steps.find(next => next.id === step.id))).toEqual(clone(step));
}
function stored(): AssetTraceWorkflow { return JSON.parse(localStorage.getItem(key)!); }
function open(workflow: AssetTraceWorkflow) { const bytes = JSON.stringify(workflow); localStorage.setItem(key, bytes); render(<LegalAssetTrace />); return bytes; }
function reply(status: 'observed' | 'partial', text = '# Synthetic actual controller source') { return new Response(JSON.stringify({ text, receipt: { ok: status === 'observed', status }, verification: { status: status === 'observed' ? 'verified' : 'blocked' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
function expectControllerCall(index = 0, name = 'Synthetic Controller Source Company') {
  const call = vi.mocked(fetch).mock.calls[index];
  expect(new URL(String(call[0]), 'http://localhost').pathname).toBe('/api/legal/tool/legal_company_database_lookup');
  expect(JSON.parse(String(call[1]?.body)).args).toEqual({ persistCase: false, name, queryType: 'controller', sourceIds: ['qichacha'] });
}

it.each(['completed', 'needs_action', 'failed'] as const)('invalidates only old equity step4 with %s status while preserving prior source bytes and the user note', status => {
  const original = savedWorkflow(true, status); const before = JSON.stringify(original);
  const normalized = normalizeAssetTraceWorkflow(original)!;
  const fourth = normalized.steps.find(step => step.id === target)!;
  expect(fourth).toMatchObject({ tool: 'legal_company_database_lookup', status: 'pending', note: 'User supplied controller note' });
  expect(fourth.output).toBeUndefined(); expect(fourth.error).toBeUndefined(); expect(fourth.updatedAt).toBeUndefined();
  otherStepsUnchanged(original, normalized); expect(getNextAssetTraceStep(normalized)?.id).toBe(target); expect(normalized.status).toBe('ready');
  expect(JSON.stringify(original)).toBe(before);
});

async function replayMigration(original: AssetTraceWorkflow) {
  const bytes = JSON.stringify(original); localStorage.setItem(key, bytes);
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<LegalAssetTrace />);
  const control = await screen.findByRole('button', { name: action(copy.executeNext) });
  expect(within(screen.getByTestId('asset-trace-controls')).getAllByRole('button')).toEqual([control]);
  expect(screen.getByRole('heading', { name: title(target) })).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(bytes);
  fireEvent.click(control); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); expectControllerCall(0, original.subjectName);
  otherStepsUnchanged(original, stored());
  await act(async () => finish(reply('observed')));
  await waitFor(() => expect(screen.getByRole('button', { name: action(copy.executeNext, following) })).toBeTruthy());
  expect(stored().steps.find(step => step.id === target)?.status).toBe('completed');
  otherStepsUnchanged(original, stored()); expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: action(copy.executeNext, following) }));
  expect(stored().steps.find(step => step.id === following)?.status).toBe('needs_action');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: copy.markComplete }).hasAttribute('disabled')).toBe(true);
}
it('renders old step4 read-only then runs only the controller lookup without restarting registration, case or public queries', async () => { await replayMigration(savedWorkflow()); });
it.skipIf(!capturePath)('replays the exact current native controller workflow through its supplied evidence path', async () => {
  const bytes = fs.readFileSync(capturePath!, 'utf8'); const original = JSON.parse(bytes) as AssetTraceWorkflow;
  const normalized = normalizeAssetTraceWorkflow(original)!; otherStepsUnchanged(original, normalized);
  expect(getNextAssetTraceStep(normalized)?.id).toBe(target);
  await replayMigration(original); expect(fs.readFileSync(capturePath!, 'utf8')).toBe(bytes);
});

it('keeps a partial automatic result pending and offers only a retry or skip, without manual verification controls', async () => {
  const original = savedWorkflow(false); original.steps.find(step => step.id === target)!.status = 'pending';
  vi.mocked(fetch).mockResolvedValue(reply('partial', '# Synthetic missing controller source'));
  open(original); fireEvent.click(await screen.findByRole('button', { name: action(copy.executeNext) }));
  await waitFor(() => expect(stored().steps.find(step => step.id === target)?.status).toBe('needs_action'));
  expect(screen.getByRole('heading', { name: 'Synthetic missing controller source' })).toBeTruthy();
  expect(screen.getByRole('button', { name: action(copy.retryStep) })).toBeTruthy();
  expect(screen.getByRole('button', { name: copy.skip })).toBeTruthy();
  expect(screen.queryByRole('button', { name: copy.markComplete })).toBeNull();
  expect(screen.queryByPlaceholderText(copy.manualNotePlaceholder)).toBeNull();
  expect(screen.queryByRole('button', { name: action(copy.executeNext, following) })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1); expectControllerCall(); otherStepsUnchanged(original, stored());
});

it.each([
  ['system', true],
  ['custom', false],
] as const)('retries only an automatic pending step and handles its %s note without leaving a stale system failure after success', async (_kind, system) => {
  const original = savedWorkflow(false);
  const note = system ? uiMessage('legal-asset-trace.verifiable-external-source-required.9b3fa7d6e1', 'zh') : 'A lawyer supplied source note remains unchanged';
  original.steps.find(step => step.id === target)!.note = note;
  vi.mocked(fetch).mockResolvedValue(reply('observed'));
  const bytes = open(original); expect(localStorage.getItem(key)).toBe(bytes);
  fireEvent.click(await screen.findByRole('button', { name: action(copy.retryStep) }));
  await waitFor(() => expect(stored().steps.find(step => step.id === target)?.status).toBe('completed'));
  expect(fetch).toHaveBeenCalledTimes(1); expectControllerCall(); otherStepsUnchanged(original, stored());
  if (system) expect(stored().steps.find(step => step.id === target)?.note).toBeUndefined();
  else expect(stored().steps.find(step => step.id === target)?.note).toBe(note);
  expect(screen.getByRole('button', { name: action(copy.executeNext, following) })).toBeTruthy();
});

it('retries only step4 after a transport failure and reaches step5 without rerunning the successful sources', async () => {
  const original = savedWorkflow(false); original.steps.find(step => step.id === target)!.status = 'pending';
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Synthetic controller source transport failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } })).mockResolvedValueOnce(reply('observed'));
  open(original); fireEvent.click(await screen.findByRole('button', { name: action(copy.executeNext) }));
  await waitFor(() => expect(stored().steps.find(step => step.id === target)?.status).toBe('failed'));
  expectControllerCall(0); expect(screen.queryByRole('button', { name: copy.markComplete })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: action(copy.retryStep) }));
  await waitFor(() => expect(stored().steps.find(step => step.id === target)?.status).toBe('completed'));
  expect(fetch).toHaveBeenCalledTimes(2); expectControllerCall(1); otherStepsUnchanged(original, stored());
  expect(screen.getByRole('button', { name: action(copy.executeNext, following) })).toBeTruthy();
});

it('can explicitly skip an automatic missing source without marking it verified or discarding the partial original', async () => {
  const original = savedWorkflow(false); open(original);
  await screen.findByRole('button', { name: action(copy.retryStep) });
  expect(screen.queryByRole('button', { name: copy.markComplete })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: copy.skip }));
  expect(stored().steps.find(step => step.id === target)).toMatchObject({ status: 'skipped', output: 'Synthetic old controller source output', note: 'User supplied controller note' });
  expect(screen.getByRole('button', { name: action(copy.executeNext, following) })).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled(); otherStepsUnchanged(original, stored());
});

it.each([
  ['enterprise-finance-tax', 'manual'],
  ['enterprise-bids-receivables', 'assisted'],
] as const)('preserves the existing %s %s confirmation path without an extra API query', async (id, mode) => {
  let workflow = createAssetTraceWorkflow({ subjectName: 'Different Synthetic Manual Subject', subjectType: 'enterprise', runMode: 'deep' });
  const index = workflow.steps.findIndex(step => step.id === id);
  for (const step of workflow.steps.slice(0, index)) workflow = patchAssetTraceStep(workflow, step.id, { status: 'completed', output: 'Retained original ' + step.id });
  workflow = patchAssetTraceStep(workflow, id, { status: 'needs_action', output: 'Returned task source ' + id });
  localStorage.setItem(key, JSON.stringify(workflow)); render(<LegalAssetTrace />);
  await screen.findByRole('heading', { name: title(id) });
  const confirm = screen.getByRole('button', { name: copy.markComplete });
  expect(screen.getByPlaceholderText(copy.manualNotePlaceholder)).toBeTruthy();
  if (mode === 'manual') expect(confirm.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByPlaceholderText(copy.manualNotePlaceholder), { target: { value: 'Synthetic lawyer confirmed source and finding' } });
  fireEvent.click(confirm);
  expect(stored().steps.find(step => step.id === id)).toMatchObject({ status: 'completed', note: 'Synthetic lawyer confirmed source and finding' });
  expect(stored().steps.slice(0, index)).toEqual(workflow.steps.slice(0, index)); expect(fetch).not.toHaveBeenCalled();
});
