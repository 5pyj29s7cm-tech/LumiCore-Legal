import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { legalAuthorityResearchWorkflow } from '../server/skills/bundled/legal-casework/authority_research_workflow';
import { registerProductVariantTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

const PROMPT = '基于四号案件ID d2789373-effc-404c-aff6-25f101267790，只使用可核验权威来源输出法条与类案检索结果、来源状态和任务回执状态。';

describe('verified legal authority research workflow', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('keeps substantive authority work as a model hint inside the Chat manifest', () => {
    const registry = new ToolRegistry();
    registerProductVariantTools(registry);
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'user-1', text: PROMPT, channel: 'chat', source: 'chat', domain: 'personal', orgId: '',
        operationMode: 'assistant', targetIsLumi: true,
      },
      registry,
    });
    expect(pipeline.turnIntent.flow.workflowHint?.id).toBe('verified_authority_research');
    expect(pipeline.turnIntent.flow.workflowRouting).toBe('model_hint');
    expect(pipeline.turnIntent.flow.specialWorkflow).toBeNull();
    expect(pipeline.turnIntent.flow.modelToolAccess).toBe('manifest');
    expect(pipeline.execution.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
      'legal_case_workflow_status',
      'legal_authority_source_status',
      'legal_search_statute',
      'legal_search_case',
    ]));
    expect(pipeline.execution.promptOverlay).not.toContain('Selected workflow adapter is restricted to:');
  });

  it('does not intercept navigation-only requests', () => {
    expect(legalAuthorityResearchWorkflow.match('打开法条与类案工作区，只执行客户端导航，不要检索。')).toBe(false);
  });

  it('uses only receipt-backed local/configured source operations and reports no-hit boundaries', async () => {
    const desktopRelay = vi.fn(async (name: string) => {
      if (name === 'legal_case_workflow_status') return '# 四号案件 案件闭环状态\n- 案件ID：d2789373-effc-404c-aff6-25f101267790\n- 当事人：甲公司；乙公司\n- 案由：买卖合同纠纷\n- 事实摘要：争议金额80万元';
      if (name === 'legal_authority_source_status') return '# 权威来源状态\n- 国家法律法规数据库：暂时不可用';
      if (name === 'legal_external_source_status') return '# 外部法律数据源接入状态\n## 统一口径\n- 未配置 API 的来源只允许网页登录协作。';
      if (name === 'legal_search_statute') return '未找到与“买卖合同纠纷”相关的法条。';
      if (name === 'legal_search_case') return '本地知识库中未找到相似案例。';
      return '# 四号案件\n## 六、检索词\n1. 买卖合同纠纷 履行 违约';
    });
    const result = await legalAuthorityResearchWorkflow.run({
      socket: {} as any,
      userText: PROMPT,
      userId: 'user-1',
      desktopRelay,
      speak: async () => 0,
      voiceScope: { domain: 'personal', orgId: '' },
    });
    expect(desktopRelay.mock.calls.map(call => call[0])).toEqual([
      'legal_case_workflow_status',
      'legal_authority_source_status',
      'legal_external_source_status',
      'legal_search_statute',
      'legal_search_case',
      'legal_external_research_plan',
    ]);
    expect(result.responseText).toContain('无法完成实质法条或类案检索');
    expect(result.responseText).toContain('未自动登录任何外部网站');
  });
});
