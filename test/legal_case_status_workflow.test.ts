import { describe, expect, it, vi } from 'vitest';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import {
  formatLegalCaseStatusResponse,
  isLegalCaseReadOnlyStatusRequest,
  parseLegalCaseStatus,
} from '../server/cognition/legal_case_status';
import { legalCaseStatusWorkflow } from '../server/skills/bundled/legal-casework/status_workflow';
import { appendReadOnlyConversationActionReceipts } from '../server/conversation/action_ledger';

const STATUS = `# 律师版稳定性验收四号买卖合同纠纷 案件闭环状态

- 案件ID：d2789373-effc-404c-aff6-25f101267790
- 当事人：四号甲公司；四号乙公司
- 案由：买卖合同纠纷
- 完成度：3/10（30%）
- 阻断项：2
- 待补项：5
- 下一动作：材料入案：补齐合同原件（推荐 legal_case_workspace）

## 已知事实与现有材料
- 事实摘要：争议金额：人民币80万元

## 证据缺口与待核验事项
- 买卖合同原件、签署页和附件
`;

describe('legal case read-only status workflow', () => {
  const prompt = '同步验收：请用一句话确认你还记得四号案件的案件ID和争议金额，不要创建新任务，不要调用外部平台。';

  it('classifies case recall as a read-only workspace status contract', () => {
    expect(isLegalCaseReadOnlyStatusRequest(prompt)).toBe(true);
    const contract = buildActionContract(prompt);
    expect(contract.kind).toBe('legal_workspace');
    expect(contract.preferredTools).toEqual(['legal_case_workflow_status']);
    expect(contract.preferredTools).not.toContain('legal_generate_argument_or_opinion');
    expect(hasCoreActionEvidence(contract, [{
      id: 'status',
      name: 'legal_case_workflow_status',
      arguments: {},
      result: STATUS,
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'Read-only case status returned from the persistent legal ledger.',
      },
    }], prompt)).toBe(true);
  });

  it('does not steal create or draft operations', () => {
    expect(isLegalCaseReadOnlyStatusRequest('新建一个测试案件工作台，创建后告诉我案件ID和争议金额。')).toBe(false);
    expect(isLegalCaseReadOnlyStatusRequest('基于当前案件生成诉前策略草稿，完成后告诉我回执状态。')).toBe(false);
    expect(isLegalCaseReadOnlyStatusRequest('微信/飞书发给 Lumi bot 的法院短信链接和案件材料，自动入案并整理下一步')).toBe(false);
    expect(isLegalCaseReadOnlyStatusRequest(
      '基于四号案件ID d2789373-effc-404c-aff6-25f101267790，只使用可核验权威来源输出法条与类案检索结果、来源状态和任务回执状态。',
    )).toBe(false);
  });

  it('parses and formats only receipt-backed fields', () => {
    expect(parseLegalCaseStatus(STATUS)).toMatchObject({
      title: '律师版稳定性验收四号买卖合同纠纷',
      caseId: 'd2789373-effc-404c-aff6-25f101267790',
      amount: '80万元',
    });
    expect(formatLegalCaseStatusResponse(prompt, STATUS)).toBe(
      '记得，案件 ID 是 d2789373-effc-404c-aff6-25f101267790，争议金额是 80万元。',
    );
  });

  it('runs one local status tool and never creates a task', async () => {
    const desktopRelay = vi.fn().mockResolvedValue(STATUS);
    const result = await legalCaseStatusWorkflow.run({
      socket: {} as any,
      userText: prompt,
      userId: 'user-1',
      desktopRelay,
      speak: async () => 0,
      voiceScope: { domain: 'personal', orgId: '' },
    });
    expect(legalCaseStatusWorkflow.createsTask).toBe(false);
    expect(desktopRelay).toHaveBeenCalledTimes(1);
    expect(desktopRelay).toHaveBeenCalledWith('legal_case_workflow_status', {});
    expect(result.responseText).toContain('争议金额是 80万元');
  });

  it('binds the read receipt to an existing case task instead of creating a status task', () => {
    const caseTask = {
      id: 'task-case', conversationId: 'conv-1', userId: 'user-1', domain: 'personal', orgId: '',
      parentTaskId: '', rootUserMessageId: '', intentKind: 'legal_document', operation: 'create',
      goal: '基于案件ID d2789373-effc-404c-aff6-25f101267790生成律师复核草稿', target: '',
      status: 'completed', blocker: '', activeRequestId: '', completionSource: 'tool_receipt', context: '{}',
      revision: 1, createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z', completedAt: '2026-08-16T00:00:00.000Z',
    };
    const accidentalStatusTask = {
      ...caseTask,
      id: 'task-status',
      intentKind: 'none',
      operation: 'read',
      goal: prompt,
      status: 'planning',
    };
    const db: any = { conversationActionTasks: [caseTask, accidentalStatusTask], conversationActionReceipts: [] };
    const records: any[] = [{ id: 'receipt-status', name: 'legal_case_workflow_status', arguments: {}, result: STATUS }];
    const appended = appendReadOnlyConversationActionReceipts(db, {
      conversationId: 'conv-1', userId: 'user-1', records,
      anchors: ['d2789373-effc-404c-aff6-25f101267790', '律师版稳定性验收四号买卖合同纠纷'],
      preferredIntentKinds: ['legal_workspace', 'legal_document'], requestId: 'request-1',
    });
    expect(db.conversationActionTasks).toHaveLength(2);
    expect(appended).toHaveLength(1);
    expect(appended[0].taskId).toBe('task-case');
  });
});
