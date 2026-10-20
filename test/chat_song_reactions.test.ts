import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { mountChatSongRoutes } from '../server/routes/chat_song_routes';
import { generatedKnowledgeDirectory } from '../server/files/knowledge_directory';
import { getChatSongProject, applyChatSongAction, chatSongHandoff } from '../server/creative/chat_song';
import { parseChatSongReactionResults, searchChatSongReactions } from '../server/creative/chat_song_reactions';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import type { ChatSongProject } from '../shared/chat_song';
const mock = vi.hoisted(() => ({ download: vi.fn(), llm: vi.fn(), media: vi.fn() }));
vi.mock('../server/tools/media_artifact', () => ({ downloadPublicMedia: (...args: any[]) => mock.download(...args) }));
vi.mock('../server/llm/providers', () => ({ makeLLMCall: (...args: any[]) => mock.llm(...args), makeLLMCallStreaming: (...args: any[]) => mock.llm(...args) }));
vi.mock('../server/media/process', () => ({ runMediaProcess: (...args: any[]) => mock.media(...args) }));
let app: Awaited<ReturnType<typeof makeApp>>, png: Buffer;
const owner = 'web-reaction-owner';
const rawLines = [{ role: 'A', text: '资料先核对。', group: 1, reaction: '惊讶' }, { role: 'B', text: '好，再一起看看。', group: 1, reaction: '惊讶' }];
const card = (query: string, image = 'https://img.adoutu.com/picture/123.png') => `<a href="/picture/123"><img alt="熊猫${query}表情" src="${image}"/></a>`;
async function request(url = '', method = 'GET', body?: any, uid = owner, work = false) {
  const response = await fetch(`${app.url}/api/creative/chat-songs${url}`, { method, headers: { Authorization: 'Bearer ' + jwt.sign({ uid, username: uid, role: 'user', ...(work ? { orgId: 'work-org' } : {}) }, JWT_SECRET), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null), response };
}
async function create(): Promise<ChatSongProject> { return (await request('', 'POST', { id: randomUUID(), title: 'Synthetic web reactions' })).body; }
async function save(p: ChatSongProject, lines = rawLines, reactions?: any[]) { return request('/' + p.id, 'PATCH', { revision: p.revision, project: { title: p.title, brief: p.brief, lines, ...(reactions ? { reactions } : {}) } }); }
async function search(p: ChatSongProject, lines?: any[], extra = {}) { return request('/' + p.id + '/reactions/search', 'POST', { revision: p.revision, ...(lines ? { lines } : {}), ...extra }); }
beforeAll(async () => { app = await makeApp(); mountChatSongRoutes(app.apiRouter, LLM_GETTERS); png = await (sharp as any)({ create: { width: 80, height: 60, channels: 3, background: '#aabbcc' } }).png().toBuffer(); });
beforeEach(() => {
  mock.download.mockReset().mockImplementation(async (url: string) => url.startsWith('https://www.adoutu.com/search?') ? { bytes: Buffer.from(card(new URL(url).searchParams.get('keyword') || '')), contentType: 'text/html' } : { bytes: png, contentType: 'image/png' });
  mock.llm.mockReset().mockResolvedValue({ text: JSON.stringify({ lines: rawLines }), finishReason: 'stop' });
  mock.media.mockReset().mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 12 } }));
});
afterAll(() => app.cleanup());
afterEach(() => vi.restoreAllMocks());

