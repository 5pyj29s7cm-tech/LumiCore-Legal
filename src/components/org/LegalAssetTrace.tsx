import { useLegalDocument, useLegalDocumentScope } from '../../hooks/useLegalDocument';
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
import { runLegalToolExecution } from '../../lib/legalToolClient';
import { LegalCaseContextBar } from './LegalCaseContextBar';
import { chinaLegalCopy } from '../../i18n/regions/cn/legal';
import { uiMessage } from '../../i18n/uiMessages';
import { ChatMessageMarkdown } from '../ChatMessageMarkdown';
import { ChatFilePreview, type ChatPreviewFile } from '../ChatFilePreview';
import { sanitizeAgentResponseTextForDisplay } from '../../lib/agentResponseDelivery';
import { mapQichachaCompanyRegistration, pickQichachaResult, type CompanyRegistrationFields } from '../../../shared/legal_company_info';

interface TraceResult extends Partial<CompanyRegistrationFields> {
  shareholders?: { name: string; ratio?: number }[];
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
    case 'legal_trace_assets':
      return { ...common, name: workflow.subjectName };
    case 'legal_company_database_lookup':
      return step.id === 'enterprise-related-parties'
        ? { ...common, name: workflow.subjectName, queryType: 'controller', sourceIds: ['qichacha'] }
        : { ...common, name: workflow.subjectName };
    case 'legal_search_subject_cases':
      return { ...common, name: workflow.subjectName, subjectType: workflow.subjectType,
        scope: step.id === 'individual-enforcement-rewards' ? 'enforcement' : 'cases' };
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
          combineAssetTraceOutputs(workflow),
        ].filter(Boolean).join('\n'),
      };
    case 'legal_search_public_footprint':
      return { ...common, name: workflow.subjectName, subjectType: workflow.subjectType };
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
  const conclusion = workflow.status === 'completed'
    ? workflow.runMode === 'quick' ? copy.quickComplete : copy.workflowComplete
    : workflow.status === 'needs_action' ? copy.stepBlocked
      : workflow.status === 'running' ? copy.inProgress : copy.readyToContinue;
  const lines = [
    `# ${copy.reportLabels.title}`,
    '',
    `- ${copy.reportLabels.subject}: ${workflow.subjectName}`,
    `- ${copy.reportLabels.subjectType}: ${workflow.subjectType === 'enterprise' ? copy.enterprise : copy.individual}`,
    `- ${copy.reportLabels.depth}: ${workflow.runMode === 'deep' ? copy.deepMode : copy.quickMode}`,
    `- ${copy.reportLabels.claimAmount}: ${workflow.claimAmount || copy.reportLabels.noValue}`,
    `- ${copy.reportLabels.terminationDate}: ${workflow.terminationDate || copy.reportLabels.noValue}`,
    `- ${copy.reportLabels.generatedAt}: ${new Date().toLocaleString(locale)}`,
    `- ${workflow.runMode === 'quick' ? copy.quickProgress : copy.deepProgress}: ${completion.done}/${completion.total} (${completion.percent}%)`,
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
      : [`- ${workflow.runMode === 'quick' ? copy.startDeep : copy.workflowComplete}`]),
    '',
    `## ${copy.reportLabels.legalNote}`,
    copy.legalBoundary,
  ];
  return lines.join('\n');
}

