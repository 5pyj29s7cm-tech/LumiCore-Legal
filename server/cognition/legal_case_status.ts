const NEGATED_ACTION_RE = /(?:不要|不必|无需|别|不得)(?:再)?(?:创建|新建|生成|起草|制作|更新|写入|添加|归档|提交|发送|调用)[^，。！？；;,.!?]{0,32}/gu;
const LEGAL_CASE_CONTEXT_RE = /(?:案件|案情|案号|案件\s*ID|case\s*id|争议金额|当事人|案由)/iu;
const READ_ONLY_STATUS_RE = /(?:还记得|记不记得|确认|核对|查询|查看|告诉我|说一下|当前|刚才|刚创建|已知事实|缺什么|下一步|进度|状态|回执|完成度|案件\s*ID|争议金额)/iu;
const MUTATING_LEGAL_ACTION_RE = /(?:新建|创建|建立|生成|起草|制作|更新|写入|添加|归档|提交|发送|签署|缴费|立案|上传).{0,64}(?:案件|工作台|文书|草稿|意见书|代理词|起诉状|答辩状|合同|材料|证据|平台)|(?:案件|工作台|文书|草稿|意见书|代理词|起诉状|答辩状|合同|材料|证据).{0,48}(?:新建|创建|建立|生成|起草|制作|更新|写入|添加|归档|提交|发送|签署|缴费|立案|上传)/iu;
const SUBSTANTIVE_LEGAL_WORK_RE = /(?:检索|搜索|研究|核验|验证|审查|分析|调查|追查|提取|比对|输出).{0,64}(?:法条|法规|法律|法源|权威来源|类案|案例|判例|裁判规则|合同|财产线索|交付包|标书)|(?:法条|法规|法律|法源|权威来源|类案|案例|判例|裁判规则|合同|财产线索|交付包|标书).{0,64}(?:检索|搜索|研究|核验|验证|审查|分析|调查|追查|提取|比对|输出)/iu;

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function actionBearingText(text: string): string {
  return text.replace(NEGATED_ACTION_RE, ' ');
}

/** A legal-case fact/status lookup that must not become document generation. */
export function isLegalCaseReadOnlyStatusRequest(input: string): boolean {
  const text = compact(input);
  if (!text || !LEGAL_CASE_CONTEXT_RE.test(text) || !READ_ONLY_STATUS_RE.test(text)) return false;
  const actionable = actionBearingText(text);
  if (SUBSTANTIVE_LEGAL_WORK_RE.test(actionable)) return false;
  const explicitIntakeOrOrganization = /(?:自动|请|帮我|现在|继续|并|然后).{0,24}(?:入案|归档|导入|上传|整理)|(?:案件|材料|链接).{0,24}(?:自动)?(?:入案|归档|导入|上传)/u.test(actionable);
  const describesPastMutation = /(?:刚刚|刚才|已经|已).{0,20}(?:入案|归档|导入|上传|整理)/u.test(actionable);
  if (explicitIntakeOrOrganization && !describesPastMutation) return false;
  return !MUTATING_LEGAL_ACTION_RE.test(actionable);
}

export interface LegalCaseStatusSnapshot {
  title: string;
  caseId: string;
  parties: string;
  cause: string;
  amount: string;
  completion: string;
  blockers: string;
  missingCount: string;
  nextAction: string;
  knownFacts: string;
  firstEvidenceGap: string;
}

function lineValue(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || '').match(new RegExp(`^-\\s*${escaped}\\s*[:：]\\s*(.+)$`, 'mu'))?.[1]?.trim() || '';
}

function extractAmount(text: string): string {
  const match = String(text || '').match(/争议金额\s*[:：]?\s*(?:人民币\s*)?([0-9０-９,.，]+(?:\.\d+)?\s*(?:万|亿)?\s*元?)/u);
  return match?.[1]?.replace(/\s+/g, '') || '';
}