it('parses only literal matching public-site cards and rejects unrelated/unsafe results', () => {
  expect(parseChatSongReactionResults(card('惊讶') + card('开心') + card('惊讶', 'http://127.0.0.1/a.png') + card('惊讶', 'https://evil.example/a.png'), '惊讶')).toEqual([{ title: '熊猫惊讶表情', sourceUrl: 'https://www.adoutu.com/picture/123', imageUrl: 'https://img.adoutu.com/picture/123.png' }]);
});
it('returns decoded same-origin previews, provenance and stable IDs without leaking dialogue into search', async () => {
  const p = await create(), result = await search(p, rawLines);
  expect(result.status).toBe(200); expect(result.body.reactions).toHaveLength(2);
  const candidate = result.body.reactions[0].candidates[0];
  expect(candidate).toMatchObject({ lineId: '01', query: '惊讶', title: '熊猫惊讶表情', sourceUrl: 'https://www.adoutu.com/picture/123', imageUrl: 'https://img.adoutu.com/picture/123.png', width: 80, height: 60 });
  expect(candidate.id).toMatch(/^[a-f0-9]{64}$/); expect(candidate.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(mock.download.mock.calls.filter(([url]) => url.startsWith('https://www.adoutu.com/search?'))).toHaveLength(1);
  expect(mock.download.mock.calls.filter(([url]) => url.startsWith('https://img.adoutu.com/'))).toHaveLength(1);
  expect(JSON.stringify(mock.download.mock.calls)).not.toContain(rawLines[0].text);
  const preview = await fetch(app.url + candidate.previewUrl, { headers: { Authorization: 'Bearer ' + jwt.sign({ uid: owner, username: owner, role: 'user' }, JWT_SECRET) } });
  expect(preview.status).toBe(200); expect(preview.headers.get('content-type')).toContain('image/png');
  expect(createHash('sha256').update(Buffer.from(await preview.arrayBuffer())).digest('hex')).toBe(candidate.sha256);
  const repeated = await search(p, rawLines); expect(repeated.body.reactions[0].candidates[0].id).toBe(candidate.id);
});
it('adopts new dialogue and selected images atomically through the existing save contract', async () => {
  const p = await create(), result = await search(p, rawLines), candidates = result.body.reactions.map((r: any) => ({ lineId: r.lineId, candidateId: r.candidates[0].id }));
  const saved = await save(p, rawLines, candidates);
  expect(saved.status).toBe(200); expect(saved.body.lines.map((l: any) => l.text)).toEqual(rawLines.map(l => l.text));
  expect(saved.body.assets).toHaveLength(2); expect(saved.body.assets.every((a: any) => a.kind === 'reaction' && a.reactionSource.query === '惊讶' && a.reactionSource.sourceUrl === 'https://www.adoutu.com/picture/123')).toBe(true);
  const dir = generatedKnowledgeDirectory({ userId: owner, domain: 'personal' });
  for (const asset of saved.body.assets) expect(createHash('sha256').update(fs.readFileSync(path.join(dir, asset.fileId))).digest('hex')).toBe(asset.sha256);
  expect(new Set(saved.body.assets.map((a: any) => a.fileId)).size).toBe(1);
});
it('rejects unknown/foreign/stale or edited-line candidates before writing any project or image', async () => {
  const p = await create(), result = await search(p, rawLines), candidate = result.body.reactions[0].candidates[0];
  const dir = generatedKnowledgeDirectory({ userId: owner, domain: 'personal' }), before = fs.readdirSync(dir);
  expect((await save(p, rawLines, [{ lineId: '01', candidateId: candidate.id }, { lineId: '02', candidateId: '0'.repeat(64) }])).status).toBe(409);
  expect(getChatSongProject(owner, p.id)).toEqual(p); expect(fs.readdirSync(dir)).toEqual(before);
  expect((await save(p, [{ ...rawLines[0], text: 'Different source text' }, rawLines[1]], [{ lineId: '01', candidateId: candidate.id }])).status).toBe(409);
  const other = await create(); expect((await save(other, rawLines, [{ lineId: '01', candidateId: candidate.id }])).status).toBe(409);
  const changed = (await save(p)).body;
  expect((await request('/' + p.id + '/action', 'POST', { revision: changed.revision, action: 'attach-asset', value: { kind: 'reaction', lineId: '01', candidateId: candidate.id } })).status).toBe(409);
  expect((await search(p, rawLines)).status).toBe(409);
  expect((await request('/' + p.id + '/reactions/search', 'POST', { revision: changed.revision }, 'someone-else')).status).toBe(404);
  expect((await request('/' + p.id + '/reactions/search?domain=work', 'POST', { revision: changed.revision }, owner, true)).status).toBe(403);
});
it('searches during dialogue drafting without auto-saving or sending private dialogue', async () => {
  const p = await create(); upsertUserPreferredLLM(owner, { provider: 'relay', model: 'synthetic-official' });
  const result = await request('/' + p.id + '/draft', 'POST', { revision: p.revision });
  expect(result.status).toBe(200); expect(result.body.reactions[0].status).toBe('matched');
  expect(getChatSongProject(owner, p.id)).toEqual(p); expect(mock.llm).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mock.download.mock.calls)).not.toContain('资料先核对');
});
it('returns explicit empty/no-match/network/decoding states and has no AI fallback', async () => {
  const p = await create(); mock.download.mockResolvedValueOnce({ bytes: Buffer.from(card('完全不相关')), contentType: 'text/html' });
  expect((await search(p, [rawLines[0]])).body.reactions[0].status).toBe('no_match');
  mock.download.mockRejectedValue(new Error('network failed'));
  expect((await search(p, [{ ...rawLines[0], reaction: '无奈' }])).body.reactions[0].status).toBe('unavailable');
  mock.download.mockClear(); expect((await search(p, [{ ...rawLines[0], reaction: '' }])).body.reactions[0].status).toBe('empty'); expect(mock.download).not.toHaveBeenCalled();
  expect(mock.llm).not.toHaveBeenCalled(); expect(chatSongHandoff({ ...p, lines: [{ ...rawLines[0], id: '01' } as any] }).prompts.some(row => row.kind === 'reaction')).toBe(false);
});
it('blocks all external keyword requests for strict/local-only and skips animation', async () => {
  const p = await create();
  expect((await search(p, rawLines, { dataRoutingPolicy: 'local_only' })).body.reactions.every((r: any) => r.status === 'privacy_blocked')).toBe(true);
  process.env.LUMI_PRIVACY = 'strict';
  try { expect((await search(p, rawLines)).body.reactions.every((r: any) => r.status === 'privacy_blocked')).toBe(true); } finally { delete process.env.LUMI_PRIVACY; }
  const animated = (await request('/' + p.id, 'PATCH', { revision: p.revision, project: { title: p.title, brief: { ...p.brief, outputStyle: 'animation' }, lines: rawLines } })).body;
  expect((await search(animated)).body.reactions.every((r: any) => r.status === 'skipped')).toBe(true); expect(mock.download).not.toHaveBeenCalled();
});
it('preserves saved song, script identity and real timings when only reaction words/images change', async () => {
  let p = (await save(await create(), rawLines.map(l => ({ ...l, reaction: '' })))).body;
  p = await applyChatSongAction(owner, p.id, p.revision, 'lock-script', undefined);
  const dir = generatedKnowledgeDirectory({ userId: owner, domain: 'personal' }); fs.writeFileSync(path.join(dir, 'reaction-song.wav'), 'synthetic audio; ffprobe mocked');
  p = await applyChatSongAction(owner, p.id, p.revision, 'select-song', { fileId: 'reaction-song.wav' });
  p = await applyChatSongAction(owner, p.id, p.revision, 'set-timings', [{ lineId: '01', start: 0, end: 4 }, { lineId: '02', start: 5, end: 11 }]);
  const result = await search(p, rawLines), candidate = result.body.reactions[0].candidates[0];
  const saved = await save(p, rawLines, [{ lineId: '01', candidateId: candidate.id }]);
  expect(saved.status).toBe(200); expect(saved.body.scriptRevision).toBe(p.scriptRevision); expect(saved.body.scriptLocked).toBe(true); expect(saved.body.song).toEqual(p.song); expect(saved.body.timings).toEqual(p.timings);
});
it('supports all forty line slots plus three global pictures within the bounded existing asset contract', async () => {
  const p = await create(), rows = Array.from({ length: 40 }, (_, i) => ({ ...rawLines[i % 2], group: i + 1 }));
  const result = await search(p, rows), saved = await save(p, rows, result.body.reactions.map((r: any) => ({ lineId: r.lineId, candidateId: r.candidates[0].id })));
  expect(saved.status).toBe(200); expect(saved.body.assets).toHaveLength(40); expect(mock.download.mock.calls.filter(([url]) => url.startsWith('https://www.adoutu.com/search?'))).toHaveLength(1);
});

