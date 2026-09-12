import { describe, expect, it } from 'vitest';
import { evaluateLegalCaseWorkflow } from '../shared/legal_case_workflow';

describe('legal case workflow consistency', () => {
  it('derives a stable workflow from persisted case evidence', () => {
    const workflow = evaluateLegalCaseWorkflow({
      party: '甲公司',
      notes: '案件事实：甲公司已经交付货物，乙公司逾期未支付货款。',
      materials: [
        {
          type: 'evidence',
          title: '证据目录',
          content: '营业执照；授权委托书；合同原件。证明目的：证明双方合同关系及履行事实。',
        },
        {
          type: 'note',
          title: '法律分析三段论',
          content: '大前提、小前提、涵摄结论。',
        },
        {
          type: 'contract',
          title: '合同审查报告',
          content: '现行有效法律硬门槛：通过\n来源登记表\n正式交付包已生成',
        },
      ],
    });

    expect(workflow.steps.find(step => step.key === 'identity')?.state).toBe('done');
    expect(workflow.steps.find(step => step.key === 'facts')?.state).toBe('done');
    expect(workflow.steps.find(step => step.key === 'evidence')?.state).toBe('done');
    expect(workflow.steps.find(step => step.key === 'reasoning')?.state).toBe('ready');
    expect(workflow.steps.find(step => step.key === 'reasoning')?.summary).toBe('尚未形成完整法律分析底稿');
    expect(workflow.steps.find(step => step.key === 'current-law')?.state).toBe('done');
    expect(workflow.steps.find(step => step.key === 'drafts')?.state).toBe('done');
    expect(workflow.steps.find(step => step.key === 'delivery')?.state).toBe('done');
    expect(workflow.readyForFormalDelivery).toBe(true);
  });

  it('lets a blocking authority override otherwise completed work products', () => {
    const workflow = evaluateLegalCaseWorkflow({
      party: '乙公司',
      notes: '完整案件事实和时间线已经整理。',
      materials: [{
        type: 'contract',
        title: '合同审查报告',
        content: '正式交付包已生成\n现行有效法律硬门槛：未通过\n引用法条已废止',
      }],
    });

    expect(workflow.steps.find(step => step.key === 'current-law')?.state).toBe('blocked');
    expect(workflow.steps.find(step => step.key === 'delivery')?.state).toBe('blocked');
    expect(workflow.nextStep?.key).toBe('current-law');
    expect(workflow.readyForFormalDelivery).toBe(false);
  });

  it('keeps the server adapter on the shared evaluator', async () => {
    const LegalCases = await import('../server/org/legal_cases');
    const input = {
      party: '申请人',
      notes: '已经形成案件事实时间线、付款和履行情况。',
      materials: [{
        id: 'mat-1',
        type: 'evidence' as const,
        title: '证据目录',
        content: '身份证、授权委托书、证明目的、原件页码。',
        source: 'manual' as const,
        createdBy: 'test',
        createdAt: new Date().toISOString(),
      }],
    };

    expect(LegalCases.evaluateCaseWorkflow(input)).toEqual(evaluateLegalCaseWorkflow(input));
  });
});
