import { getArtifactTaskProgress } from '../../cognition/action_contract';
import { artifactPathFromRecord, isArtifactProducerRecord, sameArtifactPath } from '../../tools/artifact_evidence';
import { isCanonicalToolExecutionRecord } from '../../tools/execution_engine';
import { isVerifiedToolSuccess } from './recovery';
import { getStoredDesktopExecutionPreference } from '../../cognition/operation_mode_store';
import { replacePromptBlock } from "../prompt_blocks";
import { formatCnMediaGenerationFailure } from "../../regions/messages/voice_fast_path_messages";
import type { NormalizedLLMResponse, ParsedToolCall } from "../../tools/types";
import { classifySkillAuthoringIntent } from "../../skills/authoring_intent";
import { findDesktopCompletionReview, desktopCompletionReviewText, DESKTOP_COMPLETION_REVIEW_REASON } from "../../cognition/desktop_completion_review";
import { hasCompletedCurrentSimplePlayback } from "../../cognition/simple_playback_goal";
import { missingTaskInputResult } from "../../cognition/missing_task_input";
import { guardCurrentAppToolCall } from "../../cognition/current_app_execution";
import { isConfirmationBlockedToolRecord } from "../../tools/confirmation_block";
import { executeToolCall } from "../../tools/execution_engine";
import type { ToolLoopState } from './loop_setup';
import type { LLMResult } from './contracts';
import { desktopControlPauseReason, buildDesktopControlPausedSummary, compactCurrentDocumentTargetStateForModel } from './projection';
import { recordWorkflowIfToolsUsed } from './workflow';
import { toolCallSignature, shouldSuppressConfirmedReplay } from './recovery';
import { formatToolRecordForModel } from './receipts';
import { hasSameTaskSkillGenerationDiscovery } from './runtime_activation';
import { isForbiddenLocalCadImageFallback } from './artifacts';
import { buildConfirmationBlockedSummary, getPrimaryUserText } from './summaries';

