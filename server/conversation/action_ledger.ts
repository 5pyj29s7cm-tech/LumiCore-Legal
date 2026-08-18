import crypto from 'node:crypto';
import {
  formatConversationActionTaskStatus,
  normalizeConversationActionState,
  type ConversationActionContinuationState,
} from '../cognition/action_continuation';
import { normalizeActionIntent, type NormalizedActionIntent } from '../cognition/normalized_action_intent';
import {
  mergeTaskReceipts,
  taskCompletionFromReceipts,
  taskReceiptsToRecords,
  toolRecordSucceeded,
  type ConversationTaskStatus,
} from '../cognition/task_execution_ledger';
import { buildToolExecutionEnvelope, toolRecordIdempotencyKey } from '../tools/execution_envelope';
import type { ToolExecutionRecord } from '../tools/types';
import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import type {
  ModelExecutionGraph,
  ModelGraphArbitrationReceipt,
  ModelGraphNodeReceipt,
} from '../agents/model_execution_graph';
import { getCurrentIndustryCapabilityProfile } from '../regions/packs/cn/industry_capability_profile';
import { reconcileConversationFocusThread } from './focus_threads';

export interface ConversationActionTaskRow {
  id: string;
  conversationId: string;
  userId: string;
  domain: string;
  orgId: string;
  parentTaskId: string;
  rootUserMessageId: string;
  intentKind: string;
  operation: string;
  goal: string;
  target: string;
  status: ConversationTaskStatus;
  blocker: string;
  activeRequestId: string;
  completionSource: string;
  context: string | Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface ConversationActionReceiptRow {
  id: string;
  taskId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  idempotencyKey: string;
  toolName: string;
  targetIdentity: string;
  inputDigest: string;
  envelope: string;
  outcome: string;
  createdAt: string;
}

export interface PersistedCapabilityExecutionPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  intent: Omit<NormalizedActionIntent, 'payload'> & {
    payload: '';
    payloadDigest: string;
  };
  nodes: Array<{
    nodeId: string;
    type: string;
    capabilityId: string;
    toolName?: string;
    lane: string;
    operation: string;
    risk: string;
    requiresConfirmation: boolean;
    verificationStrategy: string;
    executionRole: 'planner' | 'adapter' | 'verifier' | 'join';
    selectionGroup?: string;
    selectionRank?: number;
  }>;
  edges: CapabilityExecutionPlan['edges'];
  expectedEvidence: CapabilityExecutionPlan['expectedEvidence'];
  risk: CapabilityExecutionPlan['risk'];
  fallbackPolicy: CapabilityExecutionPlan['fallbackPolicy'];
  contextRefs: CapabilityExecutionPlan['contextRefs'];
  decisionAuthority: 'semantic_planner';
  scriptAuthority: 'adapter_only';
  persistedAt: string;
}

export interface ConversationModelExecutionRecovery {
  graph: ModelExecutionGraph;
  receipts: ModelGraphNodeReceipt[];
}

function stableValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => stableValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [
    key,
    stableValue((value as Record<string, unknown>)[key], depth + 1),
  ]));
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function redactArguments(args: Record<string, any>): Record<string, any> {
  const sensitive = /^(?:message|text|content|body|payload|draft|password|secret|token|api.?key)$/i;
  return Object.fromEntries(Object.entries(args || {}).map(([key, value]) => (
    sensitive.test(key)
      ? [key, { digest: digest(value), length: typeof value === 'string' ? value.length : undefined }]
      : [key, stableValue(value)]
  )));
}

function redactGoal(goal: string, intent: NormalizedActionIntent): string {
  if (intent.sideEffectClass !== 'external_commit' || !intent.payload) return String(goal || '').slice(0, 700);
  return `${intent.kind}:${intent.target || '(unresolved target)'} payload_sha256=${digest(intent.payload)}`;
}

function sanitizeState(state: ConversationActionContinuationState): ConversationActionContinuationState {
  return {
    ...state,
    receipts: (state.receipts || []).map(receipt => ({
      ...receipt,
      arguments: redactArguments(receipt.arguments || {}),
    })),
  };
}

export function sanitizeCapabilityExecutionPlan(
  plan: CapabilityExecutionPlan,
  persistedAt: string,
): PersistedCapabilityExecutionPlan {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    taskId: plan.taskId,
    intent: {
      ...plan.intent,
      payload: '',
      payloadDigest: digest(plan.intent.payload),
    },
    nodes: plan.nodes.map(node => ({
      nodeId: node.nodeId,
      type: node.type,
      capabilityId: node.capabilityId,
      ...(node.toolName ? { toolName: node.toolName } : {}),
      lane: node.lane,
      operation: node.operation,
      risk: node.risk,
      requiresConfirmation: node.requiresConfirmation,
      verificationStrategy: node.verification.strategy,
      executionRole: node.executionRole,
      ...(node.selectionGroup ? { selectionGroup: node.selectionGroup } : {}),
      ...(node.selectionRank !== undefined ? { selectionRank: node.selectionRank } : {}),
    })),
    edges: plan.edges.map(edge => ({ ...edge })),
    expectedEvidence: plan.expectedEvidence.map(requirement => ({
      ...requirement,
      requiredFields: [...requirement.requiredFields],
      ...(requirement.requiredValues ? { requiredValues: { ...requirement.requiredValues } } : {}),
      requiredArtifacts: [...requirement.requiredArtifacts],
      successStatuses: [...requirement.successStatuses],
    })),
    risk: {
      ...plan.risk,
      reasons: [...plan.risk.reasons],
      ...(plan.risk.confirmationBinding
        ? { confirmationBinding: { ...plan.risk.confirmationBinding } }
        : {}),
    },
    fallbackPolicy: { ...plan.fallbackPolicy },
    contextRefs: plan.contextRefs.map(ref => ({ ...ref })),
    decisionAuthority: plan.decisionAuthority,
    scriptAuthority: plan.scriptAuthority,
    persistedAt,
  };
}

function ensureTables(db: any): void {
  if (!Array.isArray(db.conversationActionTasks)) db.conversationActionTasks = [];
  if (!Array.isArray(db.conversationActionReceipts)) db.conversationActionReceipts = [];
}

