import { legalTemporalOptions } from './context';
import { legalWorkspaceId } from "./context";
import { textArg } from "./context";
import { searchSimilarCases } from "../../../../legal/kb";
import { searchStatutes } from "../../../../legal/kb";
import { searchLegalAuthorityDatabase } from "../../../../legal/sources";
import { listArg } from "./context";
import * as LegalCases from "../../../../org/legal_cases";
import { normalizeMaterialArticleType } from "./documents";
import crypto from "node:crypto";
import * as EDB from "../../../../org/db";
import { extractLegalMetadata } from "../../../../legal/parser";
import { legalWrite } from "../../../../legal/execution";
import { createLegalArticle } from "../../../../legal/kb";
import { buildImportedMaterialContent } from "./documents";
import { materialCategory } from "./documents";
import { normalizeTagsFromArgs } from "./documents";
import { indexLegalArticle } from "../../../../legal/kb";
import { legalExecutionSignal } from "../../../../legal/execution";
import { assertLegalExecutionActive } from "../../../../legal/execution";
import path from "path";
import { expandLocalPath } from "./context";
import fs from "fs";
import { collectMaterialFiles } from "./documents";
import { LEGAL_MATERIAL_EXTENSIONS } from "./context";
import { LEGAL_IMAGE_EXTENSIONS } from "./context";
import { parseLegalDocument } from "./documents";
import { legalReadError } from "./documents";
import { encodeToolResult } from "../../../../tools/result_envelope";
import { type CitationCheck } from "../../../../legal/kb";
import { verifyMultipleCitations } from "../../../../legal/kb";
import { verifyCitation } from "../../../../legal/kb";
import { refreshAuthoritativeStatuteSources } from "../../../../legal/statute_authority_refresh";
import { formatStatuteAuthorityRefreshReport } from "../../../../legal/statute_authority_refresh";
import { loadStatuteAuthorityRefreshState } from "../../../../legal/statute_authority_store";
import { courtLevelRank } from "./case_workflow";

export async function searchCaseHandler(args: Record<string, any>, context?: any): Promise<string> {
  const query = textArg(args, 'query');
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 20));
  const result = (content: string, sourceResults: Record<string, unknown>[] = []) => encodeToolResult(content, {
    ok: sourceResults.length > 0,
    status: sourceResults.length ? 'observed' : 'partial',
    resultCount: sourceResults.length,
    excerptCount: sourceResults.reduce((count, source) => count + (source.excerpts as unknown[]).length, 0),
    sourceResults,
    persisted: false,
    changedCaseIds: [],
    articleIds: [],
    artifacts: [],
  });
  if (!query) return result('请提供案由或事实描述（query参数）；未执行类案检索。');

  // Search local KB
  const orgId = legalWorkspaceId(args, context);
  const userId = context?.userId || textArg(args, 'userId') || 'system';
  const localResults = await searchSimilarCases(orgId, query, Math.min(50, limit * 4), userId);
  const documents = new Map<string, typeof localResults>();
  for (const row of localResults) {
    const excerpts = documents.get(row.articleId) || [];
    if (!excerpts.some(excerpt => excerpt.citationKey === row.citationKey && excerpt.chunk === row.chunk)) excerpts.push(row);
    documents.set(row.articleId, excerpts);
  }
  const candidates = [...documents.values()].sort((a, b) =>
    courtLevelRank(a[0].court || '') - courtLevelRank(b[0].court || '')
    || Math.max(...b.map(row => row.score)) - Math.max(...a.map(row => row.score))).slice(0, limit);

  if (candidates.length > 0) {
    const queriedAt = new Date().toISOString();
    const sourceResults = candidates.map(rows => ({
      sourceName: '本地裁判文书知识库', sourceTool: 'legal_search_case', queriedAt, query,
      articleId: rows[0].articleId, title: rows[0].title,
      caseNumber: rows[0].caseNumber, court: rows[0].court,
      status: 'observed',
      excerpts: rows.map(row => ({ text: row.chunk, citationKey: row.citationKey || row.articleId,
        score: row.score, retrievalMethod: row.source })),
    }));
    const lines = candidates.map((rows, index) => [
      `${index + 1}. **${rows[0].title}**`,
      `   案号: ${rows[0].caseNumber || '未提供'} | 法院: ${rows[0].court || '未提供'}`,
      ...rows.map(row => `   [${row.source === 'keyword' ? '原文匹配' : '语义相关度'}: ${row.score}]\n   引用: ${row.citationKey || row.articleId}\n   摘录: ${row.chunk}`),
    ].join('\n'));
    return result(`本地知识库检索到 ${candidates.length} 份候选裁判文书，共 ${sourceResults.reduce((count, source) => count + source.excerpts.length, 0)} 段相关摘录：\n\n${lines.join('\n\n')}\n\n*来源: 本地裁判文书知识库。相似检索结果为候选材料，不确认其与查询主体、具体案件或执行记录的对应关系。*`, sourceResults);
  }

  return result('本地知识库中未找到相似案例，未取得候选裁判文书。可导入相关裁判文书，或通过中国裁判文书网 (wenshu.court.gov.cn) 检索；本次未查询外部来源。');
}

