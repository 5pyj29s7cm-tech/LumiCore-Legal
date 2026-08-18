import type { OperationMode } from './operation_modes';
import { formatCnCapabilityMetaResponse } from '../regions/packs/cn/capability_meta_messages';
import { getCurrentIndustryCapabilityProfile } from '../regions/packs/cn/industry_capability_profile';
import { buildActionContract } from './action_contract';

export interface CapabilityMetaResponseInput {
  text: string;
  operationMode?: OperationMode | string;
  source?: string;
}

const CAPABILITY_SUBJECT_RE =
  /(?:\u5de5\u5177|\u6280\u80fd|\u80fd\u529b|\u6743\u9650|\u52a9\u624b\u6a21\u5f0f|\u52a9\u7406\u6a21\u5f0f|\u81ea\u4e3b\u6a21\u5f0f|\u4f1a\u8bdd|\u6302\u8f7d|\u8def\u7531|\b(?:tools?|skills?|capabilit(?:y|ies)|permissions?|assistant\s+mode|autonomous\s+mode|session|routing)\b)/iu;

const CAPABILITY_META_QUESTION_RE =
  /(?:\u600e\u4e48|\u5982\u4f55|\u600e\u6837|\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u662f\u4e0d\u662f|\u662f\u5426|\u80fd\u4e0d\u80fd|\u53ef\u4e0d\u53ef\u4ee5|\u8981\u600e\u4e48|\u600e\u6837\u624d\u80fd|\u53ea\u6709|\u53ea\u6302\u8f7d|\u6ca1\u6302\u8f7d|\u672a\u6302\u8f7d|\u6ca1\u5e26|\u6ca1\u5f00\u542f|\u4e0d\u53ef\u7528|\u600e\u4e48\u7528|\u600e\u4e48\u8c03\u7528|\b(?:how|why|can|could|is|are|do|does|only|enable|access|available|mounted|loaded|permission)\b)/iu;

const CAPABILITY_ACCESS_RE =
  /(?:\u4f7f\u7528|\u8c03\u7528|\u5f00\u542f|\u542f\u7528|\u5207\u6362|\u6302\u8f7d|\u8bbf\u95ee|\u9009\u4e2d|\u66b4\u9732|\u53ea\u6709|\u6ca1\u6709|\u6ca1\u5e26|\u4e0d\u53ef\u7528|\b(?:use|uses|using|call|enable|access|select|expose|mount|load|available)\b)/iu;

const EDITION_SELF_INTRODUCTION_RE =
  /(?:\u4f60\u662f\u8c01|\u4f60\u53eb\u4ec0\u4e48|\u4ecb\u7ecd(?:\u4e00\u4e0b)?\u4f60\u81ea\u5df1|\u8fd9\u662f\u54ea\u4e2a(?:\u5b9a\u5236\u7248|\u7248\u672c)|\u5f53\u524d\u662f\u4ec0\u4e48(?:\u5b9a\u5236\u7248|\u7248\u672c)|\u4f60\u80fd\u5e2e.{0,24}(?:\u505a\u4ec0\u4e48|\u5b8c\u6210\u54ea\u4e9b|\u54ea\u4e9b\u5de5\u4f5c)|\b(?:who\s+are\s+you|introduce\s+yourself|which\s+edition|what\s+can\s+you\s+do)\b)/iu;

function isEditionSelfIntroductionQuestion(text: string): boolean {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return EDITION_SELF_INTRODUCTION_RE.test(normalized);
}

/**
 * Capability access questions describe Lumi's execution model. They are not
 * requests to run a tool, change modes, inspect client state, or create work.
 */
