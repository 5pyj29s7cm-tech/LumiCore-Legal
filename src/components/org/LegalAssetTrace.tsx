import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Circle,
  Clock3,
  FileText,
  FolderOpen,
  Loader2,
  Network,
  Play,
  RotateCcw,
  Search,
  ShieldAlert,
  SkipForward,
  Target,
  UserRound,
  WandSparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '../../lib/useT';
import { getLegalCaseLabel, type LegalCaseFile, type LegalCaseMaterial } from '../../lib/legalCaseStore';
import {
  combineAssetTraceOutputs,
  createAssetTraceWorkflow,
  getAssetTraceCompletion,
  getAssetTraceStepsInScope,
  getNextAssetTraceStep,
  normalizeAssetTraceWorkflow,
  patchAssetTraceStep,
  promoteAssetTraceWorkflow,
  type AssetTraceExecutionMode,
  type AssetTraceRunMode,
  type AssetTraceStepStatus,
  type AssetTraceSubjectType,
  type AssetTraceWorkflow,
  type AssetTraceWorkflowStep,
} from '../../lib/legalAssetTraceWorkflow';
import { runLegalTool } from '../../lib/legalToolClient';
import { LegalCaseContextBar } from './LegalCaseContextBar';
import { chinaLegalCopy } from '../../i18n/regions/cn/legal';

interface TraceResult {
  company?: string;
  legalPerson?: string;
  capital?: string;
  status?: string;
  establishDate?: string;
  shareholders?: { name: string; ratio: number }[];
  enforcements?: { caseNumber: string; court: string; target: string; date: string }[];
  raw?: string;
}

type TraceTab = 'workflow' | 'report' | 'info' | 'enforcement' | 'equity' | 'raw';
type TraceCopy = ReturnType<typeof chinaLegalCopy>['assetTraceWorkflow'];

const STANDALONE_WORKFLOW_STORAGE = 'lumi_legal_asset_trace_workflow_v1';

function legalCaseTitle(caseFile?: LegalCaseFile | null): string {
  return getLegalCaseLabel(caseFile || null) || chinaLegalCopy().unnamedCase;
}

function assetTraceCaseArgs(caseFile?: LegalCaseFile | null, orgId?: string): Record<string, any> {
  if (!caseFile) return { ...(orgId ? { orgId } : {}), persistCase: false };
  return {
    caseId: caseFile.id,
    caseName: legalCaseTitle(caseFile),
    caseType: caseFile.cause || chinaLegalCopy().assetTraceCaseType,
    parties: caseFile.party || undefined,
    orgId,
    persistCase: false,
  };
}

function standaloneStorageKey(orgId?: string): string {
  return orgId ? `${STANDALONE_WORKFLOW_STORAGE}:org:${encodeURIComponent(orgId)}` : STANDALONE_WORKFLOW_STORAGE;
}

function readStandaloneWorkflow(orgId?: string): AssetTraceWorkflow | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeAssetTraceWorkflow(JSON.parse(localStorage.getItem(standaloneStorageKey(orgId)) || 'null'));
  } catch {
    return null;
  }
}

function writeStandaloneWorkflow(workflow: AssetTraceWorkflow, orgId?: string) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(standaloneStorageKey(orgId), JSON.stringify(workflow));
}

function getStepCopy(copy: TraceCopy, stepId: string): { title: string; description: string } {
  return copy.steps[stepId as keyof typeof copy.steps] || { title: stepId, description: '' };
}

