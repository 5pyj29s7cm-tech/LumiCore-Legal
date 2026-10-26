import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIterationLimitSummary } from '../server/llm/tool_loop/summaries';
import type { ToolExecutionRecord } from '../server/tools/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-public-failure-copy-'));
const prohibited = ['自动恢复预算', '声明式替代', '恢复执行时必须', '重新规划', '验真工具', '受控工具操作', 're-plan', 'declared fallback', 'automatic recovery budget', '请先核对', '恢复时', '继续未完成', 'Review the files', 'Check the recorded'];
beforeAll(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network permitted in public renderer tests'); })));
afterAll(() => {
  vi.unstubAllGlobals();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('lumi-public-failure-copy-')) throw new Error('Unsafe temporary cleanup');
  fs.rmSync(resolved, { recursive: true, force: true });
});
function record(patch: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return { id: 'synthetic-public-copy', name: 'legal_generate_litigation_packet', arguments: {}, result: JSON.stringify({ status: 'partial', note: 'internal private prompt must not appear' }), durationMs: 1, terminalVerification: { status: 'unverified', reason: 'partial' }, ...patch } as ToolExecutionRecord;
}
function noInternalInstructions(text: string) { for (const token of prohibited) expect(text).not.toContain(token); }

describe('public iteration failure summary', () => {
  it('reports the actual partial progress without planning instructions or declaring that no draft exists', () => {
    const text = buildIterationLimitSummary([record(), record(), record(), record()], '生成文书工作稿');
    expect(text).toMatch(/尚未全部完成/);
    expect(text).not.toMatch(/这轮进展|任务处理|4\./u);
    expect(text).toContain('尚未确认可交付成果');
    expect(text).not.toContain('可能已生成');
    expect(text).not.toMatch(/没有检测到可验证产物|没有(?:任何)?(?:产物|文件|成果)/);
    expect(text).not.toContain('internal private prompt');
    noInternalInstructions(text);
  });
  it('retains the real verified file and its size while keeping the whole request incomplete', () => {
    const output = path.join(root, 'completed.docx'); fs.writeFileSync(output, 'synthetic delivered document');
    const ready = record({ name: 'create_docx', arguments: { outputPath: output }, result: JSON.stringify({ ok: true, status: 'created', path: output }), terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'existing file verified' } });
    const text = buildIterationLimitSummary([ready, record()], '创建两份文书');
    expect(text).toContain(output);
    expect(text).toContain('28 B');
    expect(text).toContain('已确认的产物');
    expect(text).toMatch(/尚未全部完成/);
    expect(text).toContain('本次请求尚未全部完成');
    noInternalInstructions(text);
  });
  it('does not turn an unverified file on disk into a confirmed deliverable', () => {
    const output = path.join(root, 'pending.docx'); fs.writeFileSync(output, 'synthetic pending draft');
    const text = buildIterationLimitSummary([record({ name: 'create_docx', arguments: { outputPath: output }, result: JSON.stringify({ ok: false, status: 'partial', path: output }) })], '创建合同');
    expect(fs.existsSync(output)).toBe(true);
    expect(text).not.toContain('已确认的产物');
    expect(text).not.toContain(output);
    expect(text).toContain('尚未确认可交付成果');
    expect(text).not.toContain('可能已生成');
    expect(text).toMatch(/尚未全部完成/);
    noInternalInstructions(text);
  });
  it('keeps the no-result case incomplete without telling the model how to recover', () => {
    const text = buildIterationLimitSummary([], '请处理当前材料');
    expect(text).toMatch(/尚未完成/);
    expect(text).toContain('已有信息不需要重复提供');
    noInternalInstructions(text);
  });
  it('keeps exact confirmation pending and does not convert it into ordinary completion', () => {
    const text = buildIterationLimitSummary([record({ name: 'send_message', error: 'requires user confirmation' })], '发送消息');
    expect(text).toContain('还没有完成');
    expect(text).toContain('确认');
    expect(text).toContain('只会授权这一个待执行动作');
    expect(text).not.toContain('本次请求尚未全部完成');
  });
  it('uses the same concise failure boundary in the English branch', () => {
    const text = buildIterationLimitSummary([record()], 'Prepare a draft');
    expect(text).toContain('This request is not complete.');
    expect(text).toContain('Deliverable results have not yet been confirmed');
    expect(text).not.toContain('Files may have been created');
    noInternalInstructions(text);
  });
});