type Props = {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => boolean | Promise<boolean>;
  onUpdateCase?: (patch: Partial<LegalCaseFile>) => void;
};
export function LegalAssetTrace(props: Props) {
  return <AssetTrace key={useLegalDocumentScope(props.caseFile?.id, props.orgId)} {...props} />;
}
function AssetTrace({ caseFile, orgId, onAddMaterial, onUpdateCase }: Props) {
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
  const { busy, generate, save } = useLegalDocument('', { error: uiMessage('legal-asset-trace.error.1d47687da7') });
  const loading = Boolean(busy);
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
    setResult(saved && combined ? projectTraceResult(saved) : null);
    const selected = (saved ? getAssetTraceStepsInScope(saved).find(step => step.status !== 'completed' && step.status !== 'skipped') : null)
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
    setResult(combined ? projectTraceResult(next) : null);
  };

  const executeStep = async (base: AssetTraceWorkflow, stepId: string, signal: AbortSignal): Promise<AssetTraceWorkflow> => {
    signal.throwIfAborted();
    const step = base.steps.find(item => item.id === stepId);
    if (!step) return base;
    const sourceNoteKey = 'legal-asset-trace.verifiable-external-source-required.9b3fa7d6e1';
    const previousNote = (['zh', 'en'] as const).some(lang => step.note === uiMessage(sourceNoteKey, lang)) ? undefined : step.note;
    const running = patchAssetTraceStep(base, stepId, { status: 'running', note: previousNote, error: undefined });
    commitWorkflow(running);
    setSelectedStepId(stepId);
    setManualNote(step.note || '');
    try {
      let receiptStatus = '';
      let verified = true;
      let output = '';
      if (step.tool === 'local_timeline') {
        output = buildTimelineOutput(running, copy);
      } else if (step.tool === 'local_action_plan') {
        output = buildWorkflowReport(patchAssetTraceStep(running, step.id, { status: 'completed' }), copy, locale);
      } else {
        const execution = await runLegalToolExecution(
          step.tool || '',
          buildTraceToolArgs(running, step, copy, caseFile, orgId),
          signal,
        );
        output = execution.text;
        receiptStatus = String(execution.receipt?.status || '').trim().toLowerCase();
        verified = execution.verification?.status === 'verified' && execution.receipt?.ok !== false;
      }
      signal.throwIfAborted();
      const needsSource = !verified || receiptStatus === 'needs_source';
      const next = patchAssetTraceStep(running, stepId, {
        status: needsSource || step.executionMode === 'assisted' ? 'needs_action' : 'completed',
        output,
        note: needsSource
          ? uiMessage(sourceNoteKey, isZh ? 'zh' : 'en')
          : previousNote,
        error: undefined,
      });
      commitWorkflow(next);
      return next;
    } catch (error: any) {
      signal.throwIfAborted();
      const next = patchAssetTraceStep(running, stepId, {
        status: 'failed',
        error: error?.message || String(error),
      });
      commitWorkflow(next);
      return next;
    }
  };

  const startInvestigation = () => {
    if (!name.trim() || loading) return;
    if (workflow && typeof window !== 'undefined' && !window.confirm(copy.restartConfirm)) return;
    return generate(async signal => {
      setActiveTab('workflow');
      setManualNote('');
      let next = createAssetTraceWorkflow({ subjectName: name, subjectType, runMode, claimAmount, terminationDate, caseId: caseFile?.id, orgId });
      next = await executeStep(next, 'quick-scan', signal);
      return combineAssetTraceOutputs(next);
    });
  };
  const continueWorkflow = () => {
    if (!workflow || loading) return;
    const base = workflow.runMode === 'quick' && workflow.status === 'completed'
      ? promoteAssetTraceWorkflow(workflow)
      : workflow;
    const nextStep = getNextAssetTraceStep(base);
    if (!nextStep) return;
    setRunMode(base.runMode);
    setActiveTab('workflow');
    setSelectedStepId(nextStep.id);
    setManualNote(nextStep.note || '');
    if (nextStep.executionMode === 'manual') {
      commitWorkflow(patchAssetTraceStep(base, nextStep.id, { status: 'needs_action' }));
      return;
    }
    return generate(async signal => combineAssetTraceOutputs(await executeStep(base, nextStep.id, signal)));
  };

  const resolveSelectedStep = (status: 'completed' | 'skipped') => {
    if (!workflow || !selectedStepId || loading) return;
    const step = workflow.steps.find(item => item.id === selectedStepId);
    if (!step || (status === 'completed' && step.executionMode === 'automatic')) return;
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

  const handleWorkflowAction = () => {
    if (!workflow || loading) return;
    const current = getAssetTraceStepsInScope(workflow).find(step => step.status !== 'completed' && step.status !== 'skipped');
    const blocked = current?.status === 'failed' || current?.status === 'needs_action' ? current : null;
    if (!blocked) return continueWorkflow();
    setActiveTab('workflow');
    setSelectedStepId(blocked.id);
    setManualNote(blocked.note || '');
    if (blocked.status === 'failed' || blocked.executionMode === 'automatic') return generate(async signal => combineAssetTraceOutputs(await executeStep(
      patchAssetTraceStep(workflow, blocked.id, { status: 'pending', error: undefined }), blocked.id, signal,
    )));
  };
  const archive = () => {
    if (!workflow || !onAddMaterial) { toast.info(copy.archiveUnavailable); return; }
    return save(() => onAddMaterial('note', workflow.subjectName + ' - ' + copy.reportLabels.title, buildWorkflowReport(workflow, copy, locale), 'tool'), copy.archived);
  };

  const completion = workflow ? getAssetTraceCompletion(workflow) : { done: 0, total: 0, percent: 0 };
  const scopedSteps = workflow ? getAssetTraceStepsInScope(workflow) : [];
  const selectedStep = workflow?.steps.find(step => step.id === selectedStepId) || null;
  const nextStep = workflow ? getNextAssetTraceStep(workflow) : null;
  const quickCompleted = Boolean(workflow?.steps
    .filter(step => step.stage === 'quick')
    .every(step => step.status === 'completed' || step.status === 'skipped'));
  const currentStep = scopedSteps.find(step => step.status === 'running')
    || scopedSteps.find(step => step.status !== 'completed' && step.status !== 'skipped');
  const canStartDeep = workflow?.runMode === 'quick' && quickCompleted;
  const upcomingStep = canStartDeep ? workflow?.steps.find(step => step.stage !== 'quick' && step.status === 'pending') : nextStep;
  const actionLabel = busy === 'generate'
    ? copy.executingStep.replace('{step}', currentStep ? getStepCopy(copy, currentStep.id).title : copy.report)
    : currentStep?.status === 'failed' || (currentStep?.status === 'needs_action' && currentStep.executionMode === 'automatic')
      ? copy.retryStep.replace('{step}', getStepCopy(copy, currentStep.id).title)
      : currentStep?.status === 'needs_action'
        ? copy.reviewStep.replace('{step}', getStepCopy(copy, currentStep.id).title)
        : canStartDeep ? copy.startDeep
          : nextStep ? copy.executeNext.replace('{step}', getStepCopy(copy, nextStep.id).title) : '';
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
              className={workflow
                ? 'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-white/55 transition hover:bg-white/5 hover:text-white disabled:opacity-50'
                : 'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/15 px-4 py-2.5 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:opacity-50'}
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : workflow ? <RotateCcw size={16} /> : <Play size={16} />}
              {workflow ? copy.restart : copy.start}
            </button>
          </div>
        </section>

        <section className="min-h-[420px] rounded-lg border border-white/10 bg-white/[0.04] p-3 sm:p-4">
          {workflow ? (
            <div className="flex min-h-0 flex-col">
              <div data-testid="asset-trace-controls" className="sticky top-0 z-10 -mx-3 -mt-3 mb-4 border-b border-white/10 bg-[#0c1017]/95 p-4 backdrop-blur-md sm:-mx-4 sm:-mt-4">
                <ol aria-label={copy.stages} className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                  {(['quick', 'deep', 'analysis'] as const).map((stage, index) => {
                    const steps = workflow.steps.filter(step => step.stage === stage);
                    const done = steps.filter(step => step.status === 'completed' || step.status === 'skipped').length;
                    const active = (currentStep?.stage || (workflow.runMode === 'quick' ? 'quick' : 'analysis')) === stage;
                    return <li key={stage} aria-current={active ? 'step' : undefined} className={active ? 'flex items-center gap-2 text-cyan-100' : 'flex items-center gap-2 text-white/40'}>
                      <span className={done === steps.length ? 'text-emerald-300' : active ? 'text-cyan-300' : 'text-white/30'}>{done === steps.length ? <CheckCircle2 size={15} /> : index + 1}</span>
                      <span>{stage === 'quick' ? copy.quickStage : stage === 'deep' ? copy.deepStage : copy.analysisStage}</span>
                      <span className="font-mono text-[11px] opacity-65">{done}/{steps.length}</span>
                    </li>;
                  })}
                </ol>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-[200px] flex-1">
                    <p className="mb-2 text-sm font-medium text-white/85" role="status">{canStartDeep ? copy.quickComplete : workflow.status === 'completed' ? copy.workflowComplete : currentStep?.status === 'needs_action' || currentStep?.status === 'failed' ? copy.stepBlocked : currentStep ? getStepCopy(copy, currentStep.id).title : copy.noOutput}</p>
                    {canStartDeep && upcomingStep && <p className="mb-2 text-xs text-white/50">{copy.nextStep.replace('{step}', getStepCopy(copy, upcomingStep.id).title)}</p>}
                    <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-white/45">
                      <span>{workflow.runMode === 'quick' ? copy.quickProgress : copy.deepProgress}: {completion.done}/{completion.total}</span>
                      <span>{completion.percent}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                      <div className="h-full rounded-full bg-cyan-400/70 transition-all" style={{ width: `${completion.percent}%` }} />
                    </div>
                  </div>
                  {actionLabel && <button type="button" onClick={() => void handleWorkflowAction()} disabled={loading} className="inline-flex min-h-11 max-w-full items-center justify-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-500/20 px-4 py-2.5 text-left text-sm font-medium text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-50">
                    {loading ? <Loader2 size={16} className="shrink-0 animate-spin" /> : currentStep?.status === 'failed' ? <RotateCcw size={16} className="shrink-0" /> : <Play size={16} className="shrink-0" />}
                    {actionLabel}
                  </button>}
                </div>
              </div>
              <div data-testid="asset-trace-result-tabs" className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div className="flex flex-wrap gap-2">
                  <TabButton active={activeTab === 'workflow'} icon={<WandSparkles size={14} />} label={copy.workflow} onClick={() => setActiveTab('workflow')} />
                  <TabButton active={activeTab === 'report'} icon={<FileText size={14} />} label={copy.report} onClick={() => setActiveTab('report')} />
                  <TabButton active={activeTab === 'info'} icon={<Building2 size={14} />} label={copy.company} onClick={() => setActiveTab('info')} />
                  <TabButton active={activeTab === 'enforcement'} icon={<AlertCircle size={14} />} label={copy.enforcement} onClick={() => setActiveTab('enforcement')} />
                  <TabButton active={activeTab === 'equity'} icon={<Network size={14} />} label={copy.equity} onClick={() => setActiveTab('equity')} />
                  <TabButton active={activeTab === 'raw'} icon={<FileText size={14} />} label={copy.raw} onClick={() => setActiveTab('raw')} />
                </div>
                {onAddMaterial && <button onClick={archive} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-white/55 hover:bg-white/5 hover:text-white disabled:opacity-40">
                  <FolderOpen size={14} /> {copy.archive}
                </button>}
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
              {activeTab === 'raw' && <RawReport text={result?.raw || copy.noOutput} raw />}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
                <div className="flex min-w-0 items-start gap-2 text-xs leading-5 text-white/40">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-300/65" />
                  <span>{copy.legalBoundary}</span>
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
}: {
  step: AssetTraceWorkflowStep;
  copy: TraceCopy;
  loading: boolean;
  manualNote: string;
  onManualNote: (value: string) => void;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const stepCopy = getStepCopy(copy, step.id);
  const canResolve = step.status === 'needs_action';
  const canConfirm = canResolve && step.executionMode !== 'automatic';
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
        <TraceReportContent text={step.output || (step.error ? `${copy.errorPrefix}: ${step.error}` : copy.noOutput)} />
      </div>
      {canConfirm && (
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
        {canResolve && (
          <>
            <button onClick={onSkip} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/55 hover:bg-white/10 hover:text-white disabled:opacity-50">
              <SkipForward size={14} /> {copy.skip}
            </button>
            {canConfirm && <button
              onClick={onComplete}
              disabled={loading || (step.executionMode === 'manual' && !manualNote.trim())}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/15 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
            >
              <CheckCircle2 size={14} /> {copy.markComplete}
            </button>}
          </>
        )}
      </div>
    </div>
  );
}

function EnterpriseInfo({ result, copy }: { result: TraceResult; copy: TraceCopy }) {
  if (!result.name) return <Empty text={copy.noOutput} />;
  const items = [
    [copy.companyFields.name, result.name],
    [copy.companyFields.legalPerson, result.legalPerson],
    [copy.companyFields.capital, result.registeredCapital],
    [copy.companyFields.status, result.status],
    [copy.companyFields.establishDate, result.establishDate],
    [copy.companyFields.unifiedCode, result.unifiedCode],
    [copy.companyFields.paidInCapital, result.paidInCapital],
    [copy.companyFields.enterpriseType, result.enterpriseType],
    [copy.companyFields.registrationAuthority, result.registrationAuthority],
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
  if (!result.enforcements?.length) return <Empty text={copy.noStructuredEnforcement} />;
  return (
    <div className="space-y-2">
      {result.enforcements.map((item, index) => (
        <div key={`${item.caseNumber}-${index}`} className="rounded-lg border border-white/10 bg-black/15 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-white"><FileText size={14} className="text-red-300" />{item.caseNumber}</div>
          <div className="mt-2 grid gap-2 text-xs text-white/50 md:grid-cols-3">
            {item.court && <span>{item.court}</span>}{item.date && <span>{item.date}</span>}{item.target && <span>{item.target}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function EquityList({ result, copy }: { result: TraceResult; copy: TraceCopy }) {
  if (!result.shareholders?.length) return <Empty text={copy.noStructuredEquity} />;
  return (
    <div className="space-y-2">
      {result.shareholders.map((item, index) => (
        <div key={`${item.name}-${index}`} className="rounded-lg border border-white/10 bg-black/15 p-4">
          <div className="mb-2 flex items-center justify-between gap-3"><span className="text-sm text-white/80">{item.name}</span>{item.ratio !== undefined && <span className="font-mono text-sm text-cyan-200">{item.ratio}%</span>}</div>
          {item.ratio !== undefined && <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]"><div className="h-full rounded-full bg-cyan-400/60" style={{ width: `${Math.max(0, Math.min(100, item.ratio))}%` }} /></div>}
        </div>
      ))}
    </div>
  );
}

function RawReport({ text, raw = false }: { text: string; raw?: boolean }) {
  return <div className="max-h-[680px] min-w-0 overflow-auto rounded-lg border border-white/10 bg-black/20 p-4 custom-scrollbar"><TraceReportContent text={text} raw={raw} /></div>;
}

function TraceReportContent({ text, raw = false }: { text: string; raw?: boolean }) {
  const isZh = useT().langCode !== 'en';
  const copy = chinaLegalCopy(isZh ? 'zh' : 'en').assetTraceWorkflow;
  const [preview, setPreview] = useState<ChatPreviewFile | null>(null);
  if (raw) return <pre className="whitespace-pre-wrap break-words text-sm leading-7 text-white/72">{text}</pre>;
  const readable = splitTraceReportSections(text).map(section => {
    // i18n-allow: Legacy application report metadata, never values inside official source originals.
    if (!['数据可用性', '公开执行记录'].includes(section.title)) return section.original;
    return section.original.split('\n').map(line => {
      const field = line.match(/^- (数据状态|查询状态)[：:]\s*(\S+)\s*$/);
      const label = field?.[2] === 'observed' ? copy.sourceObserved : field?.[2] === 'needs_source' ? copy.sourceMissing : '';
      return label ? '- ' + field![1] + ': ' + label : line;
    }).join('\n');
  }).join('');
  return <>
    <article className="prose prose-sm prose-invert max-w-none break-words text-sm leading-7 text-white/72"><ChatMessageMarkdown onPreview={setPreview}>{sanitizeAgentResponseTextForDisplay(readable, isZh ? 'zh' : 'en')}</ChatMessageMarkdown></article>
    {preview && <ChatFilePreview file={preview} isZh={isZh} onClose={() => setPreview(null)} />}
  </>;
}

function Empty({ text }: { text: string }) {
  return <div className="flex min-h-56 flex-col items-center justify-center gap-2 text-center text-sm text-white/40"><FileText size={30} className="text-white/20" /><span>{text}</span></div>;
}

function splitTraceReportSections(text: string) {
  return text.split(/(?=^##[ \t]+)/m).map(original => {
    const heading = original.match(/^##[ \t]+([^\r\n]+)\r?\n?/);
    return { original, title: heading?.[1].trim() || '', body: heading ? original.slice(heading[0].length) : original };
  });
}

function traceReportFields(text: string): Record<string, string> {
  return Object.fromEntries(text.split(/\r?\n/).flatMap(line => {
    const field = line.match(/^- ([^：:]+)[：:]\s*(.*)$/);
    return field ? [[field[1].trim(), field[2].trim()]] : [];
  }));
}

function projectTraceResult(workflow: AssetTraceWorkflow): TraceResult {
  const result: TraceResult = { raw: combineAssetTraceOutputs(workflow) };
  const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const matchesSubject = (company: CompanyRegistrationFields | null) => company?.name.trim() === workflow.subjectName.trim();
  for (const step of workflow.steps) {
    if (!step.output) continue;
    const sections = splitTraceReportSections(step.output);
    // i18n-allow: Exact report headings, source tool names and supplied JSON property names, never narrative keyword matches.
    for (const section of sections.filter(item => item.title === '官方来源原始结果')) {
      const [metadata, ...original] = section.body.trim().split(/\r?\n\r?\n/);
      const tool = traceReportFields(metadata)['工具'];
      if (!['get_company_registration_info', 'get_shareholder_info', 'get_judgment_debtor_info'].includes(tool)) continue;
      try {
        const record = pickQichachaResult(JSON.parse(original.join('\n\n')));
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        if (tool === 'get_judgment_debtor_info') {
          if (text(record['主体名称']) !== workflow.subjectName.trim() || !Array.isArray(record['被执行信息'])) continue;
          result.enforcements = record['被执行信息'].flatMap((entry: any) => {
            if (!entry || typeof entry !== 'object') return [];
            const item = { caseNumber: text(entry['案号']), court: text(entry['执行法院']), target: text(entry['执行标的']), date: text(entry['立案日期'] ?? entry['日期']) };
            return item.caseNumber || item.court || item.target ? [item] : [];
          });
          continue;
        }
        const company = mapQichachaCompanyRegistration(record);
        if (!matchesSubject(company)) continue;
        if (tool === 'get_company_registration_info' && !result.name) Object.assign(result, company);
        const shareholders = record.Shareholders ?? record.shareholders ?? record.Partners;
        if (Array.isArray(shareholders)) result.shareholders = shareholders.flatMap((entry: any) => {
          if (!entry || typeof entry !== 'object') return [];
          const name = text(entry.Name ?? entry.name ?? entry.StockName);
          if (!name) return [];
          const suppliedRatio = text(entry.Ratio ?? entry.ratio ?? entry.StockPercent);
          const ratio = suppliedRatio ? Number.parseFloat(suppliedRatio) : NaN;
          return [{ name, ...(Number.isFinite(ratio) ? { ratio } : {}) }];
        });
      } catch { /* Non-JSON source text remains available unchanged in the original results. */ }
    }
    // i18n-allow: A bounded canonical company section supports sources without JSON originals.
    if (!result.name) for (const section of sections.filter(item => item.title === '企业基本信息')) {
      const fields = traceReportFields(section.body);
      const company = mapQichachaCompanyRegistration({ ...fields, 企业名称: fields['名称'] || fields['企业名称'], 登记状态: fields['状态'] || fields['登记状态'] });
      if (matchesSubject(company)) Object.assign(result, company);
    }
  }
  return result;
}