function latestParentTask(
  tasks: ConversationActionTaskRow[],
  conversationId: string,
  currentTaskId: string,
): ConversationActionTaskRow | undefined {
  return tasks
    .filter(task => task.conversationId === conversationId && task.id !== currentTaskId)
    .filter(task => task.intentKind === 'cad_drafting' || /(?:Auto\s*CAD|\bCAD\b|图纸|平面图)/iu.test(`${task.goal} ${task.target}`)) // i18n-allow: Chinese CAD task matching; not user-visible copy.
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function markSupersededTask(
  tasks: ConversationActionTaskRow[],
  supersededTaskId: string | undefined,
  replacementTaskId: string,
  now: string,
): void {
  if (!supersededTaskId || supersededTaskId === replacementTaskId) return;
  const previous = tasks.find(candidate => candidate.id === supersededTaskId);
  if (!previous || previous.status === 'completed' || previous.status === 'cancelled') return;
  const context = parseObject(previous.context);
  const actionState = normalizeConversationActionState(context.actionState);
  const blocker = `Superseded by task ${replacementTaskId}.`;
  previous.status = 'cancelled';
  previous.blocker = blocker;
  previous.activeRequestId = '';
  previous.completionSource = 'superseded';
  previous.updatedAt = now;
  previous.completedAt = now;
  previous.revision = Math.max(1, Number(previous.revision) || 0) + 1;
  previous.context = JSON.stringify({
    ...context,
    ...(actionState
      ? {
          actionState: sanitizeState({
            ...actionState,
            status: 'cancelled',
            unfinished: false,
            latestBlocker: blocker,
            activeRequestId: undefined,
            supersededTaskId: replacementTaskId,
            revision: Math.max(actionState.revision || 0, previous.revision),
            updatedAt: now,
          }),
        }
      : {}),
  });
}

export function syncConversationActionTaskLedger(
  db: any,
  input: {
    conversation: { id: string; userId: string; domain?: string; orgId?: string };
    state: ConversationActionContinuationState;
    userText?: string;
    rootUserMessageId?: string;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const state = normalizeConversationActionState(input.state);
  if (!state?.taskId) return null;
  const now = input.now || state.updatedAt || new Date().toISOString();
  const intent = normalizeActionIntent(input.userText || state.latestInstruction || state.goal);
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  markSupersededTask(tasks, state.supersededTaskId, state.taskId, now);
  let task = tasks.find(candidate => candidate.id === state.taskId);
  const parent = intent.relation === 'child'
    ? latestParentTask(tasks, input.conversation.id, state.taskId)
    : undefined;
  const parentContext = parent ? parseObject(parent.context) : {};
  const currentContext = parseObject(task?.context);
  const parentState = normalizeConversationActionState(parentContext.actionState);
  const context: Record<string, any> = {
    ...parentContext,
    // Execution/model plans are attached independently from action-state
    // updates. Preserve the current task context on every later status or
    // receipt sync instead of accidentally erasing the semantic plan.
    ...currentContext,
    sourceTaskId: parent?.id || currentContext.sourceTaskId || parentContext.sourceTaskId || '',
    inheritedArtifacts: Array.from(new Set([
      ...(Array.isArray(parentContext.inheritedArtifacts) ? parentContext.inheritedArtifacts : []),
      ...(Array.isArray(currentContext.inheritedArtifacts) ? currentContext.inheritedArtifacts : []),
      ...(parentState?.sourcePaths || []),
    ])).slice(0, 20),
    inheritedReceipts: parentState?.receipts
      || currentContext.inheritedReceipts
      || parentContext.inheritedReceipts
      || [],
    actionState: sanitizeState(state),
  };
  const completed = state.status === 'completed' || !state.unfinished;
  const taskStatus = state.status || (state.unfinished ? 'blocked' : 'completed');
  context.focusThread = reconcileConversationFocusThread(currentContext.focusThread, {
    id: state.taskId,
    goal: redactGoal(state.goal, intent),
    status: taskStatus,
    blocker: state.latestBlocker || '',
    updatedAt: now,
  }, now);
  const values: ConversationActionTaskRow = {
    id: state.taskId,
    conversationId: input.conversation.id,
    userId: input.conversation.userId,
    domain: input.conversation.domain || 'personal',
    orgId: input.conversation.orgId || '',
    parentTaskId: parent?.id || task?.parentTaskId || '',
    rootUserMessageId: task?.rootUserMessageId || input.rootUserMessageId || '',
    intentKind: intent.kind === 'none' ? task?.intentKind || 'desktop_operation' : intent.kind,
    operation: intent.kind === 'none' ? task?.operation || 'mutate' : intent.operation,
    goal: redactGoal(state.goal, intent),
    target: intent.target || state.appTarget || task?.target || '',
    status: taskStatus,
    blocker: state.latestBlocker || '',
    activeRequestId: state.activeRequestId || '',
    completionSource: state.completionSource || '',
    context: JSON.stringify(context),
    revision: Math.max(task?.revision || 0, state.revision || 0, 1),
    createdAt: task?.createdAt || now,
    updatedAt: now,
    completedAt: completed ? task?.completedAt || now : '',
  };
  if (task) Object.assign(task, values);
  else {
    task = values;
    tasks.push(task);
  }

  const records = taskReceiptsToRecords(state.receipts || []);
  appendConversationActionReceipts(db, {
    task,
    records,
    turnId: state.evidenceMessageId || input.rootUserMessageId || '',
    requestId: state.activeRequestId || '',
    now,
  });
  return task;
}

/**
 * Persist terminal records that arrive after their request was replaced. The
 * immutable task/request identity decides ownership; the current conversation
 * pointer is never modified by a late record from an older task.
 */
export function archiveBoundConversationActionReceipts(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    records: ToolExecutionRecord[];
    turnId?: string;
    now?: string;
  },
): { archived: number; taskIds: string[] } {
  ensureTables(db);
  const now = input.now || new Date().toISOString();
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  const grouped = new Map<string, ToolExecutionRecord[]>();
  for (const record of input.records || []) {
    const taskId = String(record.taskId || '').trim();
    if (!taskId) continue;
    const task = tasks.find(candidate => (
      candidate.id === taskId
      && candidate.conversationId === input.conversationId
      && candidate.userId === input.userId
    ));
    if (!task) continue;
    const records = grouped.get(taskId) || [];
    records.push(record);
    grouped.set(taskId, records);
  }

  let archived = 0;
  const taskIds: string[] = [];
  for (const [taskId, records] of grouped) {
    const task = tasks.find(candidate => candidate.id === taskId)!;
    archived += appendConversationActionReceipts(db, {
      task,
      records,
      turnId: input.turnId,
      requestId: records.find(record => record.requestId)?.requestId,
      now,
    }).length;
    const context = parseObject(task.context);
    const state = normalizeConversationActionState(context.actionState);
    if (state) {
      const receipts = mergeTaskReceipts(state.receipts || [], records, now);
      const completion = taskCompletionFromReceipts(state.goal || task.goal, receipts);
      const hasFailure = records.some(record => !toolRecordSucceeded(record));
      const status: ConversationTaskStatus = completion.complete
        ? 'completed'
        : task.status === 'cancelled'
          ? 'cancelled'
          : hasFailure
            ? 'blocked'
            : task.status;
      const nextState = normalizeConversationActionState({
        ...state,
        receipts,
        status,
        unfinished: status !== 'completed' && status !== 'cancelled',
        latestBlocker: status === 'blocked' ? completion.blocker || task.blocker : status === 'cancelled' ? task.blocker : '',
        activeRequestId: state.activeRequestId && records.some(record => record.requestId === state.activeRequestId)
          ? undefined
          : state.activeRequestId,
        completionSource: completion.complete ? 'tool_receipt' : state.completionSource,
        revision: Math.max(state.revision || 0, task.revision || 0) + 1,
        updatedAt: now,
      });
      if (nextState) context.actionState = sanitizeState(nextState);
      task.context = JSON.stringify(context);
      task.status = status;
      task.blocker = nextState?.latestBlocker || task.blocker;
      task.activeRequestId = nextState?.activeRequestId || '';
      task.completionSource = nextState?.completionSource || task.completionSource;
      task.updatedAt = now;
      task.revision = nextState?.revision || task.revision;
      if (status === 'completed' || status === 'cancelled') task.completedAt = task.completedAt || now;
    }
    taskIds.push(taskId);
  }
  return { archived, taskIds };
}

export function appendConversationActionReceipts(
  db: any,
  input: {
    task: ConversationActionTaskRow;
    records: ToolExecutionRecord[];
    turnId?: string;
    requestId?: string;
    now?: string;
  },
): ConversationActionReceiptRow[] {
  ensureTables(db);
  const now = input.now || new Date().toISOString();
  const receipts = db.conversationActionReceipts as ConversationActionReceiptRow[];
  const appended: ConversationActionReceiptRow[] = [];
  input.records.forEach((rawRecord, index) => {
    const record: ToolExecutionRecord = {
      ...rawRecord,
      taskId: rawRecord.taskId || input.task.id,
      turnId: rawRecord.turnId || input.turnId,
      requestId: rawRecord.requestId || input.requestId,
      idempotencyKey: rawRecord.idempotencyKey || toolRecordIdempotencyKey(rawRecord),
    };
    const envelope = buildToolExecutionEnvelope(record, {
      taskId: input.task.id,
      turnId: input.turnId,
      requestId: input.requestId,
      completedAt: now,
    });
    const duplicate = receipts.some(candidate => (
      candidate.taskId === input.task.id
      && candidate.idempotencyKey === envelope.idempotencyKey
      && candidate.toolName === record.name
      && candidate.outcome === envelope.status
    ));
    if (duplicate) return;
    const row: ConversationActionReceiptRow = {
      id: String(record.id || `receipt_${crypto.randomUUID()}_${index}`),
      taskId: input.task.id,
      conversationId: input.task.conversationId,
      turnId: envelope.turnId,
      requestId: envelope.requestId,
      idempotencyKey: envelope.idempotencyKey,
      toolName: envelope.toolName,
      targetIdentity: envelope.targetIdentity,
      inputDigest: digest(record.arguments || {}),
      envelope: JSON.stringify(envelope),
      outcome: envelope.status,
      createdAt: now,
    };
    receipts.push(row);
    appended.push(row);
  });
  return appended;
}

/**
 * Bind a read-only observation to the closest existing durable task. This
 * preserves a receipt without manufacturing a new task for a status query.
 */
export function appendReadOnlyConversationActionReceipts(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    records: ToolExecutionRecord[];
    anchors: string[];
    preferredIntentKinds?: string[];
    turnId?: string;
    requestId?: string;
    now?: string;
  },
): ConversationActionReceiptRow[] {
  ensureTables(db);
  const anchors = input.anchors.map(value => String(value || '').trim()).filter(Boolean);
  const preferred = new Set(input.preferredIntentKinds || []);
  const candidates = (db.conversationActionTasks as ConversationActionTaskRow[])
    .filter(task => task.conversationId === input.conversationId && task.userId === input.userId)
    // The receipt must describe an existing piece of work. Attaching it to a
    // prior read/status row would keep the accidental status task alive.
    .filter(task => task.operation !== 'read' && task.intentKind !== 'status_query')
    .map(task => {
      const haystack = `${task.goal}\n${task.target}`;
      let score = 0;
      anchors.forEach((anchor, index) => {
        if (haystack.includes(anchor)) score += Math.max(4, 16 - index * 3);
      });
      if (preferred.has(task.intentKind)) score += 3;
      if (task.status === 'completed') score += 1;
      return { task, score };
    })
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.task.updatedAt.localeCompare(left.task.updatedAt));
  const task = candidates[0]?.task;
  if (!task) return [];
  return appendConversationActionReceipts(db, {
    task,
    records: input.records,
    turnId: input.turnId,
    requestId: input.requestId,
    now: input.now,
  });
}

/**
 * Create the durable action row owned by a scheduled/background plan before
 * it enters the runtime queue. The deterministic task id is also the restart
 * and idempotency boundary for the downstream orchestration.
 */
