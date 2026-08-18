import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import {
  isLegalDeliveryVerificationRequest,
  legalDeliveryVerificationWorkflow,
} from '../server/skills/bundled/legal-casework/delivery_verification_workflow';
import { registerProductVariantTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

const PROMPT = '律师版实机验收·交付核验：针对四号案件ID d2789373-effc-404c-aff6-25f101267790，对案件工作台中已归档的“诉前应对策略律师复核草稿”执行交付核验。实际核对案件事实、引用与法源状态、时效和管辖信息、草稿文件状态、律师复核边界；不得把缺失项说成通过，不要重新生成文书，不要登录外部网站，不要发送、提交或签署。输出每项通过/阻断/待确认、总体是否可正式交付、下一步、实际使用能力和任务回执状态。';

describe('verified archived legal delivery workflow', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('routes the exact delivery verification prompt to the deterministic legal workflow', () => {
    const registry = new ToolRegistry();
    registerProductVariantTools(registry);
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'user-1', text: PROMPT, channel: 'chat', source: 'chat', domain: 'personal', orgId: '',
        operationMode: 'assistant', targetIsLumi: true,
      },
      registry,
    });
    expect(pipeline.turnIntent.flow.specialWorkflow?.id).toBe('verified_archived_delivery');
    expect(pipeline.capabilityPlan.lane).toBe('skill_workflow');
    expect(pipeline.executionPlan.nodes.some(node => node.capabilityId === 'legal-casework/verified_archived_delivery')).toBe(true);
  });

  it('does not intercept navigation-only or old-task status questions', () => {
    expect(isLegalDeliveryVerificationRequest('打开交付核验，只执行客户端导航，不要检查文书。')).toBe(false);
    expect(isLegalDeliveryVerificationRequest('刚才的交付核验完成了吗？')).toBe(false);
  });

  it('uses the exact case and archived draft through one receipt-backed tool', async () => {
    const desktopRelay = vi.fn(async () => '# 已归档文书交付核验\n- 不可正式交付。');
    const result = await legalDeliveryVerificationWorkflow.run({
      socket: {} as any,
      userText: PROMPT,
      userId: 'user-1',
      desktopRelay,
      speak: async () => 0,
      voiceScope: { domain: 'personal', orgId: '' },
    });
    expect(desktopRelay).toHaveBeenCalledWith('legal_verify_archived_delivery', {
      caseId: 'd2789373-effc-404c-aff6-25f101267790',
      materialTitle: '诉前应对策略律师复核草稿',
    });
    expect(result.responseText).toContain('不可正式交付');
  });
});
