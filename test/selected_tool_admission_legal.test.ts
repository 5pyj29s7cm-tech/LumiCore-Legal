import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase, querySQL, readDB } from '../db_layer';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { getMessages, getOrCreateActiveConversation } from '../server/conversation/manager';
import { runLumiEntryTurn, type ExecutedLumiTurn, type LumiEntryTurnInput } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { createTurnConfirmation } from '../server/tools/turn_confirmation';
import { getPendingConfirmation, type PendingToolConfirmation } from '../server/tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import { shouldAllowLocalFileWriteForTurn } from '../server/socket/chat/attachments';
import type { NormalizedLLMResponse, ToolContext } from '../server/tools/types';

const provider = vi.hoisted(() => vi.fn());
// Only the normalized provider boundary is replaced. Entry admission, the
// tool loop, registry handlers, confirmation owner and SQLite remain real.
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: (...args: any[]) => provider(...args),
  makeLLMCallStreaming: (...args: any[]) => provider(...args),
}));
const observed: Record<string, unknown>[] = [];
beforeAll(async () => { await initDatabase(); await ensurePendingConfirmationPersistenceInitialized(); });
beforeEach(() => {
  provider.mockReset();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('LEGAL_SELECTED_ENTRY_NETWORK_FORBIDDEN'));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
afterAll(() => {
  if (process.env.LUMI_SELECTED_ENTRY_EVIDENCE_DIR) fs.writeFileSync(
    path.join(process.env.LUMI_SELECTED_ENTRY_EVIDENCE_DIR, 'observed-terminal-shapes.json'),
    JSON.stringify({ offline: true, dataRoot: process.env.LUMI_DATA_DIR, observed }, null, 2) + '\n');
});

function fixture(instruction: string | ((file: string) => string)) {
  const userId = 'legal-selected-' + randomUUID(), requestId = randomUUID();
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const identity = { userId, requestId, conversationId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
  const filePath = path.join(String(process.env.LUMI_DATA_DIR), 'legal-original-' + requestId + '.txt');
  const original = 'OFFLINE LEGAL SOURCE\n甲方称已付款，真实性待核验。\n未提交验收条款不代表没有约定。\n完整尾句 LEGAL_SOURCE_END_71933';
  fs.writeFileSync(filePath, original);
  const text = typeof instruction === 'function' ? instruction(filePath) : instruction;
  const registry = new ToolRegistry(); registerFileOpsTools(registry);
  const read = registry.get('read_file')!, write = registry.get('write_file')!;
  const readHandler = vi.fn(read.handler), writeHandler = vi.fn(write.handler);
  read.handler = readHandler; write.handler = writeHandler;
  const pending: PendingToolConfirmation[] = [];
  const authorization = captureRequestAuthorization(() => true, 'Isolated accepted request revoked');
  const proposalScope = () => ({ domain: 'personal', orgId: '', channelId: conversationId,
    taskId: readDB().conversationActionTurns.find((row: any) => row.requestId === requestId && row.userId === userId)?.taskId || undefined });
  const requestConfirmation = vi.fn(createTurnConfirmation({
    userId, requestId, source: 'chat', actionIntent: text,
    allowLocalFileWrites: shouldAllowLocalFileWriteForTurn(text, []),
    consumeScope: proposalScope, proposalScope, assertCurrent: authorization.assertCurrent,
    onPending: item => pending.push(item),
  }));
  let acceptedContractKind: string | undefined;
  const input: LumiEntryTurnInput<ExecutedLumiTurn> = {
    entry: { source: 'chat', channel: 'chat', historyLimit: 10,
      failureText: 'Offline legal request did not finish.', failureReason: 'legal_selected_entry_fixture' },
    identity, userText: text, authorization, controller: new AbortController(),
    planning: {
      dispatch: { ...identity, text, source: 'chat', channel: 'chat', operationMode: 'assistant', targetIsLumi: true },
      registry, personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 },
      executionBoundary: 'trusted_local',
    },
    assemble: execution => {
      acceptedContractKind = execution.turnIntent.flow.acceptedActionContract?.contract.kind;
      return { systemPrompt: 'Use the original user request and genuine receipts; never claim an unperformed action.',
        model: { registry, config: { provider: 'deepseek', model: 'offline-legal-selected', userId, requestId },
          getters: {}, maxIterations: 3,
          context: { authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local',
            actionIntent: text, routedTaskText: text, requestConfirmation,
            allowLocalFileWrites: shouldAllowLocalFileWriteForTurn(text, []) } } };
    },
    deliver: result => result,
  };
  return { input, identity, registry, filePath, original, text, readHandler, writeHandler, pending, proposalScope,
    requestConfirmation, acceptedContractKind: () => acceptedContractKind };
}
function currentAuthorization(messages: any[]): any {
  return messages.find(message => message.promptBlock?.id === 'current-execution-authorization')?.promptBlock?.fields;
}
function assertOriginal(f: ReturnType<typeof fixture>) {
  expect(fs.readFileSync(f.filePath, 'utf8')).toBe(f.original);
  expect(f.writeHandler).not.toHaveBeenCalled();
}
function selectReadThenReport(f: ReturnType<typeof fixture>) {
  let terminal: any;
  provider.mockImplementation(async (messages: any[], declarations: any[], config: any): Promise<NormalizedLLMResponse> => {
    const fields = currentAuthorization(messages);
    if (provider.mock.calls.length === 1) {
      expect(declarations.map(item => item.function.name)).toContain('read_file');
      expect(config.responseFormat).toBeUndefined();
      expect(fields.taskId).toBe('');
      expect(readDB().conversationActionTasks.filter((row: any) => row.userId === f.identity.userId)).toHaveLength(0);
      return { text: '', toolCalls: [{ id: 'legal-selected-source-read-' + f.identity.requestId, name: 'read_file', arguments: { path: f.filePath } }], finishReason: 'tool_calls' };
    }
    expect(provider.mock.calls).toHaveLength(2);
    expect(config.responseFormat).toBeUndefined();
    expect(fields.requestId).toBe(f.identity.requestId);
    expect(fields.taskId).toBeTruthy();
    expect(fields.turnRowId).toBeTruthy();
    const rows = readDB().conversationActionReceipts.filter(row => row.requestId === f.identity.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'legal-selected-source-read-' + f.identity.requestId, taskId: fields.taskId, toolName: 'read_file', outcome: 'verified_success' });
    terminal = f.original;
    return { text: terminal, toolCalls: [], finishReason: 'stop' };
  });
  return () => terminal;
}

