import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { getCurrentIndustryCapabilityProfile, matchCurrentIndustryWorkflow } from '../../regions/packs/cn/industry_capability_profile';
import {
  getIndustryWorkflowTask,
  listIndustryWorkflowTasks,
  recordIndustryWorkflowExecution,
  startIndustryWorkflow,
} from '../../industry/workflow_service';
import type { ToolContext } from '../types';

// i18n-allow: The multilingual routing hints below are internal tool-selection
// aliases for Chinese industry requests; they are never rendered as UI copy.

function scope(context?: ToolContext) {
  return {
    userId: context?.userId || 'anonymous',
    domain: context?.domain === 'work' ? 'work' as const : 'personal' as const,
    orgId: context?.domain === 'work' ? String(context?.orgId || '') : '',
  };
}

export function registerIndustryWorkflowTools(registry: ToolRegistry): void {
  registry.register({
    name: 'industry_capability_profile_get',
    description: 'Read the authoritative identity, outcome workspaces, automatic preparation actions, professional-review boundaries, and optional extensions for this exact Lumi industry edition.',
    // i18n-allow: Reviewed Chinese input-recognition aliases; not user-visible copy.
    routingHints: ['this Lumi edition', 'industry capabilities', 'what can you do', '你是什么版本', '你能做什么', '自动流程', '半自动流程'],
    parameters: {
      type: 'object',
      properties: { request: { type: 'string', description: 'Optional natural-language industry request to classify without starting work.' } },
      required: [],
    },
    handler: async (args) => {
      const profile = getCurrentIndustryCapabilityProfile();
      if (!profile) throw new Error('This runtime has no industry capability profile.');
      const match = args.request ? matchCurrentIndustryWorkflow(args.request) : null;
      return JSON.stringify({
        ok: true, status: 'observed', profile,
        match: match ? { entryId: match.entry.entryId, displayName: match.entry.displayName, score: match.score, matchedTerms: match.matchedTerms } : null,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.capability-profile.observe', family: 'industry', lane: 'industry', operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'none', scope: 'industry capability profile', reversible: true }],
      verification: {
        strategy: 'measured', required: true,
        requiredFields: ['ok', 'status', 'profile.variantId', 'profile.productLine', 'profile.entries'],
        requiredValues: { ok: true }, successStatuses: ['observed'],
        successSignals: ['server-owned profile returned'],
        limitations: ['Describes registered edition workflows; external connectors still require runtime health checks.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.capability-profile.observe', operation: 'observe', subjectArgument: 'request', limitations: ['Does not execute an industry workflow.'] }),
  });

  registry.register({
    name: 'industry_workflow_start',
    description: 'Start exactly one persistent, edition-scoped industry outcome workflow from a natural-language request. Returns the existing task on an idempotent retry. Continue it with real domain tools and verify before claiming completion.',
    // i18n-allow: Reviewed Chinese industry-workspace aliases; not user-visible copy.
    routingHints: ['industry workflow', 'outcome workspace', '今日经营', '爆款雷达', '店铺数据', '商品管理', '内容与客服', '设计项目', 'CAD 方案', '效果图', '提案 PPT', '交付中心', '案件工作台', '文书生成', '合同审查', '法条与类案', '财产线索', '交付核验', '标书制作', '经营看板', '票税管理', '账务处理', '税务申报', '资金与风险', '报表交付'],
    parameters: {
      type: 'object',
      properties: {
        entryId: { type: 'string', description: 'Exact entry id from industry_capability_profile_get.' },
      },
      required: ['entryId'],
    },
    handler: async (args, context) => {
      const activeScope = scope(context);
      const profile = getCurrentIndustryCapabilityProfile();
      const entryId = String(args.entryId || '').trim();
      const entry = profile?.entries.find(candidate => candidate.entryId === entryId);
      if (!profile || !entry) throw new Error(`Industry entry is not available in this edition: ${entryId}`);
      const namedTaskId = String(context?.routedTaskText || '').match(/\bwt_task_[a-zA-Z0-9_-]+\b/)?.[0] || '';
      const namedTask = namedTaskId ? getIndustryWorkflowTask(activeScope, namedTaskId) : null;
      if (namedTask?.metadata?.industryWorkflow?.entryId === entryId) {
        const metadata = namedTask.metadata.industryWorkflow;
        return JSON.stringify({
          ok: true, status: 'reused', persisted: true,
          entry: { entryId, displayName: entry.displayName }, task: namedTask,
          conversationId: metadata.conversationId,
          conversationTaskId: metadata.conversationTaskId,
          requestId: metadata.requestId,
          handoffPrompt: `Continue existing industry task ${namedTask.id}; do not create a duplicate.`,
          activeTaskCount: listIndustryWorkflowTasks(activeScope, 200).filter(task => ['queued', 'in_progress', 'waiting_confirmation', 'blocked'].includes(task.status)).length,
        }, null, 2);
      }
      const idempotencyKey = String(context?.idempotencyKey || context?.requestId || '').trim();
      const started = startIndustryWorkflow({
        ...activeScope,
        entryId,
        sourceInput: String(context?.actionIntent || ''),
        source: context?.source || 'industry_natural_language',
        context: { source: context?.source || 'industry_natural_language' },
        idempotencyKey: idempotencyKey ? `industry-start:${idempotencyKey}:${entryId}` : undefined,
        conversationId: context?.conversationId,
        conversationTaskId: context?.taskId,
        requestId: context?.requestId,
      });
      return JSON.stringify({
        ok: true, status: started.reused ? 'reused' : 'created', persisted: true,
        entry: { entryId, displayName: entry.displayName }, task: started.task,
        conversationId: started.conversationId, conversationTaskId: started.conversationTaskId,
        requestId: started.requestId, handoffPrompt: started.handoffPrompt,
        activeTaskCount: listIndustryWorkflowTasks(activeScope, 200).filter(task => ['queued', 'in_progress', 'waiting_confirmation', 'blocked'].includes(task.status)).length,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.workflow.start', family: 'industry', lane: 'industry', operation: 'create',
      risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'persistent industry workflow and linked action ledger', reversible: true }],
      verification: {
        strategy: 'artifact', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'task.id', 'conversationTaskId', 'entry.entryId'],
        requiredValues: { ok: true, persisted: true }, successStatuses: ['created', 'reused'],
        successSignals: ['persistent scoped task returned'],
        limitations: ['Starts and binds the workflow; it is not proof that the requested business result is complete.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.workflow.start', operation: 'create', subjectArgument: 'entryId', limitations: ['A later verified industry receipt is required for completion.'] }),
  });

  registry.register({
    name: 'industry_workflow_complete',
    description: 'Archive and verify the active edition-scoped industry workflow from real tool receipts produced earlier in this exact tool loop. Model text alone is rejected. Returns verified delivery or a concrete blocker.',
    // i18n-allow: Reviewed Chinese industry-verification aliases; not user-visible copy.
    routingHints: ['complete industry workflow', 'verify industry result', 'archive outcome', '验收行业任务', '归档行业结果'],
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'The wt_task_* id returned by industry_workflow_start.' } },
      required: ['taskId'],
    },
    handler: async (args, context) => {
      const activeScope = scope(context);
      const taskId = String(args.taskId || '').trim();
      const task = getIndustryWorkflowTask(activeScope, taskId);
      if (!task) throw new Error('Industry workflow task was not found in the active user scope.');
      const previousVerification = task.metadata?.workTakeoverVerification;
      if (task.status === 'delivered' && previousVerification?.passed === true) {
        return JSON.stringify({
          ok: true, status: 'verified', persisted: true, reused: true,
          task, verification: previousVerification,
        }, null, 2);
      }
      const excluded = new Set([
        'industry_capability_profile_get',
        'industry_workflow_start',
        'industry_workflow_complete',
        'work_takeover_task_get',
      ]);
      const evidenceRecords = (context?.getCurrentToolRecords?.() || []).filter(record => (
        !excluded.has(record.name)
        && !record.error
        && record.terminalVerification?.status === 'verified'
        && String(record.result || '').trim()
      ));
      if (!evidenceRecords.length) {
        throw new Error('No verified domain-tool receipt exists in this execution loop. Run the real industry capability before verification.');
      }
      const receiptText = evidenceRecords.map(record => String(record.result || '')).join('\n\n').slice(0, 12_000);
      const recorded = recordIndustryWorkflowExecution({
        ...activeScope,
        taskId,
        resultText: receiptText,
        toolRecords: evidenceRecords,
        source: context?.source || 'industry_natural_language',
      });
      return JSON.stringify({
        ok: recorded.verification.passed,
        status: recorded.verification.passed ? 'verified' : recorded.verification.status,
        persisted: true,
        task: recorded.task,
        verification: recorded.verification,
        archivedFilePaths: recorded.archivedFilePaths,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'industry.workflow.complete', family: 'industry', lane: 'industry', operation: 'test', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'industry workflow archive, verification and linked action ledger', reversible: true }],
      verification: {
        strategy: 'artifact', required: true,
        requiredFields: ['ok', 'status', 'persisted', 'task.id', 'verification.passed'],
        requiredValues: { ok: true, persisted: true, 'verification.passed': true },
        successStatuses: ['verified'], failureStatuses: ['blocked', 'needs_review'],
        successSignals: ['server-side industry verifier passed over current-loop receipts'],
        limitations: ['Verifies the scoped local result; it does not imply any unrequested external side effect.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'industry.workflow.complete', operation: 'test', subjectArgument: 'taskId', limitations: ['Requires earlier verified domain-tool receipts from the same execution loop.'] }),
  });
}