export function ensureBackgroundConversationActionTask(
  db: any,
  input: {
    taskId: string;
    conversationId: string;
    userId: string;
    domain: string;
    orgId: string;
    goal: string;
    target: string;
    requestId: string;
    source: string;
    context?: Record<string, unknown>;
    now?: string;
  },
): ConversationActionTaskRow {
  ensureTables(db);
  const existing = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId
    && candidate.userId === input.userId
  ));
  if (existing) return existing;
  const now = input.now || new Date().toISOString();
  const intent = normalizeActionIntent(input.goal);
  const actionState = normalizeConversationActionState({
    version: 2,
    taskId: input.taskId,
    goal: input.goal,
    latestInstruction: input.goal,
    status: 'executing',
    unfinished: true,
    latestBlocker: '',
    appTarget: input.target,
    activeRequestId: input.requestId,
    sourcePaths: [],
    evidenceTools: [],
    assistantState: '',
    toolSummaries: [],
    receipts: [],
    revision: 1,
    updatedAt: now,
  });
  const task: ConversationActionTaskRow = {
    id: input.taskId,
    conversationId: input.conversationId,
    userId: input.userId,
    domain: input.domain || 'personal',
    orgId: input.orgId || '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: intent.kind === 'none' ? 'background_work' : intent.kind,
    operation: intent.kind === 'none' ? 'mutate' : intent.operation,
    goal: input.goal,
    target: input.target,
    status: 'executing',
    blocker: '',
    activeRequestId: input.requestId,
    completionSource: '',
    context: JSON.stringify({
      ...(input.context || {}),
      source: input.source,
      actionState,
    }),
    revision: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: '',
  };
  (db.conversationActionTasks as ConversationActionTaskRow[]).push(task);
  return task;
}

/** Settle a background-owned action only from terminal records/finalization. */
export function settleBackgroundConversationActionTask(
  db: any,
  input: {
    taskId: string;
    userId: string;
    records: ToolExecutionRecord[];
    status: 'completed' | 'blocked' | 'cancelled';
    blocker?: string;
    requestId?: string;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId && candidate.userId === input.userId
  ));
  if (!task) return null;
  const now = input.now || new Date().toISOString();
  appendConversationActionReceipts(db, {
    task,
    records: input.records,
    requestId: input.requestId,
    now,
  });
  const context = parseObject(task.context);
  const previous = normalizeConversationActionState(context.actionState);
  const baseState: ConversationActionContinuationState = previous || {
    version: 2,
    taskId: task.id,
    goal: task.goal,
    appTarget: task.target,
    latestInstruction: task.goal,
    unfinished: true,
    latestBlocker: '',
    sourcePaths: [],
    evidenceTools: [],
    assistantState: '',
    toolSummaries: [],
    receipts: [],
    revision: task.revision,
    updatedAt: task.updatedAt,
  };
  task.status = input.status;
  task.blocker = input.status === 'blocked' ? String(input.blocker || 'Background execution did not reach verified completion.') : '';
  task.activeRequestId = '';
  task.completionSource = input.status === 'completed' ? 'tool_receipt' : '';
  task.updatedAt = now;
  task.completedAt = now;
  task.revision = Math.max(1, Number(task.revision) || 0) + 1;
  context.actionState = normalizeConversationActionState({
    ...baseState,
    version: 2,
    taskId: task.id,
    goal: previous?.goal || task.goal,
    latestInstruction: previous?.latestInstruction || task.goal,
    status: input.status,
    unfinished: false,
    latestBlocker: task.blocker,
    activeRequestId: undefined,
    completionSource: input.status === 'completed' ? 'tool_receipt' : undefined,
    revision: task.revision,
    updatedAt: now,
  });
  task.context = JSON.stringify(context);
  return task;
}

type SchedulerAuditOutcome = 'executing' | 'verified' | 'blocked' | 'failed' | 'unknown';

function compactSchedulerAuditTaskId(scheduledTaskId: string): string {
  return `scheduler_audit_${digest(scheduledTaskId).slice(0, 24)}`;
}

function schedulerRecordOutcome(
  status: 'executing' | 'blocked' | 'completed',
  records: ToolExecutionRecord[],
): SchedulerAuditOutcome {
  const declared = records
    .map(record => String((record.receipt as any)?.status || ''))
    .find(Boolean);
  if (declared === 'failed' || declared === 'unknown' || declared === 'blocked') return declared;
  if (status === 'completed') return 'verified';
  return status;
}

function parseSchedulerAudit(task: ConversationActionTaskRow | undefined): Record<string, any> {
  const context = parseObject(task?.context);
  const audit = parseObject(context.schedulerAudit);
  return {
    schemaVersion: 1,
    totalExecutions: 0,
    completedCount: 0,
    blockedCount: 0,
    failedCount: 0,
    unknownCount: 0,
    compactedReceiptCount: 0,
    receiptOutcomeCounts: {},
    recentExecutions: [],
    ...audit,
  };
}

/** Returns the durable state for one compact scheduler slot, if it is still in the replay window. */
export function getScheduledCapabilityExecutionStatus(
  db: any,
  input: { scheduledTaskId: string; executionId: string },
): SchedulerAuditOutcome | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === compactSchedulerAuditTaskId(input.scheduledTaskId)
  ));
  if (!task) return null;
  const audit = parseSchedulerAudit(task);
  if (audit.currentExecution?.executionId === input.executionId) {
    return audit.currentExecution.status || null;
  }
  const recent = (Array.isArray(audit.recentExecutions) ? audit.recentExecutions : [])
    .find((candidate: any) => candidate?.executionId === input.executionId);
  return recent?.status || null;
}

function persistCompactScheduledCapabilityExecution(
  db: any,
  input: {
    scheduledTaskId: string;
    plan: CapabilityExecutionPlan;
    status: Extract<ConversationTaskStatus, 'executing' | 'blocked' | 'completed'>;
    records?: ToolExecutionRecord[];
    blocker?: string;
    now?: string;
  },
): ConversationActionTaskRow {
  const now = input.now || new Date().toISOString();
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  const taskId = compactSchedulerAuditTaskId(input.scheduledTaskId);
  let task = tasks.find(candidate => candidate.id === taskId);
  const context = parseObject(task?.context);
  const audit = parseSchedulerAudit(task);
  const records = input.records || [];
  const outcome = schedulerRecordOutcome(input.status, records);
  const existing = audit.currentExecution?.executionId === input.plan.taskId
    ? audit.currentExecution
    : (Array.isArray(audit.recentExecutions) ? audit.recentExecutions : [])
      .find((candidate: any) => candidate?.executionId === input.plan.taskId);

  if (input.status === 'executing' && existing?.status && existing.status !== 'executing') {
    return task!;
  }

  const isNewExecution = input.status === 'executing' && !existing;
  if (isNewExecution) audit.totalExecutions = Number(audit.totalExecutions || 0) + 1;
  const priorOutcome = existing?.status && existing.status !== 'executing'
    ? existing.status
    : String(audit.lastOutcome || '');
  const entry = {
    executionId: input.plan.taskId,
    status: outcome,
    startedAt: existing?.startedAt || now,
    ...(outcome === 'executing' ? {} : { completedAt: now }),
  };
  const recent = (Array.isArray(audit.recentExecutions) ? audit.recentExecutions : [])
    .filter((candidate: any) => candidate?.executionId !== input.plan.taskId);
  recent.push(entry);
  audit.recentExecutions = recent.slice(-36);
  audit.currentExecution = entry;
  audit.firstExecutionAt = audit.firstExecutionAt || now;
  audit.lastExecutionAt = now;
  if (outcome !== 'executing' && existing?.status !== outcome) {
    if (outcome === 'verified') audit.completedCount = Number(audit.completedCount || 0) + 1;
    if (outcome === 'blocked') audit.blockedCount = Number(audit.blockedCount || 0) + 1;
    if (outcome === 'failed') audit.failedCount = Number(audit.failedCount || 0) + 1;
    if (outcome === 'unknown') audit.unknownCount = Number(audit.unknownCount || 0) + 1;
    audit.lastOutcome = outcome;
  }

  const persistedPlan = sanitizeCapabilityExecutionPlan(input.plan, now);
  const values: ConversationActionTaskRow = {
    id: taskId,
    conversationId: `scheduler:${input.scheduledTaskId}`,
    userId: 'system',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: input.plan.intent.kind,
    operation: input.plan.intent.operation,
    goal: `Audit declared scheduled task ${input.scheduledTaskId}`,
    target: input.scheduledTaskId,
    status: input.status,
    blocker: String(input.blocker || '').slice(0, 500),
    activeRequestId: input.status === 'executing' ? input.plan.taskId : '',
    completionSource: input.status === 'completed' ? 'tool_receipt' : '',
    context: JSON.stringify({
      ...context,
      source: 'scheduler',
      scheduledTaskId: input.scheduledTaskId,
      compactAudit: true,
      executionPlan: persistedPlan,
      schedulerAudit: audit,
    }),
    revision: Math.max(1, Number(task?.revision || 0) + (task ? 1 : 0)),
    createdAt: task?.createdAt || now,
    updatedAt: now,
    completedAt: input.status === 'completed' ? now : '',
  };
  if (task) Object.assign(task, values);
  else {
    task = values;
    tasks.push(task);
  }

  const lastReceiptAt = Date.parse(String(audit.lastReceiptAt || '')) || 0;
  const abnormal = outcome !== 'verified' && outcome !== 'executing';
  // The summary row itself keeps exact counters and the most recent 36 slot
  // identities. A successful receipt every six hours is enough to prove the
  // heartbeat while avoiding thousands of identical scheduler receipts.
  // Abnormal outcomes are still appended immediately.
  const checkpointDue = Date.parse(now) - lastReceiptAt >= 6 * 60 * 60 * 1000;
  if (records.length > 0 && (abnormal || priorOutcome !== outcome || checkpointDue)) {
    appendConversationActionReceipts(db, {
      task,
      records,
      turnId: input.plan.taskId,
      requestId: input.plan.taskId,
      now,
    });
    audit.lastReceiptAt = now;
    task.context = JSON.stringify({
      ...parseObject(task.context),
      schedulerAudit: audit,
    });
  }
  return task;
}

