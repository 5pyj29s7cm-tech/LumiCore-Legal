import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDataPath } from '../config/data_path';
import * as EDB from './db';
import {
  assertOrganizationResourceAccess,
  authorizeOrganizationResource,
  getOrganizationResourcePolicy,
  removeOrganizationResourcePolicy,
  type OrganizationResourcePermission,
} from './resource_acl';
import {
  evaluateLegalCaseWorkflow,
  type LegalCaseWorkflowEvaluation,
  type LegalCaseWorkflowOptions,
  type LegalCaseWorkflowStep,
  type LegalCaseWorkflowStepState,
} from '../../shared/legal_case_workflow';

export type {
  LegalCaseWorkflowEvaluation,
  LegalCaseWorkflowOptions,
  LegalCaseWorkflowStep,
  LegalCaseWorkflowStepState,
} from '../../shared/legal_case_workflow';

export type LegalCaseStage = 'consultation' | 'filing' | 'trial' | 'judgment' | 'enforcement' | 'closed';
export type LegalCaseMaterialType = 'consultation' | 'evidence' | 'pleading' | 'judgment' | 'contract' | 'note';

export interface OrgLegalCaseMaterial {
  id: string;
  type: LegalCaseMaterialType;
  title: string;
  content: string;
  fileName?: string;
  localPath?: string;
  source: 'manual' | 'meeting' | 'feishu' | 'wecom' | 'wechat' | 'tool' | 'import';
  createdBy: string;
  createdAt: string;
}