export async function searchStatuteHandler(args: Record<string, any>, context?: any): Promise<string> {
  const query = args.query as string;
  if (!query) return '请提供法条名称或关键词（query参数）';

  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const results = await searchStatutes(orgId, query, 5, userId);
  const externalResults = await searchLegalAuthorityDatabase({
    query,
    type: 'law',
    sourceIds: [
      ...listArg(args, 'sourceIds'),
      ...listArg(args, 'sources'),
      ...listArg(args, 'platforms'),
    ],
    includeOfficialWeb: args.includeOfficialWeb === true,
    limit: Number(args.limit) || 5,
  });

  if (results.length === 0 && externalResults.length === 0) {
    return `未找到与"${query}"相关的法条。建议通过国家法律法规数据库 (flk.npc.gov.cn) 核实。`;
  }

  const lines = results.map((r, i) =>
    `${i + 1}. **${r.title}** ${r.verificationStatus === 'verified' && r.isEffective ? '✓ 来源状态已核验，适用性待复核' : r.verificationStatus === 'repealed' ? '✗ 已废止，需检查历史适用' : '待核验有效性'}\n   ${r.chunk?.trim() ? r.chunk : '未取得可展示的法条全文；请核验权威来源'}\n   引用: ${r.citationKey || r.sourceUrl || r.articleId}`,
  );
  const externalLines = externalResults.map((r, i) =>
    `${results.length + i + 1}. **${r.title}** ${r.effectiveStatus || '待律师复核'}\n   来源: ${r.sourceName}${r.url ? ` | ${r.url}` : ''}\n   ${r.summary.slice(0, 200)}`,
  );
  return [...lines, ...externalLines].join('\n\n')
    + '\n\n*来源: 本地法条库、已配置授权法律数据库；未配置 API 的平台需通过网页登录协作核验。*';
}

