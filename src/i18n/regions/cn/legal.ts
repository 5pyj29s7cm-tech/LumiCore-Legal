import { getLocale, type Locale } from '../../runtime';

export type ChinaLegalDataSourceId = 'qichacha' | 'tianyancha' | 'qixinbao' | 'tenderData' | 'pkulaw' | 'farui';
export type ChinaLegalBrowserSourceId =
  | 'fachan'
  | 'alpha'
  | 'wenshu'
  | 'courtCases'
  | 'enterpriseCredit'
  | 'qixinbao'
  | 'tianyancha'
  | 'enforcementDisclosure'
  | 'publicResources'
  | 'movableFinance'
  | 'intellectualProperty'
  | 'constructionQualifications'
  | 'customsCredit'
  | 'bankruptcyRestructuring';

export interface ChinaLegalDataSourceField {
  keyName: string;
  label: string;
  kind: 'secret' | 'url';
  placeholder: string;
  required?: boolean;
}

export interface ChinaLegalDataSourceDefinition {
  id: ChinaLegalDataSourceId;
  mode: 'api' | 'browser';
  fields: ChinaLegalDataSourceField[];
}

export const CHINA_LEGAL_DATA_SOURCES: ChinaLegalDataSourceDefinition[] = [
  {
    id: 'qichacha',
    mode: 'api',
    fields: [
      { keyName: 'QICHACHA_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'QICHACHA_API_KEY', required: true },
      { keyName: 'QICHACHA_APP_KEY', label: 'App Key', kind: 'secret', placeholder: 'QICHACHA_APP_KEY', required: true },
      { keyName: 'QICHACHA_SECRET_KEY', label: 'Secret Key', kind: 'secret', placeholder: 'QICHACHA_SECRET_KEY', required: true },
      { keyName: 'QICHACHA_BASE_URL', label: 'Base URL', kind: 'url', placeholder: 'https://api.qichacha.com' },
    ],
  },
  {
    id: 'tianyancha',
    mode: 'api',
    fields: [
      { keyName: 'TIANYANCHA_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'TIANYANCHA_API_KEY', required: true },
      { keyName: 'TIANYANCHA_BASE_URL', label: 'Base URL', kind: 'url', placeholder: 'https://open.api.tianyancha.com' },
    ],
  },
  {
    id: 'qixinbao',
    mode: 'api',
    fields: [
      { keyName: 'QIXINBAO_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'QIXINBAO_API_KEY', required: true },
      { keyName: 'QIXINBAO_BASE_URL', label: 'API Base URL', kind: 'url', placeholder: 'https://...', required: true },
    ],
  },
  {
    id: 'tenderData',
    mode: 'api',
    fields: [
      { keyName: 'TENDER_DATA_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'TENDER_DATA_API_KEY', required: true },
      { keyName: 'TENDER_DATA_BASE_URL', label: 'API Base URL', kind: 'url', placeholder: 'https://...', required: true },
    ],
  },
  {
    id: 'pkulaw',
    mode: 'api',
    fields: [
      { keyName: 'PKULAW_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'PKULAW_API_KEY' },
      { keyName: 'PKULAW_TOKEN', label: 'Token', kind: 'secret', placeholder: 'PKULAW_TOKEN' },
      { keyName: 'PKULAW_BASE_URL', label: 'API Base URL', kind: 'url', placeholder: 'https://...' },
      { keyName: 'PKULAW_MCP_URL', label: 'MCP URL', kind: 'url', placeholder: 'https://mcp.pkulaw.com/...' },
    ],
  },
  {
    id: 'farui',
    mode: 'api',
    fields: [
      { keyName: 'FARUI_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'FARUI_API_KEY', required: true },
      { keyName: 'FARUI_BASE_URL', label: 'Base URL', kind: 'url', placeholder: 'https://...', required: true },
    ],
  },
];

export const CHINA_LEGAL_BROWSER_SOURCE_IDS: ChinaLegalBrowserSourceId[] = [
  'fachan',
  'alpha',
  'wenshu',
  'courtCases',
  'enterpriseCredit',
  'qixinbao',
  'tianyancha',
  'enforcementDisclosure',
  'publicResources',
  'movableFinance',
  'intellectualProperty',
  'constructionQualifications',
  'customsCredit',
  'bankruptcyRestructuring',
];

const CHINA_LEGAL_COPY = {
  en: {
    material: 'Material',
    unnamedCase: 'Untitled case',
    clientPartyName: 'Represented client name',
    assetTraceCaseType: 'Enforcement / asset preservation',
    bidCaseType: 'Tender / bid response',
    contractReviewCaseType: 'Contract review',
    workspace: {
      usage: 'Usage',
      standalone: 'Standalone',
      linked: 'Linked',
      noCaseSelected: 'No case selected',
      standaloneResultNotice: 'Results from this run will not be saved to a case',
      legalResearch: 'Legal Research',
      caseFlow: 'Case flow',
      caseOverview: 'Case overview',
      advancedOptions: 'Advanced options',
      strategyAnalysis: 'Strategy analysis',
      documentCheck: 'Document review',
      documentCheckDesc: 'Check citations, supporting evidence and delivery conditions. Review the findings before external use.',
      citationOnly: 'Citations only',
      toolMode: 'Work content',
      documentSource: 'Document source',
      customText: 'Custom text',
      navigationHint: 'Use each tool as needed. Results remain on their tool pages; archived materials are managed in the overview.',
      selectMaterial: 'Select a material to read its full text or manage its case record.',
      standaloneLegalTools: 'Legal deliverables',
      caseWorkspace: 'Case workspace',
      documentGeneration: 'Document drafting',
      lawAndCases: 'Statutes & precedents',
      assetClues: 'Asset leads',
      deliveryVerification: 'Citation verification',
      bidProduction: 'Bid production',
      comicDramaCreation: 'Yijing AI Comic Drama',
      externalToolOpenFailed: 'Unable to open the external tool',
    },
    assetTraceWorkflow: {
      title: 'Enforcement asset investigation',
      description: 'Law-firm workflow: quick scan, enterprise 12-step / individual 10-step investigation, human verification, and case archiving.',
      frameworkBadge: 'Law-firm investigation framework',
      subjectName: 'Debtor / subject name',
      subjectPlaceholder: 'Enter an enterprise or individual debtor name',
      subjectType: 'Subject type',
      enterprise: 'Enterprise',
      individual: 'Individual',
      runMode: 'Investigation depth',
      quickMode: 'Quick scan',
      quickModeHint: 'Run source preflight and public-data scan first; decide whether deep investigation is justified.',
      deepMode: 'Deep investigation',
      deepModeHint: 'Continue into the enterprise 12-step or individual 10-step checklist after the quick scan.',
      claimAmount: 'Claim amount (optional)',
      terminationDate: 'Termination date (optional)',
      start: 'Start investigation',
      restart: 'Start over',
      executeNext: 'Run next step: {step}',
      startDeep: 'Start deep investigation',
      reviewStep: 'Review pending step: {step}',
      retryStep: 'Retry: {step}',
      executingStep: 'Running: {step}',
      stages: 'Investigation stages',
      quickProgress: 'Quick scan progress',
      deepProgress: 'Full investigation progress',
      nextStep: 'Next step: {step}',
      readyToContinue: 'Results are saved. Investigation steps remain to be run.',
      inProgress: 'The current step is running.',
      markComplete: 'Mark verified',
      skip: 'Skip for now',
      archive: 'Archive workflow report',
      archived: 'Investigation workflow report archived to the case.',
      archiveUnavailable: 'Open this tool from a case workflow to archive the report.',
      workflow: 'Workflow',
      report: 'Investigation report',
      company: 'Enterprise',
      enforcement: 'Enforcement',
      equity: 'Equity',
      raw: 'Raw results',
      companyFields: { name: 'Name', legalPerson: 'Legal representative', capital: 'Registered capital', status: 'Status', establishDate: 'Established', unifiedCode: 'Unified social credit code', paidInCapital: 'Paid-in capital', enterpriseType: 'Enterprise type', registrationAuthority: 'Registration authority' },
      sourceObserved: 'Source received',
      sourceMissing: 'Source required',
      noStructuredEnforcement: 'No verifiable structured enforcement details were supplied. Review the original source results.',
      noStructuredEquity: 'No verifiable structured shareholder details were supplied. Review the original source results.',
      directShareholders: {
        title: 'Direct shareholders', description: 'Look up the direct shareholders of the current enterprise.',
        query: 'Query direct shareholders', querying: 'Querying…', subject: 'Enterprise', received: 'Source received', incomplete: 'Query incomplete',
        count: '{count} shareholder records', name: 'Shareholder', ratio: 'Shareholding', shares: 'Shares', notProvided: 'Not supplied',
        source: 'Source', queriedAt: 'Queried at', original: 'Original source text', noDetails: 'The source did not provide structured shareholder details. Review the original result.',
      },
      quickStage: 'Quick scan',
      deepStage: 'Deep investigation',
      analysisStage: 'Review and action plan',
      restartConfirm: 'Start a new investigation and replace the currently saved workflow?',
      waitingInput: 'Enter a subject to create an investigation workflow.',
      noOutput: 'No result has been generated for this step.',
      manualNote: 'Verification note / source / finding',
      manualNotePlaceholder: 'Record the source, lookup date, key finding, evidence status, and next action before marking the step verified.',
      manualBoundary: 'This step requires an authorized account, a court investigation order, or lawyer verification. Lumi records and organizes the result but does not bypass access controls.',
      assistedBoundary: 'Lumi can prepare queries and an authorized browser handoff. A lawyer must confirm the result and record the source.',
      legalBoundary: 'Public clues are not proof of executable property. Sensitive personal data, court lookup systems, account submission, and compulsory measures require a lawful basis, authority, and lawyer review.',
      resumeHint: 'Progress is saved with the case. You can leave this page and continue later.',
      standaloneHint: 'Standalone progress is saved on this device. Link the tool to a case to share and archive it.',
      quickComplete: 'Quick scan completed. Start deep investigation to run the next step.',
      workflowComplete: 'All in-scope steps are completed or intentionally skipped. The report is ready to archive.',
      stepBlocked: 'Review the pending step or retry the failed step before continuing.',
      errorPrefix: 'Error',
      modeLabels: { automatic: 'Automatic', assisted: 'Assisted', manual: 'Manual verification' },
      statusLabels: { pending: 'Pending', running: 'Running', needs_action: 'Awaiting verification', completed: 'Completed', skipped: 'Skipped', failed: 'Failed' },
      reportLabels: {
        title: 'Enforcement asset investigation workflow report',
        subject: 'Subject',
        subjectType: 'Subject type',
        depth: 'Depth',
        claimAmount: 'Claim amount',
        terminationDate: 'Termination date',
        generatedAt: 'Generated at',
        conclusion: 'Workflow conclusion',
        timeline: 'Investigation steps and findings',
        nextActions: 'Outstanding actions',
        legalNote: 'Professional boundary',
        noValue: 'Not provided',
      },
      steps: {
        'source-preflight': { title: 'Data-source capability preflight', description: 'Confirm which sources have an authorized API, browser collaboration, or manual import path before making any query.' },
        'quick-scan': { title: 'Public-data quick scan', description: 'Collect baseline company, enforcement, dishonesty, and visible asset clues without treating the result as a final conclusion.' },
        'enterprise-company-profile': { title: '1. Company baseline profile', description: 'Verify registration, shareholders, controller, key personnel, changes, annual reports, paid-in contribution, and insured headcount across authorized sources.' },
        'enterprise-judicial-cases': { title: '2. Subject litigation records', description: 'Query the authorized case source using the supplied subject name and retain the original receipt and query time for party and case-scope review.' },
        'enterprise-web-footprint': { title: '3. Public web lead search', description: 'Search public pages for the supplied enterprise name and display retrieved titles, search snippets and source links. Same-name hits remain candidates; they do not establish relationships or ownership.' },
        'enterprise-related-parties': { title: '4. Actual-controller source query', description: 'Query the authorized provider’s actual-controller results. Preserve original names, proportions, source, and time for review.' },
        'enterprise-finance-tax': { title: '5. Finance and tax verification', description: 'Review contribution changes, headcount trends, taxpayer status, invoicing, and customer flows where a lawful query channel or investigation order exists.' },
        'enterprise-bids-receivables': { title: '6. Bids and receivables', description: 'Trace awards, project progress, purchasers, counterparties, and possible receivables; identify records requiring a court investigation order.' },
        'enterprise-timeline': { title: '7. Reconstruct the post-termination timeline', description: 'Organize changes after the terminal enforcement event to distinguish an old no-property finding from later operating or asset activity.' },
        'enterprise-movable-rights': { title: '8. Movables and registered rights', description: 'Verify receivables pledges/transfers, inventory or warehouse-receipt pledges, leases, deposits, retention of title, and other registered rights.' },
        'enterprise-intellectual-property': { title: '9. Intellectual property', description: 'Check trademarks, patents, software copyrights, domains, ownership, encumbrances, and registrations after the terminal enforcement event.' },
        'enterprise-licenses': { title: '10. Qualifications and permits', description: 'Verify construction, safety, environmental, food, certification, and special-equipment qualifications as evidence of operations or transferable economic value where legally permitted.' },
        'enterprise-customs': { title: '11. Import, export, and customs', description: 'Check customs registration, AEO status, B2B stores, shipment clues, and records that require an investigation order.' },
        'enterprise-auction-bankruptcy': { title: '12. Auctions, insolvency, and penalties', description: 'Search judicial auctions, insolvency/restructuring, tax violations, procurement restrictions, and other public regulatory clues.' },
        'individual-identity-companies': { title: '1. Identity and associated enterprises', description: 'Disambiguate the person by region and identifiers, then verify companies in which the person is a shareholder, controller, legal representative, or executive.' },
        'individual-property-vehicles': { title: '2. Real property and vehicles', description: 'Record public clues and items to request through the court network-control system or an investigation order; check suspicious transfers by date.' },
        'individual-income-social-security': { title: '3. Income and social security', description: 'Where legally authorized, verify employer, salary, social-security, housing-fund, rent, and dividend clues.' },
        'individual-online-footprint': { title: '4. Public web lead search', description: 'Search public pages for the supplied name and display retrieved titles, search snippets and source links. Same-name hits do not establish identity, property ownership or misconduct.' },
        'individual-family-holding': { title: '5. Family members and nominee holding', description: 'Only investigate family or nominee property when supported by a case-specific legal basis and a concrete transfer or ownership clue.' },
        'individual-financial-assets': { title: '6. Financial assets', description: 'Prepare lawful court-query items for bank, securities, insurance cash value, payment accounts, and housing-fund interests.' },
        'individual-rural-assets': { title: '7. Rural assets', description: 'Check lawful interests in homestead housing, contracted land, collective dividends, compensation, machinery, farms, and greenhouses.' },
        'individual-travel-activity': { title: '8. Travel and activity location', description: 'Use only lawfully available and case-relevant records to identify residence, business location, or enforceable property; do not infer misconduct from travel alone.' },
        'individual-business-household': { title: '9. Sole proprietorships and rural contractors', description: 'Verify registrations, business premises, stores, platform merchants, merchant settlement accounts, and tax clues.' },
        'individual-enforcement-rewards': { title: '10. Public enforcement leads', description: 'Query the authorized enforcement source using the supplied name and retain its original receipt for identity and scope review.' },
        'adversarial-review': { title: 'Adversarial asset-transfer review', description: 'Reason from the debtor side to identify plausible transfer, nominee-holding, related-company, receivables-diversion, digital-asset, or insurance paths; treat each as a hypothesis requiring evidence.' },
        'revocation-matrix': { title: 'Revocation and additional-liability matrix', description: 'Map each supported transaction clue to current legal grounds, elements, evidence gaps, limitation or exclusion periods, and the proposed procedural route. Current-law verification is mandatory.' },
        'enforcement-measures': { title: 'Procedure and enforcement-measure ladder', description: 'Rank restoration, preservation, investigation orders, participation in distribution, insolvency claims, restrictions, sanctions, and criminal referral by evidence threshold and proportionality.' },
        'final-action-plan': { title: 'Layered conclusion and action plan', description: 'Generate the final summary, timeline, clue list, evidence gaps, priority, deadlines, and concrete next actions from the verified workflow.' },
      },
    },
    dataSources: {
      qichacha: { label: 'Qichacha', boundary: 'Official MCP uses only API Key and the fixed provider endpoint. Existing saved keys are reused; no App ID or custom Base URL is required. MCP takes priority when configured.', legacyApi: 'Legacy Open API (separate product)', legacyBoundary: 'Only the legacy API requires App Key plus Secret Key; Base URL is optional. It is used only when no MCP API Key is configured.' },
      tianyancha: { label: 'Tianyancha', boundary: 'Official API integration for company profiles, registry records, and risk lookup.' },
      qixinbao: { label: 'Qixinbao', boundary: 'Configurable authorized API gateway for company profiles; when blank, use the signed-in website only.' },
      tenderData: { label: 'Tender data gateway', boundary: 'Configurable authorized tender/project data gateway; no endpoint or credential is assumed by default.' },
      pkulaw: { label: 'PKULaw', boundary: 'Authorized API or MCP gateway for statutes, cases, and legal authorities.' },
      farui: { label: 'Tongyi Farui', boundary: 'Explicit authorized gateway; requires FARUI_API_KEY and FARUI_BASE_URL for automatic lookup.' },
    },
    browserSources: {
      fachan: 'Fachan',
      alpha: 'Alpha',
      wenshu: 'China Judgments Online',
      courtCases: "People's Courts Case Database",
      enterpriseCredit: 'National Enterprise Credit Information Publicity System',
      qixinbao: 'Qixinbao',
      tianyancha: 'Tianyancha',
      enforcementDisclosure: 'China Enforcement Information Disclosure',
      publicResources: 'National Public Resources Trading Platform',
      movableFinance: 'Unified Movable Financing Registration System',
      intellectualProperty: 'CNIPA Public Service Platform',
      constructionQualifications: 'National Construction Market Supervision Platform',
      customsCredit: 'Customs Enterprise Credit Publicity Platform',
      bankruptcyRestructuring: 'National Enterprise Bankruptcy and Reorganization Case Information Network',
    },
    meeting: {
      title: 'Client meeting',
      case: 'Case',
      started: 'Started',
      ended: 'Ended',
      summary: 'Lumi meeting summary',
      noSummary: 'No summary is available.',
      transcript: 'Raw transcript',
      noTranscript: 'No transcript is available.',
      boundary: 'Professional boundary',
      boundaryText: 'This record assists legal analysis. A licensed lawyer must approve final legal advice and external documents.',
    },
  },
  zh: {
    material: '材料',
    unnamedCase: '未命名案件',
    clientPartyName: '我方委托人全称',
    assetTraceCaseType: '执行/财产保全',
    bidCaseType: '投标/招标文件响应',
    contractReviewCaseType: '合同审查',
    workspace: {
      usage: '使用方式',
      standalone: '独立使用',
      linked: '已关联',
      noCaseSelected: '未选择案件',
      standaloneResultNotice: '本次结果不会写入任何案件',
      legalResearch: '法律检索',
      caseFlow: '案件办理',
      caseOverview: '案件总览',
      advancedOptions: '高级选项',
      strategyAnalysis: '策略分析',
      documentCheck: '文书核验',
      documentCheckDesc: '核对文书引用、证据依据和交付条件，核验结果由承办人确认。',
      citationOnly: '仅检查引用',
      toolMode: '工作内容',
      documentSource: '文书来源',
      customText: '自行填写正文',
      navigationHint: '各环节按需办理，无需依次执行；结果保留在对应功能页，已归档材料在总览统一管理。',
      selectMaterial: '选择一份材料查看全文、记录复核或从案件移除。',
      standaloneLegalTools: '法律成果入口',
      caseWorkspace: '案件工作台',
      documentGeneration: '文书生成',
      lawAndCases: '法条与类案',
      assetClues: '财产线索',
      deliveryVerification: '引用校验',
      bidProduction: '标书制作',
      comicDramaCreation: '一镜AI漫剧',
      externalToolOpenFailed: '无法打开外部工具',
    },
    assetTraceWorkflow: {
      title: '执行财产线索调查',
      description: '按律所框架执行：快速扫描、企业12步/个人10步、人工核验与案件归档。',
      frameworkBadge: '律所调查框架',
      subjectName: '被执行人/调查主体',
      subjectPlaceholder: '输入企业或个人被执行人名称',
      subjectType: '主体类型',
      enterprise: '企业',
      individual: '个人',
      runMode: '调查深度',
      quickMode: '快速扫描',
      quickModeHint: '先预检数据源并扫描公开线索，再判断是否值得启动深度调查。',
      deepMode: '深度调查',
      deepModeHint: '快速扫描后继续执行企业12步或个人10步调查清单。',
      claimAmount: '执行标的额（选填）',
      terminationDate: '终本日期（选填）',
      start: '开始调查',
      restart: '重新调查',
      executeNext: '执行下一步：{step}',
      startDeep: '开始深度调查',
      reviewStep: '查看待办：{step}',
      retryStep: '重试：{step}',
      executingStep: '正在执行：{step}',
      stages: '调查阶段',
      quickProgress: '快速扫描进度',
      deepProgress: '完整调查进度',
      nextStep: '下一步：{step}',
      readyToContinue: '已有结果已保存，尚有调查步骤待执行。',
      inProgress: '当前步骤正在执行。',
      markComplete: '标记已核验',
      skip: '暂时跳过',
      archive: '归档调查报告',
      archived: '调查流程报告已归档到案件。',
      archiveUnavailable: '请从案件工作流进入本工具后再归档报告。',
      workflow: '调查流程',
      report: '调查报告',
      company: '企业信息',
      enforcement: '执行信息',
      equity: '股权结构',
      raw: '原始结果',
      companyFields: { name: '名称', legalPerson: '法定代表人', capital: '注册资本', status: '状态', establishDate: '成立日期', unifiedCode: '统一社会信用代码', paidInCapital: '实缴资本', enterpriseType: '企业类型', registrationAuthority: '登记机关' },
      sourceObserved: '已取得来源',
      sourceMissing: '待补来源',
      noStructuredEnforcement: '未提供可核对的结构化执行明细，请查看原始来源结果。',
      noStructuredEquity: '未提供可核对的结构化股东明细，请查看原始来源结果。',
      directShareholders: {
        title: '直接股东', description: '按当前企业名称单独查询一层直接股东。',
        query: '查询直接股东', querying: '正在查询…', subject: '企业名称', received: '已取得来源', incomplete: '本次查询未完成',
        count: '共 {count} 条股东记录', name: '股东名称', ratio: '持股比例', shares: '持股数', notProvided: '未提供',
        source: '来源', queriedAt: '查询时间', original: '原始来源全文', noDetails: '来源未提供结构化股东明细，请查看原始结果。',
      },
      quickStage: '快速扫描',
      deepStage: '深度调查',
      analysisStage: '复核与行动方案',
      restartConfirm: '重新开始会替换当前已保存的调查流程，是否继续？',
      waitingInput: '输入调查主体后即可建立可继续的调查流程。',
      noOutput: '本步骤尚未产生结果。',
      manualNote: '核验记录 / 来源 / 发现',
      manualNotePlaceholder: '填写查询来源、查询日期、关键发现、证据状态和下一步，再标记已核验。',
      manualBoundary: '本步骤需要授权账号、法院调查令或律师人工核验。Lumi 负责记录和整理，不绕过权限控制。',
      assistedBoundary: 'Lumi 可生成检索词和授权网页登录交接单，结果仍需律师确认并登记来源。',
      legalBoundary: '公开线索不等于可供执行财产证明。个人敏感信息、法院查控、账号提交及强制措施必须具备合法依据和授权，并由律师复核。',
      resumeHint: '进度已随案件保存，离开本页后仍可继续。',
      standaloneHint: '独立使用的进度仅保存在本机；关联案件后才能共享和归档。',
      quickComplete: '快速扫描已完成，可继续执行深度调查。',
      workflowComplete: '范围内步骤均已完成或明确跳过，可以归档调查报告。',
      stepBlocked: '请先处理当前待办或重试失败步骤，再继续调查。',
      errorPrefix: '错误',
      modeLabels: { automatic: '自动执行', assisted: '协作执行', manual: '人工核验' },
      statusLabels: { pending: '待执行', running: '执行中', needs_action: '待核验', completed: '已完成', skipped: '已跳过', failed: '失败' },
      reportLabels: {
        title: '执行财产线索调查流程报告',
        subject: '调查主体',
        subjectType: '主体类型',
        depth: '调查深度',
        claimAmount: '执行标的额',
        terminationDate: '终本日期',
        generatedAt: '生成时间',
        conclusion: '流程结论',
        timeline: '调查步骤与发现',
        nextActions: '待办事项',
        legalNote: '专业边界',
        noValue: '未填写',
      },
      steps: {
        'source-preflight': { title: '数据源能力预检', description: '查询前确认各数据源是授权 API、网页登录协作还是人工导入，避免把未接入的平台误当成自动能力。' },
        'quick-scan': { title: '公开信息快速扫描', description: '采集工商、公开执行、失信及可见财产线索，只形成初筛结果，不直接等同于最终执行结论。' },
        'enterprise-company-profile': { title: '第1步 工商基础画像', description: '通过已授权来源核验工商登记、股东、实控人、主要人员、变更、年报、实缴与参保情况。' },
        'enterprise-judicial-cases': { title: '第2步 主体涉诉案件查询', description: '按主体名称查询已授权案件来源，保留原始回执和查询时间，核对当事人及案件范围。' },
        'enterprise-web-footprint': { title: '第3步 公开网络线索检索', description: '按企业名称检索公开网页，展示实际标题、搜索摘要和原文链接。同名命中仅作候选，不据此认定关联或资产归属。' },
        'enterprise-related-parties': { title: '第4步 实控人穿透查询', description: '查询已授权来源的实控人结果，保留提供方原始名称、比例、来源和查询时间。' },
        'enterprise-finance-tax': { title: '第5步 财务与税务核验', description: '在具备合法查询通道或调查令时，核验实缴变化、参保趋势、纳税资质、开票及客户资金流向。' },
        'enterprise-bids-receivables': { title: '第6步 招投标与应收款', description: '追踪中标、项目进度、采购方、交易对手及潜在应收款，并标记需要法院调查令的记录。' },
        'enterprise-timeline': { title: '第7步 终本后时间线重建', description: '整理终本后发生的变化，区分历史无财产结论与其后的经营、资金或资产活动。' },
        'enterprise-movable-rights': { title: '第8步 动产与权利登记', description: '核验应收账款质押/转让、存货或仓单质押、融资租赁、保证金、所有权保留等登记。' },
        'enterprise-intellectual-property': { title: '第9步 知识产权', description: '核验商标、专利、软件著作权、域名的权属、负担及终本后的新增登记。' },
        'enterprise-licenses': { title: '第10步 行业资质与许可证', description: '核验建筑、安全、环保、食品、认证、特种设备等资质，作为持续经营或依法可处分经济价值的线索。' },
        'enterprise-customs': { title: '第11步 进出口与海关', description: '核验海关备案、AEO、B2B店铺、运输线索，以及需要调查令获取的报关记录。' },
        'enterprise-auction-bankruptcy': { title: '第12步 拍卖、破产与监管处罚', description: '检索司法拍卖、破产重整、税收违法、政府采购限制及其他公开监管线索。' },
        'individual-identity-companies': { title: '第1步 身份与关联企业', description: '结合地区和身份要素排除同名，并核验其担任股东、实控人、法人或高管的企业。' },
        'individual-property-vehicles': { title: '第2步 不动产与车辆', description: '记录公开线索及拟申请法院网络查控/调查令的事项，并按时间核验可疑转让。' },
        'individual-income-social-security': { title: '第3步 收入与社保', description: '在合法授权范围内核验工作单位、工资、社保、公积金、租金与分红线索。' },
        'individual-online-footprint': { title: '第4步 公开网络线索检索', description: '按已提供的姓名检索公开网页，展示实际标题、搜索摘要和原文链接；同名命中不能直接确认身份、资产归属或违规行为。' },
        'individual-family-holding': { title: '第5步 家庭成员与代持', description: '仅在存在具体转移或权属线索及案件法律依据时，调查亲属或代持财产。' },
        'individual-financial-assets': { title: '第6步 金融资产', description: '整理银行、证券、保险现金价值、支付账户与公积金权益的合法法院查询事项。' },
        'individual-rural-assets': { title: '第7步 农村资产', description: '核验宅基地房屋、承包经营权、集体分红、征收补偿、农机、养殖场与大棚等合法权益。' },
        'individual-travel-activity': { title: '第8步 出行与活动地', description: '仅使用合法且与案件相关的记录定位住所、经营地或可执行财产，不以出行本身推定违法。' },
        'individual-business-household': { title: '第9步 个体工商户与农村承包户', description: '核验工商登记、经营场所、门店、平台商户、结算账户与纳税线索。' },
        'individual-enforcement-rewards': { title: '第10步 公开执行线索查询', description: '按已提供的姓名查询授权公开执行来源，保留原始回执，供核对主体身份和查询范围。' },
        'adversarial-review': { title: '对抗式资产转移反推', description: '从债务人视角提出转让、代持、关联公司、应收款截流、数字资产或保险等可能路径；全部仅作为待取证假设。' },
        'revocation-matrix': { title: '撤销权与追加责任矩阵', description: '把已支持的交易线索对应到现行法律依据、构成要件、证据缺口、诉讼时效或除斥期间及程序路径，并强制核验法条效力。' },
        'enforcement-measures': { title: '程序策略与执行措施阶梯', description: '按证据门槛和比例原则排序恢复执行、保全、调查令、参与分配、破产申报、限制措施、制裁及刑事移送。' },
        'final-action-plan': { title: '分层结论与行动方案', description: '根据已核验流程生成结论摘要、时间线、线索清单、证据缺口、优先级、期限和下一步动作。' },
      },
    },
    dataSources: {
      qichacha: { label: '企查查', boundary: '官方 MCP 只需 API Key，使用固定官方端点；直接复用已保存密钥，无需 App ID 或自填 Base URL。已配置 MCP 时优先使用。', legacyApi: '旧版开放 API（另一产品）', legacyBoundary: '仅旧版 API 需要 App Key 与 Secret Key，Base URL 可选；只有未配置 MCP API Key 时使用。' },
      tianyancha: { label: '天眼查', boundary: '官方 API 接入；用于企业主体、工商和风险信息查询。' },
      qixinbao: { label: '启信宝', boundary: '预留授权 API 网关；接口和凭证为空时仅使用已登录网页协作，不假定供应商接口。' },
      tenderData: { label: '招投标数据网关', boundary: '预留律所采购的招投标/项目数据接口；未填写端点和凭证时只生成官方网页核验清单。' },
      pkulaw: { label: '北大法宝', boundary: '授权 API/MCP 网关；用于法规、案例和法条依据检索。' },
      farui: { label: '通义法睿', boundary: '显式授权网关；必须配置 FARUI_API_KEY 和 FARUI_BASE_URL 才会自动查询。' },
    },
    browserSources: {
      fachan: '法蝉',
      alpha: 'Alpha',
      wenshu: '中国裁判文书网',
      courtCases: '人民法院案例库',
      enterpriseCredit: '国家企业信用信息公示系统',
      qixinbao: '启信宝',
      tianyancha: '天眼查',
      enforcementDisclosure: '中国执行信息公开网',
      publicResources: '全国公共资源交易平台',
      movableFinance: '动产融资统一登记公示系统',
      intellectualProperty: '国家知识产权公共服务平台',
      constructionQualifications: '全国建筑市场监管公共服务平台',
      customsCredit: '海关企业信用信息公示平台',
      bankruptcyRestructuring: '全国企业破产重整案件信息网',
    },
    meeting: {
      title: '当事人会谈',
      case: '案件',
      started: '开始',
      ended: '结束',
      summary: 'Lumi 会谈整理',
      noSummary: '暂无整理结果。',
      transcript: '原始转写',
      noTranscript: '暂无转写。',
      boundary: '安全边界',
      boundaryText: '本记录用于辅助律师分析，最终法律意见与对外文书由执业律师确认。',
    },
  },
} as const;

export function chinaLegalCopy(locale: Locale = getLocale()) {
  return CHINA_LEGAL_COPY[locale];
}

export const CHINA_LEGAL_TOOL_COPY = {
  noticeLinkMaterial: '短信/法院通知链接材料',
  clientOrParty: '委托人/当事人',
  party: '当事人',
  sparseEngagementFacts: '当前案件档案信息较少，请生成通用委托书/代理手续草稿。',
  engagementClaim: '生成律师委托/代理手续草稿，包含委托事项、授权范围、费用/风险提示占位、双方信息、签署栏和附件清单。',
  sparseReasoningFacts: '当前案件材料较少，请先形成可复核的三段论分析框架，并列出待补事实、证据和法源。',
} as const;

export function buildChinaLegalCaseProfile(caseFile: any, stageLabel: string): string {
  return [
    caseFile?.title && `案件名称：${caseFile.title}`,
    caseFile?.caseNumber && `案号：${caseFile.caseNumber}`,
    caseFile?.party && `当事人：${caseFile.party}`,
    caseFile?.cause && `案由：${caseFile.cause}`,
    caseFile?.court && `法院：${caseFile.court}`,
    caseFile?.judge && `承办法官：${caseFile.judge}`,
    caseFile?.stage && `阶段：${stageLabel || caseFile.stage}`,
    caseFile?.notes && `事实摘要/待补材料：\n${caseFile.notes}`,
    Array.isArray(caseFile?.materials) && caseFile.materials.length > 0
      && `已归档材料：\n${caseFile.materials.slice(0, 8).map((item: any) => `- ${item.title}（${item.type}）`).join('\n')}`,
  ].filter(Boolean).join('\n');
}

export function inferChinaLegalDocumentType(title: string, type?: string): string {
  if (/起诉状|complaint/i.test(title)) return '起诉状';
  if (/答辩状|answer|defen[cs]e/i.test(title)) return '答辩状';
  if (/质证|evidence\s+objection/i.test(title)) return '质证意见';
  if (/代理词|argument/i.test(title)) return '代理词';
  if (/法律意见|legal\s+(?:opinion|memo)/i.test(title)) return '法律意见书';
  if (/合同|contract/i.test(title) || type === 'contract') return '合同文本';
  if (/标书|投标|tender|bid/i.test(title)) return '投标书';
  if (/证据目录|evidence\s+(?:index|catalog)/i.test(title) || type === 'evidence') return '证据目录';
  return '法律工作底稿';
}

export interface ChinaCaseSearchResult {
  articleId: string;
  title: string;
  caseNumber?: string;
  court?: string;
  chunk: string;
  score: number;
  date?: string;
}

export function parseChinaCaseSearchResults(text: string): ChinaCaseSearchResult[] {
  const parsed: ChinaCaseSearchResult[] = [];
  let current: Partial<ChinaCaseSearchResult> = {};
  for (const line of text.split('\n')) {
    const titleMatch = line.match(/^\d+\.\s*\*\*(.+?)\*\*\s*(?:\[(?:相似度|Similarity)[:：]\s*([\d.]+)\])?/i);
    if (titleMatch) {
      if (current.title) parsed.push(current as ChinaCaseSearchResult);
      current = { title: titleMatch[1].trim(), score: titleMatch[2] ? Number.parseFloat(titleMatch[2]) : 0, articleId: '', chunk: '' };
      continue;
    }
    const caseNumber = line.match(/(?:案号|Case\s*(?:number|no\.?))[:：]\s*([^|]+)/i);
    const court = line.match(/(?:法院|Court)[:：]\s*([^|]+)/i);
    const summary = line.match(/(?:摘要|Summary)[:：]\s*(.+)/i);
    if (caseNumber) current.caseNumber = caseNumber[1].trim();
    else if (court) current.court = court[1].trim();
    else if (summary) current.chunk = summary[1].trim();
    else if (current.title && line.trim()) current.chunk = [current.chunk, line.trim()].filter(Boolean).join('\n');
  }
  if (current.title) parsed.push(current as ChinaCaseSearchResult);
  return parsed;
}
