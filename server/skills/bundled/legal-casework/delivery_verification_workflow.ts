import type {
  SkillWorkflowDescriptor,
  SkillWorkflowRunOptions,
  SkillWorkflowResult,
} from '../../workflow_registry';

const DELIVERY_VERIFICATION_RE =
  /(?:执行|进行|完成|做|核对|检查|验证).{0,40}(?:交付核验|交付检查|文书核验)|(?:交付核验|交付检查|文书核验).{0,80}(?:核对|检查|验证|通过|阻断|待确认|正式交付|下一步)/u;
const NAVIGATION_ONLY_RE = /(?:只|仅|仅仅|只需|仅需).{0,16}(?:打开|进入|导航).{0,24}(?:交付核验|交付检查|文书核验)|(?:打开|进入).{0,24}(?:交付核验|交付检查|文书核验).{0,24}(?:只执行|仅执行).{0,12}(?:客户端)?导航/u;
const STATUS_ONLY_RE = /^\s*(?:(?:刚才|上次|之前|那个).{0,12})?(?:交付核验|交付检查|文书核验).{0,12}(?:完成了吗|好了吗|怎么样了|什么状态|进度如何)[？?。\s]*$/u;

function caseIdFromText(text: string): string {
  return String(text || '').match(/(?:案件\s*ID|case\s*id)\s*[:：]?\s*([0-9a-z_-]{8,})/iu)?.[1] || '';
}

function materialTitleFromText(text: string): string {
  const normalized = String(text || '');
  return normalized.match(/[“"]([^”"]{2,100}(?:草稿|文书|意见|策略|合同|标书|报告))[^”"]*[”"]/u)?.[1]?.trim()
    || normalized.match(/(?:已归档的|归档的|针对)([^，。；;]{2,100}(?:草稿|文书|意见|策略|合同|标书|报告))/u)?.[1]?.trim()
    || '';
}

export function isLegalDeliveryVerificationRequest(text: string): boolean {
  const normalized = String(text || '').trim();
  return DELIVERY_VERIFICATION_RE.test(normalized)
    && !NAVIGATION_ONLY_RE.test(normalized)
    && !STATUS_ONLY_RE.test(normalized);
}

async function runLegalDeliveryVerificationWorkflow(options: SkillWorkflowRunOptions): Promise<SkillWorkflowResult> {
  const caseId = caseIdFromText(options.userText);
  const materialTitle = materialTitleFromText(options.userText);
  const result = String(await options.desktopRelay('legal_verify_archived_delivery', {
    ...(caseId ? { caseId } : {}),
    ...(materialTitle ? { materialTitle } : {}),
  }) || '');
  return { responseText: result, toolCalls: [] };
}

export const legalDeliveryVerificationWorkflow: SkillWorkflowDescriptor = {
  id: 'verified_archived_delivery',
  skillId: 'legal-casework',
  phase: 'legal_delivery_verification',
  source: 'legal_delivery_verification',
  logLabel: 'Verified archived legal delivery',
  statusDetail: '正在读取案件工作台并逐项核验交付条件',
  chatSpeech: { minMs: 1200, maxMs: 4200, msPerChar: 48 },
  fallbackText: '交付核验没有形成可验证回执；我已停止，没有重新生成、发送、提交或签署任何文书。',
  requiredTools: ['legal_verify_archived_delivery'],
  match: (text, context) => context?.targetIsLumi !== false && isLegalDeliveryVerificationRequest(text),
  run: runLegalDeliveryVerificationWorkflow,
};
