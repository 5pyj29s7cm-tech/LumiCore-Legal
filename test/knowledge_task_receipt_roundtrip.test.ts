import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ model: vi.fn(), network: vi.fn() }));
vi.mock('../server/llm/providers', async original => ({ ...await original<any>(), makeLLMCall: calls.model, makeLLMCallStreaming: calls.model }));
import { initDatabase, readDB } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { runLumiEntryTurn } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import { registerProductVariantTools } from '../server/tools/definitions';
import { actualDocumentReadContent } from '../server/cognition/action_desktop_evidence';
import { recordsToTaskReceipts, taskReceiptsToRecords, taskCompletionFromReceipts } from '../server/cognition/task_execution_ledger';
import type { ToolExecutionRecord } from '../server/tools/types';
const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/knowledge_core_e240_capture.json'), 'utf8'));
const original = (): ToolExecutionRecord => structuredClone(captured.records[0]);
const scope = () => ({ taskId: captured.taskId, requestId: captured.requestId });
const roundtrip = (record: ToolExecutionRecord) => JSON.parse(JSON.stringify(recordsToTaskReceipts([record])));
beforeAll(() => initDatabase());
beforeEach(() => { vi.clearAllMocks(); calls.network.mockRejectedValue(new Error('UNEXPECTED_NETWORK')); vi.stubGlobal('fetch', calls.network); });
afterEach(() => vi.unstubAllGlobals());
describe('durable knowledge source receipt fidelity', () => {
  it('restores the exact structured original through JSON persistence without duplicating envelope payload', () => {
    const record = original();
    expect(record.result.length).toBeGreaterThan(3000);
    const receipts = roundtrip(record);
    const hydrated = taskReceiptsToRecords(receipts)[0];
    expect(receipts[0].result).toHaveLength(3000);
    expect(receipts[0].envelope).not.toHaveProperty('result');
    const { result: _result, ...metadata } = record.envelope!;
    expect(hydrated.envelope).toEqual(metadata);
    expect(hydrated.adapterStarted).toBe(true);
    expect(hydrated.arguments).toEqual(record.arguments);
    expect(JSON.parse(hydrated.result)).toEqual(JSON.parse(record.result));
    expect(actualDocumentReadContent(hydrated)).toBe(actualDocumentReadContent(record));
    expect(taskCompletionFromReceipts(captured.taskText, receipts, null, scope())).toMatchObject({ complete: true, blocker: '' });
    expect(calls.network).not.toHaveBeenCalled();
    expect(calls.model).not.toHaveBeenCalled();
  });
  it('reuses the already stored structured payload beyond both textual summary sizes', () => {
    const record = original();
    const payload = JSON.parse(record.result);
    for (const file of payload.files) {
      file.text = file.text.repeat(4); file.characters = file.text.length;
      file.textHash = createHash('sha256').update(file.text).digest('hex');
      file.sourceHash = file.textHash; file.sourceRevision = file.sourceHash;
    }
    record.result = JSON.stringify(payload);
    expect(record.result.length).toBeGreaterThan(8000);
    const receipts = roundtrip(record);
    expect(JSON.parse(taskReceiptsToRecords(receipts)[0].result)).toEqual(payload);
    expect(taskCompletionFromReceipts(captured.taskText, receipts, null, scope()).complete).toBe(true);
  });
  it('does not turn malformed unstructured source output into a valid original', () => {
    const record = original(); record.result = '{not-valid-json'; delete record.receipt;
    expect(taskCompletionFromReceipts(captured.taskText, roundtrip(record), null, scope()).complete).toBe(false);
  });
  it.each(['missing-envelope', 'missing-adapter', 'bad-request', 'bad-task', 'bad-idempotency', 'wrong-file-args', 'bad-hash', 'truncated-source', 'missing-source-text'])(
    'does not turn malformed or legacy source evidence into completion: %s', kind => {
      const record = original();
      if (kind === 'missing-envelope') delete record.envelope;
      if (kind === 'missing-adapter') delete record.adapterStarted;
      if (kind === 'bad-request') record.envelope!.requestId = 'different-request';
      if (kind === 'bad-task') record.envelope!.taskId = 'different-task';
      if (kind === 'bad-idempotency') record.envelope!.idempotencyKey = 'different-key';
      if (kind === 'wrong-file-args') record.arguments.fileIds = ['other.txt', ...record.arguments.fileIds.slice(1)];
      const payload = JSON.parse(record.result);
      if (kind === 'bad-hash') payload.files[0].textHash = '0'.repeat(64);
      if (kind === 'truncated-source') payload.files[0].truncated = true;
      if (kind === 'missing-source-text') delete payload.files[0].text;
      record.result = JSON.stringify(payload);
      expect(taskCompletionFromReceipts(captured.taskText, roundtrip(record), null, scope()).complete).toBe(false);
      expect(calls.model).not.toHaveBeenCalled();
      expect(calls.network).not.toHaveBeenCalled();
    },
  );
  it.each(['failed', 'waiting_confirmation', 'unknown_outcome', 'forbidden'] as const)('keeps the original %s outcome ineligible for source completion', status => {
    const record = original();
    record.envelope!.status = status;
    record.envelope!.verification.status = status === 'failed' || status === 'forbidden' ? 'failed' : 'unverified';
    record.terminalVerification = { ...record.terminalVerification!, status: record.envelope!.verification.status };
    expect(taskCompletionFromReceipts(captured.taskText, roundtrip(record), null, scope()).complete).toBe(false);
  });
  it('archives and settles the same selected source read in a real isolated conversation database', async () => {
    const userId = 'knowledge-roundtrip-' + crypto.randomUUID();
    const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
    const requestId = crypto.randomUUID();
    const registry = new ToolRegistry(); registerProductVariantTools(registry);
    const payload = JSON.parse(original().result); payload.userId = userId;
    const handler = vi.fn(async () => JSON.stringify(payload));
    registry.get('knowledge_file_stats')!.handler = handler;
    calls.model.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'selected-knowledge-read', name: 'knowledge_file_stats', arguments: original().arguments }] })
      .mockResolvedValue({ text: '已读取这三份虚构资料。原告诉请金额为90000元，属于原告主张；被告自述付款70000元未取得银行原始流水核实。算术差额20000元不等于承认余债。合同签署日期、付款条件和管辖均未提供，不能据此认定没有约定。', toolCalls: [] });
    const result: any = await runLumiEntryTurn({
      entry: { source: 'knowledge-roundtrip-test', channel: 'chat', historyLimit: 10, failureText: 'Isolated retrieval failed.', failureReason: 'test' },
      identity: { userId, conversationId, agentId: 'lumi', domain: 'personal', orgId: '', requestId },
      userText: captured.taskText,
      authorization: captureRequestAuthorization(() => true, 'revoked'), controller: new AbortController(),
      planning: { dispatch: { userId, text: captured.taskText, channel: 'chat', source: 'knowledge-roundtrip-test', domain: 'personal', orgId: '', operationMode: 'assistant', targetIsLumi: true }, registry,
        personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 2 }, executionBoundary: 'trusted_local' },
      assemble: execution => ({ systemPrompt: execution.capabilityPlan.promptOverlay, model: { registry, getters: {}, config: { provider: 'deepseek', model: 'offline-test', requestId }, maxIterations: 2,
        context: { localExecution: true, authenticated: true, domain: 'personal', executionBoundary: 'trusted_local', actionIntent: captured.taskText, routedTaskText: execution.turnIntent.flow.routeText } } }),
      deliver: response => response,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls.model).toHaveBeenCalledTimes(2);
    expect(calls.network).not.toHaveBeenCalled();
    const db: any = readDB();
    const tasks = db.conversationActionTasks.filter((task: any) => task.userId === userId && task.conversationId === conversationId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('completed');
    expect(tasks[0]).toMatchObject({ completionSource: 'tool_receipt', activeRequestId: '' });
    const context = JSON.parse(tasks[0].context);
    expect(context.actionState.status).toBe('completed');
    expect(context.taskFinalization).toMatchObject({ outcome: 'completed', requestId });
    expect(context.executionPlan).toMatchObject({ decisionAuthority: 'registry_bound_call', risk: { sideEffectClass: 'none' } });
    expect(db.conversationActionReceipts.filter((receipt: any) => receipt.taskId === tasks[0].id)).toHaveLength(1);
    expect(result.finalized?.blocked).not.toBe(true);
  });
});
