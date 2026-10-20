import { describe, expect, it, vi } from 'vitest';
import { classifyExecutionGuardIntent, decideExecutionGuardRecovery, finalizeExecutionForOutboundDelivery } from '../server/cognition/execution_guard_recovery';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { hasExplicitToolIntent, traceToolIntentDecision } from '../server/cognition/tool_intent';
import type { ToolExecutionRecord } from '../server/tools/types';

const originalRequest = '下面是虚构程序验收素材，不是真实委托案件。只在当前隔离个人聊天里处理，不要创建或归档案件，不要向法院提交任何材料。请现在直接提炼争议焦点，不要介绍办理方法，也不要起草诉状。2026年9月1日虚构甲公司与虚构乙公司订立买卖合同，9月5日交货。原告甲公司主张被告乙公司仍欠货款9万元；被告称其中7万元已经付款，目前只有付款截图，原始银行流水和收款记录尚未核实。被告同时主张货物存在质量问题，但没有检验报告，质量争议尚未检验。请分项给出付款抵扣及欠款金额、货物质量与付款抗辩这两个方面的争议焦点、双方主张、待证事实和需要补核实的证据；对7万元付款和质量缺陷都保留未核实状态，不作确定认定。只返回面向律师复核的争点工作稿。';
const missingToolReason = 'No successful current-turn tool execution was recorded for that execution-status claim.';
const legalText = '争议焦点：付款抵扣及欠款金额；货物质量与付款抗辩。7万元截图和质量缺陷均待核实，须补银行原始流水及检验材料。';
const legalRecord: ToolExecutionRecord = {
  id: 'dispute-receipt', name: 'legal_extract_dispute_focus', arguments: { facts: 'fictional facts', persistCase: false }, result: legalText,
  terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'verified tool return' },
};

function blockedInput(task = originalRequest) {
  return { task, responseText: 'Internal execution recovery: without a current-turn tool receipt',
    finalization: { text: 'Internal execution recovery: without a current-turn tool receipt', blocked: true, reason: missingToolReason },
    allowToolUse: true, toolRecords: [] as ToolExecutionRecord[],
    finalize: (text: string, records: ToolExecutionRecord[]) => ({ text, blocked: !records.some(record => record.terminalVerification?.status === 'verified'), reason: records.length ? '' : missingToolReason }),
  };
}

describe('first legal chat execution guard regression', () => {
  it.each([originalRequest, '请直接提炼争议焦点，保留未核实状态并列出待证事实和证据。'])('reuses existing explicit legal work intent despite supplied status/evidence nouns', task => {
    expect(normalizeActionIntent(task).relation).toBe('new');
    expect(hasExplicitToolIntent(task)).toBe(true);
    expect(traceToolIntentDecision(task, 'chat', 'assistant').allowToolUse).toBe(true);
    expect(classifyExecutionGuardIntent(task)).toBe('action_execution');
    expect(decideExecutionGuardRecovery({ task, blocked: true, reason: missingToolReason, allowToolUse: true, toolRecords: [] }))
      .toMatchObject({ recoverable: true, intent: 'action_execution', code: 'missing_tool_execution' });
  });

  it('runs the existing bounded recovery and returns the verified legal work product', async () => {
    const attempt = vi.fn(async ({ recordTool }) => { recordTool(legalRecord); return { text: legalText, toolRecords: [legalRecord] }; });
    const result = await finalizeExecutionForOutboundDelivery({ ...blockedInput(), attempt });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ attempted: true, recoveryFailed: false, decision: { intent: 'action_execution' },
      finalization: { blocked: false, reason: '' } });
    expect(result.toolRecords).toHaveLength(1);
    expect(result.toolRecords[0]).toMatchObject({ name: 'legal_extract_dispute_focus', terminalVerification: { status: 'verified' } });
    expect(result.finalization.text).toContain('争议焦点');
    expect(result.finalization.text).not.toMatch(/persistCase|fictional facts|Internal execution recovery/);
  });

  it('keeps the first task blocked when recovery still has no tool receipt', async () => {
    const attempt = vi.fn(async () => ({ text: '这项操作还没完成。', toolRecords: [] }));
    const result = await finalizeExecutionForOutboundDelivery({ ...blockedInput(), attempt });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ attempted: true, recoveryFailed: true, finalization: { blocked: true, reason: 'execution_recovery_incomplete' } });
    expect(result.finalization.reason).not.toBe('task_status');
  });

  it('keeps missing recovery capability blocked without inventing a status answer', async () => {
    const result = await finalizeExecutionForOutboundDelivery(blockedInput());
    expect(result).toMatchObject({ attempted: false, finalization: { blocked: true } });
    expect(result.finalization.reason).not.toBe('task_status');
  });

  it.each(['刚才任务的结果是什么？', '当前任务进度怎么样了？', '刚才那次执行有什么证据？', '任务完成了吗？'])('preserves genuine receipt/status queries without authorizing recovery: %s', async task => {
    expect(hasExplicitToolIntent(task)).toBe(false);
    expect(classifyExecutionGuardIntent(task)).toBe('status_query');
    const attempt = vi.fn(async () => ({ text: legalText, toolRecords: [legalRecord] }));
    const result = await finalizeExecutionForOutboundDelivery({ ...blockedInput(task), attempt });
    expect(attempt).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attempted: false, decision: { intent: 'status_query' }, finalization: { blocked: false, reason: 'task_status' } });
  });
});
