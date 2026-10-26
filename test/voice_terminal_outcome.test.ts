import { describe, expect, it, vi } from 'vitest';
import { applyPersistedVoiceTerminalOutcome, createVoiceTerminalCompletion } from '../server/socket/voice/terminal_completion';
import type { ConversationActionTurn } from '../server/conversation/action_turn_ledger';

const identity = { userId: 'owner', conversationId: 'conversation', requestId: 'voice_request', taskId: 'task', assistantMessageId: 'assistant_row' };
const turn = (changes: Partial<ConversationActionTurn> = {}): ConversationActionTurn => ({
  id: 'turn', userId: identity.userId, conversationId: identity.conversationId, requestId: identity.requestId,
  taskId: identity.taskId, terminalMessageId: '', channel: 'voice', source: 'voice',
  domain: 'personal', orgId: '', userMessageId: 'user_row', status: 'leased', terminalReason: '',
  leaseOwnerId: '', leaseEpoch: '', leaseAcquiredAt: '', leaseHeartbeatAt: '', leaseExpiresAt: '',
  recoveryReason: '', recoveredAt: '', revision: 1, createdAt: '', updatedAt: '', terminalAt: '', ...changes,
});
const snapshot = (status = 'blocked') => ({
  turn: turn(),
  assistant: { id: identity.assistantMessageId, userId: identity.userId, conversationId: identity.conversationId, requestId: identity.requestId, role: 'assistant' },
  task: { id: identity.taskId, userId: identity.userId, conversationId: identity.conversationId, status,
    context: JSON.stringify({ taskFinalization: { outcome: status, requestId: identity.requestId } }) },
});

describe('persisted voice terminal outcome projection', () => {
  it.each(['blocked', 'failed', 'cancelled', 'persistence_unknown'])('uses the request-bound %s adjudication before the turn transition commits without changing model prose', status => {
    const payload = { text: 'The requested source was unavailable. Give me the corrected path.', blocked: false, reason: '' };
    applyPersistedVoiceTerminalOutcome(payload, identity, snapshot(status));
    expect(payload).toEqual({ text: 'The requested source was unavailable. Give me the corrected path.', blocked: true,
      reason: ['cancelled', 'persistence_unknown'].includes(status) ? status : 'task_outcome:' + status });
  });
  it.each([
    { userId: 'other_owner' }, { conversationId: 'other_conversation' }, { requestId: 'other_request' },
    { taskId: 'other_task' }, { channel: 'chat' },
  ])('does not borrow an unrelated turn: %j', changes => {
    const payload = { blocked: false, reason: '' }, saved = snapshot();
    saved.turn = turn(changes);
    applyPersistedVoiceTerminalOutcome(payload, identity, saved);
    expect(payload).toEqual({ blocked: false, reason: '' });
  });
  it.each(['id', 'userId', 'conversationId', 'requestId', 'role'] as const)('requires this exact assistant row (%s)', field => {
    const payload = { blocked: false, reason: '' }, saved = snapshot();
    saved.assistant[field] = 'unrelated';
    applyPersistedVoiceTerminalOutcome(payload, identity, saved);
    expect(payload).toEqual({ blocked: false, reason: '' });
  });
  it.each(['id', 'userId', 'conversationId', 'requestId', 'outcome'] as const)('cannot reuse another task or old task adjudication (%s)', field => {
    const payload = { blocked: false, reason: '' }, saved = snapshot();
    if (field === 'requestId' || field === 'outcome') saved.task.context = JSON.stringify({ taskFinalization: { outcome: 'blocked', requestId: identity.requestId, [field]: 'unrelated' } });
    else saved.task[field] = 'unrelated';
    applyPersistedVoiceTerminalOutcome(payload, identity, saved);
    expect(payload).toEqual({ blocked: false, reason: '' });
  });
  it.each(['cancelled', 'persistence_unknown'] as const)('retains an already committed %s outcome bound to the same assistant', status => {
    const payload = { blocked: false, reason: '' }, saved = snapshot('completed');
    saved.turn = turn({ status, terminalMessageId: identity.assistantMessageId });
    applyPersistedVoiceTerminalOutcome(payload, identity, saved);
    expect(payload).toEqual({ blocked: true, reason: status });
  });
  it('keeps a successful terminal unblocked and does not erase an existing blocked verdict', () => {
    const success = { blocked: false, reason: '' }, alreadyBlocked = { blocked: true, reason: 'delivery_unavailable' };
    applyPersistedVoiceTerminalOutcome(success, identity, snapshot('completed'));
    applyPersistedVoiceTerminalOutcome(alreadyBlocked, identity, snapshot('completed'));
    expect(success).toEqual({ blocked: false, reason: '' });
    expect(alreadyBlocked).toEqual({ blocked: true, reason: 'delivery_unavailable' });
  });
  it('does not learn when persistence commits a blocked terminal after model finalization', async () => {
    const payload = { blocked: false, reason: '' }, onCommitted = vi.fn();
    const finish = createVoiceTerminalCompletion({
      commit: async candidate => { applyPersistedVoiceTerminalOutcome(candidate, identity, snapshot()); return true; },
      drainSpeech: async () => {}, isCurrent: () => true,
    });
    await expect(finish(payload, { onCommitted })).resolves.toBe(true);
    expect(payload.blocked).toBe(true);
    expect(onCommitted).not.toHaveBeenCalled();
  });
});
