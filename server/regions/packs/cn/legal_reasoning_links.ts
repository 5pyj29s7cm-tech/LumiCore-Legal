import { verifyCitation, verifyMultipleCitations } from '../../../legal/kb';
import { isLegalSourceMaterial } from '../../../../shared/legal_workflow_receipts';
import type { OrgLegalCaseFile } from '../../../org/legal_cases';

export interface LegalReasoningLink {
  issue: string;
  ruleCitation: string;
  ruleQuote: string;
  fact: string;
  evidence: Array<{ materialId: string; quote: string; locator: string }>;
  application: string;
  conclusion: string;
  limitations: string;
}

export const legalReasoningLinksSchema = {
  type: 'array', maxItems: 30, description: '逐项关联规则原文、待证事实、当前案件材料 ID/原文/页码、适用分析、结论和证据限制；仅有三个标题不能通过交付检查。',
  items: { type: 'object', required: ['issue', 'ruleCitation', 'ruleQuote', 'fact', 'evidence', 'application', 'conclusion', 'limitations'], properties: {
    issue: { type: 'string' }, ruleCitation: { type: 'string' }, ruleQuote: { type: 'string' }, fact: { type: 'string' },
    evidence: { type: 'array', minItems: 1, items: { type: 'object', required: ['materialId', 'quote', 'locator'], properties: {
      materialId: { type: 'string' }, quote: { type: 'string' }, locator: { type: 'string' },
    } } },
    application: { type: 'string' }, conclusion: { type: 'string' }, limitations: { type: 'string' },
  } },
};

const compact = (value: unknown) => String(value || '').replace(/\s+/g, '');
const substantive = (value: unknown) => typeof value === 'string' && compact(value).length >= 8
  && !/^(待补|待填|待确认|TODO|TBD)/i.test(value.trim());

/** Verifies traceability, not evidentiary truth or the legal correctness of an inference. */
export function inspectLegalReasoningLinks(input: unknown, caseFile: OrgLegalCaseFile | null, orgId: string,
  options: { factDate?: string; document?: string; actorUserId?: string } = {}) {
  const errors: string[] = [];
  const links = Array.isArray(input) ? input as LegalReasoningLink[] : [];
  if (!caseFile) errors.push('需要关联有权限的案件及已归档原始材料。');
  if (!links.length || links.length > 30) errors.push('需要 1–30 条规则—事实—证据—适用结论关联，不能只提供三段论标题。');
  for (const [index, link] of links.slice(0, 30).entries()) {
    const prefix = `第 ${index + 1} 项：`;
    if (!link || typeof link !== 'object') { errors.push(`${prefix}关联格式无效。`); continue; }
    for (const field of ['issue', 'ruleCitation', 'ruleQuote', 'fact', 'application', 'conclusion', 'limitations'] as const) {
      const meaningful = field === 'limitations' ? compact(link[field]).length >= 8
        : field === 'issue' ? compact(link[field]).length >= 2 : substantive(link[field]);
      if (!meaningful) errors.push(`${prefix}${field} 缺少具体内容。`);
    }
    const check = verifyCitation(String(link.ruleCitation || ''), orgId, { quotedText: String(link.ruleQuote || ''), factDate: options.factDate, actorUserId: options.actorUserId });
    if (check.type !== 'statute' || !check.provisionVerified || check.isEffective !== true || check.quotationVerified !== true) {
      errors.push(`${prefix}规则引用未通过现行原文核验：${check.detail}`);
    }
    if (!Array.isArray(link.evidence) || !link.evidence.length || link.evidence.length > 30) errors.push(`${prefix}缺少可定位的原始证据。`);
    for (const evidence of Array.isArray(link.evidence) ? link.evidence.slice(0, 30) : []) {
      const material = caseFile?.materials.find(m => m.id === evidence?.materialId && isLegalSourceMaterial(m));
      if (!material || !substantive(evidence?.quote) || !compact(material.content).includes(compact(evidence.quote))) {
        errors.push(`${prefix}证据摘录不在本案原始材料中，不能引用其他案件或生成稿作证明。`);
      }
      if (!String(evidence?.locator || '').trim() || /^(待|TODO|TBD)/i.test(evidence.locator)) errors.push(`${prefix}证据缺少页码、段落或时间戳。`);
    }
    if (options.document !== undefined && (!substantive(link.conclusion) || !compact(options.document).includes(compact(link.conclusion)))) {
      errors.push(`${prefix}结论未出现在本次拟交付文书中，不能复用无关底稿。`);
    }
  }
  if (options.document !== undefined) {
    const linked = new Set(links.map(link => compact(verifyCitation(String(link?.ruleCitation || ''), orgId).sourceText)));
    for (const check of verifyMultipleCitations(options.document, orgId, { factDate: options.factDate, actorUserId: options.actorUserId }).filter(check => check.type === 'statute')) {
      if (!check.sourceText || !linked.has(compact(check.sourceText))) errors.push(`文书引用 ${check.citation} 缺少对应适用分析。`);
    }
  }
  return { passed: errors.length === 0, links, errors, legalValidityVerified: false as const };
}

export function formatLegalReasoningLinks(links: LegalReasoningLink[]): string {
  return links.filter(link => link && typeof link === 'object').map((link, i) => [
    `### ${i + 1}. ${link.issue}`, `大前提：${link.ruleCitation}\n法条原文：${link.ruleQuote}`,
    `小前提：${link.fact}`, ...(Array.isArray(link.evidence) ? link.evidence.map(e => `- 材料 ${e.materialId}；位置 ${e.locator}；摘录：${e.quote}`) : []),
    `适用分析：${link.application}`, `结论：${link.conclusion}`, `限制与反证：${link.limitations}`,
  ].join('\n\n')).join('\n\n');
}