export interface OrgLegalCaseFile {
  id: string;
  orgId: string;
  title: string;
  caseNumber: string;
  party: string;
  cause: string;
  court: string;
  judge: string;
  stage: LegalCaseStage;
  hearingDate: string;
  judgmentDate: string;
  appealDeadline: string;
  enforcementDeadline: string;
  notes: string;
  materials: OrgLegalCaseMaterial[];
  assetTraceWorkflow?: Record<string, unknown>;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

const STORE_PATH = getDataPath(path.join('org', 'legal_cases.json'));

interface StoreShape {
  cases: OrgLegalCaseFile[];
}

function now() {
  return new Date().toISOString();
}

function readStore(): StoreShape {
  try {
    if (!fs.existsSync(STORE_PATH)) return { cases: [] };
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { cases: Array.isArray(parsed?.cases) ? parsed.cases : [] };
  } catch {
    return { cases: [] };
  }
}

function writeStore(store: StoreShape) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function normalizeSnapshotId(value: unknown): string {
  const normalized = normalizeText(value).slice(0, 200);
  if (!normalized || !/^[a-zA-Z0-9_.:@-]+$/.test(normalized)) {
    throw new Error('A valid client case id is required.');
  }
  return normalized;
}

function normalizeSnapshotMaterial(
  value: Partial<OrgLegalCaseMaterial>,
  userId: string,
): OrgLegalCaseMaterial {
  const type = ['consultation', 'evidence', 'pleading', 'judgment', 'contract', 'note'].includes(String(value.type || ''))
    ? value.type as LegalCaseMaterialType
    : 'note';
  const source = ['manual', 'meeting', 'feishu', 'wecom', 'wechat', 'tool', 'import'].includes(String(value.source || ''))
    ? value.source as OrgLegalCaseMaterial['source']
    : 'manual';
  return {
    id: normalizeText(value.id) || randomUUID(),
    type,
    title: normalizeText(value.title) || '案件材料',
    content: normalizeText(value.content),
    fileName: normalizeText(value.fileName) || undefined,
    localPath: normalizeText(value.localPath) || undefined,
    source,
    createdBy: normalizeText(value.createdBy) || userId,
    createdAt: normalizeText(value.createdAt) || now(),
  };
}

/**
 * Mirrors a client-owned case into the server case ledger without creating a
 * second identity. Chat, voice and direct legal tools can then resolve the
 * exact case selected in the client instead of searching the source tree.
 */
export function upsertCaseSnapshot(
  orgId: string,
  userId: string,
  input: Partial<OrgLegalCaseFile> & { id: string },
): OrgLegalCaseFile {
  const store = readStore();
  const caseId = normalizeSnapshotId(input.id);
  const index = store.cases.findIndex(item => item.orgId === orgId && item.id === caseId);
  const current = index >= 0 ? store.cases[index] : null;
  if (current && getOrganizationResourcePolicy(orgId, 'legal_case', caseId).policy) {
    assertOrganizationResourceAccess({
      orgId,
      actorUserId: userId,
      resourceType: 'legal_case',
      resourceId: caseId,
      permission: 'write',
      ownerUserId: current.createdBy,
    });
  }
  const ts = now();
  const stage = ['consultation', 'filing', 'trial', 'judgment', 'enforcement', 'closed'].includes(String(input.stage || ''))
    ? input.stage as LegalCaseStage
    : current?.stage || 'consultation';
  const materials = Array.isArray(input.materials)
    ? input.materials.map(material => normalizeSnapshotMaterial(material, userId))
    : current?.materials || [];
  const caseFile: OrgLegalCaseFile = {
    id: caseId,
    orgId,
    title: normalizeText(input.title) || current?.title || '未命名案件',
    caseNumber: normalizeText(input.caseNumber),
    party: normalizeText(input.party),
    cause: normalizeText(input.cause),
    court: normalizeText(input.court),
    judge: normalizeText(input.judge),
    stage,
    hearingDate: normalizeText(input.hearingDate),
    judgmentDate: normalizeText(input.judgmentDate),
    appealDeadline: normalizeText(input.appealDeadline),
    enforcementDeadline: normalizeText(input.enforcementDeadline),
    notes: normalizeText(input.notes),
    materials,
    assetTraceWorkflow: input.assetTraceWorkflow && typeof input.assetTraceWorkflow === 'object'
      ? input.assetTraceWorkflow
      : current?.assetTraceWorkflow,
    createdBy: current?.createdBy || userId,
    updatedBy: userId,
    createdAt: normalizeText(input.createdAt) || current?.createdAt || ts,
    updatedAt: ts,
  };
  if (index >= 0) store.cases[index] = caseFile;
  else store.cases.unshift(caseFile);
  writeStore(store);
  EDB.logAudit({
    orgId,
    userId,
    action: current ? 'legal_case.client_snapshot.update' : 'legal_case.client_snapshot.create',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: { title: caseFile.title, caseNumber: caseFile.caseNumber, materialCount: materials.length },
  });
  return caseFile;
}

export function evaluateCaseWorkflow(
  caseFile: Partial<OrgLegalCaseFile>,
  options: LegalCaseWorkflowOptions = {},
): LegalCaseWorkflowEvaluation {
  return evaluateLegalCaseWorkflow(caseFile, options);
}

function normalizeLegalDateMatch(match?: RegExpMatchArray | null): string {
  if (!match) return '';
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
    + (match[4] ? ` ${match[4].padStart(2, '0')}:${(match[5] || '00').padStart(2, '0')}` : '');
}

function extractHearingDate(text: string): string {
  const datePattern = /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s*(\d{1,2})[:：时](\d{1,2})?分?)?/;
  const hearingWindow = text.match(new RegExp(`(?:开庭|庭审|审理)[^\n。；;]{0,80}${datePattern.source}|${datePattern.source}[^\n。；;]{0,40}(?:开庭|庭审|审理)`));
  if (hearingWindow) {
    const nested = hearingWindow[0].match(datePattern);
    if (nested) return normalizeLegalDateMatch(nested);
  }
  return normalizeLegalDateMatch(text.match(datePattern));
}

