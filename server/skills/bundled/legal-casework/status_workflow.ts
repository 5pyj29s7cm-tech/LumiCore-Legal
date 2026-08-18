import { formatLegalCaseStatusResponse, isLegalCaseReadOnlyStatusRequest } from '../../../cognition/legal_case_status';
import type {
  SkillWorkflowDescriptor,
  SkillWorkflowRunOptions,
  SkillWorkflowResult,
} from '../../workflow_registry';

async function runLegalCaseStatusWorkflow(options: SkillWorkflowRunOptions): Promise<SkillWorkflowResult> {
  const explicitCaseId = String(options.userText || '').match(/(?:案件\s*ID|case\s*id)\s*[:：]?\s*([0-9a-z_-]{8,})/iu)?.[1] || '';
  const status = String(await options.desktopRelay('legal_case_workflow_status', {
    ...(explicitCaseId ? { caseId: explicitCaseId } : {}),
  }) || '');
  return {
    responseText: formatLegalCaseStatusResponse(options.userText, status),
    toolCalls: [],
  };
}

export const legalCaseStatusWorkflow: SkillWorkflowDescriptor = {
  id: 'verified_case_status',
  skillId: 'legal-casework',
  phase: 'legal_case_status',
  source: 'legal_case_status',
  logLabel: 'Verified legal case status',
  statusDetail: '正在核对本地案件账本',
  chatSpeech: { minMs: 500, maxMs: 1800, msPerChar: 30 },
  fallbackText: '当前没有读取到可核对的案件账本；我已停止，没有创建新任务，也没有调用外部平台。',
  createsTask: false,
  requiredTools: ['legal_case_workflow_status'],
  match: (text, context) => context?.targetIsLumi !== false && isLegalCaseReadOnlyStatusRequest(text),
  run: runLegalCaseStatusWorkflow,
};
