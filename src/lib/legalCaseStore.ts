import { apiJson } from '../services/apiClient';
import type { LegalWorkflowRun } from '../../shared/legal_workflow_receipts';
import { chinaLegalCopy } from '../i18n/regions/cn/legal';
import { normalizeAssetTraceWorkflow, type AssetTraceWorkflow } from './legalAssetTraceWorkflow';

export type LegalCaseStage = 'consultation' | 'filing' | 'trial' | 'judgment' | 'enforcement' | 'closed';

export type LegalCaseMaterialType = 'consultation' | 'evidence' | 'pleading' | 'judgment' | 'contract' | 'note';

export interface LegalCaseMaterial {
  id: string;
  type: LegalCaseMaterialType;
  title: string;
  createdAt: string;
  content?: string;
  fileName?: string;
  localPath?: string;
  createdBy?: string;
  source?: 'manual' | 'meeting' | 'notice' | 'tool' | 'import' | 'feishu';
}

export interface LegalCaseFile {
  id: string;
  title: string;
  caseNumber: string;
  party: string;
  cause: string;
  court: string;
  judge: string;
  stage: LegalCaseStage;
  factDate?: string;
  hearingDate: string;
  judgmentDate: string;
  appealDeadline: string;
  enforcementDeadline: string;
  notes: string;
  clientPartyName?: string;
  clientRole?: string;
  objective?: string;
  workflowRuns?: LegalWorkflowRun[];
  materials: LegalCaseMaterial[];
  removedMaterialIds?: string[];
  assetTraceWorkflow?: AssetTraceWorkflow;
  createdAt: string;
  updatedAt: string;
}

export const LEGAL_CASES_STORAGE = 'lumi_legal_cases_v1';
export const ACTIVE_LEGAL_CASE_STORAGE = 'lumi_legal_active_case_v1';
export const LEGAL_CONSULTATION_CASE_STORAGE = 'lumi_legal_consultation_case_v1';
export const LEGAL_CASES_CHANGED_EVENT = 'lumi:legal-cases-changed';

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function currentLegalStorageScope(): { domain: 'personal' | 'work'; orgId: string } {
  if (!canUseStorage()) return { domain: 'personal', orgId: '' };
  try {
    if (localStorage.getItem('lumi_work_domain') !== 'work') return { domain: 'personal', orgId: '' };
    const orgId = String(JSON.parse(localStorage.getItem('lumi_org_connection') || 'null')?.orgId || '').trim();
    return orgId ? { domain: 'work', orgId } : { domain: 'work', orgId: 'pending' };
  } catch {
    return { domain: 'personal', orgId: '' };
  }
}

function scopedLegalStateKey(base: string): string {
  const scope = currentLegalStorageScope();
  return scope.domain === 'work' ? `${base}:org:${encodeURIComponent(scope.orgId)}` : base;
}