export function extractLegalCaseHints(text: string): Partial<Pick<OrgLegalCaseFile, 'caseNumber' | 'court' | 'hearingDate' | 'judgmentDate' | 'cause'>> {
  const hints: Partial<Pick<OrgLegalCaseFile, 'caseNumber' | 'court' | 'hearingDate' | 'judgmentDate' | 'cause'>> = {};
  const caseNumber = text.match(/[（(]\d{4}[）)][^，。；;\n]{2,80}(?:号|字第?\d+号?)/)?.[0] || '';
  const court = text.match(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/)?.[0] || '';
  const hearingDate = extractHearingDate(text);
  const cause = text.match(/案由[：:\s]+([^\n，。；;]{2,40})/)?.[1] || '';
  if (caseNumber) hints.caseNumber = caseNumber;
  if (court) hints.court = court;
  if (hearingDate) hints.hearingDate = hearingDate;
  if (cause) hints.cause = cause.trim();
  return hints;
}

function canAccessCase(
  caseFile: OrgLegalCaseFile,
  actorUserId?: string,
  permission: OrganizationResourcePermission = 'read',
): boolean {
  const { policy } = getOrganizationResourcePolicy(caseFile.orgId, 'legal_case', caseFile.id);
  if (!policy) return true;
  if (!actorUserId) return false;
  return authorizeOrganizationResource({
    orgId: caseFile.orgId,
    actorUserId,
    resourceType: 'legal_case',
    resourceId: caseFile.id,
    permission,
    ownerUserId: caseFile.createdBy,
  }).allowed;
}

export function listCases(orgId: string, query = '', limit = 50, actorUserId?: string): OrgLegalCaseFile[] {
  const q = query.trim().toLowerCase();
  let cases = readStore().cases.filter(item => item.orgId === orgId && canAccessCase(item, actorUserId, 'read'));
  if (q) {
    cases = cases.filter(item => {
      const haystack = [
        item.title,
        item.caseNumber,
        item.party,
        item.cause,
        item.court,
        item.judge,
        item.notes,
        ...(item.materials || []).map(mat => `${mat.title}\n${mat.content.slice(0, 2000)}`),
      ].join('\n').toLowerCase();
      return haystack.includes(q);
    });
  }
  return cases
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

export function getCase(
  orgId: string,
  caseId: string,
  actorUserId?: string,
  permission: OrganizationResourcePermission = 'read',
): OrgLegalCaseFile | null {
  const caseFile = readStore().cases.find(item => item.orgId === orgId && item.id === caseId) || null;
  return caseFile && canAccessCase(caseFile, actorUserId, permission) ? caseFile : null;
}

export function createCase(orgId: string, userId: string, input: Partial<OrgLegalCaseFile>): OrgLegalCaseFile {
  const store = readStore();
  const ts = now();
  const caseFile: OrgLegalCaseFile = {
    id: randomUUID(),
    orgId,
    title: normalizeText(input.title) || '未命名案件',
    caseNumber: normalizeText(input.caseNumber),
    party: normalizeText(input.party),
    cause: normalizeText(input.cause),
    court: normalizeText(input.court),
    judge: normalizeText(input.judge),
    stage: (input.stage as LegalCaseStage) || 'consultation',
    hearingDate: normalizeText(input.hearingDate),
    judgmentDate: normalizeText(input.judgmentDate),
    appealDeadline: normalizeText(input.appealDeadline),
    enforcementDeadline: normalizeText(input.enforcementDeadline),
    notes: normalizeText(input.notes),
    materials: Array.isArray(input.materials) ? input.materials : [],
    assetTraceWorkflow: input.assetTraceWorkflow && typeof input.assetTraceWorkflow === 'object'
      ? input.assetTraceWorkflow
      : undefined,
    createdBy: userId,
    updatedBy: userId,
    createdAt: ts,
    updatedAt: ts,
  };
  store.cases.unshift(caseFile);
  writeStore(store);
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.create',
    resourceType: 'legal_case',
    resourceId: caseFile.id,
    details: { title: caseFile.title, caseNumber: caseFile.caseNumber },
  });
  return caseFile;
}

