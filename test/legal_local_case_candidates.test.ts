import './helpers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import * as EDB from '../server/org/db';
import * as LegalCases from '../server/org/legal_cases';
import { createLegalArticle } from '../server/legal/kb';
import { chunkKnowledgeText } from '../server/knowledge/ingestion_manifest';
import { searchCaseHandler, importMaterialsToKbHandler } from '../server/regions/packs/cn/legal_tools/knowledge';
import { setOrganizationResourcePolicy } from '../server/org/resource_acl';
import { decodeToolResult } from '../server/tools/result_envelope';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';

vi.mock('../server/memory/store', async original => ({ ...await original<typeof import('../server/memory/store')>(),
  generateEmbeddingWithIdentity: vi.fn(async () => ({ provider: 'offline', model: 'case-source', vector: [1, 0] })),
}));
vi.mock('../server/llm/embedding_provider', () => ({ generateConfiguredEmbedding: vi.fn(async () => ({ provider: 'offline', model: 'case-source', vector: [1, 0] })) }));
vi.mock('../server/llm/rerank_provider', () => ({ getRerankSelection: () => ({ enabled: false }) }));

const owner = 'case-candidate-owner';
let orgId = '';
let sequence = 0;
beforeAll(() => initDatabase());
beforeEach(() => {
  orgId = EDB.createOrg('Isolated case candidates', 'isolated-case-candidates-' + ++sequence, owner).id;
  EDB.addMember(orgId, owner, 'owner');
  EDB.addMember(orgId, 'case-candidate-reader', 'member');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External transport forbidden'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
const context = (userId = owner) => ({ orgId, userId, domain: 'work' as const });
function judgment(title: string, content: string) {
  return createLegalArticle(orgId, owner, { title, content, articleType: 'judgment',
    metadata: { articleType: 'judgment', caseNumber: 'synthetic-case-' + title, jurisdiction: '测试法院' } });
}
function indexChunks(article: EDB.KbArticle) {
  const chunks = chunkKnowledgeText(article.content, { maxChunkSize: 800, overlapSize: 120 });
  for (const chunk of chunks) EDB.saveKbEmbedding(article.id, chunk.index, [1, 0], chunk.text, 'offline/case-source');
  return chunks;
}

describe('local case candidates retain document and excerpt identities', () => {
  it('counts a multi-chunk article once while preserving each retrieved excerpt and citation', async () => {
    const article = judgment('虚构候选一', Array.from({ length: 8 }, (_, i) => '第' + i + '段：' + '模拟裁判原文及例外条件。'.repeat(38)).join('\n\n'));
    const chunks = indexChunks(article);
    expect(chunks.length).toBeGreaterThan(4);
    const before = JSON.stringify(EDB.getKbArticle(orgId, article.id));
    const decoded = decodeToolResult(await searchCaseHandler({ orgId, query: '独立模拟争议', limit: 5 }, context()));
    expect(decoded.receipt).toMatchObject({ ok: true, status: 'observed', resultCount: 1, excerptCount: chunks.length });
    const sources = (decoded.receipt as { sourceResults: any[] }).sourceResults;
    expect(sources).toHaveLength(1);
    expect(sources[0].articleId).toBe(article.id);
    expect(sources[0].excerpts).toHaveLength(chunks.length);
    for (const chunk of chunks) {
      expect(decoded.content).toContain(chunk.text);
      expect(sources[0].excerpts).toContainEqual(expect.objectContaining({ text: chunk.text, citationKey: expect.stringContaining(article.id) }));
    }
    expect(decoded.content).toContain('1 份候选裁判文书');
    expect(decoded.content).not.toContain(chunks.length + ' 个相似案例');
    expect(JSON.stringify(EDB.getKbArticle(orgId, article.id))).toBe(before);
  });

  it('applies the requested document limit after grouping and keeps selected document excerpts', async () => {
    const first = judgment('虚构候选甲', '甲方争议条件。'.repeat(240));
    const second = judgment('虚构候选乙', '乙方争议条件。'.repeat(240));
    indexChunks(first); indexChunks(second);
    const decoded = decodeToolResult(await searchCaseHandler({ orgId, query: '模拟条件', limit: 1 }, context()));
    const sources = (decoded.receipt as { sourceResults: any[] }).sourceResults;
    expect(sources).toHaveLength(1);
    expect(sources[0].excerpts.length).toBeGreaterThan(1);
    expect(new Set(sources[0].excerpts.map((entry: any) => entry.citationKey)).size).toBe(sources[0].excerpts.length);
  });

  it('preserves the category boundary for both semantic and keyword candidates', async () => {
    const material = EDB.createKbArticle(orgId, owner, { title: '独立材料', category: 'legal_case_material', content: 'UNIQUEGENERAL普通材料，不是裁判。'.repeat(90) });
    indexChunks(material);
    const decoded = decodeToolResult(await searchCaseHandler({ orgId, query: 'UNIQUEGENERAL' }, context()));
    expect(decoded.receipt).toMatchObject({ ok: false, status: 'partial', resultCount: 0, sourceResults: [] });
    expect(decoded.content).not.toContain(material.content);
  });

  it('returns a partial receipt for an empty local library through the registered tool', async () => {
    const registry = new ToolRegistry(); registerLegalTools(registry);
    const decoded = decodeToolResult(await registry.execute('legal_search_case', { query: '空库检索', orgId }, context()));
    expect(decoded.receipt).toMatchObject({ ok: false, status: 'partial', resultCount: 0, sourceResults: [] });
    expect(decoded.content).toContain('未找到');
    expect(registry.get('legal_import_judgment')).toBeUndefined();
    expect(registry.get('legal_import_materials_to_kb')).toBeDefined();
  });

  it('keeps the current resource ACL when grouping local results', async () => {
    const article = judgment('受限文书', 'PRIVATECASE仅供原所有者读取。'.repeat(100)); indexChunks(article);
    setOrganizationResourcePolicy({ orgId, actorUserId: owner, resourceType: 'knowledge_article', resourceId: article.id,
      ownerUserId: owner, classification: 'restricted', grants: [] });
    const permitted = decodeToolResult(await searchCaseHandler({ orgId, query: 'PRIVATECASE' }, context()));
    const denied = decodeToolResult(await searchCaseHandler({ orgId, query: 'PRIVATECASE' }, context('case-candidate-reader')));
    expect(permitted.receipt).toMatchObject({ ok: true, resultCount: 1 });
    expect(denied.receipt).toMatchObject({ ok: false, status: 'partial', sourceResults: [] });
    expect(denied.content).not.toContain(article.content);
  });

  it('imports ordinary content as a material and archives an explicitly selected judgment as that material type', async () => {
    const generalText = '虚构产品部署材料，保留原文内容，不作为裁判事实。'.repeat(5);
    await importMaterialsToKbHandler({ orgId, title: '虚构部署材料', content: generalText }, context());
    const ordinary = EDB.listKbArticles(orgId).find(article => article.title === '虚构部署材料')!;
    expect(ordinary.category).toBe('legal_case_material');
    expect(ordinary.content).toContain(generalText);
    const local = decodeToolResult(await searchCaseHandler({ orgId, query: '虚构部署材料' }, context()));
    expect(local.receipt).toMatchObject({ ok: false, status: 'partial', sourceResults: [] });
    const caseFile = LegalCases.createCase(orgId, owner, { title: '显式材料类型归档' });
    const judgmentText = '（2026）测试民初1号\n测试人民法院\n虚构裁判材料，仅用于本地归档回归。'.repeat(4);
    await importMaterialsToKbHandler({ orgId, caseId: caseFile.id, title: '虚构判决材料', materialType: 'judgment', content: judgmentText }, context());
    const materials = LegalCases.getCase(orgId, caseFile.id, owner, 'read')!.materials;
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({ type: 'judgment', title: '虚构判决材料' });
    expect(materials[0].content).toContain(judgmentText);
  });
});
