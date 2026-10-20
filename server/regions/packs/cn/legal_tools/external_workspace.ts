import { listLegalSourceCapabilities } from "../../../../legal/sources";
import { LEGAL_CASE_SEARCH_ORDER } from "./case_workflow";
import { legalWorkspaceId } from "./context";
import { textArg } from "./context";
import { listArg } from "./context";
import { buildSearchQueries } from "./context";
import { EXTERNAL_LEGAL_SOURCES } from "./context";
import { archiveLegalReportToCase } from "./case_workflow";
import { resolveWritableOutputDir } from "./context";
import { getGeneratedOutputDir } from "../../../../config/data_path";
import path from "path";
import { legalWrite } from "../../../../legal/execution";
import fs from "fs";

export async function externalSourceStatusHandler(): Promise<string> {
  const rows = listLegalSourceCapabilities().map(source =>
    `| ${source.label} | ${source.accessMode} | ${source.configured ? '已配置/可用' : '未配置或网页登录'} | ${source.canAutoQuery ? '可以' : '不承诺'} | ${source.boundary} | ${source.nextAction} |`,
  ).join('\n');

  return `# 外部法律数据源接入状态

| 数据源 | 当前模式 | 状态 | 自动查询 | 边界 | 下一步 |
| --- | --- | --- | --- | --- | --- |
${rows}

## 统一口径
- 只有配置官方 API 凭证并受合同授权的数据源，才称为“平台数据接入”。
- 其他站点按“授权网页登录协作”处理：Lumi 可打开页面、组织检索词、辅助登记来源，但不绕过验证码、付费墙、账号权限、频控或下载限制。
- 律师确认后的网页摘录、下载文件和本地材料，可以用 材料入库 导入组织知识库。`;
}

export async function externalResearchPlanHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '半自动外部检索行动单';
  const facts = textArg(args, 'facts');
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const issues = listArg(args, 'issues');
  const companyNames = listArg(args, 'companyNames');
  const queries = buildSearchQueries({ ...args, caseType, facts, issues });
  const courtLevels = LEGAL_CASE_SEARCH_ORDER;
  const sourceCapabilities = listLegalSourceCapabilities();
  const loginActions = EXTERNAL_LEGAL_SOURCES
    .filter(source => source.presetId)
    .map(source => `- ${source.label}：${source.url}
  律师在授权网页内检索、筛选、摘录，并回填来源登记表。`)
    .join('\n');

  const report = `# ${caseName}

## 一、检索边界
- Lumi 不复制第三方平台数据，不绕过验证码、付费墙、账号权限或频控。
- 只有已配置官方 API 凭证并受合同授权的数据源，才称为“平台数据接入”；未配置 API 的数据源按授权网页登录协作处理。
- 打开对应官方网站，由律师登录授权账号进行检索。
- 律师在网页内确认检索结果后，将标题、链接、案号、法院、裁判日期、关键摘录和使用理由登记回案件；确认后的文件或摘录可由 材料入库 自动导入知识库。

## 数据源接入状态
${sourceCapabilities.map(source => `- ${source.label}: ${source.accessMode} / ${source.configured ? '已配置或官网可用' : '未配置 API'} / ${source.canAutoQuery ? '可自动查询' : '网页登录或人工确认'}`).join('\n')}

## 二、案件线索
- 案由/类型：${caseType}
- 争议焦点：${issues.join('；') || '待补充'}
- 事实摘要：${facts || '待补充'}
- 企业/被执行人：${companyNames.join('；') || '待补充'}

## 三、推荐检索顺序
1. 国家法律法规数据库：先核验法律依据是否现行有效。
2. 人民法院案例库：优先查权威案例和裁判规则。
3. 中国裁判文书网：按法院层级筛选，顺序为 ${courtLevels.join(' > ')}。
4. 法蝉 / Alpha：使用律所授权账号补充商业库资料。
5. 企查查 / 天眼查 / 启信宝 / 国家企业信用信息公示系统：核验公司和被执行人情况。
6. 中国执行信息公开网：核验被执行、失信、限制消费和终本线索。
7. 全国公共资源交易平台 / 动产融资统一登记公示系统：核验中标、应收款、动产担保和保理线索。
8. 国家知识产权、建筑市场、海关信用和破产重整平台：按主体类型补齐权利、资质、跨境与资产处置线索。
9. 人民法院在线服务：仅用于半自动立案材料核对和人工提交。

## 四、网页登录动作
${loginActions}

## 五、站点打开清单
${EXTERNAL_LEGAL_SOURCES.map(source => {
  const preset = source.presetId ? `presetId: ${source.presetId}` : '无需登录预设或使用通用网页登录';
  return `- ${source.label}（${preset}）：${source.use}\n  ${source.url}`;
}).join('\n')}

## 六、检索词
${queries.map((q, index) => `${index + 1}. ${q}`).join('\n')}

## 七、来源登记表字段
| 来源 | 检索词 | 标题/案号 | 法院层级 | 裁判日期/发布日期 | 链接 | 关键摘录 | 对我方有利点 | 不利/区分点 | 复核人 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 |
`;
  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 外部检索行动单`,
    content: report,
    type: 'note',
    cause: caseType,
  });
  return `${report}\n## 八、案件空间归档\n${caseLine}`;
}

