import './helpers';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveVerifiedArtifactRetrieval } from '../server/cognition/contracts/artifact_evidence';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactPathFromRecord, isArtifactDeliveryRecord, isArtifactProducerRecord, resolveArtifactDelivery, sameArtifactPath } from '../server/tools/artifact_evidence';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { isVerifiedProducedDocumentTarget, resolveAcceptedTaskTarget } from '../server/conversation/task_target_anchor';
import type { ToolExecutionRecord } from '../server/tools/types';

describe('one artifact identity and delivery decision across consumers', () => {
  it('keeps skill and workflow state writes out of document continuity and completion', () => {
    const csv = 'C:/Users/Administrator/Documents/orders.csv';
    const calls: ToolExecutionRecord[] = ['generate_skill', 'save_workflow'].map(name => ({
      name, requestId: 'authoring-request', arguments: {}, result: '', error: 'draft rejected',
      capability: { capabilityId: 'skills.draft.generate', lane: 'system', operation: 'create', risk: 'high',
        sideEffects: [{ type: 'local_write', scope: 'draft state', reversible: true }],
        verification: { strategy: 'artifact', required: true, requiredFields: ['ok'], requiredValues: { ok: true }, successSignals: ['Draft exists'], limitations: [] } },
    }));
    for (const call of calls) {
      expect(isArtifactProducerRecord(call)).toBe(false);
      expect(isArtifactProducerRecord({ name: call.name })).toBe(false);
    }
    const accepted = resolveAcceptedTaskTarget({ text: '把刚才读取的那份 CSV 做成 Excel，保存后回读。', persistedHistory: [
      { role: 'user', message: `读取 ${csv}，计算总额。` },
      { role: 'assistant', requestId: 'authoring-request', message: 'Draft failed', toolCalls: calls },
    ] });
    expect(accepted?.target.path.replaceAll('\\', '/')).toBe(csv);
    const task = '创建一个 Excel 文件';
    expect(hasCoreActionEvidence(buildActionContract(task), calls.map(call => ({ ...call, error: undefined,
      result: '{"ok":true,"status":"verified"}', terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'Draft exists' } })), task)).toBe(false);
  });
  it('uses returned output rather than the mutation input, including encoded receipts', () => {
    const record: ToolExecutionRecord = { name: 'modify_xlsx', arguments: { filePath: 'C:/input.xlsx' }, result: '', receipt: JSON.stringify(JSON.stringify({ path: 'C:/output.xlsx' })) };
    expect(artifactPathFromRecord(record)).toBe('C:/output.xlsx');
    expect(artifactPathFromRecord({ ...record, receipt: undefined })).toBe('');
    expect(sameArtifactPath('C:/Folder/../out.xlsx', 'c:\\OUT.xlsx')).toBe(true);
    expect(sameArtifactPath('/tmp/Output.xlsx', '/tmp/output.xlsx')).toBe(false);
  });

  it('delivers the same verified output through chat, voice, task and workflow without a model summary', () => {
    const output = path.join(process.env.LUMI_DATA_DIR!, 'unified-delivery.txt');
    const content = 'alpha\nbeta'; fs.writeFileSync(output, content);
    const identity = { taskId: 'unified-task', requestId: 'unified-request' };
    const verification = { status: 'verified' as const, strategy: 'artifact' as const, reason: 'Actual fixture file and same-path readback' };
    const producer: ToolExecutionRecord = { ...identity, name: 'write_file', arguments: { path: output, content }, result: JSON.stringify({ ok: true, path: output }), terminalVerification: verification };
    const reader: ToolExecutionRecord = { ...identity, name: 'read_file', arguments: { path: output }, result: fs.readFileSync(output, 'utf8'), terminalVerification: verification };
    const records = [producer, reader];
    const taskText = `创建 ${output}，保存后回读并告诉我全文。`;
    expect(hasCoreActionEvidence(buildActionContract(taskText), records, taskText, null, identity)).toBe(true);
    expect(isVerifiedProducedDocumentTarget(output, records)).toBe(true);
    const outcomes = ['chat', 'voice', 'task', 'workflow'].map(source => {
      const input = { ...identity, taskText, responseText: '', toolRecords: records, source };
      const bounded = finalizeLumiResponse(input);
      expect(bounded?.blocked).toBe(false);
      const delivered = finalizeLumiResponse({ ...input, responseText: bounded!.text });
      expect(delivered.blocked).toBe(false); expect(delivered.text).toContain(content);
      expect(finalizeLumiResponse({ ...input, toolRecords: [producer] })).toMatchObject({ blocked: true });
      expect(hasCoreActionEvidence(buildActionContract(taskText), records, taskText, null, { ...identity, requestId: 'other' })).toBe(false);
      return delivered.text;
    });
    expect(new Set(outcomes).size).toBe(1);
    expect(resolveArtifactDelivery([producer, { ...reader, requestId: 'different' }])?.readback).toBeUndefined();
    expect(resolveArtifactDelivery([reader, producer])?.readback).toBeUndefined();
    expect(resolveArtifactDelivery([producer, { ...reader, error: 'read failed' }])?.readback).toBeUndefined();
  });

  it('delivers an explicitly verified existing file without treating retrieval as a new write', () => {
    const output = path.join(process.env.LUMI_DATA_DIR!, 'existing-video.mp4');
    fs.writeFileSync(output, 'owned existing video fixture');
    const payload = { ok: true, verified: true, status: 'retrieved', outputPath: output, artifacts: [{ type: 'video', path: output, sha256: 'a'.repeat(64), size: fs.statSync(output).size }] };
    const record: ToolExecutionRecord = { name: 'owned_file_read', requestId: 'retrieve-request', arguments: { includeOutput: true }, result: JSON.stringify(payload), terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'Existing owned file hash checked' },
      capability: { capabilityId: 'files.owned_read', lane: 'files', operation: 'observe', risk: 'low', sideEffects: [{ type: 'local_read', scope: 'owned file', reversible: true }], verification: { strategy: 'state_diff', required: true, requiredFields: ['ok', 'verified'], successStatuses: ['read', 'retrieved'], successSignals: [], limitations: [] } } };
    expect(isArtifactDeliveryRecord(record)).toBe(true);
    expect(artifactPathFromRecord(record)).toBe(output);
    expect(artifactPathFromRecord({ ...record, result: JSON.stringify({ ...payload, path: 'C:/private-input.mp4' }) })).toBe(output);
    expect(isArtifactProducerRecord(record)).toBe(false);
    expect(resolveArtifactDelivery([record])).toBeNull();
    expect(isVerifiedProducedDocumentTarget(output, [record])).toBe(false);
    const task = '创建一个新的 Excel 文件';
    expect(hasCoreActionEvidence(buildActionContract(task), [record], task)).toBe(false);
    for (const bad of [
      { ...record, terminalVerification: { ...record.terminalVerification!, status: 'unverified' as const } },
      { ...record, error: 'Read failed' },
      { ...record, capability: undefined },
      { ...record, name: 'read_file', capability: { ...record.capability!, verification: { ...record.capability!.verification, successStatuses: ['read'] } } },
      { ...record, result: JSON.stringify({ ...payload, status: 'read' }) },
      { ...record, result: JSON.stringify({ ...payload, success: false }) },
      { ...record, result: JSON.stringify({ ...payload, artifacts: [{ ...payload.artifacts[0], path: 'C:/different.mp4' }] }) },
      { ...record, result: JSON.stringify({ ...payload, artifacts: [{ ...payload.artifacts[0], size: 0 }] }) },
      { ...record, result: JSON.stringify({ ...payload, artifacts: [{ ...payload.artifacts[0], sha256: 'invented' }] }) },
    ]) expect(isArtifactDeliveryRecord(bad)).toBe(false);
  });
});


