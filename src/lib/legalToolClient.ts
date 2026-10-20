import { apiJson } from '../services/apiClient';
import { mergePersonalLegalCaseRuntimeSnapshot } from './legalCaseStore';

async function requestLegalResult(url: string, body: Record<string, any>, toolName: string, caseId?: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const data = await apiJson<Record<string, any>>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  signal?.throwIfAborted();
  if (!data || !Object.keys(data).length) throw new Error(toolName + ' failed');
  const caseUpdates = Array.isArray(data.caseUpdates) ? data.caseUpdates : [];
  caseUpdates.forEach(mergePersonalLegalCaseRuntimeSnapshot);
  if (caseId && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lumi:org-legal-cases-changed', { detail: { caseId, toolName } }));
  return { ...data, text: data.text || data.response || data.reply || data.message || JSON.stringify(data), caseUpdates };
}

export async function runLegalRequest(url: string, body: Record<string, any>, toolName: string, caseId?: string, signal?: AbortSignal): Promise<string> {
  const data = await requestLegalResult(url, body, toolName, caseId, signal);
  return successfulLegalToolText({ text: data.text, receipt: data.receipt || {}, verification: data.verification });
}

export interface LegalToolExecutionResult { text: string; receipt: Record<string, any>; artifacts: string[]; caseUpdates: Record<string, any>[]; verification?: Record<string, any>; industryWorkflow?: Record<string, any> }
/** Use the server terminal verifier; a returned draft is not a completed result. */
export function successfulLegalToolText(result: Pick<LegalToolExecutionResult, 'text' | 'receipt' | 'verification'>): string {
  if (result.verification?.status !== 'verified' || result.receipt.ok === false) throw new Error(result.text);
  return result.text;
}

export async function runLegalToolExecution(toolName: string, args: Record<string, any>, signal?: AbortSignal): Promise<LegalToolExecutionResult> {
  const data = await requestLegalResult('/api/legal/tool/' + encodeURIComponent(toolName), { args }, toolName, args.caseId, signal);
  return { text: data.text, receipt: data.receipt || {}, artifacts: data.artifacts || [], caseUpdates: data.caseUpdates, verification: data.verification, ...(data.industryWorkflow ? { industryWorkflow: data.industryWorkflow } : {}) };
}

export function runLegalTool(toolName: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
  return runLegalRequest('/api/legal/tool/' + encodeURIComponent(toolName), { args }, toolName, args.caseId, signal);
}
