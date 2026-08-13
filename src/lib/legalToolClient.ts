function activeLegalIndustryTask(): { taskId: string; entryId: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem('lumi_legal_industry_task') || '{}');
    if (!parsed?.taskId || !parsed?.entryId) return null;
    // A stale navigation task must never absorb unrelated later legal work.
    if (Date.now() - Number(parsed.createdAt || 0) > 4 * 60 * 60_000) return null;
    return { taskId: String(parsed.taskId), entryId: String(parsed.entryId) };
  } catch {
    return null;
  }
}

export async function runLegalTool(toolName: string, args: Record<string, any>): Promise<string> {
  const industryWorkflow = activeLegalIndustryTask();
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