/**
 * One-version migration for the old 10-second/1-minute probe ledger. Only
 * verified completed rows are folded; failures, unknown outcomes and their
 * receipts remain append-only evidence.
 */
export function compactLegacyScheduledCapabilityExecutions(db: any): {
  tasksRemoved: number;
  receiptsRemoved: number;
  summariesUpdated: number;
} {
  ensureTables(db);
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  const receipts = db.conversationActionReceipts as ConversationActionReceiptRow[];
  const receiptsByTask = new Map<string, ConversationActionReceiptRow[]>();
  for (const receipt of receipts) {
    const related = receiptsByTask.get(receipt.taskId) || [];
    related.push(receipt);
    receiptsByTask.set(receipt.taskId, related);
  }
  let tasksRemoved = 0;
  let receiptsRemoved = 0;
  let summariesUpdated = 0;

  const scheduledTaskIds = new Set(tasks
    .filter(candidate => (
      candidate.intentKind === 'scheduled_task'
      && candidate.conversationId.startsWith('scheduler:')
      && candidate.target
    ))
    .map(candidate => candidate.target));

  for (const scheduledTaskId of scheduledTaskIds) {
    const summaryId = compactSchedulerAuditTaskId(scheduledTaskId);
    const candidates = tasks.filter(candidate => (
      candidate.id !== summaryId
      && candidate.conversationId === `scheduler:${scheduledTaskId}`
      && candidate.status === 'completed'
    ));
    const verified = candidates.filter(candidate => {
      const related = receiptsByTask.get(candidate.id) || [];
      return related.length > 0 && related.every(receipt => receipt.outcome === 'verified_success');
    });
    if (verified.length === 0) continue;

    verified.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const removedIds = new Set(verified.map(candidate => candidate.id));
    const removedReceipts = verified.flatMap(candidate => receiptsByTask.get(candidate.id) || []);
    const summary = tasks.find(candidate => candidate.id === summaryId);
    const audit = parseSchedulerAudit(summary);
    const last = verified[verified.length - 1];
    const lastContext = parseObject(last.context);
    const migratedRecent = verified.slice(-36).map(candidate => ({
      executionId: candidate.id,
      status: 'verified',
      startedAt: candidate.createdAt,
      completedAt: candidate.completedAt || candidate.updatedAt,
    }));
    audit.totalExecutions = Number(audit.totalExecutions || 0) + verified.length;
    audit.completedCount = Number(audit.completedCount || 0) + verified.length;
    audit.compactedReceiptCount = Number(audit.compactedReceiptCount || 0) + removedReceipts.length;
    audit.receiptOutcomeCounts = {
      ...parseObject(audit.receiptOutcomeCounts),
      verified_success: Number(parseObject(audit.receiptOutcomeCounts).verified_success || 0) + removedReceipts.length,
    };
    audit.firstExecutionAt = audit.firstExecutionAt || verified[0].createdAt;
    audit.lastExecutionAt = last.updatedAt;
    audit.lastOutcome = 'verified';
    audit.currentExecution = migratedRecent[migratedRecent.length - 1];
    audit.recentExecutions = [
      ...(Array.isArray(audit.recentExecutions) ? audit.recentExecutions : []),
      ...migratedRecent,
    ].slice(-36);

    const values: ConversationActionTaskRow = {
      id: summaryId,
      conversationId: `scheduler:${scheduledTaskId}`,
      userId: 'system',
      domain: 'personal',
      orgId: '',
      parentTaskId: '',
      rootUserMessageId: '',
      intentKind: last.intentKind,
      operation: last.operation,
      goal: `Audit declared scheduled task ${scheduledTaskId}`,
      target: scheduledTaskId,
      status: 'completed',
      blocker: '',
      activeRequestId: '',
      completionSource: 'tool_receipt',
      context: JSON.stringify({
        ...parseObject(summary?.context),
        source: 'scheduler',
        scheduledTaskId,
        compactAudit: true,
        ...(lastContext.executionPlan ? { executionPlan: lastContext.executionPlan } : {}),
        schedulerAudit: audit,
      }),
      revision: Math.max(1, Number(summary?.revision || 0) + 1),
      createdAt: summary?.createdAt || verified[0].createdAt,
      updatedAt: last.updatedAt,
      completedAt: last.completedAt || last.updatedAt,
    };
    db.conversationActionTasks = tasks.filter(candidate => !removedIds.has(candidate.id));
    const refreshedTasks = db.conversationActionTasks as ConversationActionTaskRow[];
    const refreshedSummary = refreshedTasks.find(candidate => candidate.id === summaryId);
    if (refreshedSummary) Object.assign(refreshedSummary, values);
    else refreshedTasks.push(values);
    db.conversationActionReceipts = receipts.filter(receipt => !removedIds.has(receipt.taskId));
    tasks.splice(0, tasks.length, ...refreshedTasks);
    receipts.splice(0, receipts.length, ...(db.conversationActionReceipts as ConversationActionReceiptRow[]));
    tasksRemoved += verified.length;
    receiptsRemoved += removedReceipts.length;
    summariesUpdated += 1;
  }
  return { tasksRemoved, receiptsRemoved, summariesUpdated };
}

/**
 * Stores a scheduler execution in the shared action ledger. The scheduler has
 * no chat conversation, so it uses a namespaced conversation identity while
 * retaining the same append-only task/receipt schema and sanitization rules.
 */
export function persistScheduledCapabilityExecution(
  db: any,
  input: {
    scheduledTaskId: string;
    plan: CapabilityExecutionPlan;
    status: Extract<ConversationTaskStatus, 'executing' | 'blocked' | 'completed'>;
    records?: ToolExecutionRecord[];
    blocker?: string;
    now?: string;
    compactAudit?: boolean;
  },
): ConversationActionTaskRow {
  ensureTables(db);
  if (input.compactAudit) return persistCompactScheduledCapabilityExecution(db, input);
  const now = input.now || new Date().toISOString();
  const conversationId = `scheduler:${input.scheduledTaskId}`;
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  let task = tasks.find(candidate => (
    candidate.id === input.plan.taskId
    && candidate.conversationId === conversationId
    && candidate.userId === 'system'
  ));
  const existingCompleted = task?.status === 'completed';
  const persistedPlan = sanitizeCapabilityExecutionPlan(input.plan, now);
  const existingContext = parseObject(task?.context);
  const context = {
    ...existingContext,
    source: 'scheduler',
    scheduledTaskId: input.scheduledTaskId,
    executionPlan: persistedPlan,
    executionPlans: [
      ...(Array.isArray(existingContext.executionPlans)
        ? existingContext.executionPlans.filter((candidate: any) => candidate?.planId !== persistedPlan.planId)
        : []),
      persistedPlan,
    ].slice(-12),
  };
  const status = existingCompleted ? 'completed' : input.status;
  const values: ConversationActionTaskRow = {
    id: input.plan.taskId,
    conversationId,
    userId: 'system',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: input.plan.intent.kind,
    operation: input.plan.intent.operation,
    goal: `Execute declared scheduled task ${input.scheduledTaskId}`,
    target: input.scheduledTaskId,
    status,
    blocker: existingCompleted ? '' : String(input.blocker || '').slice(0, 500),
    activeRequestId: input.plan.taskId,
    completionSource: status === 'completed' ? 'tool_receipt' : '',
    context: JSON.stringify(context),
    revision: Math.max(1, Number(task?.revision || 0) + (task ? 1 : 0)),
    createdAt: task?.createdAt || now,
    updatedAt: existingCompleted ? task?.updatedAt || now : now,
    completedAt: status === 'completed' ? task?.completedAt || now : '',
  };
  if (task) Object.assign(task, values);
  else {
    task = values;
    tasks.push(task);
  }
  appendConversationActionReceipts(db, {
    task,
    records: input.records || [],
    turnId: input.plan.taskId,
    requestId: input.plan.taskId,
    now,
  });
  return task;
}

/**
 * Persists the semantic plan in the existing append-compatible task context.
 * Raw message payloads are never stored; confirmation uses the digest already
 * bound to the durable task identity.
 */