export async function executePlannedToolBatch(state: ToolLoopState, { normalizedToolCalls, exposedToolNames, response }: {
  normalizedToolCalls: (ParsedToolCall & { id: string })[];
  exposedToolNames: Set<string>;
  response: NormalizedLLMResponse;
}): Promise<LLMResult | undefined> {


    for (const tc of normalizedToolCalls) {
      // Cancellation can also arrive between multiple tool calls in one model
      // response. Never continue the remaining batch after that boundary.
      if (state.context?.isCancelled?.()) {
        return state.finish('Task was cancelled before the remaining tool calls could run.');
      }
      if (desktopControlPauseReason(state.context)) {
        recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
        const text = buildDesktopControlPausedSummary(state.primaryTask);
        return state.finish(text, { text, blocked: true, reason: 'desktop_control_paused' });
      }
      if (!exposedToolNames.has(tc.name)) {
        state.conversationHistory.push({
          role: 'tool',
          content: 'This tool is not exposed for the current task. Use only the tools declared for this turn.',
          toolCallId: tc.id,
          name: tc.name,
        });
        continue;
      }

      const confirmedReplay = [...state.priorExecutionRecords].reverse().find(record => (
        toolCallSignature(record) === toolCallSignature({
          name: tc.name,
          arguments: tc.arguments || {},
        })
      ));
      if (shouldSuppressConfirmedReplay(confirmedReplay)) {
        state.conversationHistory.push({
          role: 'tool',
          toolCallId: tc.id,
          name: tc.name,
          content: [
            'Duplicate confirmed side effect was not executed.',
            'The exact one-time confirmation was already consumed and its canonical receipt remains authoritative.',
            'Use the existing receipt to finish, select only missing verification, or reconcile uncertain commit state before choosing a different safe recovery path.',
            confirmedReplay ? formatToolRecordForModel(confirmedReplay) : '',
          ].filter(Boolean).join('\n'),
        });
        continue;
      }

      const callCapability = state.toolRegistry.getCapabilityManifestEntry?.(tc.name, state.toolExecutionContext?.toolPolicy, state.toolExecutionContext);
      const currentAppGuard = guardCurrentAppToolCall({
        taskText: state.primaryTask,
        toolName: tc.name,
        arguments: tc.arguments || {},
        toolRecords: state.executionLog,
        acceptedTaskTarget: state.toolExecutionContext?.acceptedTaskTarget,
        currentAppTarget: state.toolExecutionContext?.currentAppTarget,
        desktopExecutionPreference: getStoredDesktopExecutionPreference(state.toolExecutionContext?.userId || ''),
        isolatedCalculation: tc.name === 'code_execution'
          && callCapability?.source === 'builtin'
          && callCapability?.capabilityId === 'code.javascript.sandbox.execute'
          && callCapability.operation === 'test'
          && callCapability.sideEffects.every(effect => effect.type === 'local_state_change'),
      });
      const executionArguments = currentAppGuard.normalizedArguments
        || tc.arguments
        || {};
      state.invocationBudget.started += 1;
      state.invocationBudget.lastTouchedAt = Date.now();
      if (tc.name === 'capture_recent_workflow') recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config, state.primaryTask);
      const record = await executeToolCall({
        registry: state.toolRegistry,
        id: tc.id,
        executionOrigin: state.deterministicRecoveryToolCallIds.has(tc.id || '') ? 'deterministic_route' : response.routingReceiptId ? 'model_selected' : undefined,
        modelRoutingReceiptId: response.routingReceiptId,
        name: tc.name,
        arguments: executionArguments,
        context: state.toolExecutionContext,
        preflight: (_name, preparedArguments) => {
          if (!currentAppGuard.allowed) {
            return { allowed: false, reason: currentAppGuard.reason, arguments: executionArguments };
          }
          const output = state.requestedArtifact;
          if (output && isArtifactProducerRecord({ name: tc.name, capability: callCapability })
            && sameArtifactPath(artifactPathFromRecord({ name: tc.name, capability: callCapability, arguments: preparedArguments, result: '' }), output.path)) {
            const progress = getArtifactTaskProgress(state.primaryTask, state.executionLog.filter(record => isCanonicalToolExecutionRecord(record) && isVerifiedToolSuccess(record)), state.toolExecutionContext);
            if (progress && sameArtifactPath(progress.savedPath, output.path) && progress.next !== 'repair_content' && progress.next !== 'repair_workbook') {
              return { allowed: false, arguments: preparedArguments, reason: 'This exact requested output is already saved. Read back, open, or finish the remaining request; do not overwrite it without a verified repair requirement.' };
            }
          }
          if (
            tc.name === 'generate_skill'
            && classifySkillAuthoringIntent(String(state.toolExecutionContext?.actionIntent || state.primaryTask)) !== 'generate'
            && !hasSameTaskSkillGenerationDiscovery(state.executionLog, state.toolExecutionContext)
          ) {
            return {
              allowed: false,
              arguments: executionArguments,
              reason: 'Skill generation is the final reuse route. This same task must first verify existing signed extensions, record a Skill Hall search with no installable match, inspect curated external MCP candidates, and complete external integration research.',
            };
          }
          if (isForbiddenLocalCadImageFallback(state.primaryTask, tc.name, tc.arguments || {})) {
            return {
              allowed: false,
              arguments: executionArguments,
              reason: 'Blocked unsafe CAD image fallback. Use desktop_list_files/desktop_path_info followed by floorplan_extract_geometry or ocr_image_file; do not use project-scoped MCP filesystem or certutil/base64 shell conversion.',
            };
          }
          return { allowed: true, arguments: executionArguments };
        },
      });
      state.executionLog.push(record);
      await state.onToolCall?.(record);

      // The receipt observer may await persistence while cancellation or
      // physical user input arrives. Those signals win over goal completion.
      if (state.context?.isCancelled?.() || state.context?.executionSignal?.aborted || state.config.signal?.aborted) {
        return state.finish('Task was cancelled before the remaining tool calls could run.');
      }
      if (desktopControlPauseReason(state.context)) {
        recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
        const text = buildDesktopControlPausedSummary(state.primaryTask);
        return state.finish(text, { text, blocked: true, reason: 'desktop_control_paused' });
      }

      const missingInput = missingTaskInputResult(state.primaryTask, [record]);
      if (missingInput) {
        recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
        return state.finish(missingInput.text, missingInput);
      }

      // A failed paid generation ends this attempt, including queued calls in
      // the same batch. The model must not rewrite the user's brief or retry
      // behind the finalizer; a later user turn owns any authorized retry.
      if (record.error && ['generate_image', 'ai_edit_image', 'generate_video'].includes(record.name)
        && !isConfirmationBlockedToolRecord(record)) {
        const text = /[\u3400-\u9fff]/u.test(state.primaryTask)
          ? formatCnMediaGenerationFailure([record.error])
          : 'Generation did not complete. No further generation was submitted in this turn. A retry must reconcile any unknown prior provider outcome before resubmitting.';
        recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
        return state.finish(text, { text, blocked: true, reason: 'media_generation_failed' });
      }

      // The native loop already stopped at an uncertain completion candidate.
      // Do not execute another model-selected action (even in this batch) or
      // request a second confirmation that would repeat the completed steps.
      const desktopReview = findDesktopCompletionReview([record]);
      if (desktopReview) {
        const text = desktopCompletionReviewText(state.primaryTask, desktopReview);
        recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
        return state.finish(text, { text, blocked: true, reason: DESKTOP_COMPLETION_REVIEW_REASON });
      }

      state.conversationHistory.push({
        role: 'tool',
        content: formatToolRecordForModel(record),
        toolCallId: tc.id,
        name: tc.name,
      });
      if (hasCompletedCurrentSimplePlayback(state.primaryTask, state.executionLog, state.context)) {
        recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
        if (!state.context?.currentTurnExecutionRequested) return state.finish('');
        // Stop queued toggles, but let the primary model finish the whole request.
        for (const skipped of normalizedToolCalls.slice(normalizedToolCalls.indexOf(tc) + 1)) state.conversationHistory.push({
          role: 'tool', toolCallId: skipped.id, name: skipped.name,
          content: 'This queued call was not executed: verified playback already settled. Do not repeat its click or toggle.',
        });
        return undefined;
      }

      const compactTargetState = compactCurrentDocumentTargetStateForModel(
        state.primaryTask,
        state.executionLog,
        state.toolExecutionContext,
      );
      if (compactTargetState) {
        replacePromptBlock(state.conversationHistory, { id: 'current-document-target', kind: 'task_state',
          authority: 'server', required: true, content: compactTargetState });
      }

      if (isConfirmationBlockedToolRecord(record)) {
        recordWorkflowIfToolsUsed(state.executionLog, state.messages, state.config);
        const text = buildConfirmationBlockedSummary(state.executionLog, getPrimaryUserText(state.messages));
        return state.finish(text, { text, blocked: true, reason: 'waiting_confirmation' });
      }

    }
}
