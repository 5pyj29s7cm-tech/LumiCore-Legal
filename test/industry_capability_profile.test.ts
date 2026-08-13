import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_VARIANT } from '../shared/product_variant';
import {
  formatIndustryCapabilityProfilePrompt,
  getCurrentIndustryCapabilityProfile,
  isCurrentIndustryWorkflowExecutionRequest,
  matchCurrentIndustryWorkflow,
} from '../server/regions/packs/cn/industry_capability_profile';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { formatClientSelfPrompt } from '../server/client/self_model';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';
import { readDB, writeDB } from '../db_layer';
import { getIndustryWorkflowTask } from '../server/industry/workflow_service';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { ensureBackgroundConversationActionTask } from '../server/conversation/action_ledger';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

const SCENARIOS: Record<string, Array<{ entryId: string; command: string; question: string; status: string }>> = {
  ecommerce: [
    { entryId: 'today-operations', command: '帮我做一下今日经营分析', question: '今日经营是什么？', status: '今日经营做完了吗？' },
    { entryId: 'trend-discovery', command: '给我做一份爆款雷达', question: '爆款雷达能做什么？', status: '爆款雷达进度怎么样？' },
    { entryId: 'store-data', command: '分析一下这批店铺数据', question: '店铺数据怎么用？', status: '店铺数据结果呢？' },
    { entryId: 'listing-automation', command: '开始商品管理，整理待处理 SKU', question: '商品管理支持吗？', status: '商品管理完成了吗？' },
    { entryId: 'ai-customer-service', command: '帮我处理内容与客服草稿', question: '内容与客服是什么？', status: '内容与客服好了吗？' },
  ],
  design: [
    { entryId: 'project', command: '帮我整理这个设计项目', question: '设计项目是什么？', status: '设计项目进度呢？' },
    { entryId: 'cad', command: '开始生成 CAD 方案', question: 'CAD 方案能做什么？', status: 'CAD 方案做完了吗？' },
    { entryId: 'visualization', command: '给这个项目生成效果图', question: '效果图怎么用？', status: '效果图好了吗？' },
    { entryId: 'presentation', command: '制作一份提案 PPT', question: '提案 PPT 支持吗？', status: '提案 PPT 完成了吗？' },
    { entryId: 'handoff', command: '帮我整理交付中心的项目交付包', question: '交付中心是什么？', status: '交付中心进度怎么样？' },
  ],
  legal: [
    { entryId: 'workspace', command: '帮我建立案件工作台', question: '案件工作台是什么？', status: '案件工作台完成了吗？' },
    { entryId: 'packet', command: '帮我生成这起案件的法律文书', question: '文书生成能做什么？', status: '文书生成好了吗？' },
    { entryId: 'contract-review', command: '帮我审查这份合同', question: '合同审查是什么？', status: '合同审查做完了吗？' },
    { entryId: 'research', command: '检索一下相关法条与类案', question: '法条与类案怎么用？', status: '法条与类案结果呢？' },
    { entryId: 'asset-trace', command: '查一下被执行人的财产线索', question: '财产线索支持吗？', status: '财产线索进度怎么样？' },
    { entryId: 'verify', command: '帮我执行交付核验', question: '交付核验是什么？', status: '交付核验完成了吗？' },
    { entryId: 'bid', command: '制作一份法律服务标书', question: '标书制作能做什么？', status: '标书制作好了吗？' },
  ],
  finance: [
    { entryId: 'business-dashboard', command: '帮我做一下经营看板分析', question: '经营看板是什么？', status: '经营看板进度呢？' },
    { entryId: 'invoice-tax', command: '核对一下票税管理资料', question: '票税管理能做什么？', status: '票税管理结果呢？' },
    { entryId: 'accounting', command: '帮我处理这批账务资料', question: '账务处理怎么用？', status: '账务处理完成了吗？' },
    { entryId: 'tax-filing', command: '准备本期税务申报资料', question: '税务申报支持吗？', status: '税务申报好了吗？' },
    { entryId: 'cash-risk', command: '分析资金与风险并预测现金流', question: '资金与风险是什么？', status: '资金与风险进度怎么样？' },
    { entryId: 'report-delivery', command: '生成并核验报表交付文件', question: '报表交付能做什么？', status: '报表交付完成了吗？' },
  ],
};

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  return registry;
}