export function attachConversationExecutionPlan(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    plan: CapabilityExecutionPlan;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.plan.taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  if (!task) return null;
  const now = input.now || new Date().toISOString();
  const context = parseObject(task.context);
  const persisted = sanitizeCapabilityExecutionPlan(input.plan, now);
  const history = (Array.isArray(context.executionPlans) ? context.executionPlans : [])
    .filter((candidate: any) => candidate?.planId !== persisted.planId)
    .slice(-11);
  history.push(persisted);
  task.context = JSON.stringify({
    ...context,
    executionPlan: persisted,
    executionPlans: history,
  });
  task.updatedAt = now;
  return task;
}

/** Stores the compiled graph and digest-only node receipts for restart recovery. */
export function attachConversationModelExecutionGraph(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    taskId: string;
    graph: ModelExecutionGraph;
    receipts: ModelGraphNodeReceipt[];
    arbitrationReceipt?: ModelGraphArbitrationReceipt;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  if (!task || input.graph.taskId !== task.id) return null;
  const now = input.now || new Date().toISOString();
  const context = parseObject(task.context);
  const persistedGraph = {
    ...input.graph,
    nodes: input.graph.nodes.map(node => ({
      ...node,
      candidates: node.candidates.map(candidate => ({ ...candidate })),
      dependsOn: [...node.dependsOn],
      inputRefs: [...node.inputRefs],
      outputSchema: { ...node.outputSchema },
    })),
    edges: input.graph.edges.map(edge => ({ ...edge })),
    budgets: { ...input.graph.budgets },
    persistedAt: now,
  };
  const graphHistory = (Array.isArray(context.modelExecutionGraphs) ? context.modelExecutionGraphs : [])
    .filter((candidate: any) => candidate?.graphId !== persistedGraph.graphId)
    .slice(-7);
  graphHistory.push(persistedGraph);
  const priorReceipts = Array.isArray(context.modelNodeReceipts) ? context.modelNodeReceipts : [];
  const receiptKeys = new Set(input.receipts.map(receipt => `${receipt.graphId}:${receipt.nodeId}`));
  const modelNodeReceipts = [
    ...priorReceipts.filter((receipt: any) => !receiptKeys.has(`${receipt?.graphId}:${receipt?.nodeId}`)),
    ...input.receipts.map(receipt => ({
      graphId: receipt.graphId,
      taskId: receipt.taskId,
      nodeId: receipt.nodeId,
      status: receipt.status,
      ...(receipt.selectedCandidate ? { selectedCandidate: { ...receipt.selectedCandidate } } : {}),
      ...(receipt.agentId ? { agentId: receipt.agentId } : {}),
      dependencyReceiptIds: [...receipt.dependencyReceiptIds],
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      durationMs: receipt.durationMs,
      nodeFingerprint: receipt.nodeFingerprint,
      outputDigest: receipt.outputDigest,
      verified: receipt.verified,
      ...(receipt.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: receipt.estimatedInputTokens }
        : {}),
      ...(receipt.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: receipt.estimatedCostUsd }
        : {}),
      ...(receipt.reusedFromReceipt ? { reusedFromReceipt: receipt.reusedFromReceipt } : {}),
      // Model output and free-form errors can contain user data. Durable recovery
      // intentionally stores only digests and bounded structural metadata.
      ...(receipt.error ? { error: 'model_node_execution_failed' } : {}),
    })),
  ].slice(-120);
  task.context = JSON.stringify({
    ...context,
    modelExecutionGraph: persistedGraph,
    modelExecutionGraphs: graphHistory,
    modelNodeReceipts,
    ...(input.arbitrationReceipt ? {
      modelArbitrationReceipt: {
        ...input.arbitrationReceipt,
        selectedNodeIds: [...input.arbitrationReceipt.selectedNodeIds],
        consideredNodeIds: [...input.arbitrationReceipt.consideredNodeIds],
      },
    } : {}),
  });
  task.updatedAt = now;
  return task;
}

/**
 * Loads restart state only from the exact scoped task. Legacy receipts without
 * a semantic node fingerprint are excluded and therefore cannot be replayed.
 */
export function loadConversationModelExecutionRecovery(
  db: any,
  input: { conversationId: string; userId: string; taskId: string },
): ConversationModelExecutionRecovery | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  if (!task) return null;
  const context = parseObject(task.context);
  const graph = context.modelExecutionGraph as ModelExecutionGraph | undefined;
  if (!graph || graph.taskId !== task.id || !Array.isArray(graph.nodes)) return null;
  const receipts = (Array.isArray(context.modelNodeReceipts) ? context.modelNodeReceipts : [])
    .filter((receipt: any) => (
      receipt
      && receipt.taskId === task.id
      && receipt.graphId === graph.graphId
      && typeof receipt.nodeId === 'string'
      && typeof receipt.nodeFingerprint === 'string'
      && receipt.nodeFingerprint.length === 64
      && typeof receipt.outputDigest === 'string'
      && receipt.outputDigest.length === 64
      && receipt.status === 'succeeded'
      && receipt.verified === true
    ))
    .map((receipt: any): ModelGraphNodeReceipt => ({
      graphId: receipt.graphId,
      taskId: receipt.taskId,
      nodeId: receipt.nodeId,
      status: 'succeeded',
      ...(receipt.selectedCandidate ? { selectedCandidate: { ...receipt.selectedCandidate } } : {}),
      ...(receipt.agentId ? { agentId: String(receipt.agentId) } : {}),
      dependencyReceiptIds: Array.isArray(receipt.dependencyReceiptIds)
        ? receipt.dependencyReceiptIds.map(String)
        : [],
      startedAt: String(receipt.startedAt || ''),
      completedAt: String(receipt.completedAt || ''),
      durationMs: Math.max(0, Number(receipt.durationMs) || 0),
      nodeFingerprint: receipt.nodeFingerprint,
      outputDigest: receipt.outputDigest,
      verified: true,
      ...(receipt.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: Math.max(0, Number(receipt.estimatedInputTokens) || 0) }
        : {}),
      ...(receipt.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: Math.max(0, Number(receipt.estimatedCostUsd) || 0) }
        : {}),
      ...(receipt.reusedFromReceipt ? { reusedFromReceipt: String(receipt.reusedFromReceipt) } : {}),
    }));
  return { graph, receipts };
}

export function findConversationActionTask(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const intent = normalizeActionIntent(input.query || '');
  const query = String(input.query || '').toLowerCase();
  const verifiedTaskIds = new Set((db.conversationActionReceipts as ConversationActionReceiptRow[])
    .filter(receipt => receipt.outcome === 'verified_success')
    .map(receipt => receipt.taskId));
  return (db.conversationActionTasks as ConversationActionTaskRow[])
    .filter(task => task.conversationId === input.conversationId && task.userId === input.userId)
    .map(task => {
      const taskContext = parseObject(task.context);
      const workflowContext = parseObject(taskContext.industryWorkflow);
      const haystack = [
        task.intentKind,
        task.goal,
        task.target,
        workflowContext.entryId,
        workflowContext.productLine,
        workflowContext.workspace?.name,
      ].filter(Boolean).join(' ').toLowerCase();
      let score = 0;
      if (intent.target && haystack.includes(intent.target.toLowerCase())) score += 8;
      if (intent.target === 'AutoCAD' && /cad|图纸|平面图/i.test(haystack)) score += 8; // i18n-allow: Chinese CAD task matching; not user-visible copy.
      if (intent.kind !== 'status_query' && intent.kind !== 'none' && task.intentKind === intent.kind) score += 6;
      if (query && haystack.includes(query)) score += 3;
      const state = conversationActionStateFromTask(task);
      const hasVerifiedReceipt = verifiedTaskIds.has(task.id) || Boolean(state?.receipts?.some(receipt => (
        receipt.outcome === 'success' && receipt.terminalVerification?.status === 'verified'
      )));
      const evidenceRank = task.status === 'completed' && task.completionSource === 'tool_receipt' && hasVerifiedReceipt
        ? 3
        : hasVerifiedReceipt
          ? 2
          : task.status === 'blocked' && !(state?.receipts || []).length
            ? 0
            : 1;
      return { task, score, evidenceRank, normalizedGoal: task.goal.trim().toLowerCase() };
    })
    .sort((left, right) => (
      right.score - left.score
      || (left.normalizedGoal === right.normalizedGoal ? right.evidenceRank - left.evidenceRank : 0)
      || (query
        ? right.task.updatedAt.localeCompare(left.task.updatedAt)
        : right.task.createdAt.localeCompare(left.task.createdAt)
          || right.task.updatedAt.localeCompare(left.task.updatedAt))
    ))[0]?.task || null;
}

