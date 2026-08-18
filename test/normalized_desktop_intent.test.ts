import { describe, expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';

describe('normalized desktop intent priority', () => {
  it('recognizes a concrete local application target', () => {
    expect(normalizeActionIntent('帮我打开记事本')).toMatchObject({
      kind: 'desktop_operation',
      operation: 'navigate',
      target: '记事本',
      sideEffectClass: 'none',
    });
  });

  it('keeps Lumi client navigation ahead of generic desktop control', () => {
    expect(normalizeActionIntent('打开聊天界面')).toMatchObject({
      kind: 'client_navigation',
      clientAction: 'open_chat',
    });
  });

  it('keeps inbound semantic roles ahead of action-shaped words', () => {
    expect(normalizeActionIntent('张勇给我发了什么')).toMatchObject({
      kind: 'messaging_read',
      sideEffectClass: 'none',
    });
  });

  it('keeps external AI history in its own read-only lane', () => {
    expect(normalizeActionIntent('读取 ChatGPT 里的聊天历史并同步新增消息')).toMatchObject({
      kind: 'external_ai_history',
      operation: 'read',
      target: 'ChatGPT',
      sideEffectClass: 'none',
      rule: 'external-ai-history-read',
    });
    expect(normalizeActionIntent('Lumi 可以读取外部 AI 里的聊天内容吗？')).toMatchObject({
      kind: 'external_ai_history',
      operation: 'read',
      target: 'external_ai',
      sideEffectClass: 'none',
    });
  });

  it('does not turn a fresh external AI prompt into history access', () => {
    expect(normalizeActionIntent('问问 ChatGPT 并让它回答聊天历史应该怎么迁移')).not.toMatchObject({
      kind: 'external_ai_history',
    });
    expect(normalizeActionIntent('打开Lumi指挥中心，只执行客户端导航，不要打开其他程序。')).toMatchObject({
      kind: 'client_navigation',
      operation: 'navigate',
      target: 'command-center',
      clientAction: 'open_command_center',
      sideEffectClass: 'none',
    });
  });

  it('keeps business-result gap questions read-only despite negated artifact words', () => {
    expect(normalizeActionIntent('这个案子还缺什么？请接着刚才的结果直接回答，不要重新生成文件。')).toMatchObject({
      kind: 'status_query',
      operation: 'status',
      target: 'recent_task',
      sideEffectClass: 'none',
      relation: 'status',
      rule: 'business-result-followup-before-action',
    });
    expect(normalizeActionIntent('这个案子下一步怎么做？')).toMatchObject({
      kind: 'status_query',
      operation: 'status',
    });
    expect(normalizeActionIntent('缺少材料，帮我重新生成案件清单')).not.toMatchObject({
      kind: 'status_query',
    });
  });
});

describe('fresh action versus trailing status wording', () => {
  it('does not turn a new action with a trailing receipt request into old-task status', () => {
    const text = '\u65b0\u5efa\u4e00\u4e2a\u6d4b\u8bd5\u6848\u4ef6\u5de5\u4f5c\u53f0\uff0c\u6848\u4ef6\u540d\u201c\u5f8b\u5e08\u7248\u7a33\u5b9a\u6027\u9a8c\u6536\u4e70\u5356\u5408\u540c\u7ea0\u7eb7\u201d\uff0c\u521b\u5efa\u5b8c\u6210\u540e\u544a\u8bc9\u6211\u6848\u4ef6ID\u548c\u4efb\u52a1\u56de\u6267\u72b6\u6001\u3002';
    expect(normalizeActionIntent(text)).not.toMatchObject({ kind: 'status_query' });
  });

  it('keeps a labeled authority-research command out of the old-task status route', () => {
    const text = '律师版实机验收·法条与类案：基于四号案件ID d2789373-effc-404c-aff6-25f101267790，只使用当前已配置且可核验的权威来源，输出检索问题、来源状态、可核验结果与缺口。若来源未配置或结果无法核验，必须明确写无法完成检索，禁止凭模型记忆编造法条、案号、法院或裁判规则。不要登录外部网站，不要发送、提交或签署。完成后告诉我实际使用了什么能力以及任务回执状态。';
    expect(normalizeActionIntent(text)).not.toMatchObject({ kind: 'status_query' });
  });
});
