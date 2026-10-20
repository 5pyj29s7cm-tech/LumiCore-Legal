import { vi } from 'vitest';
import * as preparation from '../server/regions/packs/cn/messaging_turn/execution_preparation';
import type { MessagingRouteOptions } from '../server/regions/packs/cn/messaging_finalization';
import type { LumiExecutionPipeline } from '../server/cognition/execution_pipeline';

/** Same existing Legal terminal reply shape; an observer has no completion evidence. */
export function observedModelReplyText(answer: string, execution: Pick<LumiExecutionPipeline, 'executionRequested' | 'resolution'>): string {
  return execution.executionRequested ? JSON.stringify({ answer, goals: [{
    text: execution.resolution.userText, operation: 'unknown', effects: [], status: 'incomplete', evidenceIds: [],
  }] }) : answer;
}
const prepare = preparation.prepareMessagingExecution;
const observers = new WeakMap<MessagingRouteOptions, NonNullable<MessagingRouteOptions['onMessage']>>();
/** A local read-only provider observes the actual per-turn context; it never executes an org callback. */
export function observedMessagingOptions(options: MessagingRouteOptions): MessagingRouteOptions {
  const observe = options.onMessage;
  if (!observe) throw new Error('An observer fixture is required');
  const configured: MessagingRouteOptions = { ...options, onMessage: undefined, llmGetters: { getDeepSeek: () => null, getGemini: () => null } };
  observers.set(configured, observe);
  vi.spyOn(preparation, 'prepareMessagingExecution').mockImplementation(async input => {
    const result = await prepare(input);
    const observer = input.options && observers.get(input.options);
    if (observer && result.context) {
      const accepted = result.context;
      accepted.llm = {
      getDeepSeek: () => null, getGemini: () => null,
      getRelay: () => ({ chat: { completions: { create: async () => {
        const reply = await observer(input.msg);
        return { choices: [{ message: { content: observedModelReplyText(reply?.text || 'Synthetic observed reply.', accepted.executionPlan) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      } } } }),
      };
    }
    return result;
  });
  return configured;
}
