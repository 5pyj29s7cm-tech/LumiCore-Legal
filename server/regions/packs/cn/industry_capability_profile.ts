import { PRODUCT_VARIANT } from '../../../../shared/product_variant';
import {
  getIndustryWorkflowContracts,
  normalizeIndustryProductLine,
  type IndustryProductLine,
  type IndustryWorkflowContract,
} from '../../../industry/workflow_contracts';

export type IndustryAutomationLevel = 'automatic' | 'review_required' | 'confirmation_required';

export interface IndustryCapabilityEntry {
  entryId: string;
  displayName: string;
  summary: string;
  routingTerms: string[];
  automationLevel: IndustryAutomationLevel;
  contract: IndustryWorkflowContract;
}

export interface IndustryCapabilityProfile {
  schemaVersion: 1;
  variantId: string;
  displayName: string;
  productLine: IndustryProductLine;
  positioning: string;
  automaticActions: string[];
  reviewRequiredActions: string[];
  optionalExtensions: Array<{ id: string; label: string; defaultEnabled: false }>;
  entries: IndustryCapabilityEntry[];
}

export interface IndustryWorkflowMatch {
  profile: IndustryCapabilityProfile;
  entry: IndustryCapabilityEntry;
  score: number;
  matchedTerms: string[];
}

interface EntryCopy {
  displayName: string;
  summary: string;
  routingTerms: string[];
  routingPatterns?: RegExp[];
  automationLevel?: IndustryAutomationLevel;
}

interface ProfileCopy {
  positioning: string;
  automaticActions: string[];
  reviewRequiredActions: string[];
  optionalExtensions?: Array<{ id: string; label: string; defaultEnabled: false }>;
  entries: Record<string, EntryCopy>;
}

