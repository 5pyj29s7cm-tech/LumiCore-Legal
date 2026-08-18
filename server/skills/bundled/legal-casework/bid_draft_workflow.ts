import type {
  SkillWorkflowDescriptor,
  SkillWorkflowRunOptions,
  SkillWorkflowResult,
} from '../../workflow_registry';

const SAFE_BID_DRAFT_RE =
  /(?=.*(?:\u6807\u4e66|\u6295\u6807\u54cd\u5e94|bid|tender))(?=.*(?:\u5236\u4f5c|\u751f\u6210|\u8d77\u8349|\u51c6\u5907))(?=.*(?:\u5185\u90e8|\u5de5\u4f5c\u5e95\u7a3f|\u8349\u7a3f|\u5f85\u590d\u6838))/iu;
const NAVIGATION_ONLY_RE = /(?:\u6253\u5f00|\u8fdb\u5165|\u8df3\u8f6c).{0,24}(?:\u6807\u4e66|\u6295\u6807).{0,12}(?:\u5de5\u4f5c\u53f0|\u5de5\u4f5c\u533a|\u9875\u9762)/u;

function projectNameFromText(text: string): string {
  return String(text || '').match(/(?:\u4e3a|\u9879\u76ee(?:\u540d\u79f0)?\s*[:\uff1a])\s*[\u201c"]([^\u201d"]{2,100})[\u201d"]/u)?.[1]?.trim()
    || '\u5f85\u786e\u8ba4\u9879\u76ee';
}

function requirementsFromText(text: string): string {
  const normalized = String(text || '').trim();
  const marked = normalized.match(/(?:\u6a21\u62df)?\u62db\u6807\u8981\u6c42\s*[:\uff1a]\s*([\s\S]+?)(?=\u4e0d\u8981\u767b\u5f55|\u4e0d\u5f97\u767b\u5f55|\u5b8c\u6210\u540e\u8f93\u51fa|$)/u)?.[1]?.trim();
  return marked || normalized;
}

export function isSafeLegalBidDraftRequest(text: string): boolean {
  const normalized = String(text || '');
  return SAFE_BID_DRAFT_RE.test(normalized) && !NAVIGATION_ONLY_RE.test(normalized);
}

async function runLegalBidDraftWorkflow(options: SkillWorkflowRunOptions): Promise<SkillWorkflowResult> {
  const projectName = projectNameFromText(options.userText);
  const requirements = requirementsFromText(options.userText);
  const result = String(await options.desktopRelay('legal_generate_bid', {
    projectName,
    caseName: projectName,
    caseType: '\u6295\u6807/\u62db\u6807\u6587\u4ef6\u54cd\u5e94',
    requirements,
    persistCase: true,
    useModel: false,
  }) || '');

  return {
    responseText: `${result}\n\n## \u672c\u8f6e\u6267\u884c\u56de\u6267\n- \u5b9e\u9645\u4f7f\u7528\u80fd\u529b\uff1alegal_generate_bid\uff08\u62db\u6807\u8981\u6c42\u7ed3\u6784\u5316\u3001\u5546\u52a1/\u6280\u672f\u54cd\u5e94\u5e95\u7a3f\u751f\u6210\u3001\u7f3a\u53e3\u6807\u8bb0\u548c\u6848\u4ef6\u5f52\u6863\uff09\n- \u4efb\u52a1\u56de\u6267\u72b6\u6001\uff1a\u672c\u8f6e\u5de5\u5177\u6267\u884c\u7ed3\u679c\u5df2\u4ea4\u7531\u7edf\u4e00\u56de\u6267\u9a8c\u8bc1\uff1b\u672a\u767b\u5f55\u5916\u90e8\u7f51\u7ad9\uff0c\u672a\u4e0a\u4f20\u3001\u53d1\u9001\u3001\u63d0\u4ea4\u3001\u7b7e\u7f72\u6216\u6295\u6807\u3002`,
    toolCalls: [],
  };
}

export const legalBidDraftWorkflow: SkillWorkflowDescriptor = {
  id: 'verified_bid_draft',
  skillId: 'legal-casework',
  phase: 'legal_bid_draft',
  source: 'legal_bid_draft',
  logLabel: 'Verified legal bid draft',
  statusDetail: '\u6b63\u5728\u6839\u636e\u62db\u6807\u8981\u6c42\u751f\u6210\u53ef\u590d\u6838\u7684\u6807\u4e66\u5de5\u4f5c\u5e95\u7a3f',
  chatSpeech: { minMs: 1800, maxMs: 4800, msPerChar: 80 },
  fallbackText: '\u6807\u4e66\u5de5\u4f5c\u5e95\u7a3f\u6ca1\u6709\u5f62\u6210\u53ef\u9a8c\u8bc1\u56de\u6267\uff1b\u5df2\u505c\u6b62\uff0c\u6ca1\u6709\u4e0a\u4f20\u3001\u53d1\u9001\u3001\u63d0\u4ea4\u3001\u7b7e\u7f72\u6216\u6295\u6807\u3002',
  requiredTools: ['legal_generate_bid'],
  match: (text, context) => context?.targetIsLumi !== false && isSafeLegalBidDraftRequest(text),
  run: runLegalBidDraftWorkflow,
};
