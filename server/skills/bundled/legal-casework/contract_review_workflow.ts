import type {
  SkillWorkflowDescriptor,
  SkillWorkflowRunOptions,
  SkillWorkflowResult,
} from '../../workflow_registry';

const CONTRACT_REVIEW_RE =
  /(?:审查|复核|检查).{0,36}(?:合同|协议|条款)|(?:合同|协议|条款).{0,36}(?:审查|复核|检查)/u;
const CONTRACT_DRAFT_RE = /(?:起草|生成|新建|制作|拟定).{0,24}(?:合同|协议)|(?:合同|协议).{0,24}(?:起草|生成|新建|制作|拟定)/u;
const INLINE_CONTRACT_RE = /(?:合同原文|合同文本|协议原文|协议文本|条款)\s*[:：]\s*([\s\S]+)/u;

export function extractInlineContractText(text: string): string {
  const raw = String(text || '').match(INLINE_CONTRACT_RE)?.[1]?.trim() || '';
  if (!raw) return '';
  return raw
    .split(/(?:完成后|审查完成后|最后请|并请告诉我|告诉我实际使用)/u, 1)[0]
    .trim()
    .replace(/[。；;]\s*$/u, '');
}

export function isInlineContractReviewRequest(text: string): boolean {
  const normalized = String(text || '');
  return CONTRACT_REVIEW_RE.test(normalized)
    && !CONTRACT_DRAFT_RE.test(normalized)
    && extractInlineContractText(normalized).length >= 12;
}

async function runContractReviewWorkflow(options: SkillWorkflowRunOptions): Promise<SkillWorkflowResult> {
  const contract = extractInlineContractText(options.userText);
  if (!contract) {
    return {
      responseText: '还不能开始合同审查：没有读取到可核对的合同原文或条款。',
      toolCalls: [],
    };
  }

  const sourceOnly = /(?:只|仅)(?:能|可)?(?:依据|基于|按照).{0,12}(?:原文|条款)|不要补造|不得补造|不要编造|不得编造/u
    .test(options.userText);
  const omitSpecificLawCitations = /(?:不要|不得|无需|不需要).{0,12}(?:具体)?法条/u
    .test(options.userText);
  const result = String(await options.desktopRelay('legal_review_contract', {
    contract,
    sourceOnly,
    omitSpecificLawCitations,
    persistCase: false,
  }) || '');

  return { responseText: result, toolCalls: [] };
}

export const legalContractReviewWorkflow: SkillWorkflowDescriptor = {
  id: 'verified_inline_contract_review',
  skillId: 'legal-casework',
  phase: 'legal_contract_review',
  source: 'legal_contract_review',
  logLabel: 'Verified inline contract review',
  statusDetail: '正在依据合同原文进行风险审查',
  chatSpeech: { minMs: 1200, maxMs: 4200, msPerChar: 48 },
  fallbackText: '合同审查未形成可验证回执；我已停止，没有发送、提交或签署任何内容。',
  requiredTools: ['legal_review_contract'],
  match: (text, context) => context?.targetIsLumi !== false && isInlineContractReviewRequest(text),
  run: runContractReviewWorkflow,
};