it('rejects forged URL input, duplicate selections, invalid line input and another owner preview', async () => {
  const p = await create(), result = await search(p, rawLines), candidate = result.body.reactions[0].candidates[0];
  expect((await request('/' + p.id + '/action', 'POST', { revision: p.revision, action: 'attach-asset', value: { kind: 'reaction', lineId: '01', candidateId: candidate.id, imageUrl: 'https://evil.example/a.png' } })).status).toBe(400);
  expect((await save(p, rawLines, [{ lineId: '01', candidateId: candidate.id }, { lineId: '01', candidateId: candidate.id }])).status).toBe(400);
  expect((await search(p, [null])).status).toBe(400);
  const preview = await request('/' + p.id + '/reactions/' + candidate.id + '/preview', 'GET', undefined, 'different-owner');
  expect(preview.status).toBe(404); expect(getChatSongProject(owner, p.id)).toEqual(p);
});
it('does not accept expired candidate bytes or silently replace them with a new remote image', async () => {
  const p = await create(), result = await search(p, rawLines), candidate = result.body.reactions[0].candidates[0], now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000); mock.download.mockClear();
  expect((await save(p, rawLines, [{ lineId: '01', candidateId: candidate.id }])).status).toBe(409);
  expect(mock.download).not.toHaveBeenCalled(); expect(getChatSongProject(owner, p.id)).toEqual(p);
});
it.each(['svg', 'oversized', 'broken'])('marks undecodable or oversized %s search images unavailable', async kind => {
  const p = await create(), query = '图像' + kind;
  const bytes = kind === 'oversized' ? await (sharp as any)({ create: { width: 2200, height: 2200, channels: 3, background: '#ffccaa' } }).png().toBuffer()
    : Buffer.from(kind === 'svg' ? '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>' : 'not-an-image');
  mock.download.mockImplementation(async (url: string) => url.includes('/search?') ? { bytes: Buffer.from(card(query, `https://img.adoutu.com/picture/${kind}.png`)), contentType: 'text/html' } : { bytes, contentType: 'image/png' });
  const result = await search(p, [{ ...rawLines[0], reaction: query }]);
  expect(result.status).toBe(200); expect(result.body.reactions[0]).toMatchObject({ status: 'unavailable', candidates: [] }); expect(getChatSongProject(owner, p.id)).toEqual(p);
});
it('propagates real HTTP disconnect cancellation to the bounded public search', async () => {
  const p = await create(), abort = new AbortController(); let started!: () => void, downloadSignal: AbortSignal | undefined;
  const began = new Promise<void>(resolve => { started = resolve; });
  mock.download.mockImplementation(async (_url: string, options: any) => { downloadSignal = options.signal; started(); return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); });
  const pending = fetch(`${app.url}/api/creative/chat-songs/${p.id}/reactions/search`, { method: 'POST', headers: { Authorization: 'Bearer ' + jwt.sign({ uid: owner, username: owner, role: 'user' }, JWT_SECRET), 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: p.revision, lines: [{ ...rawLines[0], reaction: '取消探针' }] }), signal: abort.signal }).catch(e => e);
  await began; abort.abort(); await pending; await vi.waitFor(() => expect(downloadSignal?.aborted).toBe(true));
  expect(getChatSongProject(owner, p.id)).toEqual(p); expect(mock.llm).not.toHaveBeenCalled();
});
it('keeps query/download concurrency bounded and sends neither author names nor full dialogue', async () => {
  const p = await create(); let active = 0, max = 0;
  mock.download.mockImplementation(async (url: string, options: any) => {
    active++; max = Math.max(max, active); expect(options.maxBytes).toBeLessThanOrEqual(2 * 1024 * 1024); expect(options.signal).toBeInstanceOf(AbortSignal);
    await new Promise(resolve => setTimeout(resolve, 3)); active--;
    return url.includes('/search?') ? { bytes: Buffer.from(card(new URL(url).searchParams.get('keyword')!, `https://img.adoutu.com/picture/${new URL(url).searchParams.get('keyword')!.length}.png`)), contentType: 'text/html' } : { bytes: png, contentType: 'image/png' };
  });
  const rows = Array.from({ length: 10 }, (_, i) => ({ ...rawLines[i % 2], reaction: '检索' + i }));
  expect((await search(p, rows)).status).toBe(200); expect(max).toBeLessThanOrEqual(3);
  expect(JSON.stringify(mock.download.mock.calls)).not.toContain('好，再一起看看');
});