function buildTraceToolArgs(
  workflow: AssetTraceWorkflow,
  step: AssetTraceWorkflowStep,
  copy: TraceCopy,
  caseFile?: LegalCaseFile | null,
  orgId?: string,
): Record<string, any> {
  const common = assetTraceCaseArgs(caseFile, orgId);
  const stepCopy = getStepCopy(copy, step.id);
  switch (step.tool) {
    case 'legal_external_source_status':
      return {};
    case 'legal_trace_assets':
    case 'legal_equity_penetration':
    case 'legal_company_database_lookup':
      return { ...common, name: workflow.subjectName };
    case 'legal_search_case':
      return { ...common, query: `${workflow.subjectName} ${stepCopy.title}`, limit: 10 };
    case 'legal_search_statute':
      return { ...common, query: stepCopy.title, includeOfficialWeb: true, limit: 10 };
    case 'legal_search_tender_projects':
      return { ...common, keyword: workflow.subjectName, limit: 20 };
    case 'legal_case_strategy':
      return {
        ...common,
        facts: [
          workflow.subjectName,
          stepCopy.description,
          combineAssetTraceOutputs(workflow).replace(/\s+/g, ' ').slice(0, 12000),
        ].filter(Boolean).join('\n'),
      };
    case 'legal_external_research_plan':
      return {
        ...common,
        facts: stepCopy.description,
        issues: [stepCopy.title],
        companyNames: [workflow.subjectName],
      };
    default:
      return common;
  }
}

function buildTimelineOutput(workflow: AssetTraceWorkflow, copy: TraceCopy): string {
  const prior = workflow.steps.filter(step => step.output && step.id !== 'enterprise-timeline');
  return [
    `# ${getStepCopy(copy, 'enterprise-timeline').title}`,
    '',
    `- ${copy.reportLabels.subject}: ${workflow.subjectName}`,
    `- ${copy.reportLabels.terminationDate}: ${workflow.terminationDate || copy.reportLabels.noValue}`,
    '',
    `## ${copy.reportLabels.timeline}`,
    ...prior.map(step => {
      const stepCopy = getStepCopy(copy, step.id);
      const excerpt = String(step.output || '').replace(/\s+/g, ' ').trim().slice(0, 280);
      return `- ${stepCopy.title}: ${excerpt || copy.noOutput}`;
    }),
  ].join('\n');
}

function buildWorkflowReport(workflow: AssetTraceWorkflow, copy: TraceCopy, locale: string): string {
  const completion = getAssetTraceCompletion(workflow);
  const scopedSteps = getAssetTraceStepsInScope(workflow);
  const outstanding = scopedSteps.filter(step => !['completed', 'skipped'].includes(step.status));
  const conclusion = workflow.status === 'completed' ? copy.workflowComplete : copy.stepBlocked;
  const lines = [
    `# ${copy.reportLabels.title}`,
    '',
    `- ${copy.reportLabels.subject}: ${workflow.subjectName}`,
    `- ${copy.reportLabels.subjectType}: ${workflow.subjectType === 'enterprise' ? copy.enterprise : copy.individual}`,
    `- ${copy.reportLabels.depth}: ${workflow.runMode === 'deep' ? copy.deepMode : copy.quickMode}`,
    `- ${copy.reportLabels.claimAmount}: ${workflow.claimAmount || copy.reportLabels.noValue}`,
    `- ${copy.reportLabels.terminationDate}: ${workflow.terminationDate || copy.reportLabels.noValue}`,
    `- ${copy.reportLabels.generatedAt}: ${new Date().toLocaleString(locale)}`,
    `- ${copy.progress}: ${completion.done}/${completion.total} (${completion.percent}%)`,
    '',
    `## ${copy.reportLabels.conclusion}`,
    conclusion,
    '',
    `## ${copy.reportLabels.timeline}`,
    ...scopedSteps.flatMap(step => {
      const stepCopy = getStepCopy(copy, step.id);
      const body = step.output || step.note || step.error || copy.noOutput;
      return [
        '',
        `### ${stepCopy.title}`,
        `- ${copy.modeLabels[step.executionMode]} / ${copy.statusLabels[step.status]}`,
        step.note ? `- ${copy.manualNote}: ${step.note}` : '',
        '',
        body,
      ].filter(Boolean);
    }),
    '',
    `## ${copy.reportLabels.nextActions}`,
    ...(outstanding.length
      ? outstanding.map(step => `- ${getStepCopy(copy, step.id).title}: ${copy.statusLabels[step.status]}`)
      : [`- ${copy.workflowComplete}`]),
    '',
    `## ${copy.reportLabels.legalNote}`,
    copy.legalBoundary,
  ];
  return lines.join('\n');
}

