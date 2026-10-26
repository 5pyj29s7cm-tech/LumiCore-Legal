// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegalAssetTrace } from '../src/components/org/LegalAssetTrace';
import { chinaLegalCopy } from '../src/i18n/regions/cn/legal';
import { setLocale } from '../src/i18n/runtime';
import { combineAssetTraceOutputs, createAssetTraceWorkflow, type AssetTraceWorkflow } from '../src/lib/legalAssetTraceWorkflow';

vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ workDomain: 'personal', orgConnection: null, user: { uid: 'full-context-fixture-owner' } }) }));

const storageKey = 'lumi_legal_asset_trace_workflow_v1';
const copy = chinaLegalCopy('zh').assetTraceWorkflow;
const target = 'adversarial-review';
const observationPath = process.env.LUMI_ASSET_TRACE_FULL_CONTEXT_OBSERVATIONS;
const observations: Record<string, unknown>[] = [];
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setLocale('zh');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
afterAll(() => {
  if (!observationPath) return;
  fs.mkdirSync(path.dirname(observationPath), { recursive: true });
  fs.writeFileSync(observationPath, JSON.stringify({ synthetic: true, externalCalls: 0, modelCalls: 0, observations }, null, 2));
});

function completedSources(subject: string, fixtureId: string): AssetTraceWorkflow {
  const workflow = createAssetTraceWorkflow({ subjectName: subject, subjectType: 'enterprise', runMode: 'deep' });
  workflow.id = 'synthetic-full-context-' + fixtureId;
  workflow.createdAt = '2026-10-20T01:00:00.000Z';
  workflow.updatedAt = '2026-10-20T02:00:00.000Z';
  for (const [index, step] of workflow.steps.entries()) {
    if (step.stage === 'analysis') continue;
    step.status = 'completed';
    step.updatedAt = '2026-10-20T01:' + String(index).padStart(2, '0') + ':00.000Z';
    step.note = 'Synthetic user note ' + fixtureId + ' / ' + step.id + '\n\nNo additional fact is implied.';
    step.output = [
      '# Synthetic source ' + fixtureId + ' / ' + step.id,
      'Subject: ' + subject,
      'Provided fact: this source has no verified transfer date.\n\nSeparate limitation: do not infer a transfer date from the next paragraph.',
      'Reference: https://sources.invalid/' + fixtureId + '/' + step.id,
    ].join('\n\n');
  }
  const quick = workflow.steps.find(step => step.id === 'quick-scan')!;
  quick.output += '\n\n' + Array.from({ length: 180 }, (_, index) => [
    'Original paragraph ' + fixtureId + '-' + String(index).padStart(3, '0') + ': ' + subject + ' supplied a separate synthetic record, with its own source and scope.',
    'No payment was confirmed here.\n\nThe following sentence is a different source statement.\tIt does not establish payment.',
  ].join('\n\n')).join('\n\n');
  const last = workflow.steps.find(step => step.id === 'enterprise-auction-bankruptcy')!;
  last.output += '\n\nLate original fact ' + fixtureId + ': no adjudication or auction completion date was supplied.\n\nLate source ' + fixtureId + ': https://sources.invalid/' + fixtureId + '/last-original-source\nOriginal source time: 2026-10-20T01:12:00.000Z';
  return workflow;
}

function stored(): AssetTraceWorkflow { return JSON.parse(localStorage.getItem(storageKey)!); }

describe('asset trace analysis receives every original source paragraph without a fixed context slice', () => {
  it.each([
    ['Synthetic Northern Precision Company', 'north-precision'],
    ['Synthetic Southern Trading Cooperative', 'south-trading'],
  ])('preserves complete context and previous local source records for %s', async (subject, fixtureId) => {
    const original = completedSources(subject, fixtureId);
    const previous = clone(original.steps.filter(step => step.stage !== 'analysis'));
    expect(previous).toHaveLength(13);
    expect(previous.every(step => step.status === 'completed')).toBe(true);
    const combined = combineAssetTraceOutputs(original);
    expect(combined.length).toBeGreaterThan(12000);
    const expected = [subject, copy.steps[target].description, combined].filter(Boolean).join('\n');
    const originalBytes = JSON.stringify(original);
    localStorage.setItem(storageKey, originalBytes);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      text: '# Synthetic analysis response\n\nHuman review remains pending.',
      receipt: { ok: true, status: 'observed' },
      verification: { status: 'verified' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(<LegalAssetTrace />);
    const control = await screen.findByRole('button', { name: copy.executeNext.replace('{step}', copy.steps[target].title) });
    expect(within(screen.getByTestId('asset-trace-controls')).getAllByRole('button')).toEqual([control]);
    expect(localStorage.getItem(storageKey)).toBe(originalBytes);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(control);
    await waitFor(() => expect(stored().steps.find(step => step.id === target)?.status).toBe('needs_action'));
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(call[0]), 'http://localhost').pathname).toBe('/api/legal/tool/legal_case_strategy');
    const args = JSON.parse(String(call[1]?.body)).args;
    expect(Object.keys(args).sort()).toEqual(['facts', 'persistCase']);
    expect(args.persistCase).toBe(false);
    expect(typeof args.facts).toBe('string');
    const facts = args.facts as string;
    const after = stored();
    const savedPrevious = clone(after.steps.filter(step => step.stage !== 'analysis'));
    expect(savedPrevious).toEqual(previous);
    expect(clone(after.steps.filter(step => step.stage === 'analysis' && step.id !== target)))
      .toEqual(clone(original.steps.filter(step => step.stage === 'analysis' && step.id !== target)));
    expect(JSON.stringify(original)).toBe(originalBytes);
    const lateSource = 'https://sources.invalid/' + fixtureId + '/last-original-source';
    observations.push({
      subject, fixtureId, sourceStepCount: previous.length, requestPath: new URL(String(call[0]), 'http://localhost').pathname,
      requestCount: vi.mocked(fetch).mock.calls.length, combinedLength: combined.length,
      expectedLength: expected.length, actualLength: facts.length, expectedSha256: sha256(expected), actualSha256: sha256(facts),
      exactContext: facts === expected, lateSourcePreserved: facts.includes(lateSource),
      paragraphBoundariesPreserved: facts.includes('No payment was confirmed here.\n\nThe following sentence is a different source statement.\tIt does not establish payment.'),
      priorSourceRecordsUnchanged: isDeepStrictEqual(savedPrevious, previous),
      originalWorkflow: original, savedWorkflow: after, requestArgs: args, expectedFacts: expected,
    });
    expect(facts).toBe(expected);
    for (const step of previous) {
      expect(facts).toContain(step.output);
      expect(facts).toContain(step.note);
    }
    expect(facts).toContain(lateSource);
    expect(facts).toContain('No payment was confirmed here.\n\nThe following sentence is a different source statement.\tIt does not establish payment.');
  });
});