export async function importMaterialsToKbHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = legalWorkspaceId(args, context);
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const filePath = textArg(args, 'filePath');
  const folderPath = textArg(args, 'folderPath');
  const content = textArg(args, 'materials') || textArg(args, 'content');
  const caseId = textArg(args, 'caseId');
  if (caseId && !LegalCases.getCase(orgId, caseId, userId, 'write')) throw new Error('Legal case unavailable for this user.');
  if (!filePath && !folderPath && !content) return '请提供 filePath、folderPath 或 content。';
  const imported: Array<{ title: string; articleId: string; chunks: number; category: string; reused: boolean }> = [];
  const skipped: Array<{ source: string; reason: string }> = [];
  const ingestOne = async (source: string, text: string, format: string, title: string) => {
    if (text.trim().length < 20) { skipped.push({ source, reason: '文本过短或解析为空' }); return; }
    const articleType = normalizeMaterialArticleType(textArg(args, 'materialType') || title);
    const identity = 'legal-import:' + crypto.createHash('sha256')
      .update(JSON.stringify([userId, caseId, source, text, articleType])).digest('hex');
    const existing = EDB.listKbArticles(orgId).find(article => article.authorId === userId && (() => {
      try { return JSON.parse(article.tags || '[]').includes(identity); } catch { return false; }
    })());
    const metadata = articleType === 'judgment' ? extractLegalMetadata(text) : undefined;
    const article = existing || legalWrite(() => createLegalArticle(orgId, userId, {
      title,
      content: buildImportedMaterialContent(args, { title, text, source, format, articleType }),
      category: materialCategory(articleType),
      tags: [...normalizeTagsFromArgs(args, articleType, source), identity, ...(caseId ? ['legal-case:' + caseId] : [])],
      articleType,
      metadata: { articleType, ...metadata, jurisdiction: metadata?.court },
    }));
    // Retry an interrupted index without making a duplicate article or another case.
    let chunks = 0;
    try { chunks = await indexLegalArticle(orgId, article.id, userId, { signal: context?.executionSignal || legalExecutionSignal() }); }
    catch (error) { assertLegalExecutionActive(context); skipped.push({ source, reason: '原文已保存，向量索引未完成；可重试原材料。' }); }
    if (caseId) {
      const marker = 'knowledge-article:' + article.id;
      const current = LegalCases.getCase(orgId, caseId, userId, 'write');
      if (!current) throw new Error('Legal case authorization changed.');
      if (!current.materials.some(material => material.content?.includes(marker))) {
        const material = legalWrite(() => LegalCases.addMaterial(orgId, userId, caseId, {
          type: articleType === 'judgment' || articleType === 'contract' || articleType === 'pleading' ? articleType : 'evidence',
          title, content: marker + '\n' + text,
          fileName: source === 'pasted-content' ? undefined : path.basename(source),
          localPath: source === 'pasted-content' ? undefined : source, source: 'manual',
        }));
        if (!material) throw new Error('Legal case archive failed.');
      }
    }
    imported.push({ title, articleId: article.id, chunks, category: article.category, reused: Boolean(existing) });
  };
  if (content) await ingestOne('pasted-content', content, 'text', textArg(args, 'title') || textArg(args, 'caseName') || '粘贴法律材料');
  const files = new Set<string>();
  if (filePath) files.add(path.resolve(expandLocalPath(filePath)));
  if (folderPath) {
    const resolved = path.resolve(expandLocalPath(folderPath));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) skipped.push({ source: resolved, reason: '文件夹不存在或不可访问' });
    else {
      const limit = Math.max(1, Math.min(Number(args.maxFiles) || 30, 100));
      const found = collectMaterialFiles(resolved, args.recursive !== false, limit + 1);
      found.slice(0, limit).forEach(file => files.add(file));
      if (!found.length) skipped.push({ source: resolved, reason: '未找到可导入的材料' });
      if (found.length > limit) skipped.push({ source: resolved, reason: '超过本次文件数量上限，其余文件尚未导入' });
    }
  }
  for (const source of files) {
    assertLegalExecutionActive(context);
    try {
      const ext = path.extname(source).toLowerCase();
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) { skipped.push({ source, reason: '文件不存在或不是文件' }); continue; }
      if (!LEGAL_MATERIAL_EXTENSIONS.has(ext)) {
        skipped.push({ source, reason: LEGAL_IMAGE_EXTENSIONS.has(ext)
          ? '图片材料需先进行图片文字识别，再将识别文本导入知识库'
          : '暂不支持该格式：' + ext }); continue;
      }
      const parsed = await parseLegalDocument(source, args);
      if (!parsed?.text?.trim()) { skipped.push({ source, reason: '解析失败或内容为空' }); continue; }
      await ingestOne(source, parsed.text, parsed.format, path.basename(source));
    } catch (error) {
      assertLegalExecutionActive(context);
      skipped.push({ source, reason: legalReadError(error) });
    }
  }
  const totalChunks = imported.reduce((sum, item) => sum + item.chunks, 0);
  const lines = imported.map((item, index) =>
    (index + 1) + '. ' + item.title + '\n   - articleId: ' + item.articleId + '\n   - category: ' + item.category
    + '\n   - indexedChunks: ' + item.chunks + (item.reused ? '\n   - 已复用原入库记录，未重复创建' : '')).join('\n');
  const report = '# 法律材料导入知识库报告\n\n## 一、导入结果\n- 成功导入：' + imported.length
    + ' 份\n- 索引块数：' + totalChunks + '\n- 跳过/失败：' + skipped.length + ' 份\n- 案件：' + (caseId || '未指定，不另建案件')
    + '\n\n## 二、已导入材料\n' + (lines || '无')
    + '\n\n## 三、跳过/失败材料\n' + (skipped.map(item => '- ' + item.source + ' — ' + item.reason).join('\n') || '无')
    + '\n\n## 四、后续处理\n' + (imported.length ? '- 已列出的原文已保存，可检索和复用。' : '- 本次没有材料入库。')
    + '\n- 失败材料仍待处理；补充密码后用相同路径和案件ID重试，密码只用于当次读取。'
    + '\n- 向量索引为0不等于原文丢失，但语义检索可能尚未就绪。';
  return encodeToolResult(report, {
    ok: imported.length > 0 && skipped.length === 0,
    status: imported.length ? (skipped.length ? 'partial' : 'imported') : 'blocked',
    existingArticleIds: imported.filter(item => item.reused).map(item => item.articleId),
  });
}

