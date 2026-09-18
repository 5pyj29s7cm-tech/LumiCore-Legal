import { legalToolEntryId as inferLegalEntryId, legalToolCaseIdentity as legalCaseIdentity } from '../../shared/legal_tool_entry';
import { getDesktopSessionProof } from '../services/authService';
import { getIndustryWorkflowTaskRef, startIndustryWorkflow } from './industryWorkflowClient';
import { mergePersonalLegalCaseRuntimeSnapshot } from './legalCaseStore';

interface LegalIndustrySelection {
  taskId?: string;
  entryId: string;
  caseIdentity?: string;
  createdAt: number;
}

const ACTIVE_INDUSTRY_TASK_STATUSES = new Set(['queued', 'in_progress', 'waiting_confirmation']);

function activeLegalIndustrySelection(): LegalIndustrySelection | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem('lumi_legal_industry_task') || '{}');
    if (!parsed?.entryId) return null;
    // A stale selection must never absorb unrelated later legal work.
    if (Date.now() - Number(parsed.createdAt || 0) > 4 * 60 * 60_000) return null;
    return {
      ...(parsed.taskId ? { taskId: String(parsed.taskId) } : {}),
      entryId: String(parsed.entryId),
      ...(parsed.caseIdentity ? { caseIdentity: String(parsed.caseIdentity) } : {}),
      createdAt: Number(parsed.createdAt || 0),
    };
  } catch {
    return null;
  }
}

function taskMatchesLegalSelection(
  task: Awaited<ReturnType<typeof getIndustryWorkflowTaskRef>>,
  entryId: string,
  caseIdentity: string,
): boolean {
  if (!task || !ACTIVE_INDUSTRY_TASK_STATUSES.has(String(task.status || ''))) return false;
  const workflow = task.metadata?.industryWorkflow;
  return String(workflow?.entryId || '') === entryId
    && String(workflow?.context?.caseIdentity || '') === caseIdentity;
}

async function ensureLegalIndustryTask(
  toolName: string,
  args: Record<string, any>,
): Promise<{ taskId: string; entryId: string }> {
  const selected = activeLegalIndustrySelection();
  const inferredEntryId = inferLegalEntryId(toolName);
  const caseIdentity = legalCaseIdentity(args);
  const entryId = selected?.entryId === inferredEntryId ? selected.entryId : inferredEntryId;
  if (
    selected?.taskId
    && selected.entryId === entryId
    && selected.caseIdentity === caseIdentity
  ) {
    const task = await getIndustryWorkflowTaskRef(selected.taskId);
    if (taskMatchesLegalSelection(task, entryId, caseIdentity)) {
      return { taskId: selected.taskId, entryId };
    }
  }

  const sourceInput = JSON.stringify({
    toolName,
    caseId: args.caseId || '',
    caseName: args.caseName || '',
    caseType: args.caseType || '',
  });
  const started = await startIndustryWorkflow({
    entryId,
    source: 'legal_tool_execution',
    sourceInput,
    context: { toolName, caseIdentity },
  });
  const active = {
    taskId: started.task.id,
    entryId,
    caseIdentity,
    createdAt: Date.now(),
  };
  sessionStorage.setItem('lumi_legal_industry_task', JSON.stringify(active));
  return active;
}

export interface LegalToolExecutionResult {
  text: string;
  receipt: Record<string, any>;
  artifacts: string[];
  caseUpdates: Record<string, any>[];
  industryWorkflow?: Record<string, any>;
}

export async function runLegalToolExecution(
  toolName: string,
  args: Record<string, any>,
): Promise<LegalToolExecutionResult> {
  const industryWorkflow = await ensureLegalIndustryTask(toolName, args);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const desktopSessionProof = getDesktopSessionProof();
  if (desktopSessionProof) headers.set('x-lumi-desktop-session', desktopSessionProof);
  const res = await fetch(`/api/legal/tool/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({
      args,
      industryWorkflowTaskId: industryWorkflow?.taskId,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${toolName} failed`);
  const text = data.text || data.response || data.reply || data.message || JSON.stringify(data);
  const caseUpdates = Array.isArray(data.caseUpdates) ? data.caseUpdates : [];
  caseUpdates.forEach((caseFile: Record<string, any>) => mergePersonalLegalCaseRuntimeSnapshot(caseFile));
  if (args.caseId && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lumi:org-legal-cases-changed', {
      detail: { caseId: args.caseId, toolName },
    }));
  }
  return {
    text,
    receipt: data.receipt && typeof data.receipt === 'object' ? data.receipt : {},
    artifacts: Array.isArray(data.artifacts) ? data.artifacts.map((value: unknown) => String(value)) : [],
    caseUpdates,
    industryWorkflow: data.industryWorkflow && typeof data.industryWorkflow === 'object'
      ? data.industryWorkflow
      : undefined,
  };
}

export async function runLegalTool(toolName: string, args: Record<string, any>): Promise<string> {
  return (await runLegalToolExecution(toolName, args)).text;
}
