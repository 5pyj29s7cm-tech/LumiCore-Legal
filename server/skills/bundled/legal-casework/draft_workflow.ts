import type {
  SkillWorkflowDescriptor,
  SkillWorkflowRunOptions,
  SkillWorkflowResult,
} from '../../workflow_registry';

const SAFE_LEGAL_DRAFT_RE =
  /(?:\u751f\u6210|\u8d77\u8349|\u51c6\u5907|\u5236\u4f5c).{0,80}(?:\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1\u4e66|\u5ead\u5ba1\u63d0\u7eb2|\u5e94\u5bf9\u7b56\u7565).{0,48}(?:\u8349\u7a3f|\u590d\u6838\u7a3f|\u5de5\u4f5c\u5e95\u7a3f)|(?:\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1\u4e66|\u5ead\u5ba1\u63d0\u7eb2|\u5e94\u5bf9\u7b56\u7565).{0,48}(?:\u8349\u7a3f|\u590d\u6838\u7a3f|\u5de5\u4f5c\u5e95\u7a3f)/u;

function requestedDocumentType(text: string): string {
  if (/\u6cd5\u5f8b\u610f\u89c1\u4e66/u.test(text)) return '\u6cd5\u5f8b\u610f\u89c1\u4e66';
  if (/\u5ead\u5ba1\u63d0\u7eb2/u.test(text)) return '\u5ead\u5ba1\u63d0\u7eb2';
  if (/\u5e94\u5bf9\u7b56\u7565/u.test(text)) return '\u5e94\u5bf9\u7b56\u7565';
  return '\u4ee3\u7406\u8bcd';
}

function lineValue(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || '').match(new RegExp(`^-\\s*${escaped}\\s*[:：]\\s*(.+)$`, 'mu'))?.[1]?.trim() || '';
}

function caseIdFromText(text: string): string {
  return String(text || '').match(/(?:\u6848\u4ef6\s*ID|case\s*id)\s*[:：]?\s*([0-9a-z_-]{8,})/iu)?.[1] || '';
}

function caseNameFromStatus(text: string): string {
  return String(text || '').match(/^#\s+(.+?)\s+\u6848\u4ef6\u95ed\u73af\u72b6\u6001\s*$/mu)?.[1]?.trim() || '';
}

async function runLegalDraftWorkflow(options: SkillWorkflowRunOptions): Promise<SkillWorkflowResult> {
  const requestedCaseId = caseIdFromText(options.userText);
  const status = String(await options.desktopRelay('legal_case_workflow_status', {
    ...(requestedCaseId ? { caseId: requestedCaseId } : {}),
  }) || '');
  const caseId = lineValue(status, '\u6848\u4ef6ID') || requestedCaseId;
  const caseName = caseNameFromStatus(status);
  const caseType = lineValue(status, '\u6848\u7531') || '\u5f85\u786e\u8ba4\u6848\u7531';
  const parties = lineValue(status, '\u5f53\u4e8b\u4eba');
  const facts = lineValue(status, '\u4e8b\u5b9e\u6458\u8981');

  if (!caseId || !caseName || !facts) {
    return {
      responseText: '\u8fd8\u4e0d\u80fd\u751f\u6210\u8349\u7a3f\uff1a\u5f53\u524d\u6848\u4ef6\u5de5\u4f5c\u53f0\u7f3a\u5c11\u53ef\u6838\u5bf9\u7684\u6848\u4ef6ID\u6216\u5df2\u77e5\u4e8b\u5b9e\u3002',
      toolCalls: [],
    };
  }

  const documentType = requestedDocumentType(options.userText);
  const result = String(await options.desktopRelay('legal_generate_argument_or_opinion', {
    caseId,
    caseName,
    caseType,
    documentType,
    facts: [parties ? `\u5f53\u4e8b\u4eba\uff1a${parties}` : '', facts].filter(Boolean).join('\n'),
    // Generated notes and earlier drafts may also be archived in the case.
    // They are not source evidence and must never be fed back as if they were
    // contracts, originals, receipts or other verified case materials.
    evidence: '\u6848\u4ef6\u5de5\u4f5c\u53f0\u5f53\u524d\u672a\u63d0\u4f9b\u53ef\u6838\u9a8c\u7684\u539f\u59cb\u8bc1\u636e\uff1b\u5f85\u6574\u7406\u8bc1\u636e\u76ee\u5f55\u5e76\u7531\u5f8b\u5e08\u6838\u5bf9\u3002',
    opponentArguments: '\u5f85\u786e\u8ba4',
    objective: `\u5f62\u6210${documentType}\u5f8b\u5e08\u590d\u6838\u8349\u7a3f\uff1b\u672a\u77e5\u4e8b\u5b9e\u3001\u8bc1\u636e\u548c\u6cd5\u6e90\u5168\u90e8\u6807\u6ce8\u5f85\u786e\u8ba4\u6216\u5f85\u6838\u9a8c\u3002`,
    persistCase: true,
  }) || '');

  return { responseText: result, toolCalls: [] };
}

export const legalDraftWorkflow: SkillWorkflowDescriptor = {
  id: 'verified_case_draft',
  skillId: 'legal-casework',
  phase: 'legal_case_draft',
  source: 'legal_case_draft',
  logLabel: 'Verified legal case draft',
  statusDetail: '\u6b63\u5728\u8bfb\u53d6\u6848\u4ef6\u5de5\u4f5c\u53f0\u5e76\u751f\u6210\u5f8b\u5e08\u590d\u6838\u8349\u7a3f',
  chatSpeech: { minMs: 1800, maxMs: 4800, msPerChar: 90 },
  fallbackText: '\u5f8b\u5e08\u590d\u6838\u8349\u7a3f\u8fd8\u6ca1\u6709\u751f\u6210\uff1a\u9700\u8981\u5148\u8bfb\u53d6\u53ef\u6838\u5bf9\u7684\u6848\u4ef6\u5de5\u4f5c\u53f0\u56de\u6267\u3002',
  requiredTools: ['legal_case_workflow_status', 'legal_generate_argument_or_opinion'],
  match: (text, context) => context?.targetIsLumi !== false && SAFE_LEGAL_DRAFT_RE.test(String(text || '')),
  run: runLegalDraftWorkflow,
};
