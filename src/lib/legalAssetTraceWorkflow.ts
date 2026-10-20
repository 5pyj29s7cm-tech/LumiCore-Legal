export type AssetTraceSubjectType = 'enterprise' | 'individual';
export type AssetTraceRunMode = 'quick' | 'deep';
export type AssetTraceStage = 'quick' | 'deep' | 'analysis';
export type AssetTraceExecutionMode = 'automatic' | 'assisted' | 'manual';
export type AssetTraceStepStatus = 'pending' | 'running' | 'needs_action' | 'completed' | 'skipped' | 'failed';
export type AssetTraceWorkflowStatus = 'ready' | 'running' | 'needs_action' | 'completed';

export interface AssetTraceStepBlueprint {
  id: string;
  stage: AssetTraceStage;
  order: number;
  executionMode: AssetTraceExecutionMode;
  tool?: string;
}

export interface AssetTraceWorkflowStep extends AssetTraceStepBlueprint {
  status: AssetTraceStepStatus;
  output?: string;
  note?: string;
  error?: string;
  updatedAt?: string;
}

export interface AssetTraceWorkflow {
  version: 1;
  id: string;
  caseId?: string;
  orgId?: string;
  subjectName: string;
  subjectType: AssetTraceSubjectType;
  runMode: AssetTraceRunMode;
  claimAmount?: string;
  terminationDate?: string;
  status: AssetTraceWorkflowStatus;
  steps: AssetTraceWorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

const QUICK_STEPS: readonly AssetTraceStepBlueprint[] = [
  { id: 'quick-scan', stage: 'quick', order: 1, executionMode: 'automatic', tool: 'legal_trace_assets' },
];

const ENTERPRISE_STEPS: readonly AssetTraceStepBlueprint[] = [
  { id: 'enterprise-company-profile', stage: 'deep', order: 1, executionMode: 'automatic', tool: 'legal_company_database_lookup' },
  { id: 'enterprise-judicial-cases', stage: 'deep', order: 2, executionMode: 'automatic', tool: 'legal_search_case' },
  { id: 'enterprise-web-footprint', stage: 'deep', order: 3, executionMode: 'assisted', tool: 'legal_external_research_plan' },
  { id: 'enterprise-related-parties', stage: 'deep', order: 4, executionMode: 'automatic', tool: 'legal_equity_penetration' },
  { id: 'enterprise-finance-tax', stage: 'deep', order: 5, executionMode: 'manual' },
  { id: 'enterprise-bids-receivables', stage: 'deep', order: 6, executionMode: 'assisted', tool: 'legal_search_tender_projects' },
  { id: 'enterprise-timeline', stage: 'deep', order: 7, executionMode: 'automatic', tool: 'local_timeline' },
  { id: 'enterprise-movable-rights', stage: 'deep', order: 8, executionMode: 'manual' },
  { id: 'enterprise-intellectual-property', stage: 'deep', order: 9, executionMode: 'manual' },
  { id: 'enterprise-licenses', stage: 'deep', order: 10, executionMode: 'manual' },
  { id: 'enterprise-customs', stage: 'deep', order: 11, executionMode: 'manual' },
  { id: 'enterprise-auction-bankruptcy', stage: 'deep', order: 12, executionMode: 'manual' },
];

const INDIVIDUAL_STEPS: readonly AssetTraceStepBlueprint[] = [
  { id: 'individual-identity-companies', stage: 'deep', order: 1, executionMode: 'assisted', tool: 'legal_company_database_lookup' },
  { id: 'individual-property-vehicles', stage: 'deep', order: 2, executionMode: 'manual' },
  { id: 'individual-income-social-security', stage: 'deep', order: 3, executionMode: 'manual' },
  { id: 'individual-online-footprint', stage: 'deep', order: 4, executionMode: 'assisted', tool: 'legal_external_research_plan' },
  { id: 'individual-family-holding', stage: 'deep', order: 5, executionMode: 'manual' },
  { id: 'individual-financial-assets', stage: 'deep', order: 6, executionMode: 'manual' },
  { id: 'individual-rural-assets', stage: 'deep', order: 7, executionMode: 'manual' },
  { id: 'individual-travel-activity', stage: 'deep', order: 8, executionMode: 'manual' },
  { id: 'individual-business-household', stage: 'deep', order: 9, executionMode: 'assisted', tool: 'legal_company_database_lookup' },
  { id: 'individual-enforcement-rewards', stage: 'deep', order: 10, executionMode: 'automatic', tool: 'legal_search_case' },
];

const ANALYSIS_STEPS: readonly AssetTraceStepBlueprint[] = [
  { id: 'adversarial-review', stage: 'analysis', order: 1, executionMode: 'assisted', tool: 'legal_case_strategy' },
  { id: 'revocation-matrix', stage: 'analysis', order: 2, executionMode: 'assisted', tool: 'legal_search_statute' },
  { id: 'enforcement-measures', stage: 'analysis', order: 3, executionMode: 'assisted', tool: 'legal_case_strategy' },
  { id: 'final-action-plan', stage: 'analysis', order: 4, executionMode: 'automatic', tool: 'local_action_plan' },
];

export function getAssetTraceBlueprints(subjectType: AssetTraceSubjectType): AssetTraceStepBlueprint[] {
  const deepSteps = subjectType === 'enterprise' ? ENTERPRISE_STEPS : INDIVIDUAL_STEPS;
  return [...QUICK_STEPS, ...deepSteps, ...ANALYSIS_STEPS].map(step => ({ ...step }));
}

export function createAssetTraceWorkflow(input: {
  subjectName: string;
  subjectType: AssetTraceSubjectType;
  runMode: AssetTraceRunMode;
  caseId?: string;
  orgId?: string;
  claimAmount?: string;
  terminationDate?: string;
}): AssetTraceWorkflow {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    id: `asset_trace_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    caseId: input.caseId,
    orgId: input.orgId,
    subjectName: input.subjectName.trim(),
    subjectType: input.subjectType,
    runMode: input.runMode,
    claimAmount: input.claimAmount?.trim() || undefined,
    terminationDate: input.terminationDate || undefined,
    status: 'ready',
    steps: getAssetTraceBlueprints(input.subjectType).map(step => ({ ...step, status: 'pending' })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function normalizeAssetTraceWorkflow(value: unknown): AssetTraceWorkflow | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<AssetTraceWorkflow>;
  if (!input.id || !input.subjectName || !['enterprise', 'individual'].includes(String(input.subjectType))) return null;
  const subjectType = input.subjectType as AssetTraceSubjectType;
  const currentSteps = Array.isArray(input.steps) ? input.steps : [];
  const savedById = new Map(currentSteps.map(step => [step?.id, step]));
  const steps = getAssetTraceBlueprints(subjectType).map(blueprint => {
    const saved = savedById.get(blueprint.id) as Partial<AssetTraceWorkflowStep> | undefined;
    const status = saved && ['pending', 'running', 'needs_action', 'completed', 'skipped', 'failed'].includes(String(saved.status))
      ? saved.status as AssetTraceStepStatus
      : 'pending';
    return {
      ...blueprint,
      status: status === 'running' ? 'pending' : status,
      output: saved?.output ? String(saved.output) : undefined,
      note: saved?.note ? String(saved.note) : undefined,
      error: saved?.error ? String(saved.error) : undefined,
      updatedAt: saved?.updatedAt ? String(saved.updatedAt) : undefined,
    };
  });
  const workflow: AssetTraceWorkflow = {
    version: 1,
    id: String(input.id),
    caseId: input.caseId ? String(input.caseId) : undefined,
    orgId: input.orgId ? String(input.orgId) : undefined,
    subjectName: String(input.subjectName).trim(),
    subjectType,
    runMode: input.runMode === 'deep' ? 'deep' : 'quick',
    claimAmount: input.claimAmount ? String(input.claimAmount) : undefined,
    terminationDate: input.terminationDate ? String(input.terminationDate) : undefined,
    status: 'ready',
    steps,
    createdAt: input.createdAt ? String(input.createdAt) : new Date().toISOString(),
    updatedAt: input.updatedAt ? String(input.updatedAt) : new Date().toISOString(),
  };
  return recalculateAssetTraceWorkflow(workflow);
}

export function getAssetTraceStepsInScope(workflow: AssetTraceWorkflow): AssetTraceWorkflowStep[] {
  return workflow.steps.filter(step => step.stage === 'quick' || workflow.runMode === 'deep');
}

export function getAssetTraceCompletion(workflow: AssetTraceWorkflow): { done: number; total: number; percent: number } {
  const steps = getAssetTraceStepsInScope(workflow);
  const done = steps.filter(step => step.status === 'completed' || step.status === 'skipped').length;
  return { done, total: steps.length, percent: steps.length ? Math.round((done / steps.length) * 100) : 0 };
}

export function getNextAssetTraceStep(workflow: AssetTraceWorkflow): AssetTraceWorkflowStep | null {
  const scoped = getAssetTraceStepsInScope(workflow);
  if (scoped.some(step => step.status === 'running' || step.status === 'needs_action' || step.status === 'failed')) return null;
  return scoped.find(step => step.status === 'pending') || null;
}

export function patchAssetTraceStep(
  workflow: AssetTraceWorkflow,
  stepId: string,
  patch: Partial<Pick<AssetTraceWorkflowStep, 'status' | 'output' | 'note' | 'error'>>,
): AssetTraceWorkflow {
  const timestamp = new Date().toISOString();
  return recalculateAssetTraceWorkflow({
    ...workflow,
    steps: workflow.steps.map(step => step.id === stepId ? { ...step, ...patch, updatedAt: timestamp } : step),
    updatedAt: timestamp,
  });
}

export function promoteAssetTraceWorkflow(workflow: AssetTraceWorkflow): AssetTraceWorkflow {
  return recalculateAssetTraceWorkflow({ ...workflow, runMode: 'deep', status: 'ready', updatedAt: new Date().toISOString() });
}

export function recalculateAssetTraceWorkflow(workflow: AssetTraceWorkflow): AssetTraceWorkflow {
  const steps = getAssetTraceStepsInScope(workflow);
  let status: AssetTraceWorkflowStatus = 'ready';
  if (steps.some(step => step.status === 'running')) status = 'running';
  else if (steps.some(step => step.status === 'needs_action' || step.status === 'failed')) status = 'needs_action';
  else if (steps.length > 0 && steps.every(step => step.status === 'completed' || step.status === 'skipped')) status = 'completed';
  return { ...workflow, status };
}

export function combineAssetTraceOutputs(workflow: AssetTraceWorkflow): string {
  return workflow.steps
    .filter(step => step.output || step.note || step.error)
    .map(step => [
      `## ${step.stage === 'quick' ? 'Quick' : step.stage === 'analysis' ? 'Analysis' : step.order}. ${step.id}`,
      step.output,
      step.note ? `Note: ${step.note}` : '',
      step.error ? `Error: ${step.error}` : '',
    ].filter(Boolean).join('\n\n'))
    .join('\n\n---\n\n');
}
