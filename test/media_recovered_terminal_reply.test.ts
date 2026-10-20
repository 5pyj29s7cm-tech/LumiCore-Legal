import './helpers';
import { describe, expect, it, vi } from 'vitest';
import replay from './fixtures/media_recovered_native_20261017.json';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { finalizeLumiResponseForDelivery } from '../server/cognition/response_delivery';
import { groundedMediaGeneration } from '../server/cognition/result_artifact_presenter';
import { buildForegroundTaskCompletionFeedback } from '../server/cognition/acceptance_evidence';
import { recordsToTaskReceipts, taskCompletionFromReceipts } from '../server/cognition/task_execution_ledger';
import type { ToolExecutionRecord } from '../server/tools/types';
const scope = { requestId: replay.requestId, taskId: replay.taskId };
const actual = () => structuredClone(replay.record) as ToolExecutionRecord;
const input = (record = actual(), taskText = replay.taskText, responseText = '已查询，原视频已经保存。') => ({ ...scope, taskText, responseText, source: 'chat', toolRecords: [record] });
function payload(record: ToolExecutionRecord, change: (value: any) => void) { const value = JSON.parse(record.result!); change(value); record.result = JSON.stringify(value); record.envelope!.result = value; }
describe('verified original media retrieval terminal reply', () => {
  it('replays the exact canonical successful query without a false saved-file block or extra summary call', async () => {
    const record = actual(), unchanged = structuredClone(record), value = input(record);
    const bounded = finalizeLumiResponse(value);
    expect(bounded).toMatchObject({ blocked: true, reason: 'media_retrieval_only' });
    expect(bounded!.text).toContain('原任务的视频已取回');
    expect(bounded!.text).toContain('15.00'); expect(bounded!.text).toContain('1080x1920');
    expect(bounded!.text).toContain('已检测到音轨'); expect(bounded!.text).toContain('内容质量尚未核验');
    const final = finalizeLumiResponse(value);
    expect(final).toEqual(bounded);
    const attempt = vi.fn(async () => { throw new Error('No extra model call is permitted'); });
    const delivery = await finalizeLumiResponseForDelivery({ ...value, allowToolUse: true, attempt });
    expect(delivery.attempted).toBe(false); expect(delivery.finalization).toEqual(final); expect(attempt).not.toHaveBeenCalled();
    const feedback = buildForegroundTaskCompletionFeedback({ taskId: scope.taskId, taskLabel: replay.taskText, toolRecords: [record], finalization: final });
    expect(feedback?.status).not.toBe('completed');
    expect(feedback?.completed.join(' ')).toContain('原任务的视频已取回');
    expect(feedback?.incomplete).toContain('整体请求尚未核验。');
    expect(taskCompletionFromReceipts(replay.taskText, recordsToTaskReceipts([record]), undefined, scope).complete).toBe(true);
    expect(record).toEqual(unchanged);
    expect(final.text).not.toMatch(/recoveryId|providerTaskId|prompt|120|已发布|已发送|唱词正确/);
  });
  it.each(['requestId', 'taskId'] as const)('does not consume a different %s', key => {
    const record = actual(); record[key] = 'other'; record.envelope![key] = 'other';
    expect(groundedMediaGeneration(input(record))).toBeNull();
  });
  it.each(['recovery-id', 'terminal', 'adapter', 'operation', 'reconciliation', 'committed', 'verifier', 'metadata-only', 'settings', 'segment', 'unknown'] as const)('requires real current retrieval proof: %s', kind => {
    const record = actual();
    if (kind === 'recovery-id') record.arguments.recoveryId = 'different';
    if (kind === 'terminal') { record.terminalVerification!.status = 'unverified'; record.envelope!.status = 'unknown_outcome'; }
    if (kind === 'adapter') record.adapterStarted = false;
    if (kind === 'operation') record.capability!.operation = 'create';
    if (kind === 'reconciliation') delete record.capability!.reconciliation;
    if (kind === 'verifier') record.capability!.verification.required = false;
    if (kind === 'committed') payload(record, p => p.reconciliationStatus = 'unknown');
    if (kind === 'metadata-only') payload(record, p => { delete p.artifacts; delete p.outputPath; });
    if (kind === 'settings') payload(record, p => p.settingsMatch = false);
    if (kind === 'segment') payload(record, p => { p.compositionSegment = true; p.wholeTaskCompleted = false; });
    if (kind === 'unknown') payload(record, p => { p.status = 'unknown'; p.verified = false; p.verificationStatus = 'unverified'; });
    expect(groundedMediaGeneration(input(record))).toBeNull();
  });
  it.each([
    '查询原任务并把视频发送给客户',
    '查询原任务并发布到抖音',
    '查询原任务并播放视频',
    '生成120秒带声音的视频',
  ])('does not promote retrieval into the whole mixed goal: %s', taskText => {
    const value = input(actual(), taskText, '已生成120秒视频，已发送并发布。');
    expect(groundedMediaGeneration(value)?.reason).not.toBe('media_generation_recovered');
    expect(finalizeLumiResponse(value)?.blocked).not.toBe(false);
    const final = finalizeLumiResponse(value);
    expect(final.blocked).toBe(true);
    expect(buildForegroundTaskCompletionFeedback({ taskId: scope.taskId, taskLabel: taskText, toolRecords: value.toolRecords, finalization: final })?.status).not.toBe('completed');
    expect(taskCompletionFromReceipts(taskText, recordsToTaskReceipts(value.toolRecords), undefined, scope).complete).toBe(false);
  });
  it.each(['查询原任务，然后签署合同。', '查询原任务，然后支付款项。', '查询原任务，然后提交合同。'])('never completes an unrecognized mixed goal from retrieval alone: %s', taskText => {
    const value = input(actual(), taskText, '全部完成。');
    const bounded = finalizeLumiResponse(value);
    expect(bounded).toMatchObject({ blocked: true, reason: 'media_retrieval_only' });
    expect(bounded!.text).toContain('原任务的视频已取回');
    const final = finalizeLumiResponse(value);
    expect(final.blocked).toBe(true);
    const feedback = buildForegroundTaskCompletionFeedback({ taskId: scope.taskId, taskLabel: taskText, toolRecords: value.toolRecords, finalization: final });
    expect(feedback?.status).not.toBe('completed');
    expect(feedback?.incomplete).toContain('整体请求尚未核验。');
    expect(feedback?.completed.join(' ')).not.toMatch(/签署|支付|提交/);
  });
  it('does not expose provider diagnostics or accept unbound host scope', () => {
    const record = actual(); payload(record, p => { p.reason = 'secret diagnostic sentinel'; p.prompt = 'untrusted generated prompt'; });
    expect(finalizeLumiResponse(input(record)).text).not.toMatch(/secret diagnostic|untrusted generated/);
    expect(groundedMediaGeneration({ taskText: replay.taskText, responseText: '', source: 'chat', toolRecords: [record] })).toBeNull();
  });
});