function firstEvidenceGap(text: string): string {
  const section = String(text || '').match(/##\s*证据缺口与待核验事项\s*\r?\n([\s\S]*?)(?=\r?\n##\s|\r?\n\|\s*模块\s*\||$)/u)?.[1] || '';
  return section
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
    .find(line => Boolean(line) && !/^暂无/u.test(line)) || '';
}

export function parseLegalCaseStatus(input: string): LegalCaseStatusSnapshot | null {
  const text = String(input || '').trim();
  const title = text.match(/^#\s+(.+?)\s+案件闭环状态\s*$/mu)?.[1]?.trim() || '';
  const caseId = lineValue(text, '案件ID');
  if (!title || !caseId || /未持久化|未匹配/u.test(caseId)) return null;
  const knownFacts = lineValue(text, '事实摘要');
  return {
    title,
    caseId,
    parties: lineValue(text, '当事人'),
    cause: lineValue(text, '案由'),
    amount: extractAmount(`${knownFacts}\n${text}`),
    completion: lineValue(text, '完成度'),
    blockers: lineValue(text, '阻断项'),
    missingCount: lineValue(text, '待补项'),
    nextAction: lineValue(text, '下一动作'),
    knownFacts,
    firstEvidenceGap: firstEvidenceGap(text),
  };
}

function requestedCaseHint(text: string): string {
  const quoted = text.match(/(?:案件名|案件名称)\s*[“"']([^”"']+)[”"']/u)?.[1]?.trim();
  if (quoted) return quoted;
  const short = text.match(/([一二三四五六七八九十百零0-9]{1,8}号)案件/u)?.[1]?.trim();
  return short || '';
}

export function formatLegalCaseStatusResponse(userText: string, statusText: string): string {
  const snapshot = parseLegalCaseStatus(statusText);
  if (!snapshot) {
    return '当前没有读取到可核对的案件账本；我已停止，没有创建新任务，也没有调用外部平台。';
  }

  const hint = requestedCaseHint(userText);
  if (hint && !snapshot.title.includes(hint)) {
    return `当前绑定的是“${snapshot.title}”（案件 ID：${snapshot.caseId}），与您提到的“${hint}”不一致；我已停止，没有创建新任务。`;
  }

  const text = compact(userText);
  const parts: string[] = [];
  if (/案件(?:名称|名)|哪个案件|当前案件/u.test(text)) parts.push(`案件名称是“${snapshot.title}”`);
  if (/案件\s*ID|case\s*id|案件编号/iu.test(text)) parts.push(`案件 ID 是 ${snapshot.caseId}`);
  if (/争议金额|金额/u.test(text)) parts.push(snapshot.amount ? `争议金额是 ${snapshot.amount}` : '争议金额尚未记录');
  if (/当事人|甲方|乙方/u.test(text)) parts.push(`已记录当事人：${snapshot.parties || '待补充'}`);
  if (/案由/u.test(text)) parts.push(`案由是${snapshot.cause || '待确认'}`);
  if (/已知事实|事实/u.test(text)) parts.push(`已知事实：${snapshot.knownFacts || '待补充'}`);
  if (/进度|完成度|当前状态|案件状态/u.test(text)) {
    parts.push(`当前完成度 ${snapshot.completion || '待核对'}，阻断项 ${snapshot.blockers || '待核对'}，待补项 ${snapshot.missingCount || '待核对'}`);
  }
  if (/下一步/u.test(text)) parts.push(`下一步：${snapshot.nextAction || '由律师结合材料确定'}`);
  if (/缺什么|补什么|缺失材料|待补材料/u.test(text)) {
    parts.push(`优先待补：${snapshot.firstEvidenceGap || '由律师核对原件、来源和证明目的'}`);
  }
  if (/回执/u.test(text)) {
    parts.push(/(?:草稿|复核稿|文书).{0,12}回执|回执.{0,12}(?:草稿|复核稿|文书)/u.test(text)
      ? '本次案件状态读取回执已验证；此前草稿回执需按原任务账本单独核对'
      : '本次案件状态读取回执已验证');
  }
  if (!parts.length) {
    parts.push(`当前案件是“${snapshot.title}”`, `案件 ID 是 ${snapshot.caseId}`);
    if (snapshot.amount) parts.push(`争议金额是 ${snapshot.amount}`);
  }

  const prefix = /还记得|记不记得/u.test(text) ? '记得，' : '';
  return `${prefix}${parts.join('，')}。`;
}
