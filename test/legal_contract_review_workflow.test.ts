import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import {
  extractInlineContractText,
  isInlineContractReviewRequest,
  legalContractReviewWorkflow,
} from '../server/skills/bundled/legal-casework/contract_review_workflow';
import { matchSkillWorkflow } from '../server/skills/workflow_registry';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';

const PROMPT = '律师版实机验收·合同审查：请审查下面这段模拟买卖合同条款，只依据原文输出“风险点、建议修改、待确认信息、律师复核边界”，不要补造交易背景、证据或具体法条，不要发送、提交或签署。条款：甲方向乙方采购设备，合同总价80万元；乙方应在付款后30日内交货；验收标准未约定；甲方可以随时解除合同且不承担责任；乙方每逾期一日按合同总价5%支付违约金；争议由甲方所在地法院管辖。完成后告诉我实际使用了什么能力、结果是否已验证。';

beforeAll(async () => {
  const app = await makeApp();
  return app.cleanup;
});

describe('verified inline contract review workflow', () => {
  it('routes the exact visible test prompt to one legal contract-review tool', () => {
    expect(isInlineContractReviewRequest(PROMPT)).toBe(true);
    expect(extractInlineContractText(PROMPT)).toContain('验收标准未约定');
    expect(extractInlineContractText(PROMPT)).not.toContain('完成后告诉我');
    const workflow = matchSkillWorkflow(PROMPT);
    expect(workflow?.id).toBe('verified_inline_contract_review');
    expect(workflow?.requiredTools).toEqual(['legal_review_contract']);
  });

  it('keeps the matched workflow as a model hint without taking Chat routing away from the model', () => {
    const registry = new ToolRegistry();
    registerLegalTools(registry);
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'vitest-contract-review',
        text: PROMPT,
        channel: 'chat',
        source: 'chat',
        domain: 'personal',
        orgId: '',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
    });
    expect(pipeline.turnIntent.flow.workflowHint?.id).toBe('verified_inline_contract_review');
    expect(pipeline.turnIntent.flow.workflowRouting).toBe('model_hint');
    expect(pipeline.turnIntent.flow.specialWorkflow).toBeNull();
    expect(pipeline.turnIntent.flow.modelToolAccess).toBe('manifest');
    expect(pipeline.execution.toolPolicy.allowedTools).toContain('legal_review_contract');
    expect(pipeline.execution.promptOverlay).not.toContain('Selected workflow adapter is restricted to:');
  });

  it('does not hijack contract drafting or a general how-to question', () => {
    expect(isInlineContractReviewRequest('请起草一份设备采购合同，条款：总价80万元。')).toBe(false);
    expect(isInlineContractReviewRequest('合同审查一般要看什么？')).toBe(false);
  });

  it('passes source-only and no-citation boundaries to the real tool', async () => {
    const desktopRelay = vi.fn().mockResolvedValue('# 合同审查结果\n\n## 风险点\n1. 验收标准缺失。');
    await legalContractReviewWorkflow.run({
      socket: {} as any,
      userText: PROMPT,
      userId: 'user-1',
      desktopRelay,
      speak: async () => 0,
      voiceScope: { domain: 'personal', orgId: '' },
    });
    expect(desktopRelay).toHaveBeenCalledTimes(1);
    expect(desktopRelay).toHaveBeenCalledWith('legal_review_contract', expect.objectContaining({
      sourceOnly: true,
      omitSpecificLawCitations: true,
      persistCase: false,
    }));
  });

  it('produces a verified source-only receipt without fabricated law or external action', async () => {
    const registry = new ToolRegistry();
    registerLegalTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'legal_review_contract',
      arguments: {
        contract: extractInlineContractText(PROMPT),
        sourceOnly: true,
        omitSpecificLawCitations: true,
        persistCase: false,
      },
      context: {
        userId: 'vitest-contract-review',
        orgId: '',
        domain: 'personal',
        authenticated: true,
        authRole: 'user',
        localExecution: true,
        executionBoundary: 'trusted_local',
      },
    });
    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(record.receipt).toMatchObject({ ok: true, status: 'reviewed', persisted: false });
    expect(record.result).toContain('## 风险点');
    expect(record.result).toContain('验收标准');
    expect(record.result).toContain('合同总价5%');
    expect(record.result).toContain('甲方所在地法院');
    expect(record.result).not.toMatch(/民法典|第\s*\d+\s*条/u);

    const contract = buildActionContract(PROMPT);
    expect(hasCoreActionEvidence(contract, [record], PROMPT)).toBe(true);
    const final = finalizeLumiResponse({
      taskText: PROMPT,
      responseText: record.result,
      toolRecords: [record],
      source: 'legal_contract_review',
    });
    expect(final.blocked).toBe(false);
    expect(final.text).toContain('实际使用能力：legal_review_contract');
    expect(final.text).toContain('已通过结构化工具回执验证');
  });
});
