export type IndustrySettingsLanguage = 'zh' | 'en';

type IndustryCopy = {
  title: string;
  description: string;
  connectionTitle: string;
  connectionDescription: string;
  boundaries: string[];
};

const COMMON = {
  zh: {
    industryTab: '行业配置',
    coreTab: 'Lumi 基础设置',
    corePreserved: '完整的模型、语音、记忆、工具、设备、隐私与安全设置均保留在 Lumi 基础设置中。',
    skillsTitle: '默认行业技能',
    modulesTitle: '交付模块',
    approvalTitle: '人工确认边界',
    refresh: '刷新连接',
    connected: '已连接',
    disconnected: '未连接',
    notConfigured: '尚未配置匹配的行业连接',
    loading: '检测中',
  },
  en: {
    industryTab: 'Industry setup',
    coreTab: 'Lumi settings',
    corePreserved: 'The complete Lumi model, voice, memory, tools, devices, privacy, and security settings remain available.',
    skillsTitle: 'Default industry skills',
    modulesTitle: 'Delivery modules',
    approvalTitle: 'Human approval boundary',
    refresh: 'Refresh connections',
    connected: 'Connected',
    disconnected: 'Disconnected',
    notConfigured: 'No matching industry connection configured',
    loading: 'Checking',
  },
} as const;

const INDUSTRIES: Record<string, Record<IndustrySettingsLanguage, IndustryCopy>> = {
  ecommerce: {
    zh: {
      title: '电商业务配置',
      description: '连接经营数据、店铺工具与客服渠道，Lumi 通用能力继续保持可用。',
      connectionTitle: '电商平台与运营工具',
      connectionDescription: '读取电商、商城、浏览器自动化及客服相关 MCP 的真实运行状态。',
      boundaries: ['上架、下架、改价和发布', '客户发送、退款、赔付和订单修改', '投放预算、采购和外部授权'],
    },
    en: {
      title: 'Commerce setup',
      description: 'Connect operating data, store tools, and support channels while retaining Lumi core capabilities.',
      connectionTitle: 'Commerce platforms and tools',
      connectionDescription: 'Reads live MCP health for commerce, marketplace, browser automation, and support runtimes.',
      boundaries: ['Listing, delisting, repricing, and publishing', 'Customer sends, refunds, compensation, and order edits', 'Ad budgets, sourcing, and external authorization'],
    },
  },
  design: {
    zh: {
      title: '设计业务配置',
      description: '连接 CAD、渲染和设计交付工具，保留 Lumi 的完整通用工作能力。',
      connectionTitle: '设计与制图工具',
      connectionDescription: '读取 CAD、设计、渲染、图像及演示相关 MCP 的真实运行状态。',
      boundaries: ['覆盖源图、模型和正式交付文件', '向客户发送方案、报价或承诺', '发布、采购及外部平台提交'],
    },
    en: {
      title: 'Design setup',
      description: 'Connect CAD, rendering, and delivery tools while retaining the complete Lumi foundation.',
      connectionTitle: 'Design and drafting tools',
      connectionDescription: 'Reads live MCP health for CAD, design, rendering, image, and presentation runtimes.',
      boundaries: ['Overwriting source drawings, models, and final deliverables', 'Sending proposals, quotations, or commitments', 'Publishing, purchasing, and external submissions'],
    },
  },
  legal: {
    zh: {
      title: '法律业务配置',
      description: '连接案件资料、权威法源和交付工具，保留 Lumi 的完整通用能力。',
      connectionTitle: '法律资料与办案工具',
      connectionDescription: '读取法律检索、文档、浏览器和案件工具 MCP 的真实运行状态。',
      boundaries: ['向法院、客户或第三方发送材料', '提交、签署、立案及对外承诺', '删除案卷、覆盖原件和改变案件事实'],
    },
    en: {
      title: 'Legal setup',
      description: 'Connect case materials, authoritative sources, and delivery tools while retaining Lumi core capabilities.',
      connectionTitle: 'Legal sources and case tools',
      connectionDescription: 'Reads live MCP health for legal research, documents, browsers, and casework runtimes.',
      boundaries: ['Sending materials to courts, clients, or third parties', 'Submission, signature, filing, and external commitments', 'Deleting case files, overwriting originals, or changing case facts'],
    },
  },
  finance: {
    zh: {
      title: '财税业务配置',
      description: '连接账务、票税、申报和报表工具，保留 Lumi 的完整通用能力。',
      connectionTitle: '财税数据与办公工具',
      connectionDescription: '读取财税、发票、表格、办公和银行相关 MCP 的真实运行状态。',
      boundaries: ['申报、缴税、付款和银行操作', '记账入账、冲销及修改正式账簿', '向客户、税局或第三方提交报表'],
    },
    en: {
      title: 'Finance and tax setup',
      description: 'Connect accounting, invoice, filing, and reporting tools while retaining Lumi core capabilities.',
      connectionTitle: 'Finance data and office tools',
      connectionDescription: 'Reads live MCP health for finance, tax, invoices, spreadsheets, office, and banking runtimes.',
      boundaries: ['Tax filing, payment, and banking operations', 'Posting, reversal, and formal ledger changes', 'Submitting reports to clients, tax authorities, or third parties'],
    },
  },
};

export function industrySettingsCopy(productLine: string, language: IndustrySettingsLanguage) {
  const industry = INDUSTRIES[productLine]?.[language] || INDUSTRIES.ecommerce[language];
  return { ...COMMON[language], ...industry };
}
