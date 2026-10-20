import { makeApp } from './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import * as Cases from '../server/org/legal_cases';
let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry();
beforeAll(async () => { app = await makeApp(); registerLegalTools(registry); });
afterAll(() => app.cleanup());
beforeEach(() => { vi.stubEnv('TENDER_DATA_API_KEY', ''); vi.stubEnv('TENDER_DATA_BASE_URL', ''); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No external fixture network'); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['unconfigured', 'empty', 'http-failed'])('does not archive %s tender results as observed sources', async mode => {
  const userId = 'tender-boundary-' + randomUUID(), orgId = Cases.legalWorkspaceNamespace(userId);
  const item = Cases.createCase(orgId, userId, { title: 'Synthetic original-preservation case' });
  Cases.addMaterial(orgId, userId, item.id, { type: 'evidence', source: 'manual', title: 'Original', content: 'Unverified original source TENDER-TAIL-828.' });
  const before = JSON.stringify(Cases.getCase(orgId, item.id, userId)!.materials);
  if (mode !== 'unconfigured') { vi.stubEnv('TENDER_DATA_API_KEY', 'synthetic-tender-test'); vi.stubEnv('TENDER_DATA_BASE_URL', 'https://tender.invalid/search'); vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: mode === 'empty' ? 200 : 401 })); }
  const result = await executeToolCall({ registry, name: 'legal_search_tender_projects', arguments: { keyword: 'No observed project ' + randomUUID(), caseId: item.id, persistCase: true }, context: { userId, domain: 'personal', source: 'legal-direct-tool', authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local' } as any });
  expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false, changedCaseIds: [] });
  expect(result.terminalVerification?.status).toBe('failed'); expect(result.result).not.toContain('案件空间：已归档');
  expect(JSON.stringify(Cases.getCase(orgId, item.id, userId)!.materials)).toBe(before);
  expect(fetch).toHaveBeenCalledTimes(mode === 'unconfigured' ? 0 : 1);
});
