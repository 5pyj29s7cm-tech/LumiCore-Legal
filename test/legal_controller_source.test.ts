import './helpers';
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { mcpManager } from '../server/mcp/client';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { createCase, getCase, legalWorkspaceNamespace } from '../server/org/legal_cases';
import * as EDB from '../server/org/db';

const registry = new ToolRegistry();
const userId = 'controller-source-fixture-owner';
const syntheticCredential = 'offline-controller-source-credential';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const llmGetters = { getDeepSeek: vi.fn(() => { throw new Error('No model call allowed'); }), getOpenAI: vi.fn(() => { throw new Error('No model call allowed'); }) };
const context = { userId, domain: 'personal', authenticated: true, authRole: 'user', llmGetters } as any;
const keys = ['QICHACHA_API_KEY', 'QICHACHA_APP_KEY', 'QICHACHA_SECRET_KEY', 'QICHACHA_BASE_URL', 'TIANYANCHA_API_KEY', 'QIXINBAO_API_KEY'];
beforeAll(async () => { await initDatabase(); registerLegalTools(registry); });
beforeEach(() => {
  for (const key of keys) vi.stubEnv(key, '');
  vi.stubEnv('QICHACHA_API_KEY', syntheticCredential);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No external HTTP in offline controller fixture'); }));
  vi.spyOn(mcpManager, 'callToolForServer');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-04-07T02:03:04.000Z'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(llmGetters.getDeepSeek).not.toHaveBeenCalled();
  expect(llmGetters.getOpenAI).not.toHaveBeenCalled();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
const run = (name: string, extra: Record<string, unknown> = {}, executionContext = context) => executeToolCall({
  registry, name: 'legal_company_database_lookup', arguments: { name, queryType: 'controller', sourceIds: ['qichacha'], persistCase: false, confirmedForKb: false, ...extra }, context: executionContext,
});
function makeOriginal(name: string, proportion: string) {
  return JSON.stringify({ 企业名称: name, 实际控制人: [{ 名称: '虚构来源控制人', 总持股比例: proportion, 说明: '提供商聚合终值，离线合成材料' }],
    原文附注: 'CONTROLLER-FULL-RAW-HEAD ' + '原始来源说明及限制条件。'.repeat(250) + ' CONTROLLER-FULL-RAW-TAIL' });
}

describe('controller lookup uses the existing explicit QCC source instead of registration recursion', () => {
  it.each([
    ['虚构杏川研发有限公司', '0.003708%'],
    ['虚构岚石贸易股份有限公司', '31.007009%'],
  ])('preserves the exact controller original and decimal precision for %s', async (name, proportion) => {
    const original = makeOriginal(name, proportion);
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(original);
    const item = createCase(legalWorkspaceNamespace(userId), userId, { title: '已有控制人调查原件', notes: 'USER FACTS UNCHANGED' });
    const before = JSON.stringify(getCase(item.orgId, item.id, userId));
    const articlesBefore = JSON.stringify(EDB.listKbArticles(item.orgId));
    const result = await run(name, { caseId: item.id });
    expect(result.receipt).toMatchObject({ ok: true, status: 'observed', persisted: false, changedCaseIds: [], articleIds: [], artifacts: [],
      sourceResults: [{ subject: name, queryType: 'controller', sourceTool: 'get_actual_controller', sourceName: '企查查官方 MCP',
        sourceEndpoint: 'https://agent.qcc.com/mcp/company/stream', queriedAt: '2026-04-07T02:03:04.000Z', sourceTextSha256: sha(original) }] });
    expect(result.result).toContain(original);
    expect(result.result).toContain(proportion);
    expect(result.result).toContain('CONTROLLER-FULL-RAW-TAIL');
    expect(result.result).toContain('- 工具：get_actual_controller');
    expect(result.result).toContain('- 查询端点：https://agent.qcc.com/mcp/company/stream');
    expect(result.result).toContain('- 查询时间：2026-04-07T02:03:04.000Z');
    expect(result.result).not.toMatch(/间接持股 ~|get_company_registration_info/);
    expect(result.result).not.toContain(syntheticCredential);
    expect(mcpManager.callToolForServer).toHaveBeenCalledExactlyOnceWith('qcc-company', 'get_actual_controller', { searchKey: name }, expect.any(Object));
    expect(JSON.stringify(getCase(item.orgId, item.id, userId))).toBe(before);
    expect(JSON.stringify(EDB.listKbArticles(item.orgId))).toBe(articlesBefore);
  });

  it('removes the obsolete tool instead of retaining an executable alias', () => {
    expect(registry.get('legal_equity_penetration')).toBeUndefined();
    expect(registry.get('legal_company_database_lookup')).toBeDefined();
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
  });

  it('does not silently substitute registration when controller credentials are missing', async () => {
    vi.stubEnv('QICHACHA_API_KEY', '');
    const result = await run('虚构缺少来源企业');
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false, sourceResults: [] });
    expect(result.terminalVerification?.status).not.toBe('verified');
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', '[]'],
    ['empty', '{}'],
    ['response', '<html>not a controller receipt</html>'],
    ['authorization', JSON.stringify({ code: 403, message: syntheticCredential })],
  ])('keeps a %s controller response partial without creating evidence', async (reason, original) => {
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(original);
    const item = createCase(legalWorkspaceNamespace(userId), userId, { title: '失败来源保留原件', notes: 'PRESERVE USER NOTE' });
    const before = getCase(item.orgId, item.id, userId)!;
    const articlesBefore = JSON.stringify(EDB.listKbArticles(item.orgId));
    const result = await run('虚构失败控制人企业', { caseId: item.id, persistCase: true, confirmedForKb: true });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false, sourceResults: [], changedCaseIds: [], articleIds: [] });
    expect(result.result).toContain('[QCC_' + reason.toUpperCase() + ']');
    expect(result.result).not.toContain(syntheticCredential);
    const after = getCase(item.orgId, item.id, userId)!;
    expect(after.materials).toEqual(before.materials); expect(after.notes).toBe(before.notes);
    expect(JSON.stringify(EDB.listKbArticles(item.orgId))).toBe(articlesBefore);
    expect(mcpManager.callToolForServer).toHaveBeenCalledExactlyOnceWith('qcc-company', 'get_actual_controller', { searchKey: '虚构失败控制人企业' }, expect.any(Object));
  });

  it('preserves a provider failure without falling back to registration or another source', async () => {
    vi.mocked(mcpManager.callToolForServer).mockRejectedValueOnce(new Error('HTTP 403 ' + syntheticCredential));
    const result = await run('虚构连接失败企业');
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', sourceResults: [] });
    expect(result.result).toContain('[QCC_AUTHORIZATION]');
    expect(result.result).not.toContain(syntheticCredential);
    expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
  });

  it('honors local-only before controller dispatch', async () => {
    const result = await run('虚构本地策略企业', {}, { ...context, dataRoutingPolicy: 'local_only' });
    expect(result.terminalVerification?.status).not.toBe('verified');
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
  });

  it('rejects pre-cancelled and late controller receipts without material writes', async () => {
    const item = createCase(legalWorkspaceNamespace(userId), userId, { title: '取消控制人调查', notes: 'KEEP BEFORE CANCEL' });
    const before = getCase(item.orgId, item.id, userId)!;
    const cancelledController = new AbortController(); cancelledController.abort();
    const cancelled = await run('虚构取消企业', { caseId: item.id, persistCase: true }, { ...context, executionSignal: cancelledController.signal });
    expect(cancelled.terminalVerification?.status).not.toBe('verified');
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
    const liveController = new AbortController(); let release!: (text: string) => void;
    vi.mocked(mcpManager.callToolForServer).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = run('虚构迟到企业', { caseId: item.id, persistCase: true }, { ...context, executionSignal: liveController.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    liveController.abort(); release(makeOriginal('虚构迟到企业', '0.0023%'));
    const late = await pending;
    expect(late.terminalVerification?.status).not.toBe('verified');
    const after = getCase(item.orgId, item.id, userId)!;
    expect(after.materials).toEqual(before.materials); expect(after.notes).toBe(before.notes);
    expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
  });
});
