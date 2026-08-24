import { Router } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { runWithTools } from "../llm/adapter";
import { makeLLMCall } from "../llm/providers";
import { toolRegistry } from "../tools/registry";
import { executeToolCall, executeToolCallOrThrow } from "../tools/execution_engine";
import { recordLatency } from "../monitor/latency_store";
import { optionalAuth, requireAuth, resolveDomain } from "../middleware/auth";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import { recordTokenUsage } from "../llm/token_tracker";
import { buildUnifiedLegalEntryPrompt } from "../cognition/legal_entry";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import { buildLumiTurnDispatch } from "../cognition/turn_dispatch";
import { buildLumiExecutionDecision } from "../cognition/execution_decision";
import { buildModelCapabilityPolicy } from "../cognition/capability_selection";
import {
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
} from "../cognition/response_delivery";
import type { LumiTurnFlow } from "../cognition/turn_flow";
import type { ToolExecutionRecord } from "../tools/types";
import {
  blockIndustryWorkflowExecution,
  getIndustryWorkflowTask,
  recordIndustryWorkflowExecution,
} from "../industry/workflow_service";
import { bindIndustryWorkspaceContext } from '../industry/workspace_context';
import * as LegalCases from '../org/legal_cases';
import {
  formatIndustryCapabilityProfilePrompt,
  formatIndustryWorkflowRoutingPrompt,
} from '../regions/packs/cn/industry_capability_profile';
import { restrictToolPolicyForExecutionBoundary } from "../tools/remote_policy";
import { isLoopbackAddress } from "../config/local_identity";
import {
  DESKTOP_SESSION_HEADER,
  verifyDesktopSessionProof,
} from "../config/desktop_bootstrap";

const REST_CHAT_BASE_SYSTEM_INSTRUCTION =
  'You are Lumi, the local core intelligence. Be professional, thoughtful, forward-looking, concise, and useful. Follow the user-facing response-language instruction while keeping internal protocols, tool names, state fields, and execution policy in canonical English.';

function buildRestChatRouteText(messages: unknown, prompt: unknown): string {
  if (Array.isArray(messages)) {
    return messages
      .map((item: any) => String(item?.content || item?.message || item?.text || '').trim())
      .filter(Boolean)
      .join('\n')
      .slice(-12000);
  }
  return String(prompt || '').trim().slice(-12000);
}

function buildRestProviderMessages(messages: unknown, prompt: unknown, systemInstruction: string): any[] {
  const rawMessages = Array.isArray(messages) && messages.length > 0
    ? messages
    : [{ role: 'user', content: String(prompt || '') }];
  const existingSystem = rawMessages
    .filter((item: any) => item?.role === 'system')
    .map((item: any) => String(item?.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const systemContent = [systemInstruction, existingSystem].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: systemContent },
    ...rawMessages
      .filter((item: any) => item?.role !== 'system')
      .map((item: any) => ({
        role: item?.role === 'assistant' ? 'assistant' : 'user',
        content: String(item?.content || item?.message || item?.text || ''),
      })),
  ];
}

function buildRestAnthropicMessages(messages: unknown, prompt: unknown): any[] {
  const rawMessages = Array.isArray(messages) && messages.length > 0
    ? messages
    : [{ role: 'user', content: String(prompt || '') }];
  return rawMessages
    .filter((item: any) => item?.role !== 'system')
    .map((item: any) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: String(item?.content || item?.message || item?.text || ''),
    }));
}

function buildRestChatSystemInstruction(input: {
  routeText: string;
  domain: 'personal' | 'work';
  orgId: string;
  source: string;
}): string {
  const legalOverlay = buildUnifiedLegalEntryPrompt({
    text: input.routeText,
    domain: input.domain,
    orgId: input.orgId,
    channel: 'chat',
    source: input.source,
  });
  return [
    REST_CHAT_BASE_SYSTEM_INSTRUCTION,
    formatIndustryCapabilityProfilePrompt(),
    formatIndustryWorkflowRoutingPrompt(input.routeText),
    legalOverlay,
  ].filter(Boolean).join('\n\n');
}

function finalizeRestChatResponse(input: {
  taskText: string;
  responseText: string;
  toolRecords?: ToolExecutionRecord[];
  source: string;
  flow?: LumiTurnFlow;
}) {
  return finalizeLumiResponse({
    taskText: input.taskText,
    responseText: input.responseText,
    toolRecords: input.toolRecords || [],
    source: input.source,
    flow: input.flow,
  });
}

