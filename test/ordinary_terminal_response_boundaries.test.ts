import './helpers';
import { beforeEach, expect, it, vi } from 'vitest';
const prepared = vi.hoisted(() => vi.fn());
vi.mock('../server/llm/tool_loop/model_response', () => ({ prepareToolLoopModelResponse: prepared }));
import { executeToolLoopIteration } from '../server/llm/tool_loop/iteration';
beforeEach(() => { prepared.mockReset(); });
function state(context: Record<string, unknown> = {}) {
  const finish = vi.fn((text, completionGuard) => ({ text, completionGuard }));
  return { primaryTask: '正常对话', executionLog: [], messages: [], config: {}, context: { currentTurnExecutionRequested: true, ...context }, toolExecutionContext: { requestId: 'terminal-request', taskId: 'terminal-task' }, finish } as any;
}
it('retains an ordinary complete answer without requiring model-authored JSON goals', async () => {
  const current = state(); prepared.mockResolvedValue({ response: { text: '完整正文与分析。', toolCalls: [], finishReason: 'stop' } });
  const result = await executeToolLoopIteration(current, 0);
  expect(result?.text).toBe('完整正文与分析。'); expect(result?.completionGuard?.blocked).toBe(false);
  expect(prepared).toHaveBeenCalledOnce(); expect(current.finish).toHaveBeenCalledOnce();
});
it.each([{ streamIncomplete: true }, { finishReason: 'length' }, { finishReason: 'content_filter' }])('keeps the original transport truncation boundary after removing the JSON wrapper: %j', async flag => {
  const current = state(); prepared.mockResolvedValue({ response: { text: '已收到的部分正文。', toolCalls: [], ...flag } });
  const result = await executeToolLoopIteration(current, 0);
  expect(result?.text).toBe('已收到的部分正文。'); expect(result?.completionGuard).toMatchObject({ blocked: true, reason: 'reply_response_incomplete' });
  expect(prepared).toHaveBeenCalledOnce(); expect(current.finish).toHaveBeenCalledOnce();
});
it('keeps a trusted continuation without its root request blocked without fabricating a model report', async () => {
  const current = state({ trustedActionContinuation: true, completionRequest: { currentText: '继续' } });
  prepared.mockResolvedValue({ response: { text: '当前已有内容。', toolCalls: [], finishReason: 'stop' } });
  const result = await executeToolLoopIteration(current, 0);
  expect(result?.text).toBe('当前已有内容。'); expect(result?.completionGuard).toMatchObject({ blocked: true, reason: 'reply_root_unavailable' });
  expect(prepared).toHaveBeenCalledOnce(); expect(current.finish).toHaveBeenCalledOnce();
});