export function conversationActionStateFromTask(
  task: ConversationActionTaskRow | null | undefined,
): ConversationActionContinuationState | null {
  if (!task) return null;
  const context = parseObject(task.context);
  const persisted = normalizeConversationActionState(context.actionState);
  return normalizeConversationActionState({
    ...(persisted || {}),
    version: 2,
    taskId: task.id,
    goal: persisted?.goal || task.goal,
    latestInstruction: persisted?.latestInstruction || persisted?.goal || task.goal,
    status: task.status,
    latestBlocker: task.blocker,
    activeRequestId: task.activeRequestId || undefined,
    completionSource: task.completionSource === 'user_observation'
      ? 'user_observation'
      : task.completionSource === 'tool_receipt'
        ? 'tool_receipt'
        : undefined,
    unfinished: task.status !== 'completed' && task.status !== 'cancelled',
    updatedAt: task.updatedAt,
    appTarget: persisted?.appTarget || task.target,
    sourcePaths: persisted?.sourcePaths || [],
    evidenceTools: persisted?.evidenceTools || [],
    assistantState: persisted?.assistantState || '',
    toolSummaries: persisted?.toolSummaries || [],
    receipts: persisted?.receipts || [],
  } as ConversationActionContinuationState);
}

export function getConversationActionStateFromLedger(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): ConversationActionContinuationState | null {
  return conversationActionStateFromTask(findConversationActionTask(db, input));
}

function industryWorkflowStatusLabel(status: ConversationTaskStatus, finalReceiptVerified = true): string {
  if (status === 'completed') return finalReceiptVerified
    ? '已完成（最终回执已验证）'
    : '已完成（无行业最终回执）';
  if (status === 'waiting_confirmation') return '等待确认';
  if (status === 'blocked') return '受阻';
  if (status === 'cancelled') return '已取消';
  if (status === 'executing') return '执行中';
  return '准备中';
}

function receiptPayload(receipt: any): Record<string, any> {
  if (receipt?.receipt && typeof receipt.receipt === 'object') return receipt.receipt;
  return parseObject(receipt?.result);
}

function describeIndustryConfirmationBoundary(values: unknown[]): string[] {
  const text = values.map(String).join(' ').toLowerCase();
  const labels: string[] = [];
  const add = (label: string) => { if (!labels.includes(label)) labels.push(label); };
  if (/customer messages?|communications?|\bmessages?\b|send(?:ing)?/.test(text)) add('发送客户消息');
  if (/publish|publishing/.test(text)) add('发布内容');
  if (/refund/.test(text)) add('退款');
  if (/compensation/.test(text)) add('赔偿');
  if (/binding promises?|promise/.test(text)) add('承诺处理结果');
  if (/price changes?|repric/.test(text)) add('改价');
  if (/listing changes?|\blisting\b|\bdelisting\b|list(?:ing)?\s+(?:or\s+)?delist/.test(text)) add('上下架');
  if (/external store changes?|store mutation|platform mutation/.test(text)) add('店铺外部修改');
  if (/advertising spend|\bad spend\b|campaign spend/.test(text)) add('广告投放');
  if (/product selection/.test(text)) add('选品');
  if (/procurement|purchas(?:e|ing)/.test(text)) add('采购');
  if (/submit|submission|filing/.test(text)) add('提交或申报');
  if (/payment/.test(text)) add('付款');
  if (/sign(?:ing|ature)?/.test(text)) add('签署');
  if (/formal legal opinions?/.test(text)) add('正式法律意见');
  if (/client delivery|external delivery|external submission/.test(text)) add('客户外发或外部报送');
  if (/licensed lawyer approval|professional approval/.test(text)) add('执业律师复核');
  return labels;
}

interface IndustryWorkflowLedgerSummary {
  workflowType: string;
  status: string;
  keyResults: string[];
  deliverables: string[];
  confirmationBoundaries: string[];
  blocker: string;
}

function summarizeIndustryWorkflowLedger(
  task: ConversationActionTaskRow,
  state: ConversationActionContinuationState,
): IndustryWorkflowLedgerSummary | null {
  const context = parseObject(task.context);
  if (!context.industryWorkflow) return null;
  const receipts = state.receipts || [];
  const start = receipts.find(receipt => receipt.name === 'industry_workflow_start');
  const completion = [...receipts].reverse().find(receipt => (
    receipt.name === 'industry_workflow_complete'
    && receipt.outcome === 'success'
    && receipt.terminalVerification?.status === 'verified'
  ));
  const startResult = receiptPayload(start);
  const deterministicCompletion = [...receipts].reverse().find(receipt => {
    if (!receipt.name.startsWith('industry_')) return false;
    if (['industry_workflow_start', 'industry_workspace_status', 'industry_workflow_complete'].includes(receipt.name)) return false;
    if (receipt.outcome !== 'success' || receipt.terminalVerification?.status !== 'verified') return false;
    const payload = receiptPayload(receipt);
    return payload.ok === true
      && (payload.status === 'verified' || payload.verification?.passed === true || payload.verification?.status === 'passed');
  });
  const terminalCompletion = completion || deterministicCompletion;
  const completionResult = receiptPayload(terminalCompletion);
  const workflowTask = parseObject(completionResult.task);
  const workflowType = String(startResult?.entry?.displayName || workflowTask.title || context.industryWorkflow.entryId || '行业工作流');
  const workspaceName = String(context.industryWorkflow?.workspace?.name || '').trim();
  const meaningfulArtifacts = (Array.isArray(workflowTask.artifacts) ? workflowTask.artifacts : [])
    .filter((artifact: any) => artifact && (
      String(artifact.status || '').toLowerCase() !== 'planned'
      || artifact.content
      || artifact.filePath
      || artifact.url
    ));
  const verificationChecks = Array.isArray(completionResult?.verification?.checks)
    ? completionResult.verification.checks
    : [];
  const verifiedArtifactLabels = verificationChecks
    .filter((check: any) => check?.id === 'artifact_labels' && check?.passed === true)
    .flatMap((check: any) => String(check.detail || '')
      .replace(/^(?:已记录|recorded)\s*[：:]\s*/iu, '')
      .split(/[、,，;；]/u)
      .map((label: string) => label.trim())
      .filter(Boolean));
  const deliverables = [...new Set([...meaningfulArtifacts
    .map((artifact: any) => String(artifact.label || '').trim())
    .filter(Boolean), ...verifiedArtifactLabels])];
  const draftCount = Array.isArray(workflowTask.drafts) ? workflowTask.drafts.length : 0;
  const verificationPassed = completionResult?.verification?.passed === true
    || completionResult?.verificationStatus === 'passed'
    || completionResult?.verification?.status === 'passed'
    || completionResult?.status === 'verified';
  const keyResults: string[] = [];
  if (workspaceName) keyResults.push(`绑定并沿用“${workspaceName}”工作区`);
  if (draftCount) keyResults.push(`生成并归档 ${draftCount} 份草稿`);
  const deterministicMessage = deterministicCompletion
    ? String(completionResult.message || '').split(/\r?\n/u).map(line => line.trim().replace(/[。；;]+$/u, '')).find(Boolean)
    : '';
  if (deterministicMessage) keyResults.push(deterministicMessage);
  if (verificationPassed) keyResults.push('最终结果校验通过');
  if (!keyResults.length) {
    const verifiedReceipts = receipts.filter(receipt => (
      receipt.outcome === 'success' && receipt.terminalVerification?.status === 'verified'
    )).length;
    keyResults.push(verifiedReceipts ? `核对 ${verifiedReceipts} 个已验证执行回执` : '尚无可验证执行结果');
  }
  const confirmationRequired = Array.isArray(workflowTask.confirmationRequired)
    ? workflowTask.confirmationRequired
    : [];
  const verifiedConfirmationBoundaries = verificationChecks
    .filter((check: any) => check?.id === 'confirmation_boundaries' && check?.passed === true)
    .map((check: any) => String(check.detail || '').trim())
    .filter(Boolean);
  return {
    workflowType,
    status: industryWorkflowStatusLabel(task.status, Boolean(terminalCompletion)),
    keyResults,
    deliverables,
    confirmationBoundaries: describeIndustryConfirmationBoundary([
      ...confirmationRequired,
      ...verifiedConfirmationBoundaries,
    ]),
    blocker: String(task.blocker || '').trim(),
  };
}

function formatIndustryWorkflowLedgerStatus(
  task: ConversationActionTaskRow,
  state: ConversationActionContinuationState,
): string | null {
  const summary = summarizeIndustryWorkflowLedger(task, state);
  if (!summary) return null;
  const did = [...summary.keyResults];
  if (summary.deliverables.length) did.push(`形成交付物“${summary.deliverables.slice(0, 3).join('、')}”`);
  const didNot = summary.confirmationBoundaries.length
    ? `未执行${summary.confirmationBoundaries.join('、')}；这些动作仍需逐项确认和真实平台回执。`
    : '没有把未验证步骤描述成已完成。';
  const blocker = summary.blocker ? `\n阻塞原因：${summary.blocker}` : '';
  return [
    `任务类型：${summary.workflowType}`,
    `当前状态：${summary.status}`,
    `已做：${did.join('；')}。`,
    `未做：${didNot}${blocker}`,
  ].join('\n');
}