describe('industry capability profile and channel routing', () => {
  it('exposes one authoritative profile that matches the edition workspaces', () => {
    const profile = getCurrentIndustryCapabilityProfile()!;
    expect(profile.variantId).toBe(PRODUCT_VARIANT.variantId);
    expect(profile.productLine).toBe(PRODUCT_VARIANT.productLine);
    expect(profile.entries.map(entry => entry.entryId)).toEqual(SCENARIOS[PRODUCT_VARIANT.productLine].map(item => item.entryId));
    expect(profile.entries.every(entry => entry.routingTerms.length > 2)).toBe(true);
    if (profile.productLine === 'finance') {
      expect(PRODUCT_VARIANT.runtime.defaultSkills).not.toEqual(expect.arrayContaining(['stockbot', 'tushare-market-data']));
      expect(PRODUCT_VARIANT.runtime.modules).not.toEqual(expect.arrayContaining(['market-research', 'paper-trading']));
      expect(profile.optionalExtensions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'market-research', defaultEnabled: false }),
        expect.objectContaining({ id: 'paper-trading', defaultEnabled: false }),
      ]));
      expect(matchCurrentIndustryWorkflow('我想看看今天的股票行情')).toBeNull();
    }
    const prompt = formatIndustryCapabilityProfilePrompt();
    expect(prompt).toContain(PRODUCT_VARIANT.displayName);
    const routedPrompt = formatIndustryCapabilityProfilePrompt(SCENARIOS[PRODUCT_VARIANT.productLine][0].command);
    expect(routedPrompt).toContain('trusted turn context');
    expect(routedPrompt).not.toContain('and the current user request');
    for (const entry of profile.entries) expect(prompt).toContain(entry.displayName);
    expect(formatClientSelfPrompt('industry_profile_self_user')).toContain('Industry Variant Capability Profile');
  });

  it('routes every explicit industry command identically across chat, voice, task and remote-style chat', () => {
    const registry = createRegistry();
    for (const scenario of SCENARIOS[PRODUCT_VARIANT.productLine]) {
      expect(matchCurrentIndustryWorkflow(scenario.command)?.entry.entryId).toBe(scenario.entryId);
      expect(isCurrentIndustryWorkflowExecutionRequest(scenario.command)).toBe(true);
      const builds = [
        ['chat', 'chat'],
        ['voice', 'voice'],
        ['task', 'task'],
        ['chat', 'feishu_bot'],
      ] as const;
      for (const [channel, source] of builds) {
        const pipeline = buildLumiExecutionPipeline({
          dispatch: {
            userId: 'industry_channel_user',
            text: scenario.command,
            channel,
            source,
            operationMode: channel === 'task' ? 'assistant' : 'chat',
            targetIsLumi: true,
          },
          registry,
          source,
        });
        expect(pipeline.turnIntent.flow.industryWorkflowEntryId).toBe(scenario.entryId);
        expect(pipeline.execution.allowToolUse).toBe(true);
        expect(pipeline.execution.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
          'industry_workflow_start',
          'industry_workflow_complete',
        ]));
        expect(pipeline.execution.promptOverlay).toContain(`entryId=${scenario.entryId}`);
        expect(pipeline.capabilityPlan.taskLedgerRequired).toBe(false);
      }
    }
  });

  it('keeps capability questions, status follow-ups and corrections tool-free', () => {
    const registry = createRegistry();
    for (const scenario of SCENARIOS[PRODUCT_VARIANT.productLine]) {
      for (const text of [scenario.question, scenario.status, `你搞错了，我只是问${scenario.question}`]) {
        const pipeline = buildLumiExecutionPipeline({
          dispatch: {
            userId: 'industry_non_execution_user',
            text,
            channel: 'chat',
            source: 'chat',
            operationMode: 'chat',
            targetIsLumi: true,
          },
          registry,
        });
        expect(pipeline.turnIntent.flow.industryWorkflowEntryId || '').toBe('');
        expect(pipeline.execution.toolPolicy.allowedTools || []).not.toContain('industry_workflow_start');
      }
    }
  });

  it('retains the organization ledger so department and member routing can bind the same industry work', () => {
    const registry = createRegistry();
    const scenario = SCENARIOS[PRODUCT_VARIANT.productLine][0];
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'industry_org_user', text: scenario.command, channel: 'chat', source: 'feishu_bot',
        operationMode: 'chat', targetIsLumi: true, domain: 'work', orgId: 'industry_org',
      },
      registry,
      source: 'feishu_bot',
    });
    expect(pipeline.turnIntent.flow.industryWorkflowEntryId).toBe(scenario.entryId);
    expect(pipeline.capabilityPlan.taskLedgerRequired).toBe(true);
  });

  it('starts exactly one durable workflow on idempotent retry without leaking raw input into arguments or task rows', async () => {
    const registry = createRegistry();
    const scenario = SCENARIOS[PRODUCT_VARIANT.productLine][0];
    const secretRequest = `${scenario.command} PRIVATE_INDUSTRY_VALUE_7781`;
    const context = {
      userId: 'industry_idempotent_user',
      domain: 'personal',
      orgId: '',
      source: 'chat',
      actionIntent: secretRequest,
      routedTaskText: secretRequest,
      requestId: 'industry-stable-request-7781',
      idempotencyKey: 'industry-stable-request-7781',
    } as any;
    const first = JSON.parse(await registry.execute('industry_workflow_start', { entryId: scenario.entryId }, context));
    const second = JSON.parse(await registry.execute('industry_workflow_start', { entryId: scenario.entryId }, context));
    expect(first.status).toBe('created');
    expect(second.status).toBe('reused');
    expect(second.task.id).toBe(first.task.id);
    const definition = registry.get('industry_workflow_start')!;
    expect(definition.parameters.properties).not.toHaveProperty('sourceInput');
    expect(definition.parameters.properties).not.toHaveProperty('context');
    const db = readDB();
    const storedTask = getIndustryWorkflowTask({ userId: context.userId, domain: 'personal', orgId: '' }, first.task.id);
    const actionTask = db.conversationActionTasks.find((task: any) => task.id === first.conversationTaskId);
    expect(JSON.stringify(storedTask)).not.toContain('PRIVATE_INDUSTRY_VALUE_7781');
    expect(JSON.stringify(actionTask)).not.toContain('PRIVATE_INDUSTRY_VALUE_7781');

    const otherScope = { ...context, userId: 'industry_idempotent_other_user' };
    const other = JSON.parse(await registry.execute('industry_workflow_start', { entryId: scenario.entryId }, otherScope));
    expect(other.task.id).not.toBe(first.task.id);
  });

  it('binds an organization industry workflow to the existing routed action task instead of adding a duplicate ledger row', async () => {
    const registry = createRegistry();
    const scenario = SCENARIOS[PRODUCT_VARIANT.productLine][0];
    const userId = `industry_org_bind_${PRODUCT_VARIANT.productLine}`;
    const orgId = `industry_org_bind_${PRODUCT_VARIANT.productLine}`;
    const conversation = getOrCreateActiveConversation(userId, '', 'work', orgId);
    const conversationTaskId = `industry_org_action_${PRODUCT_VARIANT.productLine}`;
    const db = readDB();
    ensureBackgroundConversationActionTask(db, {
      taskId: conversationTaskId,
      conversationId: conversation.id,
      userId,
      domain: 'work',
      orgId,
      goal: scenario.command,
      target: scenario.entryId,
      requestId: `industry-org-request-${PRODUCT_VARIANT.productLine}`,
      source: 'feishu_bot',
      context: { organizationWork: { routeId: 'org_route_verified' } },
    });
    writeDB(db);
    const started = JSON.parse(await registry.execute('industry_workflow_start', { entryId: scenario.entryId }, {
      userId,
      domain: 'work',
      orgId,
      source: 'feishu_bot',
      conversationId: conversation.id,
      taskId: conversationTaskId,
      requestId: `industry-org-request-${PRODUCT_VARIANT.productLine}`,
      idempotencyKey: `industry-org-request-${PRODUCT_VARIANT.productLine}`,
      actionIntent: scenario.command,
    } as any));
    expect(started.conversationTaskId).toBe(conversationTaskId);
    const actionTasks = readDB().conversationActionTasks.filter((task: any) => task.userId === userId);
    expect(actionTasks).toHaveLength(1);
    const context = JSON.parse(actionTasks[0].context);
    expect(context.organizationWork.routeId).toBe('org_route_verified');
    expect(context.industryWorkflow).toMatchObject({
      workTakeoverTaskId: started.task.id,
      productLine: PRODUCT_VARIANT.productLine,
      entryId: scenario.entryId,
    });
  });

  it('refuses completion without a verified domain-tool receipt from the same loop', async () => {
    const registry = createRegistry();
    const scenario = SCENARIOS[PRODUCT_VARIANT.productLine][0];
    const context = {
      userId: 'industry_receipt_gate_user',
      domain: 'personal',
      orgId: '',
      source: 'voice',
      actionIntent: scenario.command,
      routedTaskText: scenario.command,
      requestId: 'industry-receipt-gate',
      idempotencyKey: 'industry-receipt-gate',
      getCurrentToolRecords: () => [],
    } as any;
    const started = JSON.parse(await registry.execute('industry_workflow_start', { entryId: scenario.entryId }, context));
    await expect(registry.execute('industry_workflow_complete', { taskId: started.task.id }, context))
      .rejects.toThrow(/No verified domain-tool receipt/);
  });

  it('settles the persistent workflow from a verified domain receipt in the same tool loop', async () => {
    const registry = createRegistry();
    const scenario = SCENARIOS[PRODUCT_VARIANT.productLine][0];
    const profile = getCurrentIndustryCapabilityProfile()!;
    const entry = profile.entries.find(candidate => candidate.entryId === scenario.entryId)!;
    const context: any = {
      userId: `industry_verified_loop_${PRODUCT_VARIANT.productLine}`,
      domain: 'personal', orgId: '', source: 'voice', actionIntent: scenario.command,
      routedTaskText: scenario.command, requestId: `industry-verified-loop-${PRODUCT_VARIANT.productLine}`,
      idempotencyKey: `industry-verified-loop-${PRODUCT_VARIANT.productLine}`,
    };
    const started = JSON.parse(await registry.execute('industry_workflow_start', { entryId: scenario.entryId }, context));
    context.getCurrentToolRecords = () => [{
      id: 'verified-domain-receipt', name: 'industry_domain_result_probe', arguments: {},
      result: JSON.stringify({ ok: true, status: 'verified', summary: entry.contract.expectedContentTerms.join(' ') }),
      terminalVerification: { status: 'verified', strategy: 'measured', reason: 'verified domain result' },
    }];
    const completed = JSON.parse(await registry.execute('industry_workflow_complete', { taskId: started.task.id }, context));
    expect(completed).toMatchObject({ ok: true, status: 'verified', persisted: true });
    const actionTask = readDB().conversationActionTasks.find((task: any) => task.id === started.conversationTaskId);
    expect(actionTask.status).toBe('completed');
  });
});
