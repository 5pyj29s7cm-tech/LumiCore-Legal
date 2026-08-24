export interface IndustryWorkflowTaskRef {
  id: string;
  status: string;
  metadata?: Record<string, any>;
}

export interface IndustryWorkflowStartResponse {
  task: IndustryWorkflowTaskRef;
  conversationId: string;
  conversationTaskId: string;
  requestId: string;
  handoffPrompt: string;
  contract: {
    productLine: string;
    entryId: string;
    title: string;
    requiredArtifactLabels: string[];
    expectedContentTerms: string[];
    requiresFileArtifact: boolean;
  };
}

export async function startIndustryWorkflow(input: {
  entryId: string;
  sourceInput?: string;
  source?: string;
  context?: Record<string, unknown>;
}): Promise<IndustryWorkflowStartResponse> {
  const response = await fetch('/api/industry/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Unable to start industry workflow (${response.status})`);
  return data as IndustryWorkflowStartResponse;
}

export async function getIndustryWorkflowTaskRef(taskId: string): Promise<IndustryWorkflowTaskRef | null> {
  const response = await fetch(`/api/industry/workflows/${encodeURIComponent(taskId)}`, {
    credentials: 'include',
  });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Unable to read industry workflow (${response.status})`);
  return data?.task && typeof data.task === 'object'
    ? data.task as IndustryWorkflowTaskRef
    : null;
}

export async function verifyIndustryWorkflow(input: {
  taskId: string;
  resultText?: string;
  filePaths?: string[];
  source?: string;
}): Promise<Record<string, any>> {
  const response = await fetch(`/api/industry/workflows/${encodeURIComponent(input.taskId)}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      resultText: input.resultText || '',
      filePaths: input.filePaths || [],
      source: input.source || 'industry_client',
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Unable to verify industry workflow (${response.status})`);
  return data as Record<string, any>;
}