function newId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createEmptyLegalCase(): LegalCaseFile {
  const now = new Date().toISOString();
  return {
    id: newId('case'),
    title: '',
    caseNumber: '',
    party: '',
    clientPartyName: '',
    cause: '',
    court: '',
    judge: '',
    stage: 'consultation',
    factDate: '',
    hearingDate: '',
    judgmentDate: '',
    appealDeadline: '',
    enforcementDeadline: '',
    notes: '',
    materials: [],
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeCaseFile(value: any): LegalCaseFile | null {
  if (!value || typeof value !== 'object' || !value.id) return null;
  const removedMaterialIds: string[] = Array.isArray(value.removedMaterialIds) ? [...new Set<string>(value.removedMaterialIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))] : [];
  return {
    id: String(value.id),
    title: String(value.title || ''),
    caseNumber: String(value.caseNumber || ''),
    party: String(value.party || ''),
    cause: String(value.cause || ''),
    court: String(value.court || ''),
    judge: String(value.judge || ''),
    stage: (['consultation', 'filing', 'trial', 'judgment', 'enforcement', 'closed'].includes(value.stage) ? value.stage : 'consultation') as LegalCaseStage,
    factDate: String(value.factDate || ''),
    hearingDate: String(value.hearingDate || ''),
    judgmentDate: String(value.judgmentDate || ''),
    appealDeadline: String(value.appealDeadline || ''),
    enforcementDeadline: String(value.enforcementDeadline || ''),
    notes: String(value.notes || ''),
    ...(Object.hasOwn(value, 'clientPartyName') ? { clientPartyName: String(value.clientPartyName || '') } : {}),
    clientRole: String(value.clientRole || ''),
    objective: String(value.objective || ''),
    workflowRuns: Array.isArray(value.workflowRuns) ? value.workflowRuns.filter((run: LegalWorkflowRun) => !run.materialIds.some(id => removedMaterialIds.includes(id))) : undefined,
    removedMaterialIds,
    materials: Array.isArray(value.materials) ? value.materials.map((item: any) => ({
      id: String(item?.id || newId('mat')),
      type: (['consultation', 'evidence', 'pleading', 'judgment', 'contract', 'note'].includes(item?.type) ? item.type : 'note') as LegalCaseMaterialType,
      title: String(item?.title || chinaLegalCopy().material),
      createdAt: String(item?.createdAt || new Date().toISOString()),
      content: item?.content ? String(item.content) : undefined,
      fileName: item?.fileName ? String(item.fileName) : undefined,
      localPath: item?.localPath ? String(item.localPath) : undefined,
      createdBy: item?.createdBy ? String(item.createdBy) : undefined,
      source: item?.source,
    })).filter((item: LegalCaseMaterial) => !removedMaterialIds.includes(item.id)) : [],
    assetTraceWorkflow: normalizeAssetTraceWorkflow(value.assetTraceWorkflow) || undefined,
    createdAt: String(value.createdAt || new Date().toISOString()),
    updatedAt: String(value.updatedAt || value.createdAt || new Date().toISOString()),
  };
}

export function readLegalCaseFiles(): LegalCaseFile[] {
  if (!canUseStorage()) return [];
  if (currentLegalStorageScope().domain === 'work') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGAL_CASES_STORAGE) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeCaseFile).filter(Boolean) as LegalCaseFile[];
  } catch {
    return [];
  }
}

export function getActiveLegalCaseId(): string {
  if (!canUseStorage()) return '';
  return localStorage.getItem(scopedLegalStateKey(ACTIVE_LEGAL_CASE_STORAGE)) || '';
}

export function getLegalConsultationCaseId(): string {
  if (!canUseStorage()) return '';
  return localStorage.getItem(scopedLegalStateKey(LEGAL_CONSULTATION_CASE_STORAGE)) || '';
}

export function setActiveLegalCaseId(caseId: string) {
  if (!canUseStorage()) return;
  const key = scopedLegalStateKey(ACTIVE_LEGAL_CASE_STORAGE);
  if (caseId) localStorage.setItem(key, caseId);
  else localStorage.removeItem(key);
  emitLegalCasesChanged();
}

export function setLegalConsultationCaseId(caseId: string) {
  if (!canUseStorage()) return;
  const key = scopedLegalStateKey(LEGAL_CONSULTATION_CASE_STORAGE);
  if (caseId) localStorage.setItem(key, caseId);
  else localStorage.removeItem(key);
}

export function clearLegalConsultationCaseId() {
  if (!canUseStorage()) return;
  localStorage.removeItem(scopedLegalStateKey(LEGAL_CONSULTATION_CASE_STORAGE));
}

export function writeLegalCaseFiles(cases: LegalCaseFile[], activeCaseId?: string) {
  if (!canUseStorage()) return;
  if (currentLegalStorageScope().domain === 'work') return;
  localStorage.setItem(LEGAL_CASES_STORAGE, JSON.stringify(cases));
  if (typeof activeCaseId === 'string') {
    if (activeCaseId) localStorage.setItem(ACTIVE_LEGAL_CASE_STORAGE, activeCaseId);
    else localStorage.removeItem(ACTIVE_LEGAL_CASE_STORAGE);
  }
  emitLegalCasesChanged();
}

export function getLegalCaseById(caseId: string): LegalCaseFile | null {
  if (!caseId) return null;
  return readLegalCaseFiles().find(item => item.id === caseId) || null;
}

export function updateLegalCase(caseId: string, patch: Partial<LegalCaseFile>): LegalCaseFile | null {
  const cases = readLegalCaseFiles();
  let updated: LegalCaseFile | null = null;
  const next = cases.map(item => {
    if (item.id !== caseId) return item;
    updated = normalizeCaseFile({ ...item, ...patch, removedMaterialIds: [...new Set([...(item.removedMaterialIds || []), ...(patch.removedMaterialIds || [])])], updatedAt: new Date().toISOString() })!;
    return updated;
  });
  if (!updated) return null;
  writeLegalCaseFiles(next, caseId);
  return updated;
}

