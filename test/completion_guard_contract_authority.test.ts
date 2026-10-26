import { describe, expect, it } from 'vitest';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { buildActionEvidenceContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { buildToolExecutionEnvelope } from '../server/tools/execution_envelope';
import type { ToolExecutionRecord } from '../server/tools/types';
const scope = { requestId: 'current-composite-request', taskId: 'current-composite-task' };
const task = '打开技能大厅，然后打开计算器。';
const verification = { status: 'verified' as const, strategy: 'state_diff' as const, reason: 'Exact synthetic native post-state observed.' };
const client: ToolExecutionRecord = { ...scope, name: 'client_action', arguments: { action: 'open_skills' }, result: JSON.stringify({ ok: true, action: 'open_skills', verification: { status: 'verified' } }), terminalVerification: verification };
const app: ToolExecutionRecord = { ...scope, name: 'desktop_open', arguments: { target: '计算器' }, result: JSON.stringify({ ok: true, status: 'verified', targetMatched: true, requestedTarget: '计算器', actualTarget: { processName: 'CalculatorApp.exe', title: '计算器', processId: 12 } }), terminalVerification: verification };
const response = '已完成全部操作。';
const avatarTask = '在记忆领地创建一个虚拟人物并配置眨眼动画。';
const avatar: ToolExecutionRecord = { ...scope, name: 'memory_avatar_create', arguments: {}, result: JSON.stringify({ verified: true, saved: true, avatarId: 'synthetic-own-avatar', animation: { configured: true, blink: true } }), terminalVerification: verification, capability: { capabilityId: 'memory.avatar.create', lane: 'system', operation: 'create', risk: 'low', sideEffects: [{ type: 'local_state_change', scope: 'current-user', reversible: true }], verification: { strategy: 'state_diff', required: true, requiredFields: [], successSignals: [], limitations: [] } } };
function guard(records: ToolExecutionRecord[], text = response) { return guardCompletionClaims({ task, response: text, toolCalls: records, ...scope }); }
describe('completion guard uses the existing whole action contract', () => {
  it.each([[client, '打开计算器'], [app, '打开技能大厅']] as const)('does not let one completed component satisfy the whole task', (record, missing) => {
    const contract = buildActionEvidenceContract(task);
    expect(contract.components).toHaveLength(2);
    expect(hasCoreActionEvidence(contract, [record], task, undefined, scope)).toBe(false);
    const result = guard([record]);
    expect(result.blocked).toBe(true);
    expect(result.text).toContain(missing);
    expect(result.text).toContain('已经完成的部分会保留');
    expect(result.text).not.toContain(response);
  });
  it('accepts all components once, preserving the model reply', () => {
    expect(hasCoreActionEvidence(buildActionEvidenceContract(task), [client, app], task, undefined, scope)).toBe(true);
    expect(guard([client, app])).toMatchObject({ blocked: false, text: response });
  });
  it.each([
    { ...app, error: 'private diagnostic', result: '', terminalVerification: { ...verification, status: 'failed' as const } },
    { ...app, result: JSON.stringify({ status: 'waiting_confirmation', requiresConfirmation: true }), terminalVerification: { ...verification, status: 'unverified' as const } },
    { ...app, result: JSON.stringify({ status: 'unknown' }), terminalVerification: { ...verification, status: 'unverified' as const } },
    { ...app, requestId: 'prior-request' },
    { ...app, taskId: 'other-task' },
  ])('rejects failed, waiting, unknown, or stale evidence for an unfinished component', record => {
    const result = guard([client, record]);
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('打开计算器');
    expect(result.text).not.toContain('private diagnostic');
  });
  it('does not let an arbitrary successful handler override a missing component', () => {
    expect(guard([client, { ...scope, name: 'arbitrary_adapter', arguments: {}, result: JSON.stringify({ ok: true, status: 'completed' }) }]).blocked).toBe(true);
  });
  it('does not reclassify a verified app-state creation as physical file creation', () => {
    const text = '已创建人物并配置眨眼动画。';
    expect(hasCoreActionEvidence(buildActionEvidenceContract(avatarTask), [avatar], avatarTask, undefined, scope)).toBe(true);
    expect(guardCompletionClaims({ task: avatarTask, response: text, toolCalls: [avatar], ...scope })).toMatchObject({ blocked: false, text });
  });
  it('preserves generic producer checks for an unclassified task', () => {
    expect(guardCompletionClaims({ task: '确认', response: '已新建并写好了。', toolCalls: [{ name: 'write_file', arguments: { path: 'D:/virtual/note.txt' }, result: 'File written: D:/virtual/note.txt' }] }).blocked).toBe(false);
  });
});

describe('canonical non-success never becomes completed action evidence', () => {
  function canonical(status: 'verified_success' | 'unknown_outcome' | 'waiting_confirmation' | 'failed' | 'timeout' | 'forbidden' | 'target_mismatch'): ToolExecutionRecord {
    const record: ToolExecutionRecord = { ...scope, name: 'synthetic_send_adapter', arguments: {},
      capability: { capabilityId: 'synthetic.send', lane: 'messaging', operation: 'communicate', risk: 'medium',
        sideEffects: [{ type: 'external_communication', scope: 'current-synthetic-recipient', reversible: false }],
        verification: { strategy: 'provider_ack', required: true, requiredFields: [], successSignals: ['provider acknowledgement'], limitations: [] } }, result: JSON.stringify({ ok: true, status: status === 'unknown_outcome' ? 'unknown' : 'completed' }), terminalVerification: { ...verification, status: status === 'unknown_outcome' ? 'unverified' : 'verified' } };
    return { ...record, envelope: { ...buildToolExecutionEnvelope(record), status } };
  }
  it.each(['unknown_outcome', 'waiting_confirmation', 'failed', 'timeout', 'forbidden', 'target_mismatch'] as const)('does not use canonical %s as a successful generic action', status => {
    const result = guardCompletionClaims({ task: '确认', response: '任务已完成。', toolCalls: [canonical(status)], ...scope });
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('任务已完成');
  });
  it.each(['任务已完成。', '正在执行。'])('reports uncertainty without claiming an unstarted or rolled-back action: %s', text => {
    const result = guardCompletionClaims({ task: '确认', response: text, toolCalls: [canonical('unknown_outcome')], ...scope });
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('结果尚未确认');
    expect(result.text).not.toMatch(/还没有开始|没有开始|回滚|重试/);
  });
  it('does not let wording clear a current unknown execution outcome', () => {
    const text = '执行结果尚未确认，请核对原操作。';
    expect(guardCompletionClaims({ task: '确认', response: text, toolCalls: [canonical('unknown_outcome')], ...scope }))
      .toMatchObject({ blocked: true, reason: 'Current-turn canonical execution outcome is unknown.' });
  });
  it('preserves a canonical verified-success receipt and the existing legacy path', () => {
    expect(guardCompletionClaims({ task: '确认', response: '任务已完成。', toolCalls: [canonical('verified_success')], ...scope }).blocked).toBe(false);
  });
});
