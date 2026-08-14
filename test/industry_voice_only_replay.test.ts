import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_VARIANT } from '../shared/product_variant';
import { formatClientSelfPrompt } from '../server/client/self_model';
import { classifyConversationActionFollowupIntent } from '../server/cognition/action_continuation';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import {
  buildDeterministicClientNavigationCommand,
  matchQuickCommand,
} from '../server/cognition/quick_commands';
import { registerAllTools } from '../server/tools/definitions';
import {
  buildVoiceConfirmationChannelScope,
  clearAllPendingConfirmationsForTests,
  consumePendingConfirmation,
  getPendingConfirmation,
  recordPendingConfirmation,
} from '../server/tools/pending_confirmation';
import { ToolRegistry } from '../server/tools/registry';

interface VoiceReplayScenario {
  command: string;
  target: string;
  action: string;
  execution: string;
  status: string;
}

const SCENARIOS: Record<string, VoiceReplayScenario[]> = {
  ecommerce: [
    { command: '打开今日经营', target: 'dashboard', action: 'open_ecommerce_dashboard', execution: '帮我做一下今日经营分析', status: '今日经营进度怎么样？' },
    { command: '进入爆款雷达', target: 'trend-discovery', action: 'open_trend_discovery', execution: '给我做一份爆款雷达', status: '爆款雷达进度怎么样？' },
    { command: '打开店铺数据', target: 'reviews', action: 'open_review_insights', execution: '分析一下这批店铺数据', status: '店铺数据结果呢？' },
    { command: '打开商品管理', target: 'listing-automation', action: 'open_listing_automation', execution: '开始商品管理，整理待处理 SKU', status: '商品管理完成了吗？' },
    { command: '打开内容与客服', target: 'ai-customer-service', action: 'open_ai_customer_service', execution: '帮我处理内容与客服草稿', status: '内容与客服好了吗？' },
  ],
  design: [
    { command: '打开设计项目', target: 'design-project', action: 'open_design_project', execution: '帮我整理这个设计项目', status: '设计项目进度呢？' },
    { command: '进入 CAD 方案', target: 'design-cad', action: 'open_design_cad', execution: '开始生成 CAD 方案', status: 'CAD 方案做完了吗？' },
    { command: '打开效果图', target: 'design-visualization', action: 'open_design_visualization', execution: '给这个项目生成效果图', status: '效果图好了吗？' },
    { command: '打开提案 PPT', target: 'design-presentation', action: 'open_design_presentation', execution: '制作一份提案 PPT', status: '提案 PPT 完成了吗？' },
    { command: '打开交付中心', target: 'design-handoff', action: 'open_design_handoff', execution: '帮我整理交付中心的项目交付包', status: '交付中心进度怎么样？' },
  ],
  legal: [
    { command: '打开案件工作台', target: 'legal-workspace', action: 'open_legal_workspace', execution: '帮我建立案件工作台', status: '案件工作台完成了吗？' },
    { command: '进入文书生成', target: 'legal-packet', action: 'open_legal_packet', execution: '帮我生成这起案件的法律文书', status: '文书生成好了吗？' },
    { command: '打开合同审查', target: 'legal-contract-review', action: 'open_legal_contract_review', execution: '帮我审查这份合同', status: '合同审查做完了吗？' },
    { command: '打开法条与类案', target: 'legal-research', action: 'open_legal_research', execution: '检索一下相关法条与类案', status: '法条与类案结果呢？' },
    { command: '打开财产线索', target: 'legal-asset-trace', action: 'open_legal_asset_trace', execution: '查一下被执行人的财产线索', status: '财产线索进度怎么样？' },
    { command: '打开交付核验', target: 'legal-verify', action: 'open_legal_verify', execution: '帮我执行交付核验', status: '交付核验完成了吗？' },
    { command: '打开标书制作', target: 'legal-bid', action: 'open_legal_bid', execution: '制作一份法律服务标书', status: '标书制作好了吗？' },
  ],
  finance: [
    { command: '打开经营看板', target: 'finance-business-dashboard', action: 'open_finance_business_dashboard', execution: '帮我做一下经营看板分析', status: '经营看板进度呢？' },
    { command: '进入票税管理', target: 'finance-invoice-tax', action: 'open_finance_invoice_tax', execution: '核对一下票税管理资料', status: '票税管理结果呢？' },
    { command: '打开账务处理', target: 'finance-accounting', action: 'open_finance_accounting', execution: '帮我处理这批账务资料', status: '账务处理完成了吗？' },
    { command: '打开税务申报', target: 'finance-tax-filing', action: 'open_finance_tax_filing', execution: '准备本期税务申报资料', status: '税务申报好了吗？' },
    { command: '打开资金与风险', target: 'finance-cash-risk', action: 'open_finance_cash_risk', execution: '分析资金与风险并预测现金流', status: '资金与风险进度怎么样？' },
    { command: '打开报表交付', target: 'finance-report-delivery', action: 'open_finance_report_delivery', execution: '生成并核验报表交付文件', status: '报表交付完成了吗？' },
  ],
};