export function updateCase(orgId: string, userId: string, caseId: string, patch: Partial<OrgLegalCaseFile>): OrgLegalCaseFile | null {
  const store = readStore();
  const idx = store.cases.findIndex(item => item.orgId === orgId && item.id === caseId);
  if (idx < 0) return null;
  const current = store.cases[idx];
  if (getOrganizationResourcePolicy(orgId, 'legal_case', caseId).policy) {
    assertOrganizationResourceAccess({
      orgId, actorUserId: userId, resourceType: 'legal_case', resourceId: caseId,
      permission: 'write', ownerUserId: current.createdBy,
    });
  }
  const next: OrgLegalCaseFile = {
    ...current,
    ...patch,
    id: current.id,
    orgId: current.orgId,
    materials: patch.materials || current.materials || [],
    updatedBy: userId,
    updatedAt: now(),
  };
  store.cases[idx] = next;
  writeStore(store);
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.update',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: { fields: Object.keys(patch) },
  });
  return next;
}

export function deleteCase(orgId: string, userId: string, caseId: string): OrgLegalCaseFile | null {
  const store = readStore();
  const index = store.cases.findIndex(item => item.orgId === orgId && item.id === caseId);
  if (index < 0) return null;
  const current = store.cases[index];
  if (getOrganizationResourcePolicy(orgId, 'legal_case', caseId).policy) {
    assertOrganizationResourceAccess({
      orgId, actorUserId: userId, resourceType: 'legal_case', resourceId: caseId,
      permission: 'write', ownerUserId: current.createdBy,
    });
  }
  const [deleted] = store.cases.splice(index, 1);
  writeStore(store);
  removeOrganizationResourcePolicy({
    orgId,
    actorUserId: userId,
    resourceType: 'legal_case',
    resourceId: caseId,
  });
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.delete',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: {
      title: deleted.title,
      caseNumber: deleted.caseNumber,
      materialCount: deleted.materials?.length || 0,
    },
  });
  return deleted;
}

export function addMaterial(
  orgId: string,
  userId: string,
  caseId: string,
  material: Omit<OrgLegalCaseMaterial, 'id' | 'createdBy' | 'createdAt'>,
): OrgLegalCaseMaterial | null {
  const current = getCase(orgId, caseId, userId, 'write');
  if (!current) return null;
  const nextMaterial: OrgLegalCaseMaterial = {
    id: randomUUID(),
    type: material.type,
    title: normalizeText(material.title) || '案件材料',
    content: normalizeText(material.content),
    fileName: material.fileName,
    localPath: material.localPath,
    source: material.source,
    createdBy: userId,
    createdAt: now(),
  };
  const nextMaterials = [nextMaterial, ...(current.materials || [])];
  updateCase(orgId, userId, caseId, {
    materials: nextMaterials,
    notes: [current.notes, material.content ? `【材料归档】${nextMaterial.title}` : ''].filter(Boolean).join('\n'),
  });
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.material.add',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: { title: nextMaterial.title, source: nextMaterial.source, fileName: nextMaterial.fileName },
  });
  return nextMaterial;
}

export function createCaseFromRemoteMaterial(params: {
  orgId: string;
  userId: string;
  title: string;
  text: string;
  fileName?: string;
  localPath?: string;
  source?: OrgLegalCaseMaterial['source'];
}): OrgLegalCaseFile {
  const hints = extractLegalCaseHints(params.text);
  const caseFile = createCase(params.orgId, params.userId, {
    title: params.title || hints.caseNumber || params.fileName || '远程案件材料',
    caseNumber: hints.caseNumber || '',
    court: hints.court || '',
    cause: hints.cause || '',
    hearingDate: hints.hearingDate || '',
    notes: params.text.slice(0, 4000),
    stage: 'consultation',
  });
  addMaterial(params.orgId, params.userId, caseFile.id, {
    type: 'evidence',
    title: params.fileName || params.title || '远程案件材料',
    content: params.text,
    fileName: params.fileName,
    localPath: params.localPath,
    source: params.source || 'feishu',
  });
  return getCase(params.orgId, caseFile.id) || caseFile;
}
