import * as LegalCases from "../../../../org/legal_cases";
import { authorizeOrganizationResource } from "../../../../org/resource_acl";
import * as EDB from "../../../../org/db";
import path from "path";
import { expandLocalPath } from "./context";
import fs from "fs";
import { createHash } from "crypto";
import { textArg } from "./context";
import { legalWorkspaceId } from "./context";
import { decodeToolResult } from "../../../../tools/result_envelope";
import { encodeToolResult } from "../../../../tools/result_envelope";
import { type CapabilityOperation } from "../../../../tools/types";
import { type CapabilityRisk } from "../../../../tools/types";
import { type CapabilitySideEffect } from "../../../../tools/types";
import { capabilityContract } from "../../../../tools/capability_contracts";
import { capabilityEvidence } from "../../../../tools/capability_contracts";
import { type ToolDefinition } from "../../../../tools/types";
import { withLegalExecution } from "../../../../legal/execution";
import { assertLegalExecutionActive } from "../../../../legal/execution";
import { resolveLegalCaseArguments } from "./context";
import { legalTemporalOptions } from "./context";
import { evaluateCurrentLawGate } from "./citations";
import { legalWrite, legalExecutionWrites } from "../../../../legal/execution";

export type LegalToolHandler = (args: Record<string, any>, context?: any) => Promise<string>;

export interface LegalReceiptProfile {
  status: string;
  expectCaseMutation?: 'always' | 'when_requested' | 'when_case_id';
  requireArtifacts?: boolean | ((args: Record<string, any>) => boolean);
  requireArticleMutation?: boolean;
  allowExistingArticles?: boolean;
  classify?: (content: string, args: Record<string, any>) => { ok: boolean; status: string };
}

export function existingLegalOutputPaths(content: string): string[] {
  const paths = new Set<string>();
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '');
    const separator = Math.max(line.indexOf('：'), line.indexOf(': '));
    if (separator < 0) continue;
    const candidate = line.slice(separator + (line[separator] === '：' ? 1 : 2)).trim().replace(/^`|`$/g, '');
    if (!candidate || candidate.length > 1_000) continue;
    try {
      const resolved = path.resolve(expandLocalPath(candidate));
      const stat = fs.statSync(resolved);
      if (stat.isFile() && stat.size > 0) paths.add(resolved);
    } catch {}
  }
  return Array.from(paths);
}

export function legalInputBlocked(content: string): boolean {
  return /^(?:请提供|请至少提供|无法解析文件|链接格式无效|仅支持 http|出于安全原因)/.test(String(content || '').trim());
}

export function shouldExpectCaseMutation(args: Record<string, any>, mode?: LegalReceiptProfile['expectCaseMutation']): boolean {
  if (!mode || args.persistCase === false) return false;
  if (mode === 'always') return true;
  if (mode === 'when_case_id') return Boolean(textArg(args, 'caseId'));
  return args.persistCase === true || Boolean(textArg(args, 'caseId') || textArg(args, 'caseName') || textArg(args, 'title'));
}