const PROFILE_COPY: Record<IndustryProductLine, ProfileCopy> = {
  ecommerce: {
    positioning: '面向电商经营者的轻量经营与交付智能体，优先把店铺资料转化为可复核的经营结果。',
    automaticActions: ['读取已授权的店铺资料', '指标计算与异常分析', '生成经营、商品、内容与客服草稿', '归档来源、口径和本地结果'],
    reviewRequiredActions: ['选品决策', '商品动作队列', '客户回复与内容定稿', '任何发布、改价、上下架、退款、广告花费或外发动作'],
    entries: {
      'today-operations': { displayName: '今日经营', summary: '汇总本期订单、销售、投放、库存和售后，输出异常与行动清单。', routingTerms: ['今日经营', '今日经营台', '经营日报', '今日数据', '今天店铺', '销售日报', '订单异常', 'daily operations', 'daily business'] },
      'trend-discovery': { displayName: '爆款雷达', summary: '收集有日期和来源的趋势信号，形成候选机会与小规模验证方案。', routingTerms: ['爆款雷达', '爆品', '选品', '趋势机会', '热点商品', '市场趋势', 'trend discovery', 'product opportunity'] },
      'store-data': { displayName: '店铺数据', summary: '标准化经营报表并保留来源、期间、币种、字段映射和计算口径。', routingTerms: ['店铺数据', '店铺报表', '经营数据', '订单报表', '投放报表', '库存分析', 'store data', 'store report'] },
      'listing-automation': { displayName: '商品管理', summary: '核验 SKU、库存、毛利、退货和合规资料，准备待审批商品动作。', routingTerms: ['商品管理', '商品上架', '商品下架', '商品优化', 'sku 管理', '库存商品', 'listing management', 'product management'] },
      'ai-customer-service': { displayName: '内容与客服', summary: '处理内容、售前、售后和升级事项，生成待审核草稿。', routingTerms: ['内容与客服', '客服回复', '售前回复', '售后回复', '内容运营', '商品文案', '客户工单', 'customer service', 'content operations'] },
    },
  },
  design: {
    positioning: '面向设计项目交付的轻量智能体，围绕同一项目、真实文件和专业复核组织工作。',
    automaticActions: ['读取项目 Brief 和已归档资料', '整理范围、约束、风险与缺失信息', '生成本地方案草稿和可复核文件', '核验文件路径、大小、版本和项目归属'],
    reviewRequiredActions: ['未核验尺寸和结构机电条件', '最终方案和报价', '覆盖源图', '版权素材使用', '客户交付与专业签认'],
    entries: {
      project: { displayName: '设计项目', summary: '绑定项目 Brief 与资料，形成范围、方向、风险和下一步。', routingTerms: ['设计项目', '项目 brief', '设计需求', '空间方案', '项目方案', 'design project', 'project brief'] },
      cad: { displayName: 'CAD 方案', summary: '基于已核验源图和几何生成 CAD 成果，并验证几何与文件。', routingTerms: ['cad 方案', 'cad图', 'cad 图', 'dwg', 'dxf', '施工图', '平面图', 'cad scheme', 'cad drawing'] },
      visualization: { displayName: '效果图', summary: '基于确认的布局、相机、材质和灯光生成并归档真实图像。', routingTerms: ['效果图', '室内渲染', '空间渲染', '设计效果', 'rendering', 'visualization', 'render image'] },
      presentation: { displayName: '提案 PPT', summary: '从已核验项目事实生成、渲染检查并归档提案文件。', routingTerms: ['提案 ppt', '方案 ppt', '设计汇报', '汇报 ppt', 'proposal ppt', 'proposal presentation'] },
      handoff: { displayName: '交付中心', summary: '汇集图纸、清单、视觉成果与说明，检查完整性和版本。', routingTerms: ['交付中心', '设计交付', '交付包', '图纸交付', '项目交付', 'handoff', 'delivery package'] },
    },
  },
  legal: {
    positioning: '面向律师和法律团队的案件交付智能体，所有结论保留事实、证据、法源、时效与律师复核边界。',
    automaticActions: ['整理案件与材料', '生成内部文书和研究草稿', '检索已授权法源与类案', '归档证据、引用、版本和核验记录'],
    reviewRequiredActions: ['法律结论和正式法律意见', '签署、立案、付款和报送', '客户外发与正式交付', '任何需要执业律师承担责任的决定'],
    entries: {
      workspace: { displayName: '案件工作台', summary: '统一案件事实、证据、争点、材料、状态和下一步。', routingTerms: ['案件工作台', '新建案件', '案件整理', '案件状态', '案件材料', 'case workspace', 'case intake'] },
      packet: { displayName: '文书生成', summary: '基于当前案件生成可复核文书并保留版本和引用。', routingTerms: ['文书生成', '起诉状', '答辩状', '代理词', '法律意见书', '法律文书', 'legal document', 'litigation packet'] },
      'contract-review': {
        displayName: '合同审查',
        summary: '识别条款风险、法律依据和修改建议，保留复核记录。',
        routingTerms: ['合同审查', '审合同', '审核合同', '协议审查', '合同风险', '条款审查', '合同修改', 'contract review'],
        routingPatterns: [
          /(?:审查|审核|检查|复核|修改|看(?:一下|一看)?).{0,10}(?:合同|协议)|(?:合同|协议).{0,10}(?:审查|审核|检查|复核|风险|条款|修改)/u,
        ],
      },
      research: { displayName: '法条与类案', summary: '检索现行法源和相似案例，记录来源、日期、适用范围与不确定性。', routingTerms: ['法条与类案', '类案检索', '法条检索', '法律研究', '司法案例', 'law and cases', 'legal research'] },
      'asset-trace': { displayName: '财产线索', summary: '整理公开财产与主体线索，标记证据等级和人工核验项。', routingTerms: ['财产线索', '被执行人财产', '股权穿透', '执行线索', '查财产', 'asset trace', 'asset clues'] },
      verify: { displayName: '交付核验', summary: '核验事实、引用、时效、管辖、文件和律师复核状态。', routingTerms: ['交付核验', '引用核验', '法条核验', '文书核验', '交付检查', 'delivery verification', 'citation verification'] },
      bid: { displayName: '标书制作', summary: '形成响应矩阵、缺口清单和可复核标书文件。', routingTerms: ['标书制作', '投标书', '法律服务标书', '投标文件', 'bid production', 'tender document'] },
    },
  },
  finance: {
    positioning: '面向企业财务与税务工作的轻量智能体，优先处理票税、账务、申报准备、资金风险和报表交付，不默认承担证券行情或交易任务。',
    automaticActions: ['读取已授权账簿、票据、银行和业务资料', '执行可审计计算、核对和异常识别', '生成本地财税底稿、清单和报表草稿', '归档来源、期间、币种、口径和复核状态'],
    reviewRequiredActions: ['税率、会计政策和申报口径判断', '记账过账和账套变更', '申报、报送、付款、签署和资金移动', '对外报告与专业结论'],
    optionalExtensions: [
      { id: 'market-research', label: '证券行情研究', defaultEnabled: false },
      { id: 'paper-trading', label: '模拟交易', defaultEnabled: false },
    ],
    entries: {
      'business-dashboard': { displayName: '经营看板', summary: '汇总收入、利润、费用、现金和预算差异，输出经营异常与行动清单。', routingTerms: ['经营看板', '财务经营分析', '管理报表', '利润分析', '预算差异', 'business dashboard', 'management report'] },
      'invoice-tax': { displayName: '票税管理', summary: '核验发票、税负和异常，形成带依据的复核底稿。', routingTerms: ['票税管理', '发票管理', '发票核验', '税负测算', '进销项', 'invoice tax', 'invoice review'] },
      accounting: {
        displayName: '账务处理',
        summary: '核对总账、明细账、银行和往来，输出差异与处理建议，不自动过账。',
        routingTerms: ['账务处理', '账务资料', '财务核账', '账簿核对', '总账核对', '银行对账', '应收应付', '会计处理', '对账', 'accounting', 'ledger reconciliation'],
        routingPatterns: [
          /(?:处理|整理|核对|复核|检查|分析).{0,10}(?:账务|账簿|总账|明细账|流水|往来|对账)|(?:账务|账簿|总账|明细账|流水|往来).{0,10}(?:处理|整理|核对|复核|检查|分析|差异)/u,
        ],
      },
      'tax-filing': { displayName: '税务申报', summary: '按辖区、纳税人、税种和期间准备待复核申报清单与文件包。', routingTerms: ['税务申报', '纳税申报', '报税', '申报资料', '税务申报表', 'tax filing', 'tax return'] },
      'cash-risk': { displayName: '资金与风险', summary: '预测现金流、往来集中度和缺口，输出多情景风险预警。', routingTerms: ['资金与风险', '现金流预测', '资金风险', '现金缺口', '应收风险', 'cash risk', 'cash forecast'] },
      'report-delivery': { displayName: '报表交付', summary: '核验报表勾稽关系并生成可打开、可追溯的财税交付文件。', routingTerms: ['报表交付', '财务报表', '报表核验', '财税报告', '交付报表', 'report delivery', 'financial statement'] },
    },
  },
};

