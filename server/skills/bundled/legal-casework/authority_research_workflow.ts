import type {
  SkillWorkflowDescriptor,
  SkillWorkflowRunOptions,
  SkillWorkflowResult,
} from '../../workflow_registry';

const AUTHORITY_RESEARCH_RE = /(?:法条与类案|法条类案|法源|权威来源|法律检索|类案检索).{0,80}(?:检索|搜索|核验|来源状态|可核验结果|检索问题)|(?:检索|搜索|核验|来源状态|可核验结果|检索问题).{0,80}(?:法条与类案|法条类案|法源|权威来源|法律|类案|案例|裁判规则)/u;
const NAVIGATION_ONLY_RE = /(?:只执行|仅执行).{0,12}(?:客户端)?导航|不要检索|不得检索|无需检索/u;

function lineValue(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || '').match(new RegExp(`^-\\s*${escaped}\\s*[:：]\\s*(.+)$`, 'mu'))?.[1]?.trim() || '';
}

function caseIdFromText(text: string): string {
  return String(text || '').match(/(?:案件\s*ID|case\s*id)\s*[:：]?\s*([0-9a-z_-]{8,})/iu)?.[1] || '';
}

function caseNameFromStatus(text: string): string {
  return String(text || '').match(/^#\s+(.+?)\s+案件闭环状态\s*$/mu)?.[1]?.trim() || '';
}

function section(text: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || '').match(new RegExp(`##\\s*${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s|$)`, 'u'))?.[1]?.trim() || '';
}

function hasVerifiedCandidates(text: string): boolean {
  const normalized = String(text || '');
  return !/(?:未找到|未命中|请提供|待登记|无法完成)/u.test(normalized)
    && /(?:来源:|来源：|现行有效|本地知识库检索到|http)/u.test(normalized);
}

export function isLegalAuthorityResearchRequest(text: string): boolean {
  const normalized = String(text || '');
  return AUTHORITY_RESEARCH_RE.test(normalized)
    && !NAVIGATION_ONLY_RE.test(normalized)
    && !/(?:交付核验|交付检查|文书核验)/u.test(normalized);
}

async function runLegalAuthorityResearchWorkflow(options: SkillWorkflowRunOptions): Promise<SkillWorkflowResult> {
  const requestedCaseId = caseIdFromText(options.userText);
  const status = String(await options.desktopRelay('legal_case_workflow_status', {
    ...(requestedCaseId ? { caseId: requestedCaseId } : {}),
  }) || '');
  const caseId = lineValue(status, '案件ID') || requestedCaseId;
  const caseName = caseNameFromStatus(status);
  const caseType = lineValue(status, '案由') || '待确认案由';
  const parties = lineValue(status, '当事人');
  const facts = lineValue(status, '事实摘要');

  if (!caseId || !caseName) {
    return {
      responseText: '还不能开始法条与类案检索：没有读取到可核对的案件 ID 和案件工作台。',
      toolCalls: [],
    };
  }

  const [authorityStatus, externalSourceStatus, statuteResult, caseResult, plan] = await Promise.all([
    options.desktopRelay('legal_authority_source_status', {}),
    options.desktopRelay('legal_external_source_status', {}),
    options.desktopRelay('legal_search_statute', {
      query: caseType,
      includeOfficialWeb: false,
    }),
    options.desktopRelay('legal_search_case', {
      query: [caseType, parties, facts].filter(Boolean).join('；'),
      limit: 5,
    }),
    options.desktopRelay('legal_external_research_plan', {
      caseId,
      caseName,
      caseType,
      facts: [parties ? `当事人：${parties}` : '', facts].filter(Boolean).join('\n'),
      persistCase: false,
    }),
  ]).then(values => values.map(value => String(value || '')));

  const statuteVerified = hasVerifiedCandidates(statuteResult);
  const caseVerified = hasVerifiedCandidates(caseResult);
  const researchQueries = section(plan, '六、检索词') || '当前案件事实不足，检索词待律师补充。';
  const sourceSummary = section(externalSourceStatus, '统一口径') || externalSourceStatus;
  const authoritySummary = authorityStatus.trim() || '没有读取到权威法源巡检状态。';
  const resultBoundary = statuteVerified || caseVerified
    ? '已返回工具实际命中的候选结果；引用前仍须由执业律师逐条核验效力、案号、法院、日期、链接和适用边界。'
    : '当前本地库和已配置授权来源没有返回可核验候选，无法完成实质法条或类案检索；不得凭模型记忆补写法条、案号、法院或裁判规则。';

  return {
    responseText: `# 法条与类案检索核验结果

## 案件范围
- 案件：${caseName}
- 案件 ID：${caseId}
- 案由：${caseType}
- 当事人：${parties || '待确认'}
- 已知事实：${facts || '待确认'}

## 检索问题
${researchQueries}

## 权威法源巡检状态
${authoritySummary}

## 外部来源统一口径
${sourceSummary}

## 可核验结果
### 法条候选
${statuteResult}

### 类案候选
${caseResult}

## 结果与缺口
- ${resultBoundary}
- 未自动登录任何外部网站；未发送、未提交、未签署。

## 执行记录
- 实际使用能力：legal_case_workflow_status、legal_authority_source_status、legal_external_source_status、legal_search_statute、legal_search_case、legal_external_research_plan
- 任务回执状态：以上结果均来自本轮结构化工具调用，最终完成判断只接受本轮回执。`,
    toolCalls: [],
  };
}

export const legalAuthorityResearchWorkflow: SkillWorkflowDescriptor = {
  id: 'verified_authority_research',
  skillId: 'legal-casework',
  phase: 'legal_authority_research',
  source: 'legal_authority_research',
  logLabel: 'Verified legal authority research',
  statusDetail: '正在核对案件、权威法源状态和可验证类案来源',
  chatSpeech: { minMs: 1400, maxMs: 4800, msPerChar: 50 },
  fallbackText: '法条与类案检索没有形成可验证回执；我已停止，没有登录外部网站，也没有编造法条或案例。',
  requiredTools: [
    'legal_case_workflow_status',
    'legal_authority_source_status',
    'legal_external_source_status',
    'legal_search_statute',
    'legal_search_case',
    'legal_external_research_plan',
  ],
  match: (text, context) => context?.targetIsLumi !== false && isLegalAuthorityResearchRequest(text),
  run: runLegalAuthorityResearchWorkflow,
};
