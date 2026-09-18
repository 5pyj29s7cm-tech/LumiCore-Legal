/** Keep source text and coverage explicit; never invent missing commercial terms. */
export function buildGroundedBidDraft(projectName: string, requirements: string): string {
  const rows = requirements.split(/\r?\n|(?<=[；。])/u).map(line => line.trim()).filter(Boolean);
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  return `# ${projectName} 投标响应工作底稿

## 一、招标要求响应矩阵
| 编号 | 招标要求原文 | 响应/材料 | 完成状态 |
| --- | --- | --- | --- |
${rows.map((line, index) => `| R${index + 1} | ${cell(line)} | 待投标人提供对应方案及证明材料 | 待填写/待核验 |`).join('\n')}

## 二、商务响应
- 投标主体、授权代表、资质、业绩、人员、报价、保证金、税费、签章和密封要求：仅以已提供文件为准；缺失部分待补。
- 不自行生成资质、业绩、金额、交货期或实施承诺。

## 三、技术响应与实施计划
- 围绕上述编号逐项编写方案，分别说明实现方式、交付物和证明文件。
- 交付时间、里程碑、责任人和验收标准：依据对应要求填写，未提供的标为待确认。
- 不适用的章节应说明原因，不可套用其他项目的目标或工期。

## 四、待补材料与复核
- 完整招标正文、附件、评分办法、否决条款、格式要求及截止时间是否齐全，待逐项核对。
- 这是内部响应底稿，不是已完成的正式标书；尚未上传、发送、投标或签署。
- 每条响应、法源和最终签章材料需责任人复核。`;
}

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
- 原文规则检查：全文；${sourceOnly ? '按要求仅作原文规则检查，未进行模型深度审查。' : `模型深度审查：${reviewed.size}/${parts.length} 段。`}
- 未提供的附件未审查；模型深度审查与原文规则检查分别记录。
| 段落 | 原文字符位置 | 模型深度审查 |
| --- | --- | --- |
${parts.map(part => `| ${part.index} | ${part.start + 1}–${part.end} | ${sourceOnly ? '未请求' : reviewed.has(part.index) ? '已返回分析，待律师复核' : '未完成，需继续审查'} |`).join('\n')}`;
}