export function withLegalReceipt(handler: LegalToolHandler, profile: LegalReceiptProfile): LegalToolHandler {
  return async (args, context) => {
    const orgId = legalWorkspaceId(args, context);
    const userId = context?.userId || textArg(args, 'userId') || 'system';
    const decoded = decodeToolResult(await handler(args, context));
    const content = decoded.content;
    // A handler can explicitly downgrade completion; model text can never upgrade it.
    const declared = decoded.receipt as Record<string, any> | undefined;
    const writes = legalExecutionWrites(orgId, userId);
    const changedCaseIds = [...writes.cases.keys()];
    const materialSources = changedCaseIds.flatMap(caseId =>
      (LegalCases.getCase(orgId, caseId, userId, 'write')?.materials || [])
        .filter(material => writes.cases.get(caseId)?.has(material.id))
        .map(material => ({ caseId, materialId: material.id, sourceDigest: createHash('sha256').update(JSON.stringify([
          material.source, material.title, material.content, material.fileName || '', material.localPath || '',
        ])).digest('hex') })),
    );
    const reused = profile.allowExistingArticles && Array.isArray(declared?.existingArticleIds)
      ? declared.existingArticleIds.filter((id: unknown) => typeof id === 'string' && EDB.getKbArticle(orgId, id)?.authorId === userId) : [];
    const articleIds = [...new Set([...writes.articles, ...reused])] as string[];
    const artifacts = existingLegalOutputPaths(content);
    const classified = declared?.ok === false
      ? { ok: false, status: declared.status === 'partial' ? 'partial' : 'blocked' }
      : profile.classify?.(content, args)
        || (legalInputBlocked(content) ? { ok: false, status: 'blocked' } : { ok: true, status: profile.status });
    const expectedCaseMutation = shouldExpectCaseMutation(args, profile.expectCaseMutation);
    if (classified.ok && expectedCaseMutation && changedCaseIds.length === 0) {
      throw new Error('Legal work product was not persisted to the requested case workspace.');
    }
    const requireArtifacts = typeof profile.requireArtifacts === 'function'
      ? profile.requireArtifacts(args)
      : profile.requireArtifacts === true;
    if (classified.ok && requireArtifacts && artifacts.length === 0) {
      throw new Error('Legal work product did not produce a verifiable local artifact.');
    }
    if (classified.ok && profile.requireArticleMutation && articleIds.length === 0) {
      throw new Error('Legal knowledge-base import did not persist an article.');
    }
    return encodeToolResult(content, {
      ok: classified.ok,
      status: classified.status,
      persisted: changedCaseIds.length > 0 || articleIds.length > 0,
      changedCaseIds,
      materialSources,
      articleIds,
      artifacts,
      ...(Array.isArray(declared?.sourceResults) ? { sourceResults: declared.sourceResults } : {}),
      ...(typeof declared?.reasoningLinked === 'boolean' ? { reasoningLinked: declared.reasoningLinked } : {}),
      ...(typeof declared?.reasoningReviewed === 'boolean' ? { reasoningReviewed: declared.reasoningReviewed } : {}),
      ...(['template', 'mixed', 'model'].includes(declared?.draftMode) ? { draftMode: declared!.draftMode } : {}),
      ...(Array.isArray(declared?.draftFailures) ? { draftFailures: declared.draftFailures } : {}),
      content,
    });
  };
}

export function legalCapability(input: {
  id: string;
  operation: Exclude<CapabilityOperation, 'unknown'>;
  risk: Exclude<CapabilityRisk, 'none'>;
  sideEffects: CapabilitySideEffect[];
  successStatuses: string[];
  requireArtifacts?: boolean;
  limitations?: string[];
}) {
  return capabilityContract({
    id: input.id,
    family: 'legal-workflow',
    lane: 'industry',
    operation: input.operation,
    risk: input.risk,
    sideEffects: input.sideEffects,
    verification: {
      strategy: input.requireArtifacts ? 'artifact' : 'terminal_receipt',
      required: true,
      requiredFields: ['ok', 'status', 'persisted', 'changedCaseIds', 'articleIds', 'artifacts', 'content'],
      requiredValues: { ok: true },
      successStatuses: input.successStatuses,
      failureStatuses: ['blocked', 'failed', 'unverified'],
      requiredArtifactCollections: input.requireArtifacts ? ['artifacts'] : undefined,
      successSignals: ['structured legal receipt reports case, knowledge-base, and file effects separately'],
      limitations: input.limitations || ['Generated legal work remains subject to lawyer review and is not automatically filed, signed, sent, or published.'],
    },
  });
}

export function legalEvidence(
  id: string,
  operation: Exclude<CapabilityOperation, 'unknown'>,
  subjectArgument?: string,
  limitations?: string[],
) {
  return capabilityEvidence({ id, operation, subjectArgument, limitations });
}

export type LegalToolInput = Omit<ToolDefinition, 'parameters' | 'permission' | 'securityLevel'> & {
  properties: Record<string, any>; required?: string[];
};