function currentProductLine(): IndustryProductLine | null {
  return normalizeIndustryProductLine(PRODUCT_VARIANT.productLine);
}

function normalizeText(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[\s\-_—–/\\]+/g, ' ').trim();
}

export function getCurrentIndustryCapabilityProfile(): IndustryCapabilityProfile | null {
  const productLine = currentProductLine();
  if (!productLine) return null;
  const copy = PROFILE_COPY[productLine];
  const contracts = getIndustryWorkflowContracts(productLine);
  return {
    schemaVersion: 1,
    variantId: PRODUCT_VARIANT.variantId,
    displayName: PRODUCT_VARIANT.displayName,
    productLine,
    positioning: copy.positioning,
    automaticActions: [...copy.automaticActions],
    reviewRequiredActions: [...copy.reviewRequiredActions],
    optionalExtensions: [...(copy.optionalExtensions || [])],
    entries: contracts.map(contract => {
      const entryCopy = copy.entries[contract.entryId];
      if (!entryCopy) throw new Error(`Missing industry capability copy: ${productLine}/${contract.entryId}`);
      return {
        entryId: contract.entryId,
        displayName: entryCopy.displayName,
        summary: entryCopy.summary,
        routingTerms: Array.from(new Set([entryCopy.displayName, contract.title, ...entryCopy.routingTerms])),
        automationLevel: entryCopy.automationLevel || (contract.requiresFileArtifact ? 'review_required' : 'automatic'),
        contract,
      };
    }),
  };
}

export function matchCurrentIndustryWorkflow(text: unknown): IndustryWorkflowMatch | null {
  const profile = getCurrentIndustryCapabilityProfile();
  const normalized = normalizeText(text);
  if (!profile || !normalized) return null;

  const candidates = profile.entries.map(entry => {
    const matchedTerms: string[] = [];
    let score = 0;
    for (const rawTerm of entry.routingTerms) {
      const term = normalizeText(rawTerm);
      if (!term || !normalized.includes(term)) continue;
      matchedTerms.push(rawTerm);
      score += normalized === term ? 100 : 18 + Math.min(term.length, 16);
    }
    const semanticPatterns = PROFILE_COPY[profile.productLine].entries[entry.entryId]?.routingPatterns || [];
    if (semanticPatterns.some(pattern => pattern.test(normalized))) {
      matchedTerms.push(`semantic:${entry.entryId}`);
      score += 42;
    }
    return { profile, entry, score, matchedTerms };
  }).filter(candidate => candidate.score >= 20)
    .sort((left, right) => right.score - left.score || right.matchedTerms.length - left.matchedTerms.length);

  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
  return candidates[0];
}