function industryTaskEvidenceRank(db: any, task: ConversationActionTaskRow): number {
  const state = conversationActionStateFromTask(task);
  const hasVerifiedReceipt = (db.conversationActionReceipts as ConversationActionReceiptRow[])
    .some(receipt => receipt.taskId === task.id && receipt.outcome === 'verified_success')
    || Boolean(state?.receipts?.some(receipt => (
      receipt.outcome === 'success' && receipt.terminalVerification?.status === 'verified'
    )));
  if (task.status === 'completed' && task.completionSource === 'tool_receipt' && hasVerifiedReceipt) return 3;
  if (hasVerifiedReceipt) return 2;
  if (task.status === 'blocked' && !(state?.receipts || []).length) return 0;
  return 1;
}

function findLatestIndustryTaskForEntry(
  db: any,
  input: { conversationId: string; userId: string; entryId: string; acrossConversations?: boolean },
): ConversationActionTaskRow | null {
  const currentConversation = Array.isArray(db.conversations)
    ? db.conversations.find((conversation: any) => conversation.id === input.conversationId)
    : null;
  const expectedDomain = String(currentConversation?.domain || 'personal');
  const expectedOrgId = String(currentConversation?.orgId || '');
  const candidates = (Array.isArray(db.conversationActionTasks) ? db.conversationActionTasks : [])
    .filter(task => {
      if (task.userId !== input.userId) return false;
      if (input.acrossConversations) {
        if (String(task.domain || 'personal') !== expectedDomain || String(task.orgId || '') !== expectedOrgId) return false;
      } else if (task.conversationId !== input.conversationId) {
        return false;
      }
      const workflow = parseObject(parseObject(task.context).industryWorkflow);
      if (String(workflow.entryId || '') !== input.entryId) return false;
      const state = conversationActionStateFromTask(task);
      return Boolean(state?.receipts?.some(receipt => (
        receipt.name === 'industry_workflow_start'
        || receipt.name === 'industry_workflow_complete'
        || (receipt.name.startsWith('industry_') && receipt.name !== 'industry_workspace_status')
      )));
    })
    .map(task => ({
      task,
      evidenceRank: industryTaskEvidenceRank(db, task),
      normalizedGoal: task.goal.trim().toLowerCase(),
    }))
    .sort((left, right) => (
      left.normalizedGoal === right.normalizedGoal
        ? right.evidenceRank - left.evidenceRank || right.task.updatedAt.localeCompare(left.task.updatedAt)
        : right.task.updatedAt.localeCompare(left.task.updatedAt)
    ));
  return candidates[0]?.task || null;
}

const LEGACY_LEGAL_RECEIPTS_BY_ENTRY: Record<string, string[]> = {
  workspace: ['legal_case_workspace'],
  packet: ['legal_generate_argument_or_opinion', 'legal_generate_litigation_packet'],
  'contract-review': ['legal_review_contract'],
  research: ['legal_search_case', 'legal_search_statute', 'legal_authority_source_status', 'legal_search_external_authorities'],
  'asset-trace': ['legal_trace_assets', 'legal_equity_penetration'],
  verify: ['legal_verify_archived_delivery', 'legal_generate_citation_verification_report', 'legal_finalize_delivery_package'],
  bid: ['legal_generate_bid'],
};

function findLatestVerifiedLegacyLegalTaskForEntry(
  db: any,
  input: { conversationId: string; userId: string; entryId: string },
): ConversationActionTaskRow | null {
  const acceptedReceipts = new Set(LEGACY_LEGAL_RECEIPTS_BY_ENTRY[input.entryId] || []);
  if (!acceptedReceipts.size) return null;
  const currentConversation = Array.isArray(db.conversations)
    ? db.conversations.find((conversation: any) => conversation.id === input.conversationId)
    : null;
  const expectedDomain = String(currentConversation?.domain || 'personal');
  const expectedOrgId = String(currentConversation?.orgId || '');
  return (Array.isArray(db.conversationActionTasks) ? db.conversationActionTasks : [])
    .filter((task: ConversationActionTaskRow) => {
      if (task.userId !== input.userId) return false;
      if (String(task.domain || 'personal') !== expectedDomain || String(task.orgId || '') !== expectedOrgId) return false;
      const state = conversationActionStateFromTask(task);
      return Boolean(state?.receipts?.some(receipt => (
        acceptedReceipts.has(receipt.name)
        && receipt.outcome === 'success'
        && receipt.terminalVerification?.status === 'verified'
      )));
    })
    .sort((left: ConversationActionTaskRow, right: ConversationActionTaskRow) => (
      industryTaskEvidenceRank(db, right) - industryTaskEvidenceRank(db, left)
      || right.updatedAt.localeCompare(left.updatedAt)
    ))[0] || null;
}

function formatLegacyLegalLedgerSection(
  task: ConversationActionTaskRow,
  entry: { entryId: string; displayName: string; contract: { confirmationBoundaries: string[] } },
): string {
  const state = conversationActionStateFromTask(task);
  const receipts = (state?.receipts || []).filter(receipt => (
    (LEGACY_LEGAL_RECEIPTS_BY_ENTRY[entry.entryId] || []).includes(receipt.name)
    && receipt.outcome === 'success'
    && receipt.terminalVerification?.status === 'verified'
  ));
  const receiptText = receipts.map(receipt => String(receipt.result || '')).join('\n');
  const caseId = receiptText.match(/案件\s*ID[：:]\s*([\w-]+)/iu)?.[1] || '';
  const completion = receiptText.match(/完成度[：:]\s*(\d+\s*\/\s*\d+(?:（\d+%）|\s*\(\d+%\))?)/u)?.[1]?.trim() || '';
  const cannotDeliver = /不可正式交付/u.test(receiptText);
  const keyResultByEntry: Record<string, string> = {
    workspace: [caseId ? `案件 ID ${caseId}` : '', completion ? `案件闭环完成度 ${completion}` : '', '案件字段与缺失材料已持久化'].filter(Boolean).join('；'),
    packet: '诉前应对策略律师复核草稿已归档；未知事实、证据和法源保留待确认边界',
    'contract-review': '合同风险点、修改建议、待确认信息与律师复核边界已形成',
    research: '已记录权威法源状态、法条与类案的可核验结果及缺口',
    'asset-trace': '已记录外部数据源状态、可核验线索与待人工核验项，未补造资产信息',
    verify: cannotDeliver
      ? '交付核验结论为不可正式交付；事实、法源、时效、管辖、文件和律师复核缺口已列明'
      : '事实、法源、时效、管辖、文件和律师复核状态已核验',
    bid: '内部投标响应工作底稿已形成；缺失的主体、资质、业绩、人员、报价、保证金和签章信息保留待填写或待确认',
  };
  const deliverableByEntry: Record<string, string> = {
    workspace: '案件工作台记录与案件闭环状态',
    packet: '诉前应对策略律师复核草稿（案件账本正文）',
    'contract-review': '合同审查结果（仅依据原文）',
    research: '法源与类案检索状态记录',
    'asset-trace': '财产线索快速筛查报告与数据源状态记录',
    verify: '已归档文书交付核验报告',
    bid: '园区 AI 法律服务试点项目内部投标响应工作底稿',
  };
  const boundaries = describeIndustryConfirmationBoundary(entry.contract.confirmationBoundaries || []);
  return [
    `【${entry.displayName}】`,
    `最近任务状态：${industryWorkflowStatusLabel(task.status, receipts.length > 0)}`,
    `关键结果：${keyResultByEntry[entry.entryId] || `已核对 ${receipts.length} 个最终验证回执`}`,
    `交付物：${deliverableByEntry[entry.entryId] || '已验证的法律工作底稿'}`,
    `确认边界：${boundaries.length ? `${boundaries.join('、')}仍需执业律师逐项确认和真实平台回执` : '没有把未验证步骤描述成已完成'}`,
  ].join('\n');
}

function formatMultiIndustryWorkflowLedgerStatus(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): string | null {
  const query = String(input.query || '').trim();
  const profile = getCurrentIndustryCapabilityProfile();
  if (!profile || !/(?:状态|账本|回执|最近任务|关键结果|交付物|确认边界)/u.test(query)) return null;
  const requestedEntries = profile.entries.filter(entry => query.includes(entry.displayName));
  if (requestedEntries.length < 2) return null;

  const sections = requestedEntries.map(entry => {
    const industryTask = findLatestIndustryTaskForEntry(db, {
      conversationId: input.conversationId,
      userId: input.userId,
      entryId: entry.entryId,
      acrossConversations: true,
    });
    const task = industryTask || (profile.productLine === 'legal'
      ? findLatestVerifiedLegacyLegalTaskForEntry(db, {
          conversationId: input.conversationId,
          userId: input.userId,
          entryId: entry.entryId,
        })
      : null);
    if (!task) {
      return [
        `【${entry.displayName}】`,
        '最近任务状态：无已存在的行业任务记录',
        '关键结果：无可验证执行结果',
        '交付物：无最终回执记录',
        '确认边界：无任务回执，未执行任何外部修改',
      ].join('\n');
    }
    const state = conversationActionStateFromTask(task);
    const summary = state ? summarizeIndustryWorkflowLedger(task, state) : null;
    if (!summary && profile.productLine === 'legal') {
      return formatLegacyLegalLedgerSection(task, entry);
    }
    if (!summary) {
      return [
        `【${entry.displayName}】`,
        `最近任务状态：${industryWorkflowStatusLabel(task.status)}`,
        '关键结果：无可验证执行结果',
        '交付物：无最终回执记录',
        `确认边界：${task.blocker ? `任务受阻：${task.blocker}` : '没有把未验证步骤描述成已完成'}`,
      ].join('\n');
    }
    return [
      `【${entry.displayName}】`,
      `最近任务状态：${summary.status}`,
      `关键结果：${summary.keyResults.join('；')}${summary.blocker ? `；阻塞原因：${summary.blocker}` : ''}`,
      `交付物：${summary.deliverables.length ? summary.deliverables.join('、') : '最终回执中未记录交付物'}`,
      `确认边界：${summary.confirmationBoundaries.length ? `${summary.confirmationBoundaries.join('、')}仍需逐项确认和真实平台回执` : '没有把未验证步骤描述成已完成'}`,
    ].join('\n');
  });
  return [
    `行业任务账本汇总（${profile.displayName}）`,
    ...sections,
    '本次仅查询既有任务账本与最终回执；未重新执行工作流、未调用外部工具、未创建新任务、未进行外部修改。',
  ].join('\n\n');
}

