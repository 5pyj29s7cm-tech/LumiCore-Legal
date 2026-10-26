import { describe, expect, it } from 'vitest';
import {
  createAssetTraceWorkflow,
  getAssetTraceCompletion,
  getAssetTraceStepsInScope,
  getNextAssetTraceStep,
  normalizeAssetTraceWorkflow,
  patchAssetTraceStep,
  promoteAssetTraceWorkflow,
  type AssetTraceSubjectType,
} from '../src/lib/legalAssetTraceWorkflow';

describe('legal asset trace workflow', () => {
  it('models the law-firm enterprise 12-step and individual 10-step checklists', () => {
    const enterprise = createAssetTraceWorkflow({
      subjectName: 'Example Company',
      subjectType: 'enterprise',
      runMode: 'deep',
    });
    const individual = createAssetTraceWorkflow({
      subjectName: 'Example Person',
      subjectType: 'individual',
      runMode: 'deep',
    });

    expect(enterprise.steps.filter(step => step.stage === 'quick')).toHaveLength(1);
    expect(enterprise.steps.filter(step => step.stage === 'deep')).toHaveLength(12);
    expect(enterprise.steps.filter(step => step.stage === 'analysis')).toHaveLength(4);
    expect(individual.steps.filter(step => step.stage === 'quick')).toHaveLength(1);
    expect(individual.steps.filter(step => step.stage === 'deep')).toHaveLength(10);
    expect(individual.steps.filter(step => step.stage === 'analysis')).toHaveLength(4);
    expect(new Set(enterprise.steps.map(step => step.id)).size).toBe(17);
    expect(new Set(individual.steps.map(step => step.id)).size).toBe(15);
    expect(enterprise.steps.find(step => step.id === 'enterprise-bids-receivables')?.tool).toBe('legal_search_tender_projects');
  });

  it('keeps quick scans short and can promote the saved workflow to deep investigation', () => {
    let workflow = createAssetTraceWorkflow({
      subjectName: 'Example Company',
      subjectType: 'enterprise',
      runMode: 'quick',
    });
    expect(getAssetTraceStepsInScope(workflow)).toHaveLength(1);
    expect(getNextAssetTraceStep(workflow)?.id).toBe('quick-scan');

    workflow = patchAssetTraceStep(workflow, 'quick-scan', { status: 'completed', output: 'scan' });
    expect(workflow.status).toBe('completed');
    expect(getAssetTraceCompletion(workflow)).toEqual({ done: 1, total: 1, percent: 100 });

    workflow = promoteAssetTraceWorkflow(workflow);
    expect(workflow.status).toBe('ready');
    expect(getAssetTraceStepsInScope(workflow)).toHaveLength(17);
    expect(getNextAssetTraceStep(workflow)?.id).toBe('enterprise-company-profile');
  });

  it('stops progression at lawyer verification and resumes after the step is resolved', () => {
    let workflow = createAssetTraceWorkflow({
      subjectName: 'Example Company',
      subjectType: 'enterprise',
      runMode: 'deep',
    });
    for (const stepId of [
      'quick-scan',
      'enterprise-company-profile',
      'enterprise-judicial-cases',
    ]) {
      workflow = patchAssetTraceStep(workflow, stepId, { status: 'completed' });
    }
    workflow = patchAssetTraceStep(workflow, 'enterprise-web-footprint', {
      status: 'needs_action',
      output: 'authorized browser handoff',
    });
    expect(workflow.status).toBe('needs_action');
    expect(getNextAssetTraceStep(workflow)).toBeNull();

    workflow = patchAssetTraceStep(workflow, 'enterprise-web-footprint', {
      status: 'completed',
      note: 'Lawyer verified the source.',
    });
    expect(workflow.status).toBe('ready');
    expect(getNextAssetTraceStep(workflow)?.id).toBe('enterprise-related-parties');
  });

  it('recovers interrupted running steps as pending after reload', () => {
    const workflow = createAssetTraceWorkflow({
      subjectName: 'Example Person',
      subjectType: 'individual',
      runMode: 'deep',
      caseId: 'case-1',
      orgId: 'org-1',
    });
    const interrupted = patchAssetTraceStep(workflow, 'quick-scan', { status: 'running' });
    const restored = normalizeAssetTraceWorkflow(JSON.parse(JSON.stringify(interrupted)));

    expect(restored?.caseId).toBe('case-1');
    expect(restored?.orgId).toBe('org-1');
    expect(restored?.steps.find(step => step.id === 'quick-scan')?.status).toBe('pending');
    expect(restored?.status).toBe('ready');
  });

  it.each([
    ['enterprise', 'enterprise-web-footprint'],
    ['individual', 'individual-online-footprint'],
  ] as const)('runs the %s public-footprint step as a real automatic search', (subjectType, stepId) => {
    const workflow = createAssetTraceWorkflow({ subjectName: 'Synthetic Search Subject', subjectType, runMode: 'deep' });
    expect(workflow.steps.find(step => step.id === stepId)).toMatchObject({
      executionMode: 'automatic', tool: 'legal_search_public_footprint', status: 'pending',
    });
  });

  const legacyFootprints = (['enterprise', 'individual'] as const).flatMap(subjectType =>
    (['needs_action', 'completed', 'failed'] as const).map(status => ({
      subjectType, status,
      stepId: subjectType === 'enterprise' ? 'enterprise-web-footprint' : 'individual-online-footprint',
    })),
  );
  it.each(legacyFootprints)('does not reuse an old $subjectType plan with status $status as a new search result', ({ subjectType, status, stepId }) => {
    let workflow = createAssetTraceWorkflow({ subjectName: 'Synthetic Migrated ' + subjectType, subjectType, runMode: 'deep' });
    const targetIndex = workflow.steps.findIndex(step => step.id === stepId);
    for (const prior of workflow.steps.slice(0, targetIndex)) workflow = patchAssetTraceStep(workflow, prior.id, {
      status: 'completed', output: 'Saved source: ' + prior.id, note: 'Saved source note: ' + prior.id,
    });
    workflow.steps[targetIndex] = {
      ...workflow.steps[targetIndex], tool: 'legal_external_research_plan', executionMode: 'assisted', status,
      output: '# Old generic action plan', error: 'Old plan request error', note: 'Retain the user supplied note',
    };
    const original = JSON.stringify(workflow);
    const restored = normalizeAssetTraceWorkflow(workflow)!;
    expect(restored.steps[targetIndex]).toMatchObject({
      id: stepId, tool: 'legal_search_public_footprint', executionMode: 'automatic', status: 'pending',
      note: 'Retain the user supplied note',
    });
    expect(restored.steps[targetIndex].output).toBeUndefined();
    expect(restored.steps[targetIndex].error).toBeUndefined();
    expect(JSON.parse(JSON.stringify(restored.steps.slice(0, targetIndex)))).toEqual(JSON.parse(original).steps.slice(0, targetIndex));
    expect(restored.status).toBe('ready');
    expect(getNextAssetTraceStep(restored)?.id).toBe(stepId);
    expect(JSON.stringify(workflow)).toBe(original);
  });

  it.each(['enterprise', 'individual'] as AssetTraceSubjectType[])('keeps an existing %s result from the current public search tool intact', subjectType => {
    const stepId = subjectType === 'enterprise' ? 'enterprise-web-footprint' : 'individual-online-footprint';
    const workflow = patchAssetTraceStep(createAssetTraceWorkflow({ subjectName: 'Synthetic Current Search Subject', subjectType, runMode: 'deep' }), stepId, {
      status: 'completed', output: '# Observed public source', note: 'Original source note',
    });
    const originalStep = JSON.parse(JSON.stringify(workflow.steps.find(step => step.id === stepId)));
    const restored = normalizeAssetTraceWorkflow(workflow)!;
    expect(JSON.parse(JSON.stringify(restored.steps.find(step => step.id === stepId)))).toEqual(originalStep);
  });
});
