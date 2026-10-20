import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PDFDocument } from 'pdf-lib';
import { Document, Packer, Paragraph } from 'docx';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import { readDB, flushDBOrThrow } from '../db_layer';
import { bindConversationActionTurnTask } from '../server/conversation/action_turn_ledger';
import { resolveLegalCaseArguments } from '../server/regions/packs/cn/legal_tools/context';
import { extractDisputeFocusHandler } from '../server/regions/packs/cn/legal_tools/argument_drafting';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { actualDocumentReadContent, documentReadMatchesRequestedTarget, isSuccessfulExactDocumentRead } from '../server/cognition/action_desktop_evidence';
import { addMessageIdempotent, startIsolatedConversation } from '../server/conversation/manager';
import { getPersonalKnowledgeDirectory } from '../server/files/knowledge_directory';
import { getDataPath } from '../server/config/data_path';
import { readKnowledgeSourceText, registerKnowledgeAccessRoutes } from '../server/files/knowledge/access_routes';
import { registerKnowledgeTools } from '../server/tools/definitions/knowledge_tools';
import { ToolRegistry } from '../server/tools/registry';
import * as parser from '../server/legal/parser';
import { createOrg, addMember, setMemberStatus, updateMemberRole } from '../server/org/db';
import { setOrganizationResourcePolicy } from '../server/org/resource_acl';
import { executeToolCall } from '../server/tools/execution_engine';
import type { ToolContext } from '../server/tools/types';

let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry();
const realParse = parser.parseDocument;
beforeAll(async () => { app = await makeApp(); registerKnowledgeAccessRoutes(app.apiRouter); registerKnowledgeTools(registry); });
afterAll(() => app.cleanup());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const digest = (text: string | Buffer) => crypto.createHash('sha256').update(text).digest('hex');
function bound(ids: string[], domain: 'personal' | 'work' = 'personal', orgId = '', userId = 'kb-source-' + crypto.randomUUID()) {
  const conversation = startIsolatedConversation(userId, 'lumi', domain, orgId);
  const requestId = 'request-' + crypto.randomUUID(), taskId = 'task-' + crypto.randomUUID();
  addMessageIdempotent({ userId, agentId: 'lumi', conversationId: conversation.id, requestId, role: 'user', source: 'chat', channel: 'chat', domain, orgId, content: '仅依据这些知识库原件：' + ids.join('；') + '，逐条引用 fileId，不猜路径。' });
  expect(bindConversationActionTurnTask({ userId, conversationId: conversation.id, requestId, taskId }).bound).toBe(true);
  const context: ToolContext = { taskId, authenticated: true, executionBoundary: 'trusted_local', localExecution: true, userId, conversationId: conversation.id, requestId, domain, orgId, dataRoutingPolicy: 'local_only' };
  const scope = domain === 'work' ? { userId, domain, orgId, dir: getDataPath(path.join('org', orgId, 'knowledge')) } : { userId, domain, ...getPersonalKnowledgeDirectory(userId) };
  fs.mkdirSync(scope.dir, { recursive: true });
  return { context, scope };
}
async function source(name = 'source.txt', body: string | Buffer = '虚构原件，未核准。KB-SOURCE-TAIL', domain: 'personal' | 'work' = 'personal', orgId = '', userId?: string) {
  const fixture = bound([name], domain, orgId, userId);
  fs.writeFileSync(path.join(fixture.scope.dir, name), body);
  const db = readDB(); db.knowledgeFiles ||= [];
  db.knowledgeFiles.push({ filename: name, userId: fixture.context.userId, domain, orgId: orgId || undefined, status: 'indexed', extractionStatus: 'indexed', contentChars: String(body).length } as any);
  await flushDBOrThrow();
  return fixture;
}
const read = (ids: unknown, context: ToolContext) => registry.get('knowledge_file_stats')!.handler({ fileIds: ids }, context);

