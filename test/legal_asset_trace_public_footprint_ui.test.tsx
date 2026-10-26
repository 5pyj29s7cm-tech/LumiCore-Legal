// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegalAssetTrace } from '../src/components/org/LegalAssetTrace';
import { chinaLegalCopy } from '../src/i18n/regions/cn/legal';
import { setLocale } from '../src/i18n/runtime';
import { createAssetTraceWorkflow, patchAssetTraceStep, type AssetTraceSubjectType, type AssetTraceWorkflow } from '../src/lib/legalAssetTraceWorkflow';

vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ workDomain: 'personal', orgConnection: null, user: { uid: 'asset-public-footprint-owner' } }) }));

const storageKey = 'lumi_legal_asset_trace_workflow_v1';
const copy = chinaLegalCopy('zh').assetTraceWorkflow;
const oldPlanOutput = '# Legacy generic action plan\nThis is a proposed checklist, not a retrieved source.';

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
function formatted(template: string, stepId: string) {
  return template.replace('{step}', stepTitle(stepId));
}
function legacyPlanWorkflow(subjectName: string, subjectType: AssetTraceSubjectType) {
  let workflow = createAssetTraceWorkflow({ subjectName, subjectType, runMode: 'deep' });
  const stepId = subjectType === 'enterprise' ? 'enterprise-web-footprint' : 'individual-online-footprint';
  const targetIndex = workflow.steps.findIndex(step => step.id === stepId);
  for (const prior of workflow.steps.slice(0, targetIndex)) workflow = patchAssetTraceStep(workflow, prior.id, {
    status: 'completed', output: '# Saved source ' + prior.id, note: 'Existing source note ' + prior.id,
  });
  workflow.steps[targetIndex] = {
    ...workflow.steps[targetIndex], tool: 'legal_external_research_plan', executionMode: 'assisted', status: 'needs_action',
    output: oldPlanOutput, note: 'Existing user note', error: 'Old plan error',
  };
  return { workflow, stepId, targetIndex };
}
function currentSaved(): AssetTraceWorkflow {
  return JSON.parse(localStorage.getItem(storageKey)!);
}
function response(text: string, receipt: Record<string, unknown>, verification: Record<string, unknown>) {
  return new Response(JSON.stringify({ text, receipt, verification }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('public footprint continuation retrieves sources instead of repeating the old planning handoff', () => {
  it.each([
    ['Synthetic Harbor Workshop Ltd', 'enterprise'],
    ['Synthetic Meridian Technology Ltd', 'enterprise'],
    ['Synthetic Person C', 'individual'],
  ] as const)('restores %s and executes only its pending real search with the matching subject type', async (subjectName, subjectType) => {
    const { workflow, stepId, targetIndex } = legacyPlanWorkflow(subjectName, subjectType);
    const original = JSON.stringify(workflow);
    const priorSteps = JSON.parse(original).steps.slice(0, targetIndex);
    const observedOutput = '# Retrieved public footprint\nObserved source for ' + subjectName;
    localStorage.setItem(storageKey, original);
    vi.mocked(fetch).mockResolvedValue(response(observedOutput, { ok: true, status: 'observed' }, { status: 'verified' }));
    render(<LegalAssetTrace />);

    const action = await screen.findByRole('button', { name: formatted(copy.executeNext, stepId) });
    expect(screen.getByRole('heading', { name: stepTitle(stepId) })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Legacy generic action plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: formatted(copy.reviewStep, stepId) })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.markComplete })).toBeNull();
    expect(screen.queryByPlaceholderText(copy.manualNotePlaceholder)).toBeNull();
    expect(localStorage.getItem(storageKey)).toBe(original);
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(action);
    await waitFor(() => expect(currentSaved().steps.find(step => step.id === stepId)?.status).toBe('completed'));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/api/legal/tool/legal_search_public_footprint');
    expect(JSON.parse(String(init?.body)).args).toEqual({ name: subjectName, subjectType, persistCase: false });
    const saved = currentSaved();
    expect(saved.steps.slice(0, targetIndex)).toEqual(priorSteps);
    expect(saved.steps[targetIndex]).toMatchObject({
      id: stepId, executionMode: 'automatic', tool: 'legal_search_public_footprint', status: 'completed',
      output: observedOutput, note: 'Existing user note',
    });
    expect(saved.steps[targetIndex].error).toBeUndefined();
    expect(saved.steps[targetIndex + 1].status).toBe('pending');
    expect(JSON.stringify(saved)).not.toContain(oldPlanOutput);
    expect(screen.getByRole('heading', { name: 'Retrieved public footprint' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.markComplete })).toBeNull();
  });

  it('retains an incomplete search output as pending action while keeping all previously completed sources unchanged', async () => {
    const { workflow, stepId, targetIndex } = legacyPlanWorkflow('Synthetic Unavailable Source Enterprise', 'enterprise');
    const priorSteps = JSON.parse(JSON.stringify(workflow.steps.slice(0, targetIndex)));
    const partialOutput = '# Partial retrieved source\nA source timed out; no whole-search conclusion is established.';
    localStorage.setItem(storageKey, JSON.stringify(workflow));
    vi.mocked(fetch).mockResolvedValue(response(partialOutput, { ok: false, status: 'partial' }, { status: 'blocked' }));
    render(<LegalAssetTrace />);
    fireEvent.click(await screen.findByRole('button', { name: formatted(copy.executeNext, stepId) }));
    await waitFor(() => expect(currentSaved().steps.find(step => step.id === stepId)?.status).toBe('needs_action'));
    const saved = currentSaved();
    expect(saved.status).toBe('needs_action');
    expect(saved.steps[targetIndex]).toMatchObject({ tool: 'legal_search_public_footprint', output: partialOutput, status: 'needs_action' });
    expect(saved.steps.slice(0, targetIndex)).toEqual(priorSteps);
    expect(saved.steps[targetIndex + 1].status).toBe('pending');
    expect(screen.getByRole('heading', { name: 'Partial retrieved source' })).toBeTruthy();
    expect(screen.getByRole('button', { name: formatted(copy.retryStep, stepId) })).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.markComplete })).toBeNull();
    expect(screen.queryByPlaceholderText(copy.manualNotePlaceholder)).toBeNull();
    expect(screen.queryByRole('button', { name: formatted(copy.executeNext, saved.steps[targetIndex + 1].id) })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