describe('legal selected-call admission keeps strict terminal evidence', () => {
  it('answers 继续回答 naturally without a task or another conversation-category question', async () => {
    const f = fixture('继续回答。'), answer = '我接着说明：聊天里可以直接提出任务，实际调用仍按已有授权执行。';
    provider.mockResolvedValue({ text: answer, toolCalls: [], finishReason: 'stop' });
    const result = await runLumiEntryTurn(f.input);
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][2].responseFormat).toBeUndefined();
    expect(result.finalized.text).toBe(answer);
    expect(result.finalized.text).not.toMatch(/普通对话|执行对话|确认你的意图|ordinary conversation/i);
    expect(result.finalized.blocked).toBe(false);
    expect(result.taskId).toBeUndefined(); expect(result.toolRecords).toEqual([]);
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === f.identity.userId)).toHaveLength(0);
    expect(f.readHandler).not.toHaveBeenCalled(); expect(f.requestConfirmation).not.toHaveBeenCalled();
    assertOriginal(f);
    observed.push({ case: 'continue-no-tool', answer: result.finalized.text, taskId: null, blocked: result.finalized.blocked });
  });

  it('binds the actual read before the handler and delivers the complete normal body with scoped canonical evidence', async () => {
    const f = fixture(file => 'Please handle this document. Its path is ' + file + '. Show its complete contents.');
    const terminal = selectReadThenReport(f);
    const result = await runLumiEntryTurn(f.input);
    expect(provider).toHaveBeenCalledTimes(2); expect(f.readHandler).toHaveBeenCalledOnce();
    const handlerContext = f.readHandler.mock.calls[0][1] as ToolContext;
    expect(handlerContext).toMatchObject({ ...f.identity, taskId: result.taskId, currentTurnExecutionRequested: true });
    const records = result.toolRecords.filter(record => record.name === 'read_file'); expect(records).toHaveLength(1);
    expect(isCanonicalToolExecutionRecord(records[0])).toBe(true);
    expect(records[0]).toMatchObject({ requestId: f.identity.requestId, taskId: result.taskId, id: 'legal-selected-source-read-' + f.identity.requestId });
    expect(records[0].envelope?.status).toBe('verified_success'); expect(records[0].result).toContain(f.original);
    expect(result.finalized.text).toBe(f.original); expect(result.finalized.blocked).toBe(false);
    expect(result.finalized.text).not.toContain('evidenceIds'); expect(result.finalized.text).not.toContain('legal-selected-source-read');
    expect(readDB().conversationActionTasks.find((row: any) => row.id === result.taskId)?.status).toBe('completed');
    const receipts = readDB().conversationActionReceipts.filter((row: any) => row.requestId === f.identity.requestId);
    expect(receipts).toHaveLength(1); expect(receipts[0]).toMatchObject({ taskId: result.taskId, toolName: 'read_file' });
    const user = getMessages(f.identity.conversationId, 10).find(row => row.role === 'user' && row.requestId === f.identity.requestId);
    expect(user?.message).toBe(f.text); assertOriginal(f);
    observed.push({ case: 'read-strict-positive', terminal: terminal(), blocked: result.finalized.blocked,
      sourceSHA256: createHash('sha256').update(f.original).digest('hex'), finalTextSHA256: createHash('sha256').update(result.finalized.text).digest('hex') });
  });

  it('keeps a none-contract provider-selected write at the genuine exact pending confirmation', async () => {
    const f = fixture('Can Lumi make a report file?');
    const args = { path: f.filePath, content: 'UNAPPROVED_LEGAL_REPORT_CONTENT' };
    provider.mockResolvedValueOnce({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'legal-unapproved-report-write', name: 'write_file', arguments: args }] });
    const result = await runLumiEntryTurn(f.input);
    expect(f.acceptedContractKind()).toBe('none'); expect(provider).toHaveBeenCalledOnce();
    expect(f.readHandler).not.toHaveBeenCalled(); assertOriginal(f);
    expect(f.requestConfirmation).toHaveBeenCalledOnce();
    expect(f.requestConfirmation.mock.calls[0][3]?.acceptedActionContract?.contract.kind).toBe('none');
    expect(f.pending).toHaveLength(1);
    expect(f.pending[0]).toMatchObject({ toolName: 'write_file', originRequestId: f.identity.requestId, taskId: result.taskId, exactArgs: args });
    expect(f.pending[0].taskId).toBeTruthy(); expect(getPendingConfirmation(f.identity.userId, f.proposalScope())?.id).toBe(f.pending[0].id);
    const persisted = await querySQL<any>('SELECT status, taskId, originRequestId FROM pending_tool_confirmations WHERE id = ?', [f.pending[0].id]);
    expect(persisted).toHaveLength(1); expect(persisted[0]).toMatchObject({ status: 'pending', taskId: result.taskId, originRequestId: f.identity.requestId });
    expect(result.toolRecords.some(record => record.envelope?.status === 'waiting_confirmation')).toBe(true);
    expect(result.finalized.blocked).toBe(true);
    expect(readDB().conversationActionTasks.find((row: any) => row.id === result.taskId)?.status).not.toBe('completed');
    observed.push({ case: 'none-contract-exact-write-pending', providerCalls: provider.mock.calls.length, writeHandlerCalls: f.writeHandler.mock.calls.length,
      terminalStatus: result.toolRecords.map(record => record.envelope?.status), blocked: result.finalized.blocked, pendingStatus: persisted[0].status });
  });

  it.each(['foreign-request', 'foreign-task'] as const)('rejects %s evidence instead of trusting a model completion claim', async invalid => {
    const f = fixture(file => 'Read the file ' + file + ' and show its complete contents.');
    selectReadThenReport(f);
    const result = await runLumiEntryTurn(f.input);
    expect(provider).toHaveBeenCalledTimes(2); expect(f.readHandler).toHaveBeenCalledOnce();
    const canonical = result.toolRecords.find(record => record.name === 'read_file')!;
    expect(isCanonicalToolExecutionRecord(canonical)).toBe(true);
    expect(canonical.envelope?.status).toBe('verified_success');
    expect(result.finalized, JSON.stringify({ final: result.finalized, guard: result.modelResult.completionGuard, records: result.toolRecords })).toMatchObject({ blocked: false, text: f.original });
    const wrong = { ...canonical };
    if (invalid === 'foreign-request') wrong.requestId = randomUUID();
    if (invalid === 'foreign-task') wrong.taskId = randomUUID();
    const replay = finalizeLumiResponse({ taskText: f.text, responseText: f.original, toolRecords: [wrong],
      source: 'chat', requestId: f.identity.requestId, taskId: result.taskId });
    expect(isCanonicalToolExecutionRecord(wrong)).toBe(false);
    expect(replay.blocked).toBe(true);
    expect(readDB().conversationActionTasks.find(row => row.id === result.taskId)?.status).toBe('completed');
    expect(readDB().conversationActionReceipts.filter(row => row.requestId === f.identity.requestId)).toHaveLength(1);
    assertOriginal(f);
    observed.push({ case: invalid, canonicalVerified: true, replayBlocked: replay.blocked, replayReason: replay.reason });
  });
  it('rejects a model-only read claim without canonical execution evidence', async () => {
    const f = fixture(file => 'Read the file ' + file + ' and show its complete contents.');
    provider.mockResolvedValue({ text: f.original, toolCalls: [], finishReason: 'stop' });
    const result = await runLumiEntryTurn(f.input);
    expect(result.finalized.blocked).toBe(true);
    expect(result.toolRecords).toEqual([]);
    expect(readDB().conversationActionReceipts.filter(row => row.requestId === f.identity.requestId)).toHaveLength(0);
    expect(f.readHandler).not.toHaveBeenCalled(); assertOriginal(f);
    expect(readDB().conversationActionTasks.find(row => row.id === result.taskId)?.status).not.toBe('completed');
  });

});