export function formatConversationActionLedgerStatus(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): string | null {
  const multiIndustryStatus = formatMultiIndustryWorkflowLedgerStatus(db, input);
  if (multiIndustryStatus) return multiIndustryStatus;
  const task = findConversationActionTask(db, input);
  const state = conversationActionStateFromTask(task);
  if (!state) return null;
  const industryStatus = task ? formatIndustryWorkflowLedgerStatus(task, state) : null;
  if (industryStatus) return industryStatus;
  return formatConversationActionTaskStatus(state);
}

export function migrateLegacyConversationActionLedger(db: any): number {
  ensureTables(db);
  let migrated = 0;
  for (const conversation of db.conversations || []) {
    const state = normalizeConversationActionState(conversation.actionContinuationState);
    if (!state?.taskId) continue;
    if ((db.conversationActionTasks as ConversationActionTaskRow[]).some(task => task.id === state.taskId)) continue;
    if (syncConversationActionTaskLedger(db, { conversation, state, now: state.updatedAt })) migrated += 1;
  }
  return migrated;
}

/**
 * Process-local request leases cannot survive a backend restart. Recover every
 * non-scheduler ledger row, including older rows hidden by a newer task. Hidden
 * rows keep their original ordering timestamp so recovery cannot steal the
 * conversation's current task pointer; the repair time remains in context.
 */
export function recoverConversationActionTaskLeases(
  db: any,
  now = new Date().toISOString(),
): number {
  ensureTables(db);
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  let recovered = 0;

  for (const task of tasks) {
    if (task.conversationId.startsWith('scheduler:')) continue;
    if (task.status === 'completed' || task.status === 'cancelled') continue;

    const hasNewerTask = tasks.some(candidate => (
      candidate.id !== task.id
      && candidate.conversationId === task.conversationId
      && candidate.userId === task.userId
      && candidate.createdAt.localeCompare(task.createdAt) > 0
    ));
    const previousStatus = task.status;
    const context = parseObject(task.context);
    const actionState = normalizeConversationActionState(context.actionState);
    const orderingTimestamp = hasNewerTask ? task.updatedAt : now;
    const completion = actionState
      ? taskCompletionFromReceipts(actionState.goal || task.goal, actionState.receipts || [])
      : { complete: false, blocker: '' };

    // A process may have ended after durable verified receipts were written
    // but before the final status transition was flushed. Reconcile those
    // receipts first. Restart recovery must never overwrite verified business
    // completion with a generic interrupted-runtime blocker.
    if (completion.complete && actionState) {
      task.status = 'completed';
      task.blocker = '';
      task.activeRequestId = '';
      task.completionSource = 'tool_receipt';
      task.completedAt = task.completedAt || now;
      task.revision = Math.max(1, Number(task.revision) || 0) + 1;
      task.updatedAt = orderingTimestamp;
      task.context = JSON.stringify({
        ...context,
        receiptRecovery: {
          recoveredAt: now,
          priorStatus: previousStatus,
          newerTaskAlreadyExists: hasNewerTask,
        },
        actionState: sanitizeState({
          ...actionState,
          version: 2,
          status: 'completed',
          unfinished: false,
          latestBlocker: '',
          activeRequestId: undefined,
          completionSource: 'tool_receipt',
          revision: Math.max(actionState.revision || 0, task.revision),
          updatedAt: orderingTimestamp,
        }),
      });
      recovered += 1;
      continue;
    }

    if (!['planning', 'executing', 'waiting_confirmation'].includes(previousStatus)) continue;
    const blocker = previousStatus === 'waiting_confirmation'
      ? 'The pending confirmation expired when the previous runtime ended.'
      : 'The previous runtime ended before this task reached a terminal receipt.';

    task.status = 'blocked';
    task.blocker = blocker;
    task.activeRequestId = '';
    task.revision = Math.max(1, Number(task.revision) || 0) + 1;
    task.updatedAt = orderingTimestamp;
    task.context = JSON.stringify({
      ...context,
      executionLeaseRecovery: {
        recoveredAt: now,
        priorStatus: previousStatus,
        newerTaskAlreadyExists: hasNewerTask,
      },
      ...(actionState
        ? {
            actionState: sanitizeState({
              ...actionState,
              version: 2,
              status: 'blocked',
              unfinished: true,
              latestBlocker: blocker,
              activeRequestId: undefined,
              revision: Math.max(actionState.revision || 0, task.revision),
              updatedAt: orderingTimestamp,
            }),
          }
        : {}),
    });
    recovered += 1;
  }
  return recovered;
}

/**
 * One-version repair for receipts written by the former text-scanning
 * success detector. A verified structured result containing diagnostics such
 * as `failed: 0` could be persisted as a failure. Only contradictory rows
 * that already carry an explicit verified terminal decision are repaired.
 */
export function repairContradictoryConversationActionReceipts(db: any): number {
  ensureTables(db);
  let repaired = 0;
  const repairedRecords = new Map<string, ToolExecutionRecord[]>();
  for (const row of db.conversationActionReceipts as ConversationActionReceiptRow[]) {
    if (row.outcome !== 'failed') continue;
    const envelope = parseObject(row.envelope);
    if (envelope?.verification?.status !== 'verified') continue;
    const result = envelope.result;
    if (!result || typeof result !== 'object') continue;
    const record: ToolExecutionRecord = {
      taskId: row.taskId,
      turnId: row.turnId,
      requestId: row.requestId,
      idempotencyKey: row.idempotencyKey,
      name: row.toolName,
      arguments: envelope.toolName === 'client_action'
        ? {
            action: String(result.action || ''),
            target: String(result.target || row.targetIdentity || ''),
            ...(typeof result?.relayResult?.enabled === 'boolean'
              ? { enabled: result.relayResult.enabled }
              : {}),
          }
        : row.targetIdentity
          ? { target: row.targetIdentity }
          : {},
      result: JSON.stringify(result),
      receipt: result,
      terminalVerification: {
        status: 'verified',
        strategy: String(envelope?.verification?.strategy || 'terminal_receipt') as any,
        reason: String(envelope?.verification?.reason || 'Verified terminal receipt.'),
      },
    };
    if (!toolRecordSucceeded(record)) continue;
    row.outcome = 'verified_success';
    row.envelope = JSON.stringify({
      ...envelope,
      status: 'verified_success',
      error: undefined,
    });
    const records = repairedRecords.get(row.taskId) || [];
    records.push(record);
    repairedRecords.set(row.taskId, records);
    repaired += 1;
  }

  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  for (const [taskId, records] of repairedRecords) {
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task) continue;
    const context = parseObject(task.context);
    const state = normalizeConversationActionState(context.actionState);
    if (!state) continue;
    const receipts = mergeTaskReceipts(
      (state.receipts || []).map(receipt => (
        receipt.outcome === 'failure' && receipt.terminalVerification?.status === 'verified'
          ? { ...receipt, outcome: 'success' as const, error: '' }
          : receipt
      )),
      records,
      task.updatedAt,
    );
    const completion = taskCompletionFromReceipts(state.goal || task.goal, receipts);
    const status = completion.complete ? 'completed' : task.status;
    const nextState = normalizeConversationActionState({
      ...state,
      receipts,
      status,
      unfinished: status !== 'completed' && status !== 'cancelled',
      latestBlocker: completion.complete ? '' : state.latestBlocker,
      activeRequestId: completion.complete ? undefined : state.activeRequestId,
      completionSource: completion.complete ? 'tool_receipt' : state.completionSource,
      revision: Math.max(state.revision || 0, task.revision || 0) + 1,
      updatedAt: task.updatedAt,
    });
    if (nextState) context.actionState = sanitizeState(nextState);
    task.context = JSON.stringify(context);
    task.status = status;
    if (completion.complete) {
      task.blocker = '';
      task.activeRequestId = '';
      task.completionSource = 'tool_receipt';
      task.completedAt = task.completedAt || task.updatedAt;
    }
    task.revision = nextState?.revision || task.revision;
  }
  return repaired;
}
