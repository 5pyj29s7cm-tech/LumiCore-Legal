import { startIndustryWorkflow } from './industryWorkflowClient';

interface LegalIndustrySelection {
  taskId?: string;
  entryId: string;
  createdAt: number;
}

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
      createdAt: Number(parsed.createdAt || 0),
    };
  } catch {
    return null;
  }
}

function inferLegalEntryId(toolName: string): string {
  if (/bid/i.test(toolName)) return 'bid';
  if (/contract/i.test(toolName)) return 'contract-review';
  if (/(?:asset|equity|company)/i.test(toolName)) return 'asset-trace';
  if (/(?:citation|verify|final)/i.test(toolName)) return 'verify';
  if (/(?:statute|search_case|case_search|research|external_search)/i.test(toolName)) return 'research';
  if (/(?:packet|strategy|opinion|document|draft)/i.test(toolName)) return 'packet';
  return 'workspace';
}

async function ensureLegalIndustryTask(
  toolName: string,
  args: Record<string, any>,
): Promise<{ taskId: string; entryId: string }> {
  const selected = activeLegalIndustrySelection();
  if (selected?.taskId) return { taskId: selected.taskId, entryId: selected.entryId };

  const entryId = selected?.entryId || inferLegalEntryId(toolName);
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
    context: { toolName },
  });
  const active = {
    taskId: started.task.id,
    entryId,
    createdAt: Date.now(),
  };
  sessionStorage.setItem('lumi_legal_industry_task', JSON.stringify(active));
  return active;
}

export async function runLegalTool(toolName: string, args: Record<string, any>): Promise<string> {
  const industryWorkflow = await ensureLegalIndustryTask(toolName, args);
  const res = await fetch(`/api/legal/tool/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      args,
      industryWorkflowTaskId: industryWorkflow?.taskId,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${toolName} failed`);
  const text = data.text || data.response || data.reply || data.message || JSON.stringify(data);
  if (args.caseId && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lumi:org-legal-cases-changed', {
      detail: { caseId: args.caseId, toolName },
    }));
  }
  return text;
}
