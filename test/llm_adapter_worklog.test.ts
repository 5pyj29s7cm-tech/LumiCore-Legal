import { describe, expect, it } from 'vitest';
import { getPrimaryUserText } from '../server/llm/adapter';

describe('LLM workflow learning intent selection', () => {
  it('binds tool execution to the latest user request instead of the first conversation turn', () => {
    expect(getPrimaryUserText([
      { role: 'user', content: '打开案件工作台。' },
      { role: 'assistant', content: '已打开。' },
      { role: 'user', content: '生成律师可读案件推进清单。' },
    ] as any)).toBe('生成律师可读案件推进清单。');
  });

  it('extracts text parts from the latest multimodal user message', () => {
    expect(getPrimaryUserText([
      { role: 'user', content: '旧任务' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '检查当前合同' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
          { type: 'text', text: '并列出风险' },
        ],
      },
    ] as any)).toBe('检查当前合同 并列出风险');
  });
});