export function isCapabilityMetaQuestion(text: string): boolean {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (isEditionSelfIntroductionQuestion(normalized)) return true;
  const explicitWorkRequest = /(?:^|[：:，,；;。！？!?])\s*(?:(?:请|麻烦|现在|先|继续|直接|帮我|给我|替我)\s*){0,3}(?:审查|审核|起草|生成|创建|新建|制作|分析|检查|核对|读取|打开|执行|处理|修改|整理|检索|查询|归档|导入|发送|提交|签署|绘制|设计)/u.test(normalized)
    || /(?:^|[：:，,；;。！？!?])\s*(?:基于|根据|结合|针对|围绕|依照|按照|使用|只使用)[\s\S]{1,320}?(?:执行|审查|审核|起草|生成|创建|新建|制作|分析|检查|核对|读取|处理|修改|整理|检索|查询|归档|导入)/u.test(normalized);
  const actionContract = explicitWorkRequest ? buildActionContract(normalized) : null;
  if (actionContract?.applies && actionContract.kind !== 'none') return false;
  if (!CAPABILITY_SUBJECT_RE.test(normalized)) return false;
  if (/(?:\u521a\u624d|\u521a\u521a|\u4e0a\u6b21|\u4e0a\u4e00\u8f6e|\u6ca1.{0,12}\u6210\u529f|\u5931\u8d25|\u62a5\u9519|\u5361\u4f4f|\u4e3a\u4ec0\u4e48.{0,20}\u6ca1.{0,12}(?:\u6267\u884c|\u8c03\u7528)|\b(?:earlier|last\s+time|failed|error|stuck|didn'?t\s+(?:run|call))\b)/iu.test(normalized)) {
    return false;
  }

  const asksAboutMode =
    /(?:\u4f60\u73b0\u5728|\u5f53\u524d|\u8fd9\u4e0d|\u4e0d\u662f).{0,18}(?:\u52a9\u624b|\u52a9\u7406|\u81ea\u4e3b).{0,8}(?:\u6a21\u5f0f)?(?:\u5417|\u4e48|\uff1f|\?)?/u.test(normalized)
    || /\b(?:are|aren't|isn't)\s+(?:you|lumi).{0,24}(?:assistant|autonomous)\s+mode\b/i.test(normalized);
  if (asksAboutMode) return true;

  return CAPABILITY_META_QUESTION_RE.test(normalized)
    && CAPABILITY_ACCESS_RE.test(normalized);
}

function isChinese(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

export function buildCapabilityMetaResponse(input: CapabilityMetaResponseInput): string | null {
  if (!isCapabilityMetaQuestion(input.text)) return null;

  if (isEditionSelfIntroductionQuestion(input.text)) {
    const profile = getCurrentIndustryCapabilityProfile();
    if (profile) {
      const workspaceNames = profile.entries.map(entry => entry.displayName).join('\u3001');
      return [
        `\u6211\u662f Lumi\uff0c\u8fd9\u91cc\u8fd0\u884c\u7684\u662f${profile.displayName}\u3002${profile.positioning}`,
        `\u6211\u53ef\u4ee5\u5728${workspaceNames}\u8fd9\u4e9b\u5de5\u4f5c\u533a\u91cc\u5e2e\u4f60\u6574\u7406\u4e8b\u5b9e\u4e0e\u6750\u6599\u3001\u51c6\u5907\u8349\u7a3f\u3001\u68c0\u7d22\u5df2\u6388\u6743\u6765\u6e90\uff0c\u5e76\u628a\u8fc7\u7a0b\u548c\u7ed3\u679c\u7559\u5728\u53ef\u8ffd\u6eaf\u7684\u4efb\u52a1\u8d26\u672c\u4e2d\u3002`,
        `\u53ef\u4ee5\u81ea\u52a8\u51c6\u5907\u7684\u5185\u5bb9\u5305\u62ec\uff1a${profile.automaticActions.join('\uff1b')}\u3002`,
        `\u4f46\u4ee5\u4e0b\u5185\u5bb9\u4e0d\u4f1a\u7531\u6211\u64c5\u81ea\u5b9a\u6848\uff1a${profile.reviewRequiredActions.join('\uff1b')}\u3002\u8fd9\u4e9b\u7ed3\u679c\u5fc5\u987b\u7531\u5bf9\u5e94\u4e13\u4e1a\u4eba\u5458\u590d\u6838\uff0c\u7b7e\u7f72\u3001\u63d0\u4ea4\u3001\u4ed8\u6b3e\u548c\u5bf9\u5916\u53d1\u9001\u8fd8\u5fc5\u987b\u5728\u6700\u540e\u4e00\u6b65\u5f97\u5230\u7cbe\u786e\u786e\u8ba4\u3002`,
        '\u6211\u4e0d\u4f1a\u8865\u9020\u4e8b\u5b9e\u3001\u8bc1\u636e\u6216\u6765\u6e90\uff1b\u8d44\u6599\u4e0d\u8db3\u65f6\u4f1a\u76f4\u63a5\u8bf4\u660e\u7f3a\u53e3\uff0c\u800c\u4e0d\u662f\u628a\u8349\u7a3f\u8bf4\u6210\u5df2\u7ecf\u5b8c\u6210\u7684\u4e13\u4e1a\u7ed3\u8bba\u3002',
      ].join('\n');
    }
  }

  const mode = String(input.operationMode || 'assistant').toLowerCase();
  const commandCenter = input.source === 'command-center-chat';
  if (!isChinese(input.text)) {
    const modeLine = mode === 'assistant'
      ? 'You are already in Assistant mode, which has the full foreground tool, skill, browser, app, file, desktop, and team permissions.'
      : mode === 'autonomous'
        ? 'You are in Autonomous mode, which includes Assistant permissions plus continuous background execution.'
        : mode === 'chat'
          ? 'You are in Chat mode; a clear action request automatically promotes that turn to Assistant before execution.'
          : 'Meeting is a voice-capture surface; real action follows the same Assistant/Autonomous execution policy.';
    const entryLine = commandCenter
      ? 'The text panel beside the command-center office is Lumi\'s text entry; there is no second text screen to switch to.'
      : 'Give the complete task directly in the current conversation.';
    return [
      modeLine,
      entryLine,
      'Lumi selects only the relevant tools for each turn to reduce routing noise. That subset is not the installed capability inventory and does not mean other tools are disabled.',
      'If the correct tool is not selected for a clear task, that is a Lumi routing failure—not a setting you need to change.',
    ].join('\n');
  }

  return formatCnCapabilityMetaResponse(mode, commandCenter);
}