function bindIndustryToolRecords(records: ToolExecutionRecord[], input: {
  workTakeoverTaskId: string;
  conversationTaskId: string;
  requestId: string;
}): ToolExecutionRecord[] {
  return records.map(record => ({
    ...record,
    taskId: record.taskId || input.conversationTaskId,
    requestId: record.requestId || input.requestId,
    idempotencyKey: record.idempotencyKey || `industry:${input.workTakeoverTaskId}:${record.id || record.name}`,
  }));
}

function dateLikeToIso(value: unknown, fallback = Date.now()): string {
  const date = value ? new Date(value as any) : new Date(fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function shouldArchiveLegalMeeting(purpose: unknown, legalCase: unknown, domain: string, orgId: string): boolean {
  const isLegalMeeting = purpose === 'legal_consultation' || Boolean(legalCase && typeof legalCase === 'object');
  return isLegalMeeting && domain === 'work' && Boolean(orgId);
}

function safeLegalScopeSegment(value: unknown, fallback = 'anonymous'): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.@-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function resolveLegalCaseworkOrgId(input: {
  domain: 'personal' | 'work';
  explicitOrgId?: unknown;
  userOrgId?: unknown;
  userId: string;
}): string {
  if (input.domain === 'work') {
    return String(input.explicitOrgId || input.userOrgId || 'default').trim() || 'default';
  }
  return `personal:${safeLegalScopeSegment(input.userId)}`;
}

function buildLegalMeetingMinutesArgs(input: {
  transcript: string;
  startedAt?: unknown;
  endedAt?: unknown;
  legalCase?: any;
  orgId: string;
  userId: string;
}) {
  const legalCase = input.legalCase && typeof input.legalCase === 'object' ? input.legalCase : {};
  const caseName = String(
    legalCase.title ||
    legalCase.caseName ||
    legalCase.caseNumber ||
    `法律会议 ${dateLikeToIso(input.startedAt).slice(0, 10)}`,
  ).trim();
  return {
    transcript: input.transcript,
    meetingTime: dateLikeToIso(input.startedAt || input.endedAt),
    orgId: input.orgId || 'default',
    userId: input.userId,
    caseId: String(legalCase.id || '').trim(),
    caseName,
    participants: String(legalCase.party || legalCase.participants || '').trim(),
    caseType: String(legalCase.cause || legalCase.caseType || '').trim(),
    court: String(legalCase.court || '').trim(),
    stage: String(legalCase.stage || 'consultation').trim(),
    persistCase: true,
  };
}

const DIRECT_LEGAL_TOOL_ALLOWLIST = new Set([
  'legal_search_case',
  'legal_search_statute',
  'legal_case_strategy',
  'legal_case_workspace',
  'legal_case_workflow_status',
  'legal_message_intake_to_case',
  'legal_meeting_minutes_to_case',
  'legal_case_reasoning_matrix',
  'legal_generate_litigation_packet',
  'legal_prepare_filing_handoff',
  'legal_extract_dispute_focus',
  'legal_generate_argument_or_opinion',
  'legal_generate_bid',
  'legal_review_contract',
  'legal_draft_contract',
  'legal_process_notice_link',
  'legal_download_and_extract_document',
  'legal_trace_assets',
  'legal_equity_penetration',
  'legal_external_source_status',
  'legal_search_tender_projects',
  'legal_external_research_plan',
  'legal_search_external_authorities',
  'legal_company_database_lookup',
  'legal_generate_citation_verification_report',
  'legal_finalize_delivery_package',
  'legal_refresh_authoritative_sources',
  'legal_authority_source_status',
  'legal_verify_citation',
  'legal_import_judgment',
]);

/**
 * Organization viewers are limited to tools whose contract is read-only.
 * Tools that can archive a case, write an artifact, import knowledge,
 * download material, or refresh shared state remain denied. Contract review
 * is the sole conditional exception when persistence is explicitly disabled
 * and no case identity is supplied.
 */
const ORGANIZATION_VIEWER_LEGAL_READ_TOOL_ALLOWLIST = new Set([
  'legal_search_case',
  'legal_search_statute',
  'legal_case_workflow_status',
  'legal_authority_source_status',
  'legal_verify_citation',
]);

function isOrganizationViewerLegalRead(
  toolName: string,
  args: Record<string, any>,
): boolean {
  if (ORGANIZATION_VIEWER_LEGAL_READ_TOOL_ALLOWLIST.has(toolName)) return true;
  if (toolName !== 'legal_review_contract') return false;
  return args.persistCase === false
    && !String(args.caseId || '').trim()
    && !String(args.caseName || args.title || '').trim();
}

function legalReceipt(record: ToolExecutionRecord): Record<string, any> {
  return record.receipt && typeof record.receipt === 'object' && !Array.isArray(record.receipt)
    ? record.receipt as Record<string, any>
    : {};
}

function legalCaseUpdates(
  record: ToolExecutionRecord,
  legalOrgId: string,
  userId: string,
): LegalCases.OrgLegalCaseFile[] {
  const changedCaseIds = Array.isArray(legalReceipt(record).changedCaseIds)
    ? legalReceipt(record).changedCaseIds.map((value: unknown) => String(value || '').trim()).filter(Boolean)
    : [];
  return changedCaseIds
    .map((caseId: string) => LegalCases.getCase(legalOrgId, caseId, userId, 'read'))
    .filter((caseFile): caseFile is LegalCases.OrgLegalCaseFile => Boolean(caseFile));
}

export function formatMeetingTranscriptForAnalysis(notes: unknown[]): string {
  const noteItems = Array.isArray(notes) ? notes : [];
  return noteItems
    .map((note: any) => {
      const time = note?.time ? new Date(note.time).toLocaleTimeString() : '';
      const text = String(note?.text || '').trim();
      const speakerLabel = String(note?.speakerLabel || '').trim();
      const speaker = speakerLabel
        ? `${speakerLabel}: `
        : (note?.speakerMatched === false ? 'Unknown speaker: ' : '');
      return text ? `[${time}] ${speaker}${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function mountChatRoutes(router: Router, _jwtSecret: string, llm: {
  getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any;
}) {
  const asyncHandler = (fn: (req: any, res: any, next?: any) => Promise<any>) =>
    (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);

  const handleChat = asyncHandler(async (req, res) => {
    const { provider: reqProvider = "gemini", model: reqModel, messages, prompt: rawPrompt, message } = req.body;
    const prompt = rawPrompt ?? message;
    const userKey = req.headers["x-api-key"] as string;
    const isBYOK = typeof userKey === 'string' && userKey.length > 5;
    // Anonymous callers may use only their own provider key. Shared Lumi model
    // credentials are never an unauthenticated public inference endpoint.
    if (!req.user && !isBYOK) {
      return res.status(401).json({ error: 'Authentication or a caller-provided API key is required' });
    }
    const userId = req.user?.uid || 'anonymous';
    const presentedDesktopSession = req.headers[DESKTOP_SESSION_HEADER];
    const trustedLocalExecution = Boolean(
      req.user
      && isLoopbackAddress(req.socket?.remoteAddress)
      && verifyDesktopSessionProof(presentedDesktopSession, userId),
    );
    if (presentedDesktopSession && !trustedLocalExecution) {
      return res.status(403).json({
        error: 'Native desktop session proof expired or is invalid',
        code: 'DESKTOP_SESSION_PROOF_REQUIRED',
      });
    }
    const executionBoundary = trustedLocalExecution ? 'trusted_local' as const : 'remote_restricted' as const;
    const requestScope = req.user ? resolveDomain(req.user) : { domain: 'personal' as const, orgId: '' };
    const domain = requestScope.domain;
    const orgId = requestScope.orgId;
    const industryWorkflowTaskId = String(req.body?.industryWorkflowTaskId || '').trim();
    const industryWorkflowTask = industryWorkflowTaskId
      ? getIndustryWorkflowTask({ userId, domain, orgId }, industryWorkflowTaskId)
      : null;
    if (industryWorkflowTaskId && !industryWorkflowTask) {
      return res.status(404).json({ error: 'Industry workflow task not found in the current user scope.' });
    }
    const industryWorkflow = industryWorkflowTask?.metadata?.industryWorkflow || {};
    const routeText = buildRestChatRouteText(messages, prompt);
    const restTurnDispatch = buildLumiTurnDispatch({
      userId,
      text: routeText,
      channel: 'chat',
      source: 'rest_chat',
      category: 'command',
      domain,
      orgId,
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const restExecutionDecision = buildLumiExecutionDecision({
      flow: restTurnDispatch.flow,
      text: routeText,
      toolDeclarations: toolRegistry.getToolDeclarations(),
      toolRegistry,
      isSanctuary: !req.user,
    });
    const restModelToolPolicy = restrictToolPolicyForExecutionBoundary(
      buildModelCapabilityPolicy(restExecutionDecision),
      executionBoundary,
    );
    const deferRestStream =
      restExecutionDecision.allowToolUse
      || shouldDeferModelOutputUntilFinalized({
        taskText: routeText,
        flow: restTurnDispatch.flow,
      });
    const toolContext = {
      userId,
      authenticated: Boolean(req.user),
      authRole: req.user?.role,
      orgRole: req.user?.orgRole,
      localExecution: trustedLocalExecution,
      executionBoundary,
      domain,
      orgId,
      llmGetters: llm,
      source: trustedLocalExecution ? 'rest_chat_local' : 'rest_chat',
      actionIntent: routeText,
      routedTaskText: restTurnDispatch.flow.routeText,
      toolPolicy: restModelToolPolicy,
      ...(industryWorkflowTask
        ? {
            taskId: String(industryWorkflow.conversationTaskId || ''),
            conversationId: String(industryWorkflow.conversationId || ''),
            requestId: String(industryWorkflow.requestId || ''),
          }
        : {}),
    };
    const systemInstruction = buildRestChatSystemInstruction({
      routeText,
      domain,
      orgId,
      source: 'rest_chat',
    });

    const preferred = getUserPreferredLLMConfig(userId, { domain, orgId });
    const provider = isBYOK ? reqProvider : preferred.provider;
    const model = isBYOK ? reqModel : preferred.model;
    if (!isBYOK && reqProvider && reqProvider !== provider) {
      console.warn(`[Chat] Ignoring request provider ${reqProvider}; using primary brain ${provider}/${model} for user ${userId}`);
    }

    try {
      let responseText = '';

      if (isBYOK) {
        const llmStart = Date.now();
        if (provider === "gemini") {
          const client = new GoogleGenerativeAI(userKey);
          const modelInstance = client.getGenerativeModel({ model: model || "gemini-2.0-flash", systemInstruction });
          const contents = messages
            ? messages.map((m: any) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
            : [{ role: 'user', parts: [{ text: prompt }] }];
          responseText = (await modelInstance.generateContent({ contents })).response.text();
        } else if (provider === "anthropic") {
          const client = new Anthropic({ apiKey: userKey });
          const response = await client.messages.create({
            model: model || "claude-sonnet-4-6",
            max_tokens: 1024,
            system: systemInstruction,
            messages: buildRestAnthropicMessages(messages, prompt),
          });
          responseText = response.content[0].type === 'text' ? response.content[0].text : '';
        } else {
          const client = new OpenAI({ apiKey: userKey, baseURL: provider === "deepseek" ? "https://api.deepseek.com/v1" : provider === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : undefined });
          const response = await client.chat.completions.create({
            model: model || (provider === "deepseek" ? "deepseek-v4-flash" : provider === "qwen" ? "qwen-plus" : "gpt-4o"),
            messages: buildRestProviderMessages(messages, prompt, systemInstruction),
          });
          responseText = response.choices[0].message.content || '';
        }
        const finalized = finalizeRestChatResponse({
          taskText: routeText,
          responseText,
          source: 'rest_chat',
          flow: restTurnDispatch.flow,
        });
        responseText = finalized.text;
        recordLatency('llm', Date.now() - llmStart);
        return res.json({
          text: responseText,
          finalized: true,
          blocked: finalized.blocked,
          reason: finalized.reason,
          notification: finalized.notification,
        });
      } else {
        const normalizedMessages: any[] = [
          { role: 'system', content: systemInstruction },
          ...(messages || [{ role: 'user', content: prompt }]).map((m: any) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content || ''
          }))
        ];

        const stream = req.query.stream === 'true';

        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          const restTextGate = createPreFinalizationTextGate();

          const result = await runWithTools(
            normalizedMessages,
            toolRegistry,
            { provider, model, userId, domain, orgId },
            undefined, restModelToolPolicy.maxIterations || 3,
            llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
            (chunk) => {
              if (!deferRestStream) {
                const safeText = restTextGate.push(chunk);
                if (safeText) {
                  res.write(`data: ${JSON.stringify({ chunk: safeText })}\n\n`);
                }
              }
            },
            toolContext,
          );
          restTextGate.finish();

          responseText = result.text || '';
          const boundRecords = industryWorkflowTask
            ? bindIndustryToolRecords(result.toolCalls, {
                workTakeoverTaskId: industryWorkflowTask.id,
                conversationTaskId: String(industryWorkflow.conversationTaskId || ''),
                requestId: String(industryWorkflow.requestId || ''),
              })
            : result.toolCalls;
          const finalized = finalizeRestChatResponse({
            taskText: routeText,
            responseText,
            toolRecords: boundRecords,
            source: 'rest_chat_stream',
            flow: restTurnDispatch.flow,
          });
          responseText = finalized.text;
          for (const u of result.usageRecords || []) {
            recordTokenUsage(userId, u.provider, u.model, {
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              totalTokens: u.totalTokens,
            }, `rest_chat_${Date.now()}`, 'chat');
          }
          const workflowRecord = industryWorkflowTask
            ? recordIndustryWorkflowExecution({
                userId, domain, orgId, taskId: industryWorkflowTask.id,
                resultText: responseText, toolRecords: boundRecords, source: 'rest_chat_stream',
              })
            : null;
          res.write(`data: ${JSON.stringify({
            done: true,
            text: responseText,
            toolCalls: result.toolCalls.length,
            finalized: true,
            blocked: finalized.blocked,
            reason: finalized.reason,
            notification: finalized.notification,
            ...(workflowRecord ? { industryWorkflow: {
              taskId: workflowRecord.task.id,
              status: workflowRecord.task.status,
              verification: workflowRecord.verification,
            } } : {}),
          })}\n\n`);
          return res.end();
        }

        const result = await runWithTools(
          normalizedMessages,
          toolRegistry,
          { provider, model, userId, domain, orgId },
          undefined, restModelToolPolicy.maxIterations || 3,
          llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
          undefined,
          toolContext,
        );

        responseText = result.text || '';
        const boundRecords = industryWorkflowTask
          ? bindIndustryToolRecords(result.toolCalls, {
              workTakeoverTaskId: industryWorkflowTask.id,
              conversationTaskId: String(industryWorkflow.conversationTaskId || ''),
              requestId: String(industryWorkflow.requestId || ''),
            })
          : result.toolCalls;
        const finalized = finalizeRestChatResponse({
          taskText: routeText,
          responseText,
          toolRecords: boundRecords,
          source: 'rest_chat',
          flow: restTurnDispatch.flow,
        });
        responseText = finalized.text;
        for (const u of result.usageRecords || []) {
          recordTokenUsage(userId, u.provider, u.model, {
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            totalTokens: u.totalTokens,
          }, `rest_chat_${Date.now()}`, 'chat');
        }
        const usage = {
          totalTokens: result.usageRecords.reduce((sum, item) => sum + item.totalTokens, 0),
          records: result.usageRecords.length,
        };
        const workflowRecord = industryWorkflowTask
          ? recordIndustryWorkflowExecution({
              userId, domain, orgId, taskId: industryWorkflowTask.id,
              resultText: responseText, toolRecords: boundRecords, source: 'rest_chat',
            })
          : null;
        return res.json({
          text: responseText,
          usage,
          toolCalls: result.toolCalls.length,
          finalized: true,
          blocked: finalized.blocked,
          reason: finalized.reason,
          notification: finalized.notification,
          ...(workflowRecord ? { industryWorkflow: {
            taskId: workflowRecord.task.id,
            status: workflowRecord.task.status,
            verification: workflowRecord.verification,
          } } : {}),
        });
      }

      const finalized = finalizeRestChatResponse({
        taskText: routeText,
        responseText,
        source: 'rest_chat',
        flow: restTurnDispatch.flow,
      });
      res.json({
        text: finalized.text,
        finalized: true,
        blocked: finalized.blocked,
        reason: finalized.reason,
        notification: finalized.notification,
      });
    } catch (error: any) {
      console.error("AI Proxy Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/ai/chat", optionalAuth, handleChat);
  router.post("/chat", optionalAuth, handleChat);

  router.post("/legal/client-case-sync", requireAuth, asyncHandler(async (req, res) => {
    const caseSnapshot = req.body?.case && typeof req.body.case === 'object' ? req.body.case : req.body;
    const caseId = String(caseSnapshot?.id || '').trim();
    if (!caseId) return res.status(400).json({ error: 'A client case id is required.' });
    const userId = req.user!.uid;
    const requestScope = resolveDomain(req.user!);
    const domain = requestScope.domain;
    const orgId = requestScope.orgId;
    if (domain === 'work' && req.user!.orgRole === 'viewer') {
      return res.status(403).json({ error: 'Organization viewers may not modify legal case workspaces.' });
    }
    const legalOrgId = resolveLegalCaseworkOrgId({ domain, userOrgId: orgId, userId });
    const caseFile = LegalCases.upsertCaseSnapshot(legalOrgId, userId, caseSnapshot);
    const active = bindIndustryWorkspaceContext({ userId, domain, orgId }, {
      name: caseFile.title || caseFile.party || caseFile.caseNumber,
      attributes: {
        caseId: caseFile.id,
        caseName: caseFile.title,
        caseNumber: caseFile.caseNumber,
        clientName: caseFile.party,
        court: caseFile.court,
        stage: caseFile.stage,
      },
    });
    return res.json({ ok: true, status: 'synced', caseId: caseFile.id, case: caseFile, activeWorkspace: active });
  }));

  router.delete("/legal/client-case-sync/:caseId", requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user!.uid;
    const requestScope = resolveDomain(req.user!);
    if (requestScope.domain === 'work' && req.user!.orgRole === 'viewer') {
      return res.status(403).json({ error: 'Organization viewers may not delete legal cases.' });
    }
    const legalOrgId = resolveLegalCaseworkOrgId({
      domain: requestScope.domain,
      userOrgId: requestScope.orgId,
      userId,
    });
    const deleted = LegalCases.deleteCase(legalOrgId, userId, String(req.params?.caseId || '').trim());
    return res.json({ ok: true, status: deleted ? 'deleted' : 'not_found', caseId: deleted?.id || '' });
  }));

  router.post("/legal/tool/:toolName", requireAuth, asyncHandler(async (req, res) => {
    const toolName = String(req.params?.toolName || '').trim();
    if (!DIRECT_LEGAL_TOOL_ALLOWLIST.has(toolName)) {
      return res.status(404).json({ error: 'Unknown or unavailable legal tool' });
    }
    const rawArgs = req.body?.args && typeof req.body.args === 'object'
      ? req.body.args
      : (req.body || {});
    const userId = req.user!.uid;
    const requestScope = resolveDomain(req.user!);
    const domain = requestScope.domain;
    const orgId = requestScope.orgId;
    const legalOrgId = resolveLegalCaseworkOrgId({ domain, userOrgId: orgId, userId });
    const args = {
      ...rawArgs,
      orgId: legalOrgId,
      userId,
      domain,
    };

    if (args.persistCase === undefined && (args.caseId || args.caseName || args.title)) {
      args.persistCase = true;
    }

    if (
      domain === 'work'
      && req.user!.orgRole === 'viewer'
      && !isOrganizationViewerLegalRead(toolName, args)
    ) {
      return res.status(403).json({
        error: 'Organization viewers may only use read-only legal tools.',
      });
    }

    if (!toolRegistry.get(toolName)) {
      return res.status(404).json({ error: `Legal tool "${toolName}" is not registered` });
    }

    const industryWorkflowTaskId = String(req.body?.industryWorkflowTaskId || '').trim();
    const industryWorkflowTask = industryWorkflowTaskId
      ? getIndustryWorkflowTask({ userId, domain, orgId }, industryWorkflowTaskId)
      : null;
    if (industryWorkflowTaskId && !industryWorkflowTask) {
      return res.status(404).json({ error: 'Industry workflow task not found in the current user scope.' });
    }
    const industryMetadata = industryWorkflowTask?.metadata?.industryWorkflow || {};
    const record = await executeToolCall({
      registry: toolRegistry,
      name: toolName,
      arguments: args,
      context: {
        userId,
        domain,
        orgId,
        llmGetters: llm,
        source: 'legal-direct-tool',
        ...(industryWorkflowTask ? {
          taskId: String(industryMetadata.conversationTaskId || ''),
          conversationId: String(industryMetadata.conversationId || ''),
          requestId: String(industryMetadata.requestId || ''),
        } : {}),
        authenticated: true,
        authRole: req.user!.role,
        orgRole: req.user!.orgRole,
        localExecution: false,
      } as any,
    });
    if (record.error || record.terminalVerification?.status !== 'verified') {
      return res.status(500).json({
        error: record.error || record.terminalVerification?.reason || 'Legal tool did not produce verified evidence.',
        toolName,
      });
    }
    const receipt = legalReceipt(record);
    const receiptStatus = String(receipt.status || '').trim().toLowerCase();
    const workflowRecord = industryWorkflowTask
      ? receiptStatus === 'needs_source'
        ? blockIndustryWorkflowExecution({
            userId,
            domain,
            orgId,
            taskId: industryWorkflowTask.id,
            resultText: record.result,
            toolRecords: [record],
            source: 'legal_direct_tool',
            blockerStatus: 'needs_source',
            reason: 'The legal workflow needs an authorized, verifiable external source before this step can be completed.',
          })
        : recordIndustryWorkflowExecution({
            userId,
            domain,
            orgId,
            taskId: industryWorkflowTask.id,
            resultText: record.result,
            toolRecords: [record],
            source: 'legal_direct_tool',
          })
      : null;
    return res.json({
      text: record.result,
      toolName,
      receipt,
      artifacts: Array.isArray(receipt.artifacts) ? receipt.artifacts : [],
      caseUpdates: legalCaseUpdates(record, legalOrgId, userId),
      ...(workflowRecord ? { industryWorkflow: {
        taskId: workflowRecord.task.id,
        status: workflowRecord.task.status,
        verification: workflowRecord.verification,
      } } : {}),
    });
  }));

  router.post("/legal/contract-review", requireAuth, asyncHandler(async (req, res) => {
    const contract = String(req.body?.contract || '').trim();
    if (!contract) {
      return res.status(400).json({ error: '请提供合同文本' });
    }

    const userId = req.user!.uid;
    const requestScope = resolveDomain(req.user!);
    const domain = requestScope.domain;
    const orgId = requestScope.orgId;
    const legalOrgId = resolveLegalCaseworkOrgId({ domain, userOrgId: orgId, userId });
    const args = {
      contract,
      orgId: legalOrgId,
      userId,
      caseId: String(req.body?.caseId || '').trim(),
      caseName: String(req.body?.caseName || '').trim(),
      caseType: String(req.body?.caseType || req.body?.cause || '').trim(),
      court: String(req.body?.court || '').trim(),
      persistCase: req.body?.persistCase === true || Boolean(req.body?.caseId || req.body?.caseName),
    };
    if (
      domain === 'work'
      && req.user!.orgRole === 'viewer'
      && !isOrganizationViewerLegalRead('legal_review_contract', args)
    ) {
      return res.status(403).json({
        error: 'Organization viewers may only run contract review without case persistence.',
      });
    }
    const industryWorkflowTaskId = String(req.body?.industryWorkflowTaskId || '').trim();
    const industryWorkflowTask = industryWorkflowTaskId
      ? getIndustryWorkflowTask({ userId, domain, orgId }, industryWorkflowTaskId)
      : null;
    if (industryWorkflowTaskId && !industryWorkflowTask) {
      return res.status(404).json({ error: 'Industry workflow task not found in the current user scope.' });
    }
    const industryMetadata = industryWorkflowTask?.metadata?.industryWorkflow || {};
    const contractReviewRecord = await executeToolCall({
      registry: toolRegistry,
      name: 'legal_review_contract',
      arguments: args,
      context: {
        userId,
        domain,
        orgId,
        llmGetters: llm,
        source: 'legal-contract-review',
        ...(industryWorkflowTask ? {
          taskId: String(industryMetadata.conversationTaskId || ''),
          conversationId: String(industryMetadata.conversationId || ''),
          requestId: String(industryMetadata.requestId || ''),
        } : {}),
        authenticated: true,
        authRole: req.user!.role,
        orgRole: req.user!.orgRole,
        localExecution: false,
      } as any,
    });
    if (contractReviewRecord.error || contractReviewRecord.terminalVerification?.status !== 'verified') {
      return res.status(500).json({
        error: contractReviewRecord.error
          || contractReviewRecord.terminalVerification?.reason
          || 'Contract review did not produce verified evidence.',
        toolName: 'legal_review_contract',
      });
    }
    const contractReceipt = legalReceipt(contractReviewRecord);
    const contractWorkflowRecord = industryWorkflowTask
      ? recordIndustryWorkflowExecution({
          userId,
          domain,
          orgId,
          taskId: industryWorkflowTask.id,
          resultText: contractReviewRecord.result,
          toolRecords: [contractReviewRecord],
          source: 'legal_contract_review',
        })
      : null;
    const contractCaseUpdates = legalCaseUpdates(contractReviewRecord, legalOrgId, userId);
    return res.json({
      text: contractReviewRecord.result,
      degraded: false,
      toolName: 'legal_review_contract',
      receipt: contractReceipt,
      artifacts: Array.isArray(contractReceipt.artifacts) ? contractReceipt.artifacts : [],
      caseUpdates: contractCaseUpdates,
      ...(contractWorkflowRecord ? { industryWorkflow: {
        taskId: contractWorkflowRecord.task.id,
        status: contractWorkflowRecord.task.status,
        verification: contractWorkflowRecord.verification,
      } } : {}),
    });
  }));

  router.post("/meeting/analyze", requireAuth, asyncHandler(async (req, res) => {
    const { provider: reqProvider, notes, startedAt, endedAt, language = "zh", purpose = "meeting", legalCase } = req.body || {};
    const userId = req.user?.uid || 'anonymous';
    const requestScope = req.user ? resolveDomain(req.user) : { domain: 'personal' as const, orgId: '' };
    const domain = requestScope.domain;
    const orgId = requestScope.orgId;
    const preferred = getUserPreferredLLMConfig(userId, { maxTokens: 1800, domain, orgId });
    const provider = preferred.provider;
    const model = preferred.model;
    if (reqProvider && reqProvider !== provider) {
      console.warn(`[Meeting] Ignoring request provider ${reqProvider}; using primary brain ${provider}/${model} for user ${userId}`);
    }
    const transcript = formatMeetingTranscriptForAnalysis(notes);

    if (!transcript.trim()) {
      return res.status(400).json({ error: 'No meeting transcript to analyze' });
    }

    const started = startedAt ? new Date(startedAt).toLocaleString() : 'unknown';
    const ended = endedAt ? new Date(endedAt).toLocaleString() : new Date().toLocaleString();
    const outputLanguage = language === 'zh' ? 'Chinese' : 'English';
    const isLegalConsultation = purpose === 'legal_consultation';
    const caseContext = legalCase && typeof legalCase === 'object'
      ? [
          `Case title: ${legalCase.title || ''}`,
          `Case number: ${legalCase.caseNumber || ''}`,
          `Party: ${legalCase.party || ''}`,
          `Cause: ${legalCase.cause || ''}`,
          `Court: ${legalCase.court || ''}`,
          `Judge: ${legalCase.judge || ''}`,
          `Stage: ${legalCase.stage || ''}`,
          `Existing notes: ${legalCase.notes || ''}`,
        ].filter(line => !line.endsWith(': '))
      : [];
    const prompt = isLegalConsultation
      ? [
          `You are Lumi assisting a law firm with a client consultation memo. Output in ${outputLanguage}.`,
          'Do not call tools. Analyze only the case context and transcript below.',
          'Create a practical legal-work memo for lawyer review with these sections:',
          '1. Consultation summary',
          '2. Fact summary',
          '3. Disputed issues / legal questions',
          '4. Missing materials / evidence to request',
          '5. Next steps with owners/deadlines if mentioned',
          '6. Risks and open questions',
          '7. Raw transcript highlights',
          'Add a short safety boundary: this assists lawyers and does not replace licensed legal judgment.',
          '',
          `Started: ${started}`,
          `Ended: ${ended}`,
          '',
          'Case context:',
          ...(caseContext.length > 0 ? caseContext : ['No case context provided.']),
          '',
          'Transcript:',
          transcript,
        ].join('\n')
      : [
          `You are Lumi acting as a meeting analyst. Output in ${outputLanguage}.`,
          'Do not call tools. Analyze only the transcript below.',
          'Create a practical meeting report with these sections:',
          '1. Meeting summary',
          '2. Key decisions',
          '3. Action items with owner if mentioned, otherwise mark owner as unassigned',
          '4. Risks / open questions',
          '5. Follow-up suggestions',
          '6. Raw transcript highlights',
          '',
          `Started: ${started}`,
          `Ended: ${ended}`,
          '',
          'Transcript:',
          transcript,
        ].join('\n');

    const result = await makeLLMCall(
      [{ role: 'user', content: prompt }],
      [],
      { provider, model, maxTokens: 1800, userId },
      llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
    );

    const report = result.text || '';
    recordTokenUsage(userId, provider, model, result.usage, `meeting_analyze_${Date.now()}`, 'meeting');
    const usage = result.usage || null;
    let legalCasework = '';
    let legalCaseworkError = '';
    if (shouldArchiveLegalMeeting(purpose, legalCase, domain, orgId)) {
      try {
        legalCasework = await executeToolCallOrThrow({
          registry: toolRegistry,
          name: 'legal_meeting_minutes_to_case',
          arguments: buildLegalMeetingMinutesArgs({
            transcript,
            startedAt,
            endedAt,
            legalCase,
            orgId,
            userId,
          }),
          context: {
            userId,
            authenticated: true,
            authRole: req.user!.role,
            orgRole: req.user!.orgRole,
            localExecution: false,
            domain,
            orgId,
            llmGetters: llm,
            source: 'meeting-analyze',
          },
        });
      } catch (err: any) {
        legalCaseworkError = err?.message || String(err);
        console.warn('[Meeting] Legal meeting archive failed:', legalCaseworkError);
      }
    }
    res.json({
      report,
      usage,
      legalCasework,
      legalCaseArchived: Boolean(legalCasework),
      legalCaseworkError: legalCaseworkError || undefined,
    });
  }));
}