export function addLegalCaseMaterial(
  caseId: string,
  material: Omit<LegalCaseMaterial, 'id' | 'createdAt'> & Partial<Pick<LegalCaseMaterial, 'id' | 'createdAt'>>,
): LegalCaseMaterial | null {
  const current = getLegalCaseById(caseId);
  if (!current) return null;
  const nextMaterial: LegalCaseMaterial = {
    id: material.id || newId('mat'),
    type: material.type,
    title: material.title,
    createdAt: material.createdAt || new Date().toISOString(),
    content: material.content,
    fileName: material.fileName,
    localPath: material.localPath,
    createdBy: material.createdBy,
    source: material.source || 'manual',
  };
  updateLegalCase(caseId, { materials: [nextMaterial, ...(current.materials || [])] });
  return nextMaterial;
}

export function getLegalCaseLabel(caseFile: LegalCaseFile | null): string {
  if (!caseFile) return '';
  return caseFile.title || caseFile.party || caseFile.caseNumber || chinaLegalCopy().unnamedCase;
}

export function getActiveLegalCase(): LegalCaseFile | null {
  const cases = readLegalCaseFiles();
  const activeId = getActiveLegalCaseId();
  return cases.find(item => item.id === activeId) || cases[0] || null;
}

export function mergePersonalLegalCaseRuntimeSnapshot(snapshot: unknown): LegalCaseFile | null {
  if (currentLegalStorageScope().domain !== 'personal') return null;
  const incoming = normalizeCaseFile(snapshot);
  if (!incoming) return null;
  const cases = readLegalCaseFiles();
  const current = cases.find(item => item.id === incoming.id) || null;
  if (!current) {
    writeLegalCaseFiles([incoming, ...cases]);
    return incoming;
  }

  const runtimeIsNewer = incoming.updatedAt >= current.updatedAt;
  const removedMaterialIds = [...new Set([...(current.removedMaterialIds || []), ...(incoming.removedMaterialIds || [])])];
  const currentById = new Map(current.materials.map(material => [material.id, material]));
  const runtimeById = new Map(incoming.materials.map(material => [material.id, material]));
  const mergedMaterials = [
    ...incoming.materials.map(material => {
      const existing = currentById.get(material.id);
      if (!existing) return material;
      if (!runtimeIsNewer && existing.source !== 'tool') return existing;
      return {
        ...existing,
        ...material,
        fileName: material.fileName || existing.fileName,
        localPath: material.localPath || existing.localPath,
      };
    }),
    ...current.materials.filter(material => !runtimeById.has(material.id)),
  ].filter(material => !removedMaterialIds.includes(material.id));
  // A reply from another case must not switch the user's current selection.
  // Preserve edits made locally after this runtime snapshot was produced.
  const merged = { ...current, ...(runtimeIsNewer ? incoming : {}),
    factDate: runtimeIsNewer && Object.hasOwn(snapshot as object, 'factDate') ? incoming.factDate : current.factDate,
    materials: mergedMaterials, removedMaterialIds,
    workflowRuns: (runtimeIsNewer ? incoming.workflowRuns : current.workflowRuns)?.filter(run => !run.materialIds.some(id => removedMaterialIds.includes(id))) };
  if (JSON.stringify(merged) === JSON.stringify(current)) return current;
  writeLegalCaseFiles(cases.map(item => item.id === current.id ? merged : item));
  return merged;
}

export async function syncPersonalLegalCaseToRuntime(caseFile: LegalCaseFile, signal?: AbortSignal): Promise<void> {
  const data = await apiJson('/api/legal/client-case-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ case: caseFile, activate: getActiveLegalCaseId() === caseFile.id }),
  });
  signal?.throwIfAborted();
  if (data?.case) mergePersonalLegalCaseRuntimeSnapshot(data.case);
}
export async function deletePersonalLegalCaseFromRuntime(caseId: string, signal?: AbortSignal): Promise<void> {
  if (caseId) await apiJson('/api/legal/client-case-sync/' + encodeURIComponent(caseId), { method: 'DELETE', signal });
}

export function emitLegalCasesChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(LEGAL_CASES_CHANGED_EVENT, {
    detail: {
      cases: readLegalCaseFiles(),
      activeCaseId: getActiveLegalCaseId(),
      consultationCaseId: getLegalConsultationCaseId(),
    },
  }));
}