export function LegalAssetTrace({
  caseFile,
  orgId,
  onAddMaterial,
  onUpdateCase,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
  onUpdateCase?: (patch: Partial<LegalCaseFile>) => void;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const locale = isZh ? 'zh-CN' : 'en-US';
  const copy = chinaLegalCopy(isZh ? 'zh' : 'en').assetTraceWorkflow;
  const [name, setName] = useState(caseFile?.party || '');
  const [subjectType, setSubjectType] = useState<AssetTraceSubjectType>('enterprise');
  const [runMode, setRunMode] = useState<AssetTraceRunMode>('quick');
  const [claimAmount, setClaimAmount] = useState('');
  const [terminationDate, setTerminationDate] = useState('');
  const [workflow, setWorkflow] = useState<AssetTraceWorkflow | null>(null);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TraceTab>('workflow');
  const [selectedStepId, setSelectedStepId] = useState('');
  const [manualNote, setManualNote] = useState('');

  useEffect(() => {
    const saved = normalizeAssetTraceWorkflow(caseFile?.assetTraceWorkflow) || (!caseFile ? readStandaloneWorkflow(orgId) : null);
    setWorkflow(saved);
    setName(saved?.subjectName || caseFile?.party || '');
    setSubjectType(saved?.subjectType || 'enterprise');
    setRunMode(saved?.runMode || 'quick');
    setClaimAmount(saved?.claimAmount || '');
    setTerminationDate(saved?.terminationDate || '');
    const combined = saved ? combineAssetTraceOutputs(saved) : '';
    setResult(combined ? parseTraceResult(combined) : null);
    const selected = saved?.steps.find(step => step.status === 'needs_action' || step.status === 'failed')
      || (saved ? getNextAssetTraceStep(saved) : null)
      || [...(saved?.steps || [])].reverse().find(step => Boolean(step.output));
    setSelectedStepId(selected?.id || '');
    setManualNote(selected?.note || '');
    setActiveTab('workflow');
  }, [caseFile?.id, orgId]);

  const commitWorkflow = (next: AssetTraceWorkflow) => {
    setWorkflow(next);
    if (caseFile && onUpdateCase) onUpdateCase({ assetTraceWorkflow: next });
    else writeStandaloneWorkflow(next, orgId);
    const combined = combineAssetTraceOutputs(next);
    setResult(combined ? parseTraceResult(combined) : null);
  };

  const executeStep = async (base: AssetTraceWorkflow, stepId: string): Promise<AssetTraceWorkflow> => {
    const step = base.steps.find(item => item.id === stepId);
    if (!step) return base;
    const running = patchAssetTraceStep(base, stepId, { status: 'running', error: undefined });
    commitWorkflow(running);
    setSelectedStepId(stepId);
    setManualNote(step.note || '');
    try {
      const output = step.tool === 'local_timeline'
        ? buildTimelineOutput(running, copy)
        : step.tool === 'local_action_plan'
          ? buildWorkflowReport(patchAssetTraceStep(running, step.id, { status: 'completed' }), copy, locale)
          : await runLegalTool(step.tool || '', buildTraceToolArgs(running, step, copy, caseFile, orgId));
      const next = patchAssetTraceStep(running, stepId, {
        status: step.executionMode === 'assisted' ? 'needs_action' : 'completed',
        output,
        error: undefined,
      });
      commitWorkflow(next);
      return next;
    } catch (error: any) {
      const next = patchAssetTraceStep(running, stepId, {
        status: 'failed',
        error: error?.message || String(error),
      });
      commitWorkflow(next);
      return next;
    }
  };

  const startInvestigation = async () => {
    if (!name.trim() || loading) return;
    if (workflow && typeof window !== 'undefined' && !window.confirm(copy.restartConfirm)) return;
    setLoading(true);
    setActiveTab('workflow');
    setManualNote('');
    let next = createAssetTraceWorkflow({
      subjectName: name,
      subjectType,
      runMode,
      claimAmount,
      terminationDate,
      caseId: caseFile?.id,
      orgId,
    });
    commitWorkflow(next);
    try {
      next = await executeStep(next, 'source-preflight');
      if (next.steps.find(step => step.id === 'source-preflight')?.status !== 'completed') return;
      await executeStep(next, 'quick-scan');
    } finally {
      setLoading(false);
    }
  };

  const continueWorkflow = async () => {
    if (!workflow || loading) return;
    const nextStep = getNextAssetTraceStep(workflow);
    if (!nextStep) return;
    if (nextStep.executionMode === 'manual') {
      const next = patchAssetTraceStep(workflow, nextStep.id, { status: 'needs_action' });
      commitWorkflow(next);
      setSelectedStepId(nextStep.id);
      setManualNote(nextStep.note || '');
      return;
    }
    setLoading(true);
    try {
      await executeStep(workflow, nextStep.id);
    } finally {
      setLoading(false);
    }
  };

  const enterDeepInvestigation = () => {
    if (!workflow || loading) return;
    const next = promoteAssetTraceWorkflow(workflow);
    commitWorkflow(next);
    setRunMode('deep');
    const nextStep = getNextAssetTraceStep(next);
    setSelectedStepId(nextStep?.id || selectedStepId);
    setManualNote(nextStep?.note || '');
  };

  const resolveSelectedStep = (status: 'completed' | 'skipped') => {
    if (!workflow || !selectedStepId || loading) return;
    const step = workflow.steps.find(item => item.id === selectedStepId);
    if (!step) return;
    const next = patchAssetTraceStep(workflow, selectedStepId, {
      status,
      note: manualNote.trim() || step.note,
      error: undefined,
    });
    commitWorkflow(next);
    const following = getNextAssetTraceStep(next);
    if (following) {
      setSelectedStepId(following.id);
      setManualNote(following.note || '');
    }
  };

  const retrySelectedStep = async () => {
    if (!workflow || !selectedStepId || loading) return;
    setLoading(true);
    try {
      await executeStep(patchAssetTraceStep(workflow, selectedStepId, { status: 'pending', error: undefined }), selectedStepId);
    } finally {
      setLoading(false);
    }
  };

  const archive = () => {
    if (!workflow || !onAddMaterial) {
      toast.info(copy.archiveUnavailable);
      return;
    }
    const report = buildWorkflowReport(workflow, copy, locale);
    onAddMaterial('evidence', `${workflow.subjectName} - ${copy.reportLabels.title}`, report, 'tool');
    toast.success(copy.archived);
  };

  const completion = workflow ? getAssetTraceCompletion(workflow) : { done: 0, total: 0, percent: 0 };
  const scopedSteps = workflow ? getAssetTraceStepsInScope(workflow) : [];
  const selectedStep = workflow?.steps.find(step => step.id === selectedStepId) || null;
  const nextStep = workflow ? getNextAssetTraceStep(workflow) : null;
  const quickCompleted = Boolean(workflow?.steps
    .filter(step => step.stage === 'quick')
    .every(step => step.status === 'completed' || step.status === 'skipped'));
  const report = useMemo(
    () => workflow ? buildWorkflowReport(workflow, copy, locale) : '',
    [workflow, copy, locale],
  );

  return (
    <div className="h-full overflow-y-auto p-3 text-white sm:p-5 lg:p-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-4 sm:p-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-500/10 text-cyan-300">
              <Target size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-white">{copy.title}</h2>
                <span className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-200">{copy.frameworkBadge}</span>
              </div>
              <p className="mt-1 text-sm leading-6 text-white/50">{copy.description}</p>
            </div>
          </div>
        </section>

        <LegalCaseContextBar
          caseFile={caseFile}
          state={loading || workflow?.status === 'running' ? 'running' : workflow ? 'result' : 'input'}
          detail={caseFile ? copy.resumeHint : copy.standaloneHint}
        />

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.5fr)_minmax(150px,.7fr)_minmax(180px,.8fr)_minmax(140px,.65fr)_minmax(150px,.7fr)]">
            <label className="min-w-0">
              <span className="mb-1.5 block text-xs text-white/45">{copy.subjectName}</span>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/45" />
                <input
                  type="text"
                  value={name}
                  onChange={event => setName(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') void startInvestigation(); }}
                  placeholder={copy.subjectPlaceholder}
                  className="w-full rounded-lg border border-white/10 bg-black/20 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-cyan-400/35"
                />
              </div>
            </label>
            <FieldGroup label={copy.subjectType}>
              <SegmentButton active={subjectType === 'enterprise'} label={copy.enterprise} icon={<Building2 size={14} />} onClick={() => setSubjectType('enterprise')} />
              <SegmentButton active={subjectType === 'individual'} label={copy.individual} icon={<UserRound size={14} />} onClick={() => setSubjectType('individual')} />
            </FieldGroup>
            <FieldGroup label={copy.runMode}>
              <SegmentButton active={runMode === 'quick'} label={copy.quickMode} onClick={() => setRunMode('quick')} />
              <SegmentButton active={runMode === 'deep'} label={copy.deepMode} onClick={() => setRunMode('deep')} />
            </FieldGroup>
            <label>
              <span className="mb-1.5 block text-xs text-white/45">{copy.claimAmount}</span>
              <input
                value={claimAmount}
                onChange={event => setClaimAmount(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/35 focus:border-cyan-400/35"
              />
            </label>
            <label>
              <span className="mb-1.5 block text-xs text-white/45">{copy.terminationDate}</span>
              <input
                type="date"
                value={terminationDate}
                onChange={event => setTerminationDate(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none [color-scheme:dark] focus:border-cyan-400/35"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] pt-3">
            <p className="min-w-0 text-xs leading-5 text-white/40">{runMode === 'deep' ? copy.deepModeHint : copy.quickModeHint}</p>
            <button
              onClick={() => void startInvestigation()}
              disabled={loading || !name.trim()}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/15 px-4 py-2.5 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : workflow ? <RotateCcw size={16} /> : <Play size={16} />}
              {workflow ? copy.restart : copy.start}
            </button>
          </div>
        </section>

        <section className="min-h-[420px] rounded-lg border border-white/10 bg-white/[0.04] p-3 sm:p-4">
          {workflow ? (
            <div className="flex min-h-0 flex-col">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div className="min-w-[220px] flex-1">
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-white/50">
                    <span>{copy.progress}: {completion.done}/{completion.total}</span>
                    <span>{completion.percent}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                    <div className="h-full rounded-full bg-cyan-400/70 transition-all" style={{ width: `${completion.percent}%` }} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <TabButton active={activeTab === 'workflow'} icon={<WandSparkles size={14} />} label={copy.workflow} onClick={() => setActiveTab('workflow')} />
                  <TabButton active={activeTab === 'report'} icon={<FileText size={14} />} label={copy.report} onClick={() => setActiveTab('report')} />
                  <TabButton active={activeTab === 'info'} icon={<Building2 size={14} />} label={copy.company} onClick={() => setActiveTab('info')} />
                  <TabButton active={activeTab === 'enforcement'} icon={<AlertCircle size={14} />} label={copy.enforcement} onClick={() => setActiveTab('enforcement')} />
                  <TabButton active={activeTab === 'equity'} icon={<Network size={14} />} label={copy.equity} onClick={() => setActiveTab('equity')} />
                  <TabButton active={activeTab === 'raw'} icon={<FileText size={14} />} label={copy.raw} onClick={() => setActiveTab('raw')} />
                </div>
              </div>

              {activeTab === 'workflow' && (
                <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(280px,.8fr)_minmax(0,1.35fr)]">
                  <div className="min-w-0 space-y-2 xl:max-h-[680px] xl:overflow-y-auto xl:pr-1 custom-scrollbar">
                    {scopedSteps.map((step, index) => {
                      const stepCopy = getStepCopy(copy, step.id);
                      const previousStage = scopedSteps[index - 1]?.stage;
                      return (
                        <React.Fragment key={step.id}>
                          {step.stage !== previousStage && (
                            <div className="pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/35">
                              {step.stage === 'quick' ? copy.quickStage : step.stage === 'analysis' ? copy.analysisStage : copy.deepStage}
                            </div>
                          )}
                          <button
                            onClick={() => {
                              setSelectedStepId(step.id);
                              setManualNote(step.note || '');
                            }}
                            className={`flex w-full min-w-0 items-start gap-3 rounded-lg border p-3 text-left transition ${
                              selectedStepId === step.id
                                ? 'border-cyan-400/30 bg-cyan-500/10'
                                : 'border-white/[0.08] bg-black/15 hover:border-white/15 hover:bg-white/[0.05]'
                            }`}
                          >
                            <StepStatusIcon status={step.status} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-white/80">{stepCopy.title}</span>
                              <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-white/40">
                                <ModeBadge mode={step.executionMode} copy={copy} />
                                <span>{copy.statusLabels[step.status]}</span>
                              </span>
                            </span>
                          </button>
                        </React.Fragment>
                      );
                    })}
                  </div>

                  <div className="min-w-0 rounded-lg border border-white/[0.08] bg-black/15 p-4">
                    {selectedStep ? (
                      <StepDetail
                        step={selectedStep}
                        copy={copy}
                        loading={loading}
                        manualNote={manualNote}
                        onManualNote={setManualNote}
                        onComplete={() => resolveSelectedStep('completed')}
                        onSkip={() => resolveSelectedStep('skipped')}
                        onRetry={() => void retrySelectedStep()}
                      />
                    ) : (
                      <Empty text={copy.noOutput} />
                    )}
                  </div>
                </div>
              )}
              {activeTab === 'report' && <RawReport text={report} />}
              {activeTab === 'info' && <EnterpriseInfo result={result || {}} copy={copy} />}
              {activeTab === 'enforcement' && <EnforcementList result={result || {}} copy={copy} />}
              {activeTab === 'equity' && <EquityList result={result || {}} copy={copy} />}
              {activeTab === 'raw' && <RawReport text={result?.raw || copy.noOutput} />}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
                <div className="flex min-w-0 items-start gap-2 text-xs leading-5 text-white/40">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-300/65" />
                  <span>{copy.legalBoundary}</span>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {workflow.runMode === 'quick' && quickCompleted && (
                    <button onClick={enterDeepInvestigation} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-violet-400/20 bg-violet-500/15 px-3 py-2 text-sm text-violet-100 hover:bg-violet-500/25 disabled:opacity-50">
                      <WandSparkles size={14} /> {copy.enterDeep}
                    </button>
                  )}
                  {nextStep && (
                    <button onClick={() => void continueWorkflow()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/15 px-3 py-2 text-sm text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50">
                      {loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} {copy.continue}
                    </button>
                  )}
                  <button onClick={archive} disabled={!onAddMaterial} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 hover:bg-white/10 hover:text-white disabled:opacity-40">
                    <FolderOpen size={14} /> {copy.archive}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[380px] flex-col items-center justify-center gap-2 px-6 text-center text-sm text-white/40">
              <Target size={34} className="text-white/20" />
              <span>{copy.waitingInput}</span>
              <span className="max-w-xl text-xs leading-5 text-white/30">{copy.legalBoundary}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1.5 block text-xs text-white/45">{label}</span>
      <div className="grid grid-cols-2 rounded-lg border border-white/10 bg-black/20 p-1">{children}</div>
    </div>
  );
}

function SegmentButton({ active, icon, label, onClick }: { active: boolean; icon?: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition ${active ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'}`}
    >
      {icon}<span className="truncate">{label}</span>
    </button>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
        active
          ? 'border-cyan-400/25 bg-cyan-500/15 text-cyan-100'
          : 'border-white/10 bg-white/5 text-white/55 hover:bg-white/10 hover:text-white'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function StepStatusIcon({ status }: { status: AssetTraceStepStatus }) {
  if (status === 'running') return <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin text-cyan-300" />;
  if (status === 'completed') return <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-300" />;
  if (status === 'needs_action') return <Clock3 size={17} className="mt-0.5 shrink-0 text-amber-300" />;
  if (status === 'failed') return <AlertCircle size={17} className="mt-0.5 shrink-0 text-red-300" />;
  if (status === 'skipped') return <SkipForward size={17} className="mt-0.5 shrink-0 text-white/35" />;
  return <Circle size={17} className="mt-0.5 shrink-0 text-white/25" />;
}

function ModeBadge({ mode, copy }: { mode: AssetTraceExecutionMode; copy: TraceCopy }) {
  const colors = mode === 'automatic'
    ? 'border-emerald-400/15 bg-emerald-500/10 text-emerald-200/75'
    : mode === 'assisted'
      ? 'border-violet-400/15 bg-violet-500/10 text-violet-200/75'
      : 'border-amber-400/15 bg-amber-500/10 text-amber-200/75';
  return <span className={`rounded-full border px-1.5 py-0.5 ${colors}`}>{copy.modeLabels[mode]}</span>;
}

function StepDetail({
  step,
  copy,
  loading,
  manualNote,
  onManualNote,
  onComplete,
  onSkip,
  onRetry,
}: {
  step: AssetTraceWorkflowStep;
  copy: TraceCopy;
  loading: boolean;
  manualNote: string;
  onManualNote: (value: string) => void;
  onComplete: () => void;
  onSkip: () => void;
  onRetry: () => void;
}) {
  const stepCopy = getStepCopy(copy, step.id);
  const canResolve = step.status === 'needs_action';
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-white">{stepCopy.title}</h3>
          <p className="mt-1 text-sm leading-6 text-white/50">{stepCopy.description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 text-xs">
          <ModeBadge mode={step.executionMode} copy={copy} />
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-white/55">{copy.statusLabels[step.status]}</span>
        </div>
      </div>
      {(step.executionMode === 'manual' || step.executionMode === 'assisted') && (
        <div className="mt-4 rounded-lg border border-amber-400/15 bg-amber-500/[0.06] p-3 text-xs leading-5 text-amber-100/65">
          {step.executionMode === 'manual' ? copy.manualBoundary : copy.assistedBoundary}
        </div>
      )}
      <div className="mt-4 min-h-[180px] min-w-0 overflow-auto rounded-lg border border-white/[0.08] bg-black/20 p-3 custom-scrollbar">
        <pre className="whitespace-pre-wrap break-words text-xs leading-6 text-white/65">{step.output || (step.error ? `${copy.errorPrefix}: ${step.error}` : copy.noOutput)}</pre>
      </div>
      {canResolve && (
        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs text-white/45">{copy.manualNote}</span>
          <textarea
            value={manualNote}
            onChange={event => onManualNote(event.target.value)}
            placeholder={copy.manualNotePlaceholder}
            className="min-h-24 w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm leading-6 text-white outline-none placeholder:text-white/30 focus:border-cyan-400/35"
          />
        </label>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {step.status === 'failed' && (
          <button onClick={onRetry} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-100 hover:bg-red-500/20 disabled:opacity-50">
            <RotateCcw size={14} /> {copy.retry}
          </button>
        )}
        {canResolve && (
          <>
            <button onClick={onSkip} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/55 hover:bg-white/10 hover:text-white disabled:opacity-50">
              <SkipForward size={14} /> {copy.skip}
            </button>
            <button
              onClick={onComplete}
              disabled={loading || (step.executionMode === 'manual' && !manualNote.trim())}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/15 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
            >
              <CheckCircle2 size={14} /> {copy.markComplete}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function EnterpriseInfo({ result, copy }: { result: TraceResult; copy: TraceCopy }) {
  if (!result.company && !result.legalPerson && !result.capital && !result.status) return <Empty text={copy.noOutput} />;
  const items = [
    [copy.companyFields.name, result.company],
    [copy.companyFields.legalPerson, result.legalPerson],
    [copy.companyFields.capital, result.capital],
    [copy.companyFields.status, result.status],
    [copy.companyFields.establishDate, result.establishDate],
  ].filter(([, value]) => value);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-white/10 bg-black/15 p-4">
          <p className="text-xs text-white/40">{label}</p>
          <p className="mt-2 text-sm text-white/80">{value}</p>
        </div>
      ))}
    </div>
  );
}

function EnforcementList({ result, copy }: { result: TraceResult; copy: TraceCopy }) {
  if (!result.enforcements?.length) return <Empty text={copy.noOutput} />;
  return (
    <div className="space-y-2">
      {result.enforcements.map((item, index) => (
        <div key={`${item.caseNumber}-${index}`} className="rounded-lg border border-white/10 bg-black/15 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-white"><FileText size={14} className="text-red-300" />{item.caseNumber}</div>
          <div className="mt-2 grid gap-2 text-xs text-white/50 md:grid-cols-3">
            <span>{item.court}</span><span>{item.date}</span><span>{item.target}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EquityList({ result, copy }: { result: TraceResult; copy: TraceCopy }) {
  if (!result.shareholders?.length) return <Empty text={copy.noOutput} />;
  return (
    <div className="space-y-2">
      {result.shareholders.map((item, index) => (
        <div key={`${item.name}-${index}`} className="rounded-lg border border-white/10 bg-black/15 p-4">
          <div className="mb-2 flex items-center justify-between gap-3"><span className="text-sm text-white/80">{item.name}</span><span className="font-mono text-sm text-cyan-200">{item.ratio}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]"><div className="h-full rounded-full bg-cyan-400/60" style={{ width: `${Math.max(0, Math.min(100, item.ratio))}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function RawReport({ text }: { text: string }) {
  return <pre className="max-h-[680px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/20 p-4 text-sm leading-7 text-white/72 custom-scrollbar">{text}</pre>;
}

function Empty({ text }: { text: string }) {
  return <div className="flex min-h-56 flex-col items-center justify-center gap-2 text-center text-sm text-white/40"><FileText size={30} className="text-white/20" /><span>{text}</span></div>;
}

function parseTraceResult(text: string): TraceResult {
  const traceResult: TraceResult = { raw: text };
  const get = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1].trim();
    }
    return '';
  };
  traceResult.company = get([/名称[：:]\s*(.+)/, /企业名称[：:]\s*(.+)/]);
  traceResult.legalPerson = get([/法定代表人[：:]\s*(.+)/, /法人[：:]\s*(.+)/]);
  traceResult.capital = get([/注册资本[：:]\s*(.+)/]);
  traceResult.status = get([/状态[：:]\s*(.+)/, /经营状态[：:]\s*(.+)/]);
  traceResult.establishDate = get([/成立日期[：:]\s*(.+)/]);

  const shareholders: { name: string; ratio: number }[] = [];
  const shareholderRegex = /[-•]\s*(.+?)[：:]\s*(?:持股)?\s*(\d+(?:\.\d+)?)%/g;
  let shareholderMatch: RegExpExecArray | null;
  while ((shareholderMatch = shareholderRegex.exec(text)) !== null) shareholders.push({ name: shareholderMatch[1].trim(), ratio: Number(shareholderMatch[2]) });
  if (shareholders.length > 0) traceResult.shareholders = shareholders;

  const enforcements: { caseNumber: string; court: string; target: string; date: string }[] = [];
  const enforcementRegex = /\[([^\]]+)\]\s*([^|]+)\|\s*(?:立案|日期)[：:]?\s*([^|]*)\|\s*(?:执行标的|标的)[：:]?\s*(.+)/g;
  let enforcementMatch: RegExpExecArray | null;
  while ((enforcementMatch = enforcementRegex.exec(text)) !== null) {
    enforcements.push({ caseNumber: enforcementMatch[1].trim(), court: enforcementMatch[2].trim(), date: enforcementMatch[3].trim(), target: enforcementMatch[4].trim() });
  }
  if (enforcements.length > 0) traceResult.enforcements = enforcements;
  return traceResult;
}
