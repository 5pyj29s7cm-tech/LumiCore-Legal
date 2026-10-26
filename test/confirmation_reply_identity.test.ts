import './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveActiveTaskMessageRelation } from '../server/cognition/task_concurrency';
import type { ConversationActionContinuationState } from '../server/cognition/action_continuation';
import { admitAcceptedUserTurnDurably, resolveAcceptedTurnConfirmation } from '../server/socket/action_turn_durability';
import {
  buildTransportNeutralConfirmationScope,
  clearAllPendingConfirmationsForTests,
  consumePendingConfirmationDurably,
  getPendingConfirmation,
  isExplicitConfirmationReply,
  recordPendingConfirmation,
} from '../server/tools/pending_confirmation';

beforeEach(() => {
  clearAllPendingConfirmationsForTests();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OFFLINE_CONFIRMATION_IDENTITY_ONLY'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  clearAllPendingConfirmationsForTests();
});

describe('the shared confirmation reply vocabulary matches the words shown to users', () => {
  it.each(['confirm', 'confirmed', 'accept', 'accepted', 'approve', 'approved', 'Confirm.', 'accepted, accepted.'])('recognizes the exact standalone confirmation %s', reply => {
    expect(isExplicitConfirmationReply(reply)).toBe(true);
  });

  it.each([
    'confirme', 'accepte', 'confirmation', 'acceptance', 'Do not confirm',
    'confirm and change the target', 'I confirm the source is unverified', '"confirm"', 'confirmed, cancel',
  ])('does not turn a partial word, discussion or changed instruction into approval: %s', text => {
    expect(isExplicitConfirmationReply(text)).toBe(false);
  });
});

describe('English confirmation stays with the original exact pending action', () => {
  it.each(['confirm', 'confirmed', 'accept', 'accepted'])('resumes the original task and consumes only its exact action once: %s', async reply => {
    const userId = 'synthetic-confirmation-owner';
    const conversationId = 'synthetic-confirmation-conversation';
    const taskId = 'synthetic-existing-pending-task';
    const originRequestId = 'synthetic-original-request';
    const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId, taskId, originRequestId });
    const channelScope = buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId });
    const exactArgs = { path: 'C:/synthetic-confirmation/new-report.txt', content: 'Original source retained.\nTotal: 34' };
    const pending = recordPendingConfirmation(userId, 'write_file', exactArgs, 'chat', {
      ...scope, actionIntent: 'Read the source and create the named new report without changing the source.',
    });
    const state: ConversationActionContinuationState = {
      version: 2, taskId, status: 'waiting_confirmation', unfinished: true,
      goal: pending.actionIntent, latestInstruction: pending.actionIntent,
      appTarget: '', sourcePaths: ['C:/synthetic-confirmation/source.txt'], latestBlocker: '',
      evidenceTools: ['read_file', 'write_file'], assistantState: 'Waiting for the proposed action confirmation.',
      toolSummaries: [], revision: 2, activeRequestId: originRequestId, updatedAt: new Date().toISOString(),
    };
    const originalState = JSON.stringify(state);
    const relation = resolveActiveTaskMessageRelation(reply, state);
    expect(relation).toMatchObject({ taskRelation: 'confirm', taskId, binding: 'active_task' });
    const admission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => 'synthetic-confirmation-message', flush: async () => undefined,
      onPersistenceUnknown: vi.fn(),
    });
    const resolved = await resolveAcceptedTurnConfirmation({
      admission: admission!, userId, userText: reply, taskRelation: relation,
      actionState: state, taskScope: scope, channelScope,
    });
    expect(resolved.pending).toMatchObject({ id: pending.id, taskId, originRequestId, toolName: 'write_file', exactArgs });
    expect(resolved.scope).toEqual(scope);
    expect(resolved.cleared).toBe(false);
    expect(getPendingConfirmation(userId, scope)?.id).toBe(pending.id);
    expect(await consumePendingConfirmationDurably(userId, pending.id, pending.toolName, { ...exactArgs, content: 'Changed payload' }, scope)).toBe(false);
    expect(await consumePendingConfirmationDurably(userId, pending.id, pending.toolName, exactArgs, { ...scope, taskId: 'different-task' })).toBe(false);
    expect(await consumePendingConfirmationDurably(userId, pending.id, pending.toolName, exactArgs, resolved.scope)).toBe(true);
    expect(await consumePendingConfirmationDurably(userId, pending.id, pending.toolName, exactArgs, resolved.scope)).toBe(false);
    expect(JSON.stringify(state)).toBe(originalState);
  });
});