describe('shared knowledge source reader and exact-ID tool mode', () => {
  it('returns every local PDF/DOCX/TXT tail with independent source hashes through the real tool adapter', async () => {
    const ids = ['A.pdf', 'B.docx', 'C.txt']; const f = bound(ids);
    const pdf = await PDFDocument.create(), font = await (pdf as any).embedFont('Helvetica');
    for (let i = 0; i < 6; i++) { const page = pdf.addPage(); for (let j = 0; j < 30; j++) page.drawText('Virtual source page ' + i + ' row ' + j, { x: 30, y: 760 - j * 20, font, size: 11 }); }
    pdf.getPages().at(-1)!.drawText('TABLE-ROW-ORACLE 613927 KB-END-A', { x: 30, y: 80, font, size: 11 });
    const docx = new Document({ sections: [{ children: [new Paragraph('Virtual defendant denies exact balance.'), new Paragraph('KB-END-B')] }] });
    const bodies = [Buffer.from(await pdf.save()), await Packer.toBuffer(docx), Buffer.from('虚构补充材料，未提供不代表不存在。\nKB-END-C')];
    for (let i = 0; i < ids.length; i++) { fs.writeFileSync(path.join(f.scope.dir, ids[i]), bodies[i]); readDB().knowledgeFiles.push({ filename: ids[i], userId: f.context.userId, domain: 'personal', status: 'indexed', extractionStatus: 'indexed' } as any); }
    await flushDBOrThrow();
    const record = await executeToolCall({ registry, name: 'knowledge_file_stats', arguments: { fileIds: ids }, context: f.context });
    expect(record.error).toBeUndefined(); expect(record.terminalVerification?.status).toBe('verified');
    const receipt = JSON.parse(record.result); expect(receipt).toMatchObject({ ok: true, mode: 'source_text', status: 'observed' });
    expect(receipt.files.map((file: any) => file.fileId)).toEqual(ids);
    for (let i = 0; i < ids.length; i++) { const file = receipt.files[i]; expect(file.text).toContain('KB-END-' + 'ABC'[i]); expect(file.truncated).toBe(false); expect(file.characters).toBe(file.text.length); expect(file.sourceHash).toBe(digest(bodies[i])); expect(file.sourceRevision).toBe(file.sourceHash); expect(file.textHash).toBe(digest(file.text)); expect(file.path).toBeUndefined(); }
    expect(receipt.files[0].text).toContain('TABLE-ROW-ORACLE 613927'); expect(record.result).not.toContain(f.scope.dir); expect(receipt.fullyAbsorbed).toBeUndefined();
  });

  it('passes actual canonical multi-source originals into the existing legal resolver and child model prompt', async () => {
    const ids = ['claim.txt', 'defense.txt', 'supplement.txt'], f = bound(ids);
    const texts = ['原告虚构甲主张9万元，未核实原件。KB-CHILD-END-A', '被告虚构乙称付7万元但付款截图尚未核实，2万元并非承认欠款。KB-CHILD-END-B', '未提供付款期限资料，不代表没有约定。KB-CHILD-END-C'];
    for (let i = 0; i < ids.length; i++) { fs.writeFileSync(path.join(f.scope.dir, ids[i]), texts[i]); readDB().knowledgeFiles.push({ filename: ids[i], userId: f.context.userId, domain: 'personal' } as any); } await flushDBOrThrow();
    const record = await executeToolCall({ registry, name: 'knowledge_file_stats', arguments: { fileIds: ids }, context: f.context });
    expect(record.adapterStarted).toBe(true); expect(isSuccessfulExactDocumentRead(record)).toBe(true);
    const create = vi.fn(async () => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ entries: [{ issue: '原告货款主张及被告付款主张如何核对？', sourceIds: ['F1', 'F2'] }] }) }, finish_reason: 'stop' }] }));
    upsertUserPreferredLLM(f.context.userId!, { provider: 'openai', model: 'synthetic-child', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
    const childContext = { ...f.context, dataRoutingPolicy: 'policy_scoped' as const, llmGetters: { getOpenAI: () => ({ chat: { completions: { create } } }) }, getCurrentToolRecords: () => [record] };
    const resolved = resolveLegalCaseArguments('legal_extract_dispute_focus', { facts: '模型改写：被告承认2万元', evidence: '模型改写：真实付款已核准', persistCase: false }, childContext);
    for (let i = 0; i < texts.length; i++) { expect(resolved.materials).toContain(texts[i]); expect(resolved.materials).toContain('fileId=' + ids[i]); expect(resolved.materials).toContain('textSHA256=' + digest(texts[i])); }
    expect(resolved.facts).toBeUndefined(); expect(resolved.materials).not.toContain('模型改写');
    await extractDisputeFocusHandler(resolved, childContext); expect(create).toHaveBeenCalledOnce();
    const modelInput = JSON.stringify((create.mock.calls[0] as any[])[0].messages); for (const text of texts) expect(modelInput).toContain(text); expect(modelInput).not.toContain('模型改写');
    const payload = JSON.parse(record.result), scope = { userId: f.context.userId!, domain: 'personal', orgId: '' };
    for (const variant of ['actor', 'domain', 'mode', 'pending', 'truncated', 'empty', 'textHash', 'revision', 'extraFile', 'wrongRequest', 'wrongTask', 'unverified', 'plain'] as const) {
      const bad = structuredClone(record), changed = structuredClone(payload);
      if (variant === 'actor') changed.userId = 'wrong-actor'; if (variant === 'domain') changed.domain = 'work'; if (variant === 'mode') changed.mode = 'inventory'; if (variant === 'pending') changed.status = 'pending'; if (variant === 'truncated') changed.files[0].truncated = true; if (variant === 'empty') changed.files[0].text = ''; if (variant === 'textHash') changed.files[0].textHash = '0'.repeat(64); if (variant === 'revision') changed.files[0].sourceRevision = '0'.repeat(64); if (variant === 'extraFile') changed.files.push(changed.files[0]);
      bad.result = variant === 'plain' ? 'pretended source text' : JSON.stringify(changed); if (variant === 'wrongRequest') bad.requestId = 'wrong-request'; if (variant === 'wrongTask') bad.taskId = 'wrong-task'; if (variant === 'unverified') bad.terminalVerification!.status = 'unverified';
      expect(documentReadMatchesRequestedTarget(bad, 'claim.txt；defense.txt；supplement.txt', undefined, [], scope), variant).toBe(false);
      const rejected = resolveLegalCaseArguments('legal_extract_dispute_focus', { facts: 'forged parent facts', persistCase: false }, { ...childContext, getCurrentToolRecords: () => [bad] });
      for (const text of texts) expect(rejected.materials, variant).not.toContain(text);
    }
    const stats = { ...record, arguments: {}, result: JSON.stringify({ totalFiles: 3, files: payload.files.map((x: any) => ({ name: x.name, status: 'indexed_unverified' })) }) }; expect(isSuccessfulExactDocumentRead(stats)).toBe(false); expect(actualDocumentReadContent(stats)).toBe('');
  });

  it('keeps inventory mode metadata-only and unverified ingestion status unchanged', async () => {
    const f = await source(); const spy = vi.spyOn(parser, 'parseDocument');
    const result = JSON.parse(await registry.get('knowledge_file_stats')!.handler({}, f.context));
    expect(result).toMatchObject({ totalFiles: 1, verifiedFiles: 0, indexedUnverifiedFiles: 1, fullyAbsorbed: false });
    expect(result.files[0].text).toBeUndefined(); expect(spy).not.toHaveBeenCalled();
  });

  it.each([[], '', null, ['../source.txt'], ['D:/source.txt'], [''], [9]].map(ids => ({ ids })))('rejects invalid IDs without parsing or guessing a path: $ids', async ({ ids }) => {
    const f = await source(); const spy = vi.spyOn(parser, 'parseDocument');
    await expect(read(ids, f.context)).rejects.toThrow(/fileIds/); expect(spy).not.toHaveBeenCalled();
  });

  it('requires the exact persisted current user request and rejects substring aliases and assistant/routed claims', async () => {
    const f = await source('KB-source.txt'); const spy = vi.spyOn(parser, 'parseDocument');
    for (const context of [{ ...f.context, userId: 'another-user' }, { ...f.context, requestId: 'another-request' }, { ...f.context, conversationId: 'another-conversation' }, { ...f.context, domain: 'work', orgId: 'other-org' }, { ...f.context, authenticated: false }, { ...f.context, executionBoundary: 'remote_restricted' as const }]) await expect(read(['KB-source.txt'], context)).rejects.toThrow();
    await expect(read(['source.txt'], f.context)).rejects.toThrow(/explicitly referenced/);
    await expect(read(['not-referenced.txt'], { ...f.context, routedTaskText: 'not-referenced.txt', actionIntent: 'not-referenced.txt' })).rejects.toThrow(/explicitly referenced/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('denies a different actor even when that actor explicitly names an owned file', async () => {
    const f = await source(); const other = bound(['source.txt']);
    await expect(read(['source.txt'], other.context)).rejects.toThrow(/scope/);
    expect(fs.existsSync(path.join(f.scope.dir, 'source.txt'))).toBe(true);
  });

  it('fails the complete multi-file call rather than returning cached body when one explicit ID is missing', async () => {
    const f = await source(); const exact = bound(['source.txt', 'missing.txt'], 'personal', '', f.context.userId);
    await expect(read(['source.txt', 'missing.txt'], exact.context)).rejects.toThrow(/scope/);
  });

  it.each(['metadata', 'bytes'] as const)('rechecks the first source %s before returning a later multi-file result', async change => {
    const first = await source('first.txt', 'FIRST VIRTUAL SOURCE'); const f = bound(['first.txt', 'later.txt'], 'personal', '', first.context.userId);
    fs.writeFileSync(path.join(f.scope.dir, 'later.txt'), 'LATER VIRTUAL SOURCE'); readDB().knowledgeFiles.push({ filename: 'later.txt', userId: f.context.userId, domain: 'personal' } as any); await flushDBOrThrow();
    vi.spyOn(parser, 'parseDocument').mockImplementation(async (...args) => { const result = await realParse(...args); if (path.basename(args[0]) === 'later.txt') { if (change === 'metadata') { readDB().knowledgeFiles.find((x: any) => x.filename === 'first.txt' && x.userId === f.context.userId)!.userId = 'revoked-owner'; await flushDBOrThrow(); } else fs.writeFileSync(path.join(f.scope.dir, 'first.txt'), 'CHANGED FIRST SOURCE'); } return result; });
    await expect(read(['first.txt', 'later.txt'], f.context)).rejects.toThrow(/scope|changed/);
  });

  it('shares the same safe full-text implementation with the authenticated HTTP route', async () => {
    const f = await source(); const tool = JSON.parse(await read(['source.txt'], f.context)).files[0];
    const cookie = 'token=' + jwt.sign({ uid: f.context.userId, username: 'virtual-reader' }, JWT_SECRET);
    const response = await fetch(app.url + '/api/files/text/source.txt?domain=personal', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(tool);
  });

  it.each(['file', 'scope', 'metadata', 'cancel'] as const)('rechecks %s after real local asynchronous extraction and never serves a stale grant', async kind => {
    const f = await source(); const controller = new AbortController();
    vi.spyOn(parser, 'parseDocument').mockImplementationOnce(async (...args) => { const result = await realParse(...args); if (kind === 'file') fs.writeFileSync(path.join(f.scope.dir, 'source.txt'), 'REPLACED SOURCE'); if (kind === 'scope') f.scope.dir = getPersonalKnowledgeDirectory('other-owner').dir; if (kind === 'metadata') { readDB().knowledgeFiles.find((x: any) => x.filename === 'source.txt' && x.userId === f.context.userId)!.userId = 'other-owner'; await flushDBOrThrow(); } if (kind === 'cancel') controller.abort(); return result; });
    await expect(readKnowledgeSourceText('source.txt', () => f.scope, { signal: controller.signal })).rejects.toThrow();
  });

  it('rejects a same-size rewrite even if mtime is restored and observes a new revision on a later valid read', async () => {
    const f = await source('source.txt', 'AAAA'); const file = path.join(f.scope.dir, 'source.txt'), old = fs.statSync(file); const first = await readKnowledgeSourceText('source.txt', () => f.scope);
    vi.spyOn(parser, 'parseDocument').mockImplementationOnce(async (...args) => { const result = await realParse(...args); fs.writeFileSync(file, 'BBBB'); fs.utimesSync(file, old.atime, old.mtime); return result; });
    await expect(readKnowledgeSourceText('source.txt', () => f.scope)).rejects.toThrow(/changed/);
    const second = await readKnowledgeSourceText('source.txt', () => f.scope); expect(second.text).toBe('BBBB'); expect(second.sourceHash).not.toBe(first.sourceHash);
  });

  it('rejects scoped file symlinks that redirect outside the knowledge root', async () => {
    const f = await source('outside.txt'); const own = bound(['source.txt']);
    fs.symlinkSync(path.join(f.scope.dir, 'outside.txt'), path.join(own.scope.dir, 'source.txt'));
    readDB().knowledgeFiles.push({ filename: 'source.txt', userId: own.context.userId, domain: 'personal' } as any); await flushDBOrThrow();
    await expect(read(['source.txt'], own.context)).rejects.toThrow(/outside/);
  });

  it('does not invoke cloud OCR for empty, scanned or image sources under standard mode plus local_only', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'standard'); const scanned = await PDFDocument.create(); scanned.addPage().drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
    const transport = vi.spyOn(globalThis, 'fetch');
    for (const [name, body] of [['empty.txt', ''], ['scanned.pdf', Buffer.from(await scanned.save())], ['image.png', Buffer.from('not-decoded-image')]] as const) { const f = await source(name, body); await expect(read([name], f.context)).rejects.toThrow(/readable|separate extraction/); }
    expect(transport).not.toHaveBeenCalled();
  });

  it('requires active exact organization membership and the original domain', async () => {
    const owner = 'org-owner-' + crypto.randomUUID(), member = 'org-member-' + crypto.randomUUID(); const org = createOrg('Virtual org', crypto.randomUUID(), owner); addMember(org.id, owner, 'owner'); addMember(org.id, member, 'member');
    const f = await source('org.txt', 'VIRTUAL ORG SOURCE', 'work', org.id, member); expect(JSON.parse(await read(['org.txt'], f.context)).files[0].text).toBe('VIRTUAL ORG SOURCE');
    setMemberStatus(org.id, member, 'suspended'); await expect(read(['org.txt'], f.context)).rejects.toThrow(/membership/);
    await expect(read(['org.txt'], { ...f.context, domain: 'personal', orgId: '' })).rejects.toThrow(/explicitly/);
  });

  it.each(['status', 'role', 'identity', 'acl'] as const)('rejects organization %s changes during the actual local extraction', async change => {
    const owner = 'drift-owner-' + crypto.randomUUID(), reader = 'drift-reader-' + crypto.randomUUID(); const org = createOrg('Virtual drift org', crypto.randomUUID(), owner); addMember(org.id, owner, 'owner'); addMember(org.id, reader, 'member');
    const f = await source('drift.txt', 'VIRTUAL DRIFT SOURCE', 'work', org.id, reader); const articleId = 'drift-article-' + crypto.randomUUID(); const meta = readDB().knowledgeFiles.find((x: any) => x.userId === reader)!; meta.userId = owner; meta.orgArticleId = articleId; await flushDBOrThrow();
    setOrganizationResourcePolicy({ orgId: org.id, actorUserId: owner, ownerUserId: owner, resourceType: 'knowledge_article', resourceId: articleId, classification: 'restricted', grants: [{ subjectType: 'member', subjectId: reader, permissions: ['read'] }] });
    vi.spyOn(parser, 'parseDocument').mockImplementationOnce(async (...args) => { const result = await realParse(...args); if (change === 'status') setMemberStatus(org.id, reader, 'left'); if (change === 'role') updateMemberRole(org.id, reader, 'viewer'); if (change === 'identity') { readDB().orgMemberships.find((x: any) => x.orgId === org.id && x.userId === reader)!.id = crypto.randomUUID(); await flushDBOrThrow(); } if (change === 'acl') setOrganizationResourcePolicy({ orgId: org.id, actorUserId: owner, ownerUserId: owner, resourceType: 'knowledge_article', resourceId: articleId, classification: 'restricted', grants: [] }); return result; });
    await expect(read(['drift.txt'], f.context)).rejects.toThrow(/membership|Resource access denied/);
  });

  it('keeps local read separate from cloud share and respects restricted article denial', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'standard'); const owner = 'acl-owner-' + crypto.randomUUID(), reader = 'acl-reader-' + crypto.randomUUID(); const org = createOrg('Virtual protected org', crypto.randomUUID(), owner); addMember(org.id, owner, 'owner'); addMember(org.id, reader, 'member');
    const f = await source('private.txt', 'VIRTUAL PROTECTED SOURCE', 'work', org.id, reader); const meta = readDB().knowledgeFiles.find((x: any) => x.userId === reader)!; meta.userId = owner; meta.orgArticleId = 'virtual-article-' + crypto.randomUUID(); await flushDBOrThrow();
    setOrganizationResourcePolicy({ orgId: org.id, actorUserId: owner, ownerUserId: owner, resourceType: 'knowledge_article', resourceId: meta.orgArticleId, classification: 'restricted', grants: [{ subjectType: 'member', subjectId: reader, permissions: ['read'] }] });
    expect(JSON.parse(await read(['private.txt'], f.context)).files[0].text).toBe('VIRTUAL PROTECTED SOURCE');
    await expect(read(['private.txt'], { ...f.context, dataRoutingPolicy: 'policy_scoped' })).rejects.toThrow(/Resource access denied/);
    setOrganizationResourcePolicy({ orgId: org.id, actorUserId: owner, ownerUserId: owner, resourceType: 'knowledge_article', resourceId: meta.orgArticleId, classification: 'restricted', grants: [] });
    await expect(read(['private.txt'], f.context)).rejects.toThrow(/Resource access denied/);
  });
});
