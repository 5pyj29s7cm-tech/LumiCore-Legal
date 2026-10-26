import { resolveSourceDraftEntries, SourceDraftValidationError, type Source } from './legal_reasoning_generation';

export interface ContractReviewPart { index: number; start: number; end: number; text: string }

/** Exact offsets in the submitted text; overlapping windows preserve clause boundaries. */
export function splitContractForReview(text: string, size = 6000, overlap = 300): ContractReviewPart[] {
  if (size < 100 || overlap < 0 || overlap >= size) throw new Error('Invalid contract review window');
  const parts: ContractReviewPart[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end);
      if (boundary > start + size / 2) end = boundary + 1;
      if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    }
    parts.push({ index: parts.length + 1, start, end, text: text.slice(start, end) });
    if (end === text.length) break;
    start = end - overlap;
    if (/[\uDC00-\uDFFF]/u.test(text[start])) start++;
  }
  return parts;
}

export function contractCoverageReport(text: string, parts: ContractReviewPart[], reviewed: Set<number>, sourceOnly: boolean): string {
  return `## 审查覆盖范围
- 输入全文：${text.length} 字符；共 ${parts.length} 段（相邻段保留重叠条款）。
- 原文输入覆盖：全文；${sourceOnly ? '按要求仅保留原文，未进行模型深度审查。' : `模型深度审查：${reviewed.size}/${parts.length} 段。`}
- 未提供的附件未审查；栏目与来源结构通过不等于事实、法律或跨段一致性已经核准。
| 段落 | 原文字符位置 | 模型深度审查 |
| --- | --- | --- |
${parts.map(part => `| ${part.index} | ${part.start + 1}–${part.end} | ${sourceOnly ? '未请求' : reviewed.has(part.index) ? '已返回分析，待律师复核' : '未完成，需继续审查'} |`).join('\n')}`;
}

export const CONTRACT_DRAFT_SECTIONS = [
  '主体与角色', '合同目的与范围', '双方权利义务', '履行与期限',
  '对价与费用适用性', '责任、终止与争议处理', '签署、生效与待确认事项',
].map(title => ({ id: title, title }));
export const CONTRACT_REVIEW_SECTIONS = [
  { id: 'analysis', title: '原文分析' }, { id: 'revisions', title: '修改建议' }, { id: 'pending', title: '待核对事项' },
];
export const CONTRACT_WORK_PRODUCT_FORMAT = '仅输出 JSON {"complete":true,"entries":[{"sectionId":"指定栏目ID","sourceIds":["已有来源ID"],"response":"本栏目实际条款或分析正文","missing":""}]}。每个指定栏目恰好一项，仅使用已有来源ID，不复述原件为新事实。不输出说明、提纲或拒答冒充正文；无法形成完整工作稿时complete:false。complete只说明栏目正文已生成，不表示法律、事实或正式使用已核准。';

/** Compile the existing source-bound entries; completeness is structural, not legal approval. */
export function resolveContractWorkProduct(raw: string, sources: Source[], sections: Array<{id:string;title:string}>, options: { proposedDraft?: boolean } = {}): string {
  const value = JSON.parse(raw.replace(/^\s*\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60\s*$/, ''));
  if (value?.complete !== true || (value.unresolved !== undefined && (!Array.isArray(value.unresolved) || value.unresolved.length))) throw new SourceDraftValidationError('合同工作稿未完整生成。');
  const entries = resolveSourceDraftEntries(value, sources, sections.map(section=>section.id))
    .map(entry=>({...entry,response:entry.response.trim(),missing:entry.missing.trim()}));
  const bodies = entries.map(entry=>entry.response.split('\n').filter(line=>!/^\s*#/.test(line)).join('\n').trim());
  if (bodies.some(body=>body.length < 2) || bodies.join('').length < 40) throw new SourceDraftValidationError('合同工作稿缺少实际条款或分析正文。');
  return sections.map(section=>{const entry=entries.find(item=>item.sectionId===section.id)!;
    return ['## '+section.title,...(options.proposedDraft ? ['本栏以下全部为拟议条款，须双方确认；不得替代另列的原始要求。'] : []),entry.response,...(entry.missing ? ['待核对：'+entry.missing] : [])].join('\n\n');}).join('\n\n');
}