export function formatCitationVerificationResult(check: CitationCheck): string {
  const verificationLabel = check.verificationStatus === 'verified'
    ? '具体引用已对照权威原文（案件适用仍待复核）'
    : check.verificationStatus === 'metadata_only' ? '仅核验版本，具体条文未核验，正式交付阻断'
    : check.verificationStatus === 'text_mismatch' ? '引文与权威原文不符，正式交付阻断'
    : check.verificationStatus === 'changed'
      ? '权威记录已变化，正式交付阻断'
    : check.verificationStatus === 'expired'
      ? '权威快照已过期，正式交付阻断'
      : check.verificationStatus === 'repealed'
        ? '已确认废止，正式交付阻断'
        : check.verificationStatus === 'missing'
          ? '缺少权威条文快照，正式交付阻断'
          : check.verificationStatus === 'not_found'
            ? '未找到或超出已核验条文范围，正式交付阻断'
            : '不适用';
  return [
    check.citation,
    `  类型: ${check.type === 'statute' ? '法条引用' : '案例引用'}`,
    `  存在: ${check.exists ? '是' : '否'}`,
    `  有效: ${check.isEffective === null ? '尚未确认' : check.isEffective ? '现行有效' : '已废止'}`,
    `  核验状态: ${verificationLabel}`,
    check.authorityRefreshStatus ? `  自动巡检: ${check.authorityRefreshStatus}` : '',
    check.verifiedAt ? `  核验日期: ${check.verifiedAt}` : '',
    check.reviewAfter ? `  复核期限: ${check.reviewAfter}` : '',
    `  ${check.detail}`,
    check.sourceText ? `  条文原文: ${check.sourceText}` : '',
    `  来源: ${check.source || 'N/A'}`,
    check.sourceUrl ? `  官方链接: ${check.sourceUrl}` : '',
  ].filter(Boolean).join('\n');
}

export async function verifyCitationHandler(args: Record<string, any>, context?: any): Promise<string> {
  const citation = args.citation as string;
  const text = args.text as string;
  const orgId = legalWorkspaceId(args, context);

  if (text) {
    const checks = verifyMultipleCitations(text, orgId, { ...legalTemporalOptions(args), actorUserId: context?.userId });
    if (checks.length === 0) return '未在文本中检测到法条引用（《XX法》格式）或案号引用。';
    return checks.map(formatCitationVerificationResult).join('\n\n');
  }

  if (citation) {
    const check = verifyCitation(citation, orgId, { ...legalTemporalOptions(args), quotedText: textArg(args, 'quotedText') || undefined, actorUserId: context?.userId });
    return formatCitationVerificationResult(check);
  }

  return '请提供citation（单个引用）或text（批量验证）参数。';
}

export async function refreshAuthoritativeSourcesHandler(args: Record<string, any>): Promise<string> {
  const timeoutMs = Number.isFinite(Number(args.timeoutMs))
    ? Math.max(2_000, Math.min(30_000, Number(args.timeoutMs)))
    : undefined;
  const result = await refreshAuthoritativeStatuteSources({ timeoutMs });
  const content = [
    formatStatuteAuthorityRefreshReport(result),
    result.archivePath ? `\n巡检记录：${result.archivePath}` : '',
  ].filter(Boolean).join('\n');
  const state = loadStatuteAuthorityRefreshState();
  if (state.lastRunAt !== result.completedAt) {
    throw new Error('Authoritative legal source refresh state was not persisted.');
  }
  const artifacts = result.archivePath && fs.existsSync(result.archivePath)
    ? [path.resolve(result.archivePath)]
    : [];
  return encodeToolResult(content, {
    ok: true,
    status: 'refreshed',
    persisted: true,
    result,
    state,
    changedCaseIds: [],
    articleIds: [],
    artifacts,
    content,
  });
}

export async function authoritySourceStatusHandler(): Promise<string> {
  return formatStatuteAuthorityRefreshReport(loadStatuteAuthorityRefreshState());
}