describe('legal status inquiries do not turn old task references into execution authority', () => {
  it('answers the old pending report status without tool_calls, forced JSON or a new task', async () => {
    const f = fixture(file => 'Create a report file at "' + file
      + '" containing "FICTIONAL_PENDING_REPORT". Wait until my confirmation before writing.');
    provider.mockResolvedValueOnce({ text: '', finishReason: 'tool_calls', toolCalls: [{
      id: 'legal-old-report-awaiting-grant', name: 'write_file',
      arguments: { path: f.filePath, content: 'FICTIONAL_PENDING_REPORT' },
    }] });
    const prior = await runLumiEntryTurn(f.input);
    expect(prior.taskId).toBeTruthy(); expect(f.pending).toHaveLength(1);
    expect(f.pending[0].taskId).toBe(prior.taskId); assertOriginal(f);
    expect(f.readHandler).not.toHaveBeenCalled();
    const oldTask = readDB().conversationActionTasks.find((row: any) => row.id === prior.taskId)!;
    const oldState = JSON.parse(oldTask.context).actionState, oldCapsule = oldState.taskCapsule;
    expect(oldState.unfinished).toBe(true);
    expect(oldCapsule).toMatchObject({ taskId: prior.taskId, unfinished: true, goal: f.text });
    expect(path.normalize(oldCapsule.target.path)).toBe(path.normalize(f.filePath));
    const taskCount = readDB().conversationActionTasks.filter((row: any) => row.userId === f.identity.userId).length;
    const question = '上次创建报告为什么没完成', answer = '上次报告仍在等待写入确认，当前没有继续写入。';
    const identity = { ...f.identity, requestId: randomUUID() };
    const authorization = captureRequestAuthorization(() => true, 'Offline status inquiry revoked');
    const requestConfirmation = vi.fn(createTurnConfirmation({
      userId: identity.userId, requestId: identity.requestId, source: 'chat', actionIntent: question,
      allowLocalFileWrites: shouldAllowLocalFileWriteForTurn(question, []),
      consumeScope: () => ({ domain: 'personal', orgId: '', channelId: identity.conversationId }),
      proposalScope: () => ({ domain: 'personal', orgId: '', channelId: identity.conversationId }),
      assertCurrent: authorization.assertCurrent,
      onPending: () => { throw new Error('A status-only no-tool reply must not create a new pending operation.'); },
    }));
    let accepted: any;
    const input: LumiEntryTurnInput<ExecutedLumiTurn> = {
      entry: { ...f.input.entry }, identity, userText: question, authorization, controller: new AbortController(),
      planning: { dispatch: { ...identity, text: question, source: 'chat', channel: 'chat', operationMode: 'assistant', targetIsLumi: true },
        registry: f.registry, executionBoundary: 'trusted_local',
        personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 } },
      assemble: execution => {
        accepted = { taskId: execution.taskId, taskRelation: execution.taskRelation,
          trustedActionContinuation: execution.trustedActionContinuation, acceptedActionContract: execution.turnIntent.flow.acceptedActionContract };
        return { systemPrompt: 'Answer this status question. The prior pending write is evidence, not a new grant.',
          model: { registry: f.registry,
            config: { provider: 'deepseek', model: 'offline-legal-status', userId: identity.userId, requestId: identity.requestId },
            getters: {}, maxIterations: 3,
            context: { authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local',
              actionIntent: question, routedTaskText: question, requestConfirmation,
              allowLocalFileWrites: shouldAllowLocalFileWriteForTurn(question, []) } } };
      },
      deliver: result => result,
    };
    provider.mockReset(); provider.mockResolvedValue({ text: answer, toolCalls: [], finishReason: 'stop' });
    const result = await runLumiEntryTurn(input);
    expect(provider).toHaveBeenCalledOnce(); expect(provider.mock.calls[0][2].responseFormat).toBeUndefined();
    expect(currentAuthorization(provider.mock.calls[0][0]).taskId).toBe('');
    expect(accepted.taskRelation.taskId).toBe(prior.taskId);
    expect(accepted.taskId).toBeUndefined(); expect(accepted.trustedActionContinuation).toBe(false);
    expect(accepted.acceptedActionContract).toMatchObject({ taskText: question, contract: { kind: 'none' } });
    expect(result.finalized.text).toBe(answer); expect(result.finalized.blocked).toBe(false);
    expect(result.finalized.text).not.toMatch(/普通对话|执行对话|ordinary conversation|evidenceIds/);
    expect(result.taskId).toBeUndefined(); expect(result.toolRecords).toEqual([]);
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === identity.userId)).toHaveLength(taskCount);
    const currentTurn = readDB().conversationActionTurns.find((row: any) => row.requestId === identity.requestId);
    expect(currentTurn?.taskId || '').toBe('');
    expect(readDB().conversationActionReceipts.filter((row: any) => row.requestId === identity.requestId)).toHaveLength(0);
    expect(requestConfirmation).not.toHaveBeenCalled();
    const preserved = readDB().conversationActionTasks.find((row: any) => row.id === prior.taskId)!;
    expect(preserved.activeRequestId).toBe(''); expect(preserved.goal).toBe(f.text); expect(preserved.status).not.toBe('completed');
    const preservedCapsule = JSON.parse(preserved.context).actionState.taskCapsule;
    expect(preservedCapsule.goal).toBe(oldCapsule.goal); expect(preservedCapsule.target).toEqual(oldCapsule.target);
    expect(getPendingConfirmation(f.identity.userId, f.proposalScope())?.id).toBe(f.pending[0].id);
    const persisted = await querySQL<any>('SELECT status, taskId, originRequestId FROM pending_tool_confirmations WHERE id = ?', [f.pending[0].id]);
    expect(persisted).toEqual([{ status: 'pending', taskId: prior.taskId, originRequestId: f.identity.requestId }]);
    assertOriginal(f); expect(f.readHandler).not.toHaveBeenCalled();
    observed.push({ case: 'old-pending-report-status-no-tools', question, answer: result.finalized.text,
      oldTaskStatus: preserved.status, oldPendingStatus: persisted[0].status, oldTaskRelationReferenced: accepted.taskRelation.taskId === prior.taskId,
      currentExecutionTaskId: result.taskId ?? null, forcedJSON: provider.mock.calls[0][2].responseFormat ?? null,
      newTaskCount: 0, currentReceiptCount: result.toolRecords.length, blocked: result.finalized.blocked });
  });
});


describe('whole original legal request remains authoritative after a verified read', () => {
  it('keeps read-plus-sign incomplete while preserving the normal body and the full source', async () => {
    const f = fixture(file => 'Read the file ' + file + ' and show its complete contents. Then sign the contract.');
    selectReadThenReport(f);
    const result = await runLumiEntryTurn(f.input);
    expect(f.readHandler).toHaveBeenCalledOnce();
    expect(f.writeHandler).not.toHaveBeenCalled();
    const read = result.toolRecords.find(record => record.name === 'read_file');
    expect(read).toBeDefined();
    expect(isCanonicalToolExecutionRecord(read!)).toBe(true);
    expect(read!.envelope?.status).toBe('verified_success');
    expect(read!.result).toContain(f.original);
    expect(result.finalized.text).toContain(f.original);
    expect(result.finalized.blocked).toBe(true);
    expect(readDB().conversationActionTasks.find((row: any) => row.id === result.taskId)?.status).toBe('blocked');
    const user = getMessages(f.identity.conversationId, 10).find(row => row.role === 'user' && row.requestId === f.identity.requestId);
    expect(user?.message).toBe(f.text);
    assertOriginal(f);
  });
});
