import { describe, expect, it } from 'vitest';
import {
  createAssetTraceWorkflow,
  getAssetTraceCompletion,
  getAssetTraceStepsInScope,
  getNextAssetTraceStep,
  normalizeAssetTraceWorkflow,
  patchAssetTraceStep,
  promoteAssetTraceWorkflow,
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

    expect(enterprise.steps.filter(step => step.stage === 'quick')).toHaveLength(2);
    expect(enterprise.steps.filter(step => step.stage === 'deep')).toHaveLength(12);
    expect(enterprise.steps.filter(step => step.stage === 'analysis')).toHaveLength(4);
    expect(individual.steps.filter(step => step.stage === 'quick')).toHaveLength(2);
    expect(individual.steps.filter(step => step.stage === 'deep')).toHaveLength(10);
    expect(individual.steps.filter(step => step.stage === 'analysis')).toHaveLength(4);
    expect(new Set(enterprise.steps.map(step => step.id)).size).toBe(18);
    expect(new Set(individual.steps.map(step => step.id)).size).toBe(16);
    expect(enterprise.steps.find(step => step.id === 'enterprise-bids-receivables')?.tool).toBe('legal_search_tender_projects');
  });

  it('keeps quick scans short and can promote the saved workflow to deep investigation', () => {
    let workflow = createAssetTraceWorkflow({
      subjectName: 'Example Company',
      subjectType: 'enterprise',
      runMode: 'quick',
    });
    expect(getAssetTraceStepsInScope(workflow)).toHaveLength(2);
    expect(getNextAssetTraceStep(workflow)?.id).toBe('source-preflight');

    workflow = patchAssetTraceStep(workflow, 'source-preflight', { status: 'completed', output: 'ready' });
    workflow = patchAssetTraceStep(workflow, 'quick-scan', { status: 'completed', output: 'scan' });
    expect(workflow.status).toBe('completed');
    expect(getAssetTraceCompletion(workflow)).toEqual({ done: 2, total: 2, percent: 100 });

    workflow = promoteAssetTraceWorkflow(workflow);
    expect(workflow.status).toBe('ready');
    expect(getAssetTraceStepsInScope(workflow)).toHaveLength(18);
    expect(getNextAssetTraceStep(workflow)?.id).toBe('enterprise-company-profile');
  });

  it('stops progression at lawyer verification and resumes after the step is resolved', () => {
    let workflow = createAssetTraceWorkflow({
      subjectName: 'Example Company',
      subjectType: 'enterprise',
      runMode: 'deep',
    });
    for (const stepId of [
      'source-preflight',
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
    const interrupted = patchAssetTraceStep(workflow, 'source-preflight', { status: 'running' });
    const restored = normalizeAssetTraceWorkflow(JSON.parse(JSON.stringify(interrupted)));

    expect(restored?.caseId).toBe('case-1');
    expect(restored?.orgId).toBe('org-1');
    expect(restored?.steps.find(step => step.id === 'source-preflight')?.status).toBe('pending');
    expect(restored?.status).toBe('ready');
  });
});