export function isCurrentIndustryWorkflowExecutionRequest(text: unknown): boolean {
  const normalized = String(text || '').trim();
  if (!matchCurrentIndustryWorkflow(normalized)) return false;
  if (/(?:是什么|有哪些|能做什么|会做什么|怎么用|如何使用|介绍一下|支持吗|能不能|可不可以|可以吗|会不会|为什么|怎么回事|做完了吗|完成了吗|好了吗|进度|状态|结果呢|what\s+(?:is|are|can)|how\s+(?:to|do|does)|can\s+(?:you|it)|status|progress)[？?。.!！]*$/iu.test(normalized)) return false;
  return /(?:请|帮我|给我|替我|开始|启动|继续|执行|处理|整理|生成|制作|创建|输出|分析|汇总|核对|检查|审查|审核|检索|查找|查一下|查一查|预测|准备|导入|归档|做一|做个|做份|做一下|看一下|看一看|算一下|算一算|review|analy[sz]e|generate|create|prepare|start|run|check|audit|draft|build|produce|reconcile|forecast|file)/iu.test(normalized);
}

export function formatIndustryCapabilityProfilePrompt(text?: unknown): string {
  const profile = getCurrentIndustryCapabilityProfile();
  if (!profile) return '';
  const match = text == null ? null : matchCurrentIndustryWorkflow(text);
  return [
    '## Industry Variant Capability Profile (authoritative)',
    `Identity: ${profile.displayName}; variant=${profile.variantId}; productLine=${profile.productLine}.`,
    `Positioning: ${profile.positioning}`,
    'Outcome workspaces:',
    ...profile.entries.map(entry => `- ${entry.displayName} [${entry.entryId}/${entry.automationLevel}]: ${entry.summary}`),
    `Automatic preparation: ${profile.automaticActions.join('; ')}.`,
    `Professional review or confirmation boundary: ${profile.reviewRequiredActions.join('; ')}.`,
    profile.optionalExtensions.length
      ? `Optional non-default extensions: ${profile.optionalExtensions.map(item => `${item.label}(${item.id})`).join(', ')}. Do not route ordinary ${profile.productLine} work to these extensions unless the user explicitly asks for them.`
      : '',
    match
      ? `Current request matches ${match.entry.displayName} [${match.entry.entryId}] from terms: ${match.matchedTerms.join(', ')}.`
      : '',
    match
      ? `When this is an execution request and no existing industry task is named, call industry_workflow_start exactly once with entryId=${match.entry.entryId}. The server binds the current request from trusted turn context; never copy raw business text into tool arguments. Continue the returned task with real domain tools and verify it before claiming completion.`
      : 'For an industry execution request, select exactly one matching outcome workspace. If the target is genuinely ambiguous, ask one short clarification instead of creating multiple tasks.',
    'If a wt_task_* industry task is already named, continue that task and never create a duplicate. Capability questions and self-introductions explain this profile without starting tools.',
    'Automatic means local reading, analysis, preparation and archival inside the stated scope. It never bypasses the confirmation boundary or turns a draft/model statement into proof of external completion.',
  ].filter(Boolean).join('\n');
}

export function formatIndustryWorkflowRoutingPrompt(text: unknown): string {
  if (!isCurrentIndustryWorkflowExecutionRequest(text)) return '';
  const match = matchCurrentIndustryWorkflow(text);
  if (!match) return '';
  return [
    '## Industry Workflow Route',
    `The current request matches this edition's ${match.entry.displayName} outcome workspace [${match.entry.entryId}].`,
    `Matched terms: ${match.matchedTerms.join(', ')}.`,
    `Start exactly one persistent task with industry_workflow_start(entryId=${match.entry.entryId}). The server binds and hashes the current request; do not copy raw business text into tool arguments.`,
    'Then use real domain capabilities. Before claiming completion, call industry_workflow_complete with the returned task id; it will bind current-turn tool receipts and run the server verifier.',
    `Confirmation boundary: ${match.entry.contract.confirmationBoundaries.join(' ')}`,
    'If an existing wt_task_* id is already present, continue it instead of starting another task. If the user is only asking about capability, explain the profile and do not execute tools.',
  ].join('\n');
}