const retrievalId = '11111111-1111-4111-8111-111111111111';
const retrievalTurn = { requestId: 'only-retrieve-request', taskId: 'only-retrieve-task' };
const retrievalTask = '请把聊天唱歌工程 ' + retrievalId + ' 当前第 22 版选中的聊天记录＋表情包视频作为本轮附件返回。这个工程已经有完整120秒的成片，请通过 chat_song_render 复用已有文件，不要重新起草、生成歌曲、图片或视频模型画面，不要制作动画版，不要发送到任何外部聊天软件，不用再次确认歌词。歌曲人工核对状态保持原值。';
function retrievalFixture() {
  const outputPath = path.join(process.env.LUMI_DATA_DIR!, 'current-owned-output.mp4');
  fs.writeFileSync(outputPath, 'actual existing fixture bytes, not a newly generated video');
  const payload = { ok: true, verified: true, status: 'retrieved', projectId: retrievalId, revision: 22, outputPath,
    artifacts: [{ type: 'video', path: outputPath, sha256: createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex'), size: fs.statSync(outputPath).size }] };
  const record: ToolExecutionRecord = { ...retrievalTurn, name: 'owned_project_read', arguments: { includeOutput: true, projectId: retrievalId, revision: 22 }, result: JSON.stringify(payload),
    terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'Owned current output selected and hashed' },
    capability: { capabilityId: 'files.owned_project_read', lane: 'files', operation: 'observe', risk: 'low', sideEffects: [{ type: 'local_read', scope: 'owned current project file', reversible: true }],
      verification: { strategy: 'state_diff', required: true, requiredFields: ['ok', 'verified'], successStatuses: ['read', 'retrieved'], successSignals: [], limitations: [] } } };
  return { outputPath, record, payload };
}
it('completes only an explicitly requested existing attachment with current-turn identity, revision and actual file hash', () => {
  const { outputPath, record } = retrievalFixture();
  const contract = buildActionContract(retrievalTask);
  expect(contract).toMatchObject({ kind: 'artifact_work', artifactMode: 'retrieve', artifactTarget: { id: retrievalId, revision: 22 } });
  expect(resolveVerifiedArtifactRetrieval(retrievalTask, contract, [record], retrievalTurn)).toEqual({ record, outputPath });
  expect(hasCoreActionEvidence(contract, [record], retrievalTask, null, retrievalTurn)).toBe(true);
  expect(resolveArtifactDelivery([record])).toBeNull(); expect(isArtifactProducerRecord(record)).toBe(false);
  const english = 'Return the existing video for project ' + retrievalId + ' revision 22 as this turn attachment. Do not generate images, but keep the existing song unchanged.';
  expect(buildActionContract(english)).toMatchObject({ artifactMode: 'retrieve', artifactTarget: { id: retrievalId, revision: 22 } });
  expect(hasCoreActionEvidence(buildActionContract(english), [record], english, null, retrievalTurn)).toBe(true);
});
it.each([
  '然后生成一个新视频', '然后修改字幕', '然后删除源文件', '然后复制到另一个目录', '然后重命名文件', '然后签名', '然后签付', '然后下载到D盘', '然后导出成另一种格式', '然后打开视频', '然后发送到飞书', '然后签署委托书', '然后支付费用', '然后分析视频内容', '并附上另一份文书',
  '不要生成图片，但修改昵称', '不要生成图片，然后打开视频', 'do not generate images, but then send the video to a customer',
])('never lets an existing attachment complete additional requested work: %s', suffix => {
  const { record } = retrievalFixture();
  const task = '请把工程 ' + retrievalId + ' 已有视频作为附件返回，' + suffix + '。';
  const contract = buildActionContract(task);
  expect(contract.artifactMode).not.toBe('retrieve');
  expect(resolveVerifiedArtifactRetrieval(task, contract, [record], retrievalTurn)).toBeNull();
  // A none contract is vacuously true in core evidence; the execution loop requires applies as well.
  expect(contract.applies && hasCoreActionEvidence(contract, [record], task, null, retrievalTurn)).toBe(false);
});
it.each(['old-turn', 'wrong-project', 'wrong-revision', 'omitted-requested-revision', 'wrong-payload-project', 'wrong-hash', 'replaced-file', 'normal-read', 'missing-declaration', 'extra-file'] as const)('rejects %s as existing-attachment completion evidence', invalid => {
  const { record, payload, outputPath } = retrievalFixture();
  if (invalid === 'old-turn') record.requestId = 'earlier-request';
  if (invalid === 'wrong-project') record.arguments!.projectId = '22222222-2222-4222-8222-222222222222';
  if (invalid === 'wrong-revision') record.arguments!.revision = 21;
  if (invalid === 'omitted-requested-revision') delete record.arguments!.revision;
  if (invalid === 'wrong-payload-project') payload.projectId = '22222222-2222-4222-8222-222222222222';
  if (invalid === 'wrong-hash') payload.artifacts[0].sha256 = 'b'.repeat(64);
  if (invalid === 'replaced-file') fs.appendFileSync(outputPath, 'replaced');
  if (invalid === 'normal-read') payload.status = 'read';
  if (invalid === 'missing-declaration') record.capability!.verification.successStatuses = ['read'];
  if (invalid === 'extra-file') payload.artifacts.push({ ...payload.artifacts[0] });
  record.result = JSON.stringify(payload);
  expect(hasCoreActionEvidence(buildActionContract(retrievalTask), [record], retrievalTask, null, retrievalTurn)).toBe(false);
});
it('does not infer attachment retrieval from a status question, ambiguous identity or multiple requested projects', () => {
  const { record } = retrievalFixture();
  for (const task of ['请解释怎么把工程 ' + retrievalId + ' 已有视频作为附件返回', '请返回已有视频的状态', '请把已有视频作为附件返回', '请把工程 ' + retrievalId + ' 和 22222222-2222-4222-8222-222222222222 已有视频作为附件返回']) {
    const contract = buildActionContract(task); expect(contract.artifactMode).not.toBe('retrieve'); expect(resolveVerifiedArtifactRetrieval(task, contract, [record], retrievalTurn)).toBeNull();
  }
  expect(resolveVerifiedArtifactRetrieval(retrievalTask, buildActionContract(retrievalTask), [record])).toBeNull();
});
