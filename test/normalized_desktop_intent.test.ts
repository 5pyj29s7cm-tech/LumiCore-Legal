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