export function defineLegalTool({ properties, required, handler, ...definition }: LegalToolInput): ToolDefinition {
 return { ...definition, permission: 'user', securityLevel: 'safe', parameters: { type: 'object', properties: {
      factDate: stringField('案件关键事实发生日期（YYYY-MM-DD）；续办采用案件已保存日期，需改期时先通过案件工作台明确修改。'),
      procedureDate: stringField('待核验程序行为发生日期（YYYY-MM-DD），须有材料或用户确认；不得用实体事实、开庭或生成日期自动替代。'),
      temporalReviews: { type: 'array', maxItems: 30, description: '逐条记录历史法或程序法时间效力依据；权威条文连续摘录须通过已有法源核验，适用说明仍供律师复核。',
        items: { type: 'object', required: ['citation', 'referenceDate', 'scope', 'authorityCitation', 'authorityQuote', 'applicability'], properties: {
          citation: stringField('本次待核验的具体法条引用'), referenceDate: stringField('与对应事实/程序时点完全一致的YYYY-MM-DD'),
          scope: { type: 'string', enum: ['fact', 'procedure'] }, authorityCitation: stringField('权威时间效力规定的具体条款引用'),
          authorityQuote: stringField('该时间效力条文的连续原文，不以模型适用说明代替'), applicability: stringField('结合本案时点、程序阶段和例外条件的适用说明，仍须律师复核'),
        } } }, ...structuredClone(properties) }, ...(required === undefined ? {} : { required: [...required] }) }, handler: (args, context) => withLegalExecution(context, async () => {
      assertLegalExecutionActive();
      const resolved = resolveLegalCaseArguments(definition.name, args, context);
      if (resolved.factDateConflict) return encodeToolResult(`${definition.name === 'legal_finalize_delivery_package' ? '# 正式交付包未生成\n\n' : ''}案件已保存的关键事实日期为 ${textArg(resolved, 'factDate')}，本次传入日期与之冲突；续办未改写案件日期。请先在案件工作台明确核实并修改日期，再重新核验。`, { ok: false, status: 'blocked' });
      const orgId = legalWorkspaceId(resolved, context);
      const userId = context?.userId || textArg(resolved, 'userId') || 'system';
      const result = await handler(resolved, { ...context, ...legalTemporalOptions(resolved) });
      assertLegalExecutionActive();
      const decoded = decodeToolResult(result);
      const receipt = decoded.receipt as Record<string, any> | undefined;
      const lawText = definition.name === 'legal_finalize_delivery_package'
        ? textArg(resolved, 'content') || textArg(resolved, 'packetText') || textArg(resolved, 'documentText')
        : definition.name === 'legal_case_reasoning_matrix' ? textArg(resolved, 'legalAuthorities') : '';
      const lawGate = lawText ? evaluateCurrentLawGate(lawText, orgId, [], textArg(resolved, 'factDate'), legalTemporalOptions(resolved)) : null;
      const historyCaseIds = new Set<string>(Array.isArray(receipt?.changedCaseIds) ? receipt.changedCaseIds : []);
      const requestedCaseId = textArg(resolved, 'caseId');
      if (requestedCaseId && args.persistCase !== false) historyCaseIds.add(requestedCaseId);
      for (const id of historyCaseIds) {
        const item = LegalCases.getCase(orgId, id, userId, 'write');
        if (!item || (context?.domain === 'work' && !authorizeOrganizationResource({
          orgId, actorUserId: userId, resourceType: 'legal_case', resourceId: id, permission: 'write', ownerUserId: item.createdBy,
        }).allowed)) continue;
        const ownMaterialIds = legalExecutionWrites(orgId, userId).cases.get(id);
        const materialIds = item.materials.filter(m => ownMaterialIds?.has(m.id)).map(m => m.id);
        const textInMaterial = item.materials.some(m => materialIds.includes(m.id) && m.content === decoded.content);
        legalWrite(() => LegalCases.recordWorkflowRun(orgId, userId, id, {
          tool: definition.name, ok: receipt?.ok === true, status: String(receipt?.status || 'unverified'),
          materialIds,
          artifacts: Array.isArray(receipt?.artifacts) ? receipt.artifacts : [],
          ...(textInMaterial ? {} : { displayText: decoded.content }),
          ...(lawGate ? { currentLawGate: lawGate.passed ? 'passed' as const : 'blocked' as const } : {}),
          reasoningLinked: definition.name === 'legal_finalize_delivery_package' ? receipt?.ok === true : receipt?.reasoningLinked === true,
          ...(['template', 'mixed', 'model'].includes(receipt?.draftMode) ? { draftMode: receipt!.draftMode } : {}),
        }));
      }
      return result;
    }) };
}

export const stringField = (description: string) => ({ type: 'string', description });

export const numberField = (description: string) => ({ type: 'number', description });

export const booleanField = (description: string) => ({ type: 'boolean', description });

export const stringListField = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

export const CASE_ARCHIVE_FIELDS = {
  caseId: stringField('已有案件工作台 ID；提供后将工作产物归档到该案件空间'),
  caseName: stringField('案件、项目或工作空间名称'),
  caseType: stringField('案由或事项类型'),
  persistCase: booleanField('是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭'),
  orgId: stringField('组织 ID，默认上下文 orgId 或 default'),
  userId: stringField('操作用户 ID，默认上下文 userId 或 system'),
};