let registry: ToolRegistry;

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
  registry = new ToolRegistry();
  registerAllTools(registry);
});

function build(text: string, channel: 'chat' | 'voice') {
  return buildLumiExecutionPipeline({
    dispatch: {
      userId: `industry-voice-only-${channel}`,
      text,
      channel,
      source: channel,
      operationMode: 'chat',
      targetIsLumi: true,
    },
    registry,
    source: channel,
  });
}

describe('industry edition pure voice replay', () => {
  it('introduces the exact edition without starting work', () => {
    expect(formatClientSelfPrompt('industry_voice_only_user')).toContain(PRODUCT_VARIANT.displayName);
    const pipeline = build('介绍一下你自己和你的主要工作。', 'voice');
    expect(pipeline.execution.toolPolicy.allowedTools || []).not.toContain('industry_workflow_start');
  });

  it('opens every spoken industry workspace through the native client action only', async () => {
    for (const scenario of SCENARIOS[PRODUCT_VARIANT.productLine]) {
      const intent = normalizeActionIntent(scenario.command);
      expect(intent).toMatchObject({
        kind: 'client_navigation',
        operation: 'navigate',
        target: scenario.target,
        clientAction: scenario.action,
      });

      const voice = build(scenario.command, 'voice');
      const chat = build(scenario.command, 'chat');
      expect(voice.turnIntent.flow.clientActionOnlyTurn).toBe(true);
      expect(voice.turnIntent.flow.industryWorkflowEntryId || '').toBe('');
      expect(new Set(voice.execution.toolPolicy.allowedTools)).toEqual(new Set(['client_get_state', 'client_action']));
      expect(new Set(chat.execution.toolPolicy.allowedTools)).toEqual(new Set(voice.execution.toolPolicy.allowedTools));
      expect(voice.execution.toolPolicy.allowedTools).not.toContain('desktop_open');
      expect(voice.execution.toolPolicy.allowedTools).not.toContain('industry_workflow_start');

      const deterministic = buildDeterministicClientNavigationCommand(
        voice.normalizedIntent,
      );
      expect(deterministic?.toolCall).toEqual({
        name: 'client_action',
        arguments: { action: scenario.action },
      });
      expect(deterministic?.formatToolResult?.(JSON.stringify({
        ok: true,
        verification: { status: 'verified' },
      }))).toContain('\u5df2\u6253\u5f00');
      const quick = await matchQuickCommand(scenario.command, 'industry_voice_only_user');
      expect(quick?.toolCall).toEqual({ name: 'client_action', arguments: { action: scenario.action } });
    }
  });

  it('keeps execution, progress and correction as one durable voice task lifecycle', () => {
    const scenario = SCENARIOS[PRODUCT_VARIANT.productLine][0];
    const execution = build(scenario.execution, 'voice');
    expect(execution.turnIntent.flow.industryWorkflowEntryId).toBeTruthy();
    expect(execution.execution.toolPolicy.allowedTools).toContain('industry_workflow_start');

    const state = {
      version: 2, taskId: 'voice-industry-task', status: 'executing', goal: scenario.execution,
      latestInstruction: scenario.execution, appTarget: scenario.target, sourcePaths: [], receipts: [],
      unfinished: true, evidenceTools: [], assistantState: '', toolSummaries: [], revision: 1,
      updatedAt: new Date().toISOString(),
    } as any;
    expect(classifyConversationActionFollowupIntent(scenario.status, state)).toBe('status');
    const status = build(scenario.status, 'voice');
    expect(status.execution.toolPolicy.allowedTools || []).not.toContain('industry_workflow_start');
    const correction = build(`你搞错了，我只是问${scenario.status}`, 'voice');
    expect(correction.execution.toolPolicy.allowedTools || []).not.toContain('industry_workflow_start');
  });

  it('carries an exact pending confirmation across separate voice utterance request ids', () => {
    clearAllPendingConfirmationsForTests();
    const channelScope = buildVoiceConfirmationChannelScope({
      domain: 'personal', orgId: '', channelId: 'voice-socket-1', taskId: 'durable-task-1',
    });
    const pending = recordPendingConfirmation(
      'industry_voice_confirm_user',
      'wechat_send_message',
      { contact: '客户甲', message: '确认后的正文' },
      'voice',
      { ...channelScope, taskId: 'durable-task-1', actionIntent: '给客户甲发送确认后的正文' },
    );

    const nextUtterance = getPendingConfirmation('industry_voice_confirm_user', channelScope);
    expect(nextUtterance?.id).toBe(pending.id);
    expect(nextUtterance?.taskId).toBe('durable-task-1');
    expect(consumePendingConfirmation(
      'industry_voice_confirm_user',
      pending.id,
      pending.toolName,
      pending.exactArgs,
      channelScope,
    )).toBe(true);
    expect(getPendingConfirmation('industry_voice_confirm_user', channelScope)).toBeNull();
  });
});
