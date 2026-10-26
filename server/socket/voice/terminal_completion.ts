import type { ConversationActionTurn, ConversationActionTurnIdentity } from '../../conversation/action_turn_ledger';
import { parseStoredObject } from '../../tools/receipt_payload';

interface PersistedVoiceTerminalSnapshot {
  turn: ConversationActionTurn | null;
  assistant?: { id: string; userId: string; conversationId: string; requestId: string; role: string };
  task?: { id: string; userId: string; conversationId: string; status: string; context: unknown };
}

/** The assistant/task flush stages the turn transition, so use its request-bound task adjudication. */
export function applyPersistedVoiceTerminalOutcome(
  payload: { blocked: boolean; reason?: string },
  identity: ConversationActionTurnIdentity & { taskId?: string; assistantMessageId: string },
  snapshot: PersistedVoiceTerminalSnapshot,
): void {
  const { turn, assistant, task } = snapshot;
  if (!turn || turn.userId !== identity.userId || turn.conversationId !== identity.conversationId
    || turn.requestId !== identity.requestId || turn.channel !== 'voice'
    || (identity.taskId && turn.taskId !== identity.taskId)
    || !assistant || !identity.assistantMessageId || assistant.id !== identity.assistantMessageId
    || assistant.userId !== identity.userId || assistant.conversationId !== identity.conversationId
    || assistant.requestId !== identity.requestId || assistant.role !== 'assistant') return;
  const finalization = task && parseStoredObject(parseStoredObject(task.context).taskFinalization);
  const ownsTaskOutcome = task && task.id === turn.taskId && task.userId === identity.userId
    && task.conversationId === identity.conversationId && finalization?.requestId === identity.requestId
    && finalization.outcome === task.status;
  if (ownsTaskOutcome && ['blocked', 'failed', 'cancelled', 'persistence_unknown'].includes(task.status)) {
    payload.blocked = true;
    payload.reason = task.status === 'cancelled' ? 'cancelled'
      : task.status === 'persistence_unknown' ? 'persistence_unknown' : 'task_outcome:' + task.status;
  } else if (turn.terminalMessageId === identity.assistantMessageId
    && (turn.status === 'cancelled' || turn.status === 'persistence_unknown')) {
    payload.blocked = true;
    payload.reason = turn.status;
  }
}

export interface VoiceCompletionOptions {
  afterPlayback?: () => void;
  onCommitted?: () => void;
}

/** Delivery waits for durability and playback; the turn's outer finally owns resource release. */
export function createVoiceTerminalCompletion<Input extends { blocked: boolean }>(deps: {
  commit: (input: Input) => Promise<boolean>;
  drainSpeech: () => Promise<unknown>;
  isCurrent: () => boolean;
}) {
  return async (input: Input, options: VoiceCompletionOptions = {}): Promise<boolean> => {
    const committed = await deps.commit(input);
    await deps.drainSpeech();
    if (!deps.isCurrent()) return false;
    options.afterPlayback?.();
    if (committed && !input.blocked) options.onCommitted?.();
    return committed;
  };
}
