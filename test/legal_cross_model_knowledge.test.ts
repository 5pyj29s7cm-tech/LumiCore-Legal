import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import * as EDB from '../server/org/db';
import * as Cases from '../server/org/legal_cases';
import * as KB from '../server/org/kb';
import { createLegalArticle, indexLegalArticle, searchSimilarCases, searchStatutes } from '../server/legal/kb';
import { retrieveConversationKnowledge } from '../server/knowledge/conversation_retrieval';
import { bindIndustryWorkspaceContext } from '../server/industry/workspace_context';
import { upsertUserRetrievalModelPreferences } from '../server/llm/retrieval_model_preferences';
import { saveKeys } from '../server/config/keys';
import { setOrganizationResourcePolicy } from '../server/org/resource_acl';
import { ingestDocument, retrieveChunks } from '../server/agents/rag';

beforeAll(async () => { await initDatabase(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
let sequence = 0;
function fixture() {
  const userId = `knowledge-switch-${++sequence}`;
  const orgId = `personal:${userId}`;
  vi.stubEnv('LUMI_PRIVACY', 'standard');
  vi.stubEnv('OPENAI_BASE_URL', 'https://embedding.example.invalid');
  saveKeys({ OPENAI_API_KEY: 'synthetic-knowledge-test' });
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify({
    model: JSON.parse(String(init?.body || '{}')).model, data: [{ embedding: [1, 0] }],
  }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const select = (provider: string, model: string) => upsertUserRetrievalModelPreferences(userId,
    { embedding: { provider, model, fallbackProvider: '' } });
  select('openai', 'cloud-embedding-a');
  const scope = { userId, domain: 'personal' as const, orgId: '' };
  return { userId, orgId, fetchMock, select, scope };
}
const content = '星槐设备合同：供货金额 37 万元，验收后十日付款。项目编号 XH-203。';

describe('requirement 19: knowledge survives model changes and incremental cases', () => {
  it('keeps the personal uploaded-file library available when a replacement embedding model stalls', async () => {
    const f = fixture();
    await ingestDocument(f.userId, 'lumi', '星槐设备合同.txt', content, { verifyEmbeddings: false });
    const before = await retrieveChunks(f.userId, 'lumi', '星槐设备', 3, { domain: 'personal', orgId: '' });
    expect(before[0].content).toContain('37 万元');
    f.select('lmstudio', 'replacement-stalled');
    f.fetchMock.mockImplementation(() => new Promise(() => {}));
    const after = await retrieveChunks(f.userId, 'lumi', '星槐设备', 3, { domain: 'personal', orgId: '', semanticTimeoutMs: 25 });
    expect(after[0].content).toBe(before[0].content);
    expect(after[0].citation).toBe(before[0].citation);
  });
  it('keeps citations and original text available after cloud/local embedding switches and reindexing', async () => {
    const f = fixture();
    const article = createLegalArticle(f.orgId, f.userId, { title: '星槐设备案判决', content, articleType: 'judgment' });
    await indexLegalArticle(f.orgId, article.id, f.userId);
    const first = (await searchSimilarCases(f.orgId, '星槐设备', 5, f.userId))[0];
    expect(first.source).toBe('semantic');
    f.select('lmstudio', 'local-embedding-b');
    const switched = (await searchSimilarCases(f.orgId, '星槐设备', 5, f.userId))[0];
    expect(switched).toMatchObject({ articleId: article.id, source: 'keyword', citationKey: first.citationKey });
    expect(switched.chunk).toContain('37 万元');
    await indexLegalArticle(f.orgId, article.id, f.userId);
    expect((await searchSimilarCases(f.orgId, '不共享词的语义问题', 5, f.userId))[0].source).toBe('semantic');
    f.select('openai', 'cloud-embedding-c');
    expect((await searchSimilarCases(f.orgId, '星槐设备', 5, f.userId))[0].citationKey).toBe(first.citationKey);
    expect(EDB.getKbArticle(f.orgId, article.id)?.content).toBe(content);
  });

  it('retrieves new unindexed judgments and statutes without any model request', async () => {
    const f = fixture();
    const judgment = createLegalArticle(f.orgId, f.userId, { title: '新增星槐案', content, articleType: 'judgment' });
    const statute = createLegalArticle(f.orgId, f.userId, { title: '新导入测试规范', content: '星槐规范原文，仅供测试。', articleType: 'statute' });
    expect(await searchSimilarCases(f.orgId, '星槐', 5, f.userId)).toContainEqual(expect.objectContaining({ articleId: judgment.id, source: 'keyword' }));
    expect(await searchStatutes(f.orgId, '星槐', 5, f.userId)).toContainEqual(expect.objectContaining({ articleId: statute.id, verificationStatus: 'missing' }));
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('falls back when the configured provider is offline, without erasing sources', async () => {
    const f = fixture();
    const article = createLegalArticle(f.orgId, f.userId, { title: '星槐案', content, articleType: 'judgment' });
    await indexLegalArticle(f.orgId, article.id, f.userId);
    f.select('lmstudio', 'offline-model');
    f.fetchMock.mockRejectedValue(new Error('offline'));
    expect(await searchSimilarCases(f.orgId, '星槐设备', 5, f.userId)).toContainEqual(expect.objectContaining({ articleId: article.id, source: 'keyword' }));
  });

  it('returns local sources promptly even if embedding transport ignores cancellation', async () => {
    const f = fixture();
    const article = createLegalArticle(f.orgId, f.userId, { title: '星槐案', content, articleType: 'judgment' });
    await indexLegalArticle(f.orgId, article.id, f.userId);
    f.fetchMock.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const results = await KB.searchKnowledgeBase(f.orgId, '星槐设备', { userId: f.userId, semanticTimeoutMs: 30 });
    expect(results[0]).toMatchObject({ articleId: article.id, source: 'keyword' });
    expect(Date.now() - started).toBeLessThan(600);
  });

  it('uses keyword retrieval in strict mode and never sends data to cloud embedding or rerank', async () => {
    const f = fixture();
    const article = createLegalArticle(f.orgId, f.userId, { title: '星槐案', content, articleType: 'judgment' });
    await indexLegalArticle(f.orgId, article.id, f.userId);
    f.fetchMock.mockClear();
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    upsertUserRetrievalModelPreferences(f.userId, {
      embedding: { provider: 'openai', model: 'cloud-embedding-a', fallbackProvider: '' },
      rerank: { enabled: true, provider: 'relay', model: 'cloud-reranker' },
    });
    const result = await retrieveConversationKnowledge(f.scope, '星槐设备');
    expect(result).toContain('37 万元');
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('does not resurrect old indexed content after an edit or deletion', async () => {
    const f = fixture();
    const article = createLegalArticle(f.orgId, f.userId, { title: '金额核对', content, articleType: 'judgment' });
    await indexLegalArticle(f.orgId, article.id, f.userId);
    EDB.updateKbArticle(f.orgId, article.id, { content: '星槐设备供货金额已经核对为 29 万元。' });
    const result = await searchSimilarCases(f.orgId, '星槐设备', 5, f.userId);
    expect(result[0].chunk).toContain('29 万元');
    expect(JSON.stringify(result)).not.toContain('37 万元');
    EDB.deleteKbArticle(f.orgId, article.id);
    expect(await searchSimilarCases(f.orgId, '星槐设备', 5, f.userId)).toEqual([]);
  });

  it.each(['edit', 'delete'] as const)('fences a concurrent source %s during a slow model call', async operation => {
    const f = fixture();
    const article = createLegalArticle(f.orgId, f.userId, { title: '星槐案', content, articleType: 'judgment' });
    await indexLegalArticle(f.orgId, article.id, f.userId);
    let finish!: (value: Response) => void;
    f.fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = searchSimilarCases(f.orgId, '星槐设备', 5, f.userId);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (operation === 'delete') EDB.deleteKbArticle(f.orgId, article.id);
    else EDB.updateKbArticle(f.orgId, article.id, { content: '内容已撤回' });
    finish(new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 }));
    expect(await pending).toEqual([]);
  });

  it('recalls newly added case materials across conversations and separates other cases and drafts', async () => {
    const f = fixture();
    const current = Cases.createCase(f.orgId, f.userId, { title: '星槐当前案', notes: '星槐争议待核对' });
    bindIndustryWorkspaceContext(f.scope, { name: current.title, attributes: { caseId: current.id } });
    const history = Cases.createCase(f.orgId, f.userId, { title: '星槐历史案' });
    Cases.addMaterial(f.orgId, f.userId, current.id, { title: '星槐合同', content, type: 'evidence', source: 'import' });
    Cases.addMaterial(f.orgId, f.userId, history.id, { title: '星槐旧代理词', content: '星槐设备处理意见为草稿。', type: 'pleading', source: 'tool' });
    const first = await retrieveConversationKnowledge(f.scope, '星槐设备');
    expect(first).toContain('37 万元');
    expect(first).toContain('selected_case_source');
    expect(first).toContain('separate_case_reference_only');
    expect(first).toContain('generated_draft_not_evidence');
    f.select('lmstudio', 'replacement-model');
    expect(await retrieveConversationKnowledge({ ...f.scope }, '星槐设备')).toBe(first);
    Cases.updateCase(f.orgId, f.userId, current.id, { materials: [] });
    expect(await retrieveConversationKnowledge(f.scope, '星槐设备')).not.toContain('37 万元');
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('searches the full source text and old cases beyond the workbench listing limit', () => {
    const f = fixture();
    const oldest = Cases.createCase(f.orgId, f.userId, { title: '早期案件' });
    Cases.addMaterial(f.orgId, f.userId, oldest.id, {
      title: '材料末页', content: '普通材料段落。'.repeat(800) + '独角兽设备验收编号 ZX-908，尾页约定保修五年。', type: 'evidence', source: 'import',
    });
    for (let i = 0; i < 205; i++) Cases.createCase(f.orgId, f.userId, { title: `后来案件-${i}` });
    const results = Cases.searchCaseKnowledge(f.orgId, f.userId, '独角兽设备验收', 3);
    expect(results[0].caseId).toBe(oldest.id);
    expect(results[0].chunk).toContain('保修五年');
    expect(results[0].chunkIndex).toBeGreaterThan(2);
  });

  it('isolates personal users and rejects unbound or nonmember organization scopes', async () => {
    const f = fixture();
    Cases.createCase(f.orgId, f.userId, { title: '星槐案件', notes: content });
    createLegalArticle(f.orgId, f.userId, { title: '星槐知识', content, articleType: 'judgment' });
    expect(await retrieveConversationKnowledge({ ...f.scope, userId: 'someone-else' }, '星槐')).toBe('');
    expect(await retrieveConversationKnowledge({ ...f.scope, domain: 'work', orgId: f.orgId }, '星槐')).toBe('');
    expect(await retrieveConversationKnowledge({ ...f.scope, domain: 'work' }, '星槐')).toBe('');
  });

  it('propagates caller cancellation instead of disguising it as a successful empty search', async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort(new Error('user cancelled'));
    await expect(retrieveConversationKnowledge(f.scope, '星槐', { signal: abort.signal })).rejects.toThrow('user cancelled');
  });

  it('enforces restricted case and knowledge permissions before constructing conversation context', async () => {
    const f = fixture();
    const org = EDB.createOrg('Scope fixture', `scope-${f.userId}`, f.userId);
    EDB.addMember(org.id, f.userId, 'owner');
    EDB.addMember(org.id, 'allowed-reader', 'member');
    EDB.addMember(org.id, 'denied-reader', 'member');
    const article = createLegalArticle(org.id, f.userId, { title: '星槐内部知识', content, articleType: 'contract' });
    const caseFile = Cases.createCase(org.id, f.userId, { title: '星槐内部案件', notes: content });
    for (const [resourceType, resourceId] of [['knowledge_article', article.id], ['legal_case', caseFile.id]]) {
      setOrganizationResourcePolicy({ orgId: org.id, actorUserId: f.userId, resourceType, resourceId,
        ownerUserId: f.userId, classification: 'restricted', grants: [{ subjectType: 'member', subjectId: 'allowed-reader', permissions: ['read'] }] });
    }
    const scope = { userId: 'allowed-reader', domain: 'work' as const, orgId: org.id };
    expect(await retrieveConversationKnowledge(scope, '星槐')).toContain('37 万元');
    expect(await retrieveConversationKnowledge({ ...scope, userId: 'denied-reader' }, '星槐')).toBe('');
  });
});