export function pickExternalLegalSources(args: Record<string, any>): typeof EXTERNAL_LEGAL_SOURCES {
  const rawSources = [
    ...listArg(args, 'sourceIds'),
    ...listArg(args, 'sources'),
    ...listArg(args, 'platforms'),
  ].map(item => item.toLowerCase());
  const action = `${textArg(args, 'action')} ${textArg(args, 'purpose')} ${textArg(args, 'caseType')}`;
  let selected = EXTERNAL_LEGAL_SOURCES.filter(source => {
    const haystack = `${source.label} ${source.presetId} ${source.url}`.toLowerCase();
    return rawSources.length > 0 && rawSources.some(item => haystack.includes(item));
  });

  if (selected.length === 0) {
    selected = EXTERNAL_LEGAL_SOURCES.filter(source =>
      ['people-court-case-library', 'china-judgments-online', 'fachan', 'alpha-lawyer'].includes(source.presetId),
    );
  }
  if (/公司|企业|被执行|股权|工商|企查查|信用/i.test(action) || listArg(args, 'companyNames').length > 0) {
    for (const source of EXTERNAL_LEGAL_SOURCES.filter(item => ['qichacha', 'national-enterprise-credit'].includes(item.presetId))) {
      if (!selected.includes(source)) selected.push(source);
    }
  }
  if (/立案|法院在线|提交|filing/i.test(action)) {
    const filing = EXTERNAL_LEGAL_SOURCES.find(item => item.presetId === 'court-online-service');
    if (filing && !selected.includes(filing)) selected.push(filing);
  }
  return selected;
}

export async function prepareExternalBrowserWorkspaceHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const caseName = textArg(args, 'caseName') || '外部检索';
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const issues = listArg(args, 'issues');
  const facts = textArg(args, 'facts');
  const companyNames = listArg(args, 'companyNames');
  const selectedSources = pickExternalLegalSources(args);
  const queries = [
    ...listArg(args, 'queries'),
    ...buildSearchQueries({ ...args, caseType, facts, issues }),
  ].filter((item, index, arr) => item && arr.indexOf(item) === index).slice(0, 18);
  const outputDir = resolveWritableOutputDir(
    textArg(args, 'outputDir'),
    getGeneratedOutputDir(),
    caseName,
    'browser_workspace',
  );

  const runbook = [
    `# ${caseName} 外部网页登录工作区`,
    '',
    `- 案由/类型：${caseType}`,
    `- 争议焦点：${issues.join('；') || '待补充'}`,
    `- 企业/被执行人：${companyNames.join('；') || '待补充'}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 工作边界',
    '- 当前是“授权网页登录协作”，不是平台数据库接入。',
    '- Lumi 可打开可见浏览器、复用授权会话、整理检索词和来源登记表。',
    '- Lumi 不绕过验证码、二维码、人脸、短信验证、付费墙、账号权限、频控或下载限制。',
    '- 律师确认后的下载文件、网页摘录和来源登记，可再导入组织知识库。',
    '',
    '## 建议检索词',
    queries.map((query, index) => `${index + 1}. ${query}`).join('\n') || '1. 待补充检索词',
    '',
    '## 站点与用途',
    selectedSources.map(source => `- ${source.label}：${source.use}\n  ${source.url}`).join('\n'),
    '',
  ].join('\n');
  const sourceRegisterCsv = [
    'source,query,title_or_case_number,court_level,date,url,key_excerpt,favorable_point,unfavorable_or_distinguish,reviewer,status',
    '待登记,待登记,待登记,待登记,待登记,待登记,待登记,待登记,待登记,待登记,待复核',
  ].join('\n');

  const runbookPath = path.join(outputDir, '00_browser-workspace.md');
  const registerPath = path.join(outputDir, '01_source-register.csv');
  legalWrite(() => fs.writeFileSync(runbookPath, runbook, 'utf-8'));
  legalWrite(() => fs.writeFileSync(registerPath, sourceRegisterCsv, 'utf-8'));

  return [
    '# 外部网页登录工作区已生成',
    '',
    `- 案件：${caseName}`,
    `- 输出目录：${outputDir}`,
    `- 操作手册：${runbookPath}`,
    `- 来源登记表：${registerPath}`,
    `- 站点数量：${selectedSources.length}`,
    '',
    '边界：不自动抓取、不批量同步、不绕过平台限制；登录、验证码、下载权限和最终引用均由律师确认。',
  ].join('\n');
}
