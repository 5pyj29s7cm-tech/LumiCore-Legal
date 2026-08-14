import crypto from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';
import { PRODUCT_VARIANT } from '../../shared/product_variant';
import { normalizeIndustryProductLine, type IndustryProductLine } from './workflow_contracts';

export interface IndustryWorkspaceScope { userId: string; domain: 'personal' | 'work'; orgId: string }
export interface IndustryWorkspaceContext {
  id: string; productLine: IndustryProductLine; scopeId: string; ownerUserId: string;
  kind: 'store' | 'case' | 'entity'; name: string; attributes: Record<string, string>;
  createdAt: string; updatedAt: string;
}
const RECORDS_KEY = 'industry_workspace_contexts_v1';
const ACTIVE_KEY = 'industry_workspace_active_v1';
const FIELD_ALLOWLIST: Record<'ecommerce' | 'legal' | 'finance', string[]> = {
  ecommerce: ['platform', 'storeId', 'accountLabel', 'reportingPeriod', 'currency', 'timezone'],
  legal: ['caseId', 'caseName', 'caseNumber', 'clientName', 'court', 'stage'],
  finance: ['entityName', 'taxpayerId', 'jurisdiction', 'taxpayerType', 'accountingPeriod', 'currency', 'accountingBasis'],
};
function productLine(): 'ecommerce' | 'legal' | 'finance' { const line = normalizeIndustryProductLine(PRODUCT_VARIANT.productLine); if (line !== 'ecommerce' && line !== 'legal' && line !== 'finance') throw new Error('Industry workspace context is not available in this edition.'); return line }
function kindFor(line: 'ecommerce' | 'legal' | 'finance'): IndustryWorkspaceContext['kind'] { return line === 'ecommerce' ? 'store' : line === 'legal' ? 'case' : 'entity' }
function scopeId(scope: IndustryWorkspaceScope): string { const userId = String(scope.userId || '').trim(); if (!userId) throw new Error('userId is required'); return scope.domain === 'work' ? `work:${String(scope.orgId || '').trim() || 'unbound'}` : `personal:${userId}` }
function selectionKey(scope: IndustryWorkspaceScope, line = productLine()): string { return `${line}:${scopeId(scope)}:${String(scope.userId || '').trim()}` }
function settingObject(db: any, key: string): Record<string, any> { if (!Array.isArray(db.settings)) db.settings = []; const value = db.settings.find((row: any) => row.key === key)?.value; if (!value) return {}; try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { return {} } }
function saveSettingObject(db: any, key: string, value: Record<string, any>): void { const serialized = JSON.stringify(value); const row = db.settings.find((candidate: any) => candidate.key === key); if (row) row.value = serialized; else db.settings.push({ key, value: serialized }) }
function records(db: any): IndustryWorkspaceContext[] { const parsed = settingObject(db, RECORDS_KEY); return Array.isArray(parsed.items) ? parsed.items : [] }
function clean(value: unknown, limit = 300): string { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit) }
function clone(record: IndustryWorkspaceContext): IndustryWorkspaceContext { return { ...record, attributes: { ...record.attributes } } }
export function listIndustryWorkspaceContexts(scope: IndustryWorkspaceScope): IndustryWorkspaceContext[] { const line = productLine(); const selectedScope = scopeId(scope); return records(readDB()).filter(record => record.productLine === line && record.scopeId === selectedScope).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(clone) }
export function getActiveIndustryWorkspaceContext(scope: IndustryWorkspaceScope): IndustryWorkspaceContext | null { const db = readDB(); const id = clean(settingObject(db, ACTIVE_KEY)[selectionKey(scope)], 200); if (!id) return null; const selectedScope = scopeId(scope); const line = productLine(); const record = records(db).find(item => item.id === id && item.scopeId === selectedScope && item.productLine === line); return record ? clone(record) : null }
export function bindIndustryWorkspaceContext(scope: IndustryWorkspaceScope, input: { id?: unknown; name?: unknown; attributes?: Record<string, unknown> }): IndustryWorkspaceContext {
  const db = readDB(); const line = productLine(); const selectedScope = scopeId(scope); const all = records(db); const requestedId = clean(input.id, 200);
  let record = requestedId ? all.find(item => item.id === requestedId && item.scopeId === selectedScope && item.productLine === line) : undefined;
  const attributes = Object.fromEntries(FIELD_ALLOWLIST[line].map(field => [field, clean(input.attributes?.[field], 500)] as const).filter(([, value]) => value));
  const fallbackName = line === 'ecommerce' ? attributes.accountLabel || attributes.storeId : line === 'legal' ? attributes.caseName || attributes.caseNumber || attributes.caseId : attributes.entityName || attributes.taxpayerId;
  const name = clean(input.name, 160) || fallbackName; if (!record && !name) throw new Error('A workspace name or edition-specific identity is required.'); const now = new Date().toISOString();
  if (record) { record.name = name || record.name; record.attributes = { ...record.attributes, ...attributes }; record.updatedAt = now } else { record = { id: `industry_subject_${crypto.randomUUID()}`, productLine: line, scopeId: selectedScope, ownerUserId: String(scope.userId || '').trim(), kind: kindFor(line), name, attributes, createdAt: now, updatedAt: now }; all.push(record) }
  saveSettingObject(db, RECORDS_KEY, { schemaVersion: 1, items: all }); const active = settingObject(db, ACTIVE_KEY); active[selectionKey(scope, line)] = record.id; saveSettingObject(db, ACTIVE_KEY, active); writeDB(db); return clone(record);
}
export function selectIndustryWorkspaceContext(scope: IndustryWorkspaceScope, id: unknown): IndustryWorkspaceContext { return bindIndustryWorkspaceContext(scope, { id }) }
export function workflowWorkspaceContext(scope: IndustryWorkspaceScope): Record<string, unknown> | null { const active = getActiveIndustryWorkspaceContext(scope); return active ? { id: active.id, kind: active.kind, name: active.name, attributes: active.attributes, updatedAt: active.updatedAt } : null }
