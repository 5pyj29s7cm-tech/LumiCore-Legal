import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { generatedKnowledgeDirectory } from '../server/files/knowledge_directory';
import { changeChatSongProject, getChatSongProject, renderChatSongStrip, saveChatSongRender } from '../server/creative/chat_song';
import { chatSongRenderTimeline, renderChatSongVideo } from '../server/creative/chat_song_render';
import { mountChatSongRoutes } from '../server/routes/chat_song_routes';
import { CHAT_SONG_TEMPLATE, chatSongGroupLayout, chatSongStripLayout } from '../shared/chat_song_layout';
import { chatSongSongCurrent, visibleChatSongLines, type ChatSongProject } from '../shared/chat_song';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
const mock = vi.hoisted(() => ({ llm: vi.fn(), media: vi.fn() }));
vi.mock('../server/llm/providers', () => ({ makeLLMCall: (...args: any[]) => mock.llm(...args), makeLLMCallStreaming: (...args: any[]) => mock.llm(...args) }));
vi.mock('../server/media/process', () => ({ runMediaProcess: (...args: any[]) => mock.media(...args) }));

let app: Awaited<ReturnType<typeof makeApp>>, dir: string;
const owner = 'chat-song-owner';
const lines = [
  { role: 'A', text: '你怎么还没回家？', group: 1, reaction: '' },
  { role: 'B', text: '钥匙在你手里。', group: 1, reaction: '惊讶' },
  { role: 'A', text: '=原来如此', group: 2, reaction: '' },
];
function token(uid = owner, orgId?: string) { return jwt.sign({ uid, username: uid, role: 'user', ...(orgId ? { orgId } : {}) }, JWT_SECRET); }
async function request(url = '', method = 'GET', body?: any, uid = owner, orgId?: string) {
  const response = await fetch(`${app.url}/api/creative/chat-songs${url}`, { method, headers: { Authorization: `Bearer ${token(uid, orgId)}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function create(): Promise<ChatSongProject> { const result = await request('', 'POST', { id: randomUUID(), title: 'Synthetic episode' }); expect(result.status).toBe(201); return result.body; }
async function edit(p: ChatSongProject, patch: any = {}) { return request(`/${p.id}`, 'PATCH', { revision: p.revision, project: { title: p.title, brief: p.brief, lines: p.lines.map(({ id: _id, ...line }) => line), ...patch } }); }
async function action(p: ChatSongProject, action: string, value?: any) { return request(`/${p.id}/action`, 'POST', { revision: p.revision, action, value }); }
async function locked() { const p = (await edit(await create(), { lines })).body; return (await action(p, 'lock-script')).body as ChatSongProject; }
async function withSong() {
  let p = await locked();
  p = (await action(p, 'select-song', { fileId: 'song.wav' })).body;
  p = (await action(p, 'confirm-song', { noOmissions: true, noRewrites: true, noRepeats: true, correctOrder: true })).body;
  return p;
}
const timeRows = [{ lineId: '01', start: 1, end: 3 }, { lineId: '02', start: 4, end: 6 }, { lineId: '03', start: 8, end: 10 }];
beforeAll(async () => {
  app = await makeApp(); mountChatSongRoutes(app.apiRouter, LLM_GETTERS);
  dir = generatedKnowledgeDirectory({ userId: owner, domain: 'personal' });
  fs.writeFileSync(path.join(dir, 'song.wav'), 'test fixture; ffprobe mocked in this suite');
  fs.writeFileSync(path.join(dir, 'avatar.png'), await (sharp as any)({ create: { width: 40, height: 40, channels: 3, background: '#987654' } }).png().toBuffer());
});
beforeEach(() => {
  mock.llm.mockReset().mockResolvedValue({ text: JSON.stringify({ lines }), finishReason: 'stop' });
  mock.media.mockReset().mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '12.5' } }));
});
afterAll(() => { app.cleanup(); });

it('requires authentication and isolates account and work access', async () => {
  const p = await create();
  expect((await fetch(`${app.url}/api/creative/chat-songs`)).status).toBe(401);
  expect((await request(`/${p.id}`, 'GET', undefined, 'other-owner')).status).toBe(404);
  expect((await request('', 'GET', undefined, owner, 'some-org')).status).toBe(403);
  expect((await request('?domain=work')).status).toBe(403);
  expect((await request('', 'GET', undefined, 'other-owner')).body.projects).toEqual([]);
});
it('persists across reloads, deduplicates creation and rejects stale concurrent edits', async () => {
  const p = await create();
  expect((await request('', 'POST', { id: p.id, title: p.title })).body).toEqual(p);
  const changes = await Promise.all([edit(p, { title: 'one' }), edit(p, { title: 'two' })]);
  expect(changes.map(result => result.status).sort()).toEqual([200, 409]);
  const saved = getChatSongProject(owner, p.id);
  expect(saved.revision).toBe(2); expect((await request(`/${p.id}`)).body).toEqual(saved);
});
it('requires a valid two-speaker script and ordered groups', async () => {
  const p = await create();
  expect((await action(p, 'lock-script')).status).toBe(400);
  expect((await edit(p, { lines: [{ ...lines[0], group: 2 }] })).status).toBe(400);
  expect((await edit(p, { lines: [{ ...lines[0], text: '' }] })).status).toBe(400);
  expect((await action(p, 'select-song', { fileId: 'song.wav' })).status).toBe(409);
});
it('uses measured audio and allows real timings without claiming optional lyric review', async () => {
  let p = await locked();
  expect((await action(p, 'select-song', { fileId: '../song.wav' })).status).toBe(400);
  expect((await action(p, 'select-song', { fileId: 'song.wav', duration: 999 })).status).toBe(400);
  p = (await action(p, 'select-song', { fileId: 'song.wav' })).body;
  expect(p.song?.duration).toBe(12.5);
  expect(mock.media.mock.calls[0][1]).toContain('-protocol_whitelist');
  expect((await action(p, 'confirm-song', { noOmissions: true })).status).toBe(400);
  const timed = await action(p, 'set-timings', timeRows);
  expect(timed.status).toBe(200); expect(timed.body.song.confirmed).toBe(false);
  p = timed.body;
  mock.media.mockResolvedValueOnce(JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: 12 } }));
  expect((await action(p, 'select-song', { fileId: 'song.wav' })).status).toBe(400);
});
it('rejects overlapping/partial/out-of-duration timing and reveals no later punchline', async () => {
  let p = await withSong();
  expect((await action(p, 'set-timings', timeRows.slice(0, 2))).status).toBe(400);
  expect((await action(p, 'set-timings', [{ ...timeRows[0], end: 5 }, ...timeRows.slice(1)])).status).toBe(400);
  expect((await action(p, 'set-timings', [...timeRows.slice(0, 2), { ...timeRows[2], end: 20 }])).status).toBe(400);
  p = (await action(p, 'set-timings', timeRows)).body;
  expect(visibleChatSongLines(p, 0)).toEqual([]);
  expect(visibleChatSongLines(p, 3.99).map(line => line.id)).toEqual(['01']);
  expect(visibleChatSongLines(p, 4).map(line => line.id)).toEqual(['02']);
  expect(visibleChatSongLines({ ...p, brief: { ...p.brief, messageLayout: 'conversation' } }, 4).map(line => line.id)).toEqual(['01', '02']);
  expect(visibleChatSongLines(p, 8).map(line => line.id)).toEqual(['03']);
});
it('invalidates downstream song/timing only when their source changes', async () => {
  let p = await withSong(); p = (await action(p, 'set-timings', timeRows)).body;
  const renamed = (await edit(p, { title: 'New title' })).body;
  expect(chatSongSongCurrent(renamed)).toBe(true); expect(renamed.timings).toEqual(timeRows);
  const changed = (await edit(renamed, { lines: [{ ...lines[0], text: '换一句。' }, ...lines.slice(1)] })).body;
  expect(changed.scriptLocked).toBe(false); expect(changed.song.confirmed).toBe(false); expect(changed.timings).toEqual([]);
  expect(visibleChatSongLines(changed, 8)).toEqual([]);
  const replaced = (await action(renamed, 'select-song', { fileId: 'song.wav' }));
  expect(replaced.status).toBe(409); // stale version must not overwrite the newer dialogue
});
it('reuses characters/settings without carrying the previous song or story into a new episode', async () => {
  let p = await withSong(); p = (await action(p, 'attach-asset', { kind: 'avatarA', fileId: 'avatar.png' })).body;
  p = (await action(p, 'attach-asset', { kind: 'reaction', lineId: '02', fileId: 'avatar.png' })).body;
  const next = (await request('', 'POST', { id: randomUUID(), title: 'Episode two', templateId: p.id })).body;
  expect(next.lines).toEqual([]); expect(next.song).toBeNull(); expect(next.timings).toEqual([]);
  expect(next.assets.map((asset: any) => asset.kind)).toEqual(['avatarA']);
  expect((await action(next, 'attach-asset', { kind: 'background', fileId: '../../avatar.png' })).status).toBe(400);
});
it('exports exact lyrics and real PNG strips with no invented timing or native project claim', async () => {
  const p = await locked();
  const output = await request(`/${p.id}/export`, 'POST', { revision: p.revision }); expect(output.status).toBe(200);
  expect(output.body.timed).toBe(false); expect(output.body.handoffs.edit).toBe('');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, output.body.fileId)));
  expect(await zip.file('01_对白与唱词/纯唱词.txt')!.async('string')).toBe(lines.map(line => line.text).join('\n'));
  expect(await zip.file('04_剪辑/画面顺序表.csv')!.async('string')).toContain("'=原来如此");
  expect((await zip.file('project.json')!.async('string'))).toContain('chat-song-materials-v1');
  expect(await sharp(await zip.file('02_画面素材/聊天_01.png')!.async('nodebuffer')).metadata()).toMatchObject({ format: 'png', width: chatSongStripLayout(p.lines[0], p.brief.displayNameA || p.brief.roleA).screenshot.width });
  expect(Object.keys(zip.files).some(name => name.endsWith('.wav'))).toBe(false);
  expect(fs.existsSync(path.join(dir, output.body.fileId.replace('.zip', '-01.png')))).toBe(true);
});
it('exports confirmed audio and measured timing and rejects replaced asset contents', async () => {
  let p = await withSong(); p = (await action(p, 'set-timings', timeRows)).body;
  p = (await action(p, 'attach-asset', { kind: 'background', fileId: 'avatar.png' })).body;
  const result = await request(`/${p.id}/export`, 'POST', { revision: p.revision }); expect(result.status).toBe(200); expect(result.body.timed).toBe(true); expect(result.body.handoffs.edit).toContain(p.id);
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, result.body.fileId)));
  expect(zip.file('03_歌曲/选定歌曲.wav')).toBeTruthy();
  const original = fs.readFileSync(path.join(dir, 'avatar.png'));
  try { fs.writeFileSync(path.join(dir, 'avatar.png'), Buffer.concat([original, Buffer.from('modified')])); expect((await request(`/${p.id}/export`, 'POST', { revision: p.revision })).status).toBe(409); }
  finally { fs.writeFileSync(path.join(dir, 'avatar.png'), original); }
});
it('keeps AI drafts separate from saved dialogue and pins calls to the official provider', async () => {
  const p = await locked();
  upsertUserPreferredLLM(owner, { provider: 'relay', selectionMode: 'ordered_fallback', fallbackCandidates: [{ provider: 'qwen', model: 'qwen-plus' }] });
  const result = await request(`/${p.id}/draft`, 'POST', { revision: p.revision });
  expect(result.status).toBe(200); expect(mock.llm.mock.calls[0][2]).toMatchObject({ provider: 'relay', reasoningEffort: 'low', responseFormat: 'json_object', selectionMode: 'pinned', noImplicitFailover: true });
  expect(mock.llm.mock.calls[0][2]).not.toHaveProperty('thinkingMode');
  expect(getChatSongProject(owner, p.id)).toEqual(p);
  mock.llm.mockResolvedValueOnce({ text: '{"lines":[' });
  expect((await request(`/${p.id}/draft`, 'POST', { revision: p.revision })).status).toBe(502);
  mock.llm.mockRejectedValueOnce(new Error('Cloud operation timed out after 60000ms'));
  expect((await request(`/${p.id}/draft`, 'POST', { revision: p.revision })).status).toBe(504);
  expect(getChatSongProject(owner, p.id)).toEqual(p);
  upsertUserPreferredLLM(owner, { provider: 'qwen' });
  expect((await request(`/${p.id}/draft`, 'POST', { revision: p.revision })).status).toBe(409);
});
it('preflights official media selections without rewriting user settings', async () => {
  const p = await create();
  upsertUserPreferredGenerationModels(owner, { image: { provider: 'auto' }, video: { provider: 'qwen' } });
  expect((await request(`/${p.id}/media-preflight`, 'POST', { mode: 'video' })).status).toBe(409);
  upsertUserPreferredGenerationModels(owner, { image: { provider: 'relay' }, video: { provider: 'relay' } });
  expect((await request(`/${p.id}/media-preflight`, 'POST', { mode: 'image' })).status).toBe(200);
  expect((await request(`/${p.id}/media-preflight`, 'POST', { mode: 'video' })).status).toBe(409);
  const chat = await withSong();
  expect((await request(`/${chat.id}/media-preflight`, 'POST', { mode: 'video', revision: chat.revision })).status).toBe(409);
  expect((await request(`/${chat.id}/handoff`)).body.prompts.some((p: any) => p.kind === 'clip')).toBe(false);
  const confirmed = (await edit(chat, { brief: { ...chat.brief, outputStyle: 'animation' } })).body;
  expect((await request(`/${confirmed.id}/media-preflight`, 'POST', { mode: 'video', revision: confirmed.revision })).status).toBe(200);
  expect((await request(`/${confirmed.id}/media-preflight`, 'POST', { mode: 'video', revision: confirmed.revision - 1 })).status).toBe(409);
  const handoff = await request(`/${confirmed.id}/handoff`);
  expect(handoff.body.prompts.filter((p: any) => p.kind === 'clip')).toHaveLength(confirmed.lines.length);
});

it('preserves dramatic model groups without mechanically pairing or changing lyrics and saved user groups', async () => {
  const p = await locked();
  upsertUserPreferredLLM(owner, { provider: 'relay' });
  const draft = Array.from({ length: 7 }, (_, index) => ({ ...lines[index % 3], group: index + 1 }));
  mock.llm.mockResolvedValueOnce({ text: JSON.stringify({ lines: draft }), finishReason: 'stop' });
  const result = await request(`/${p.id}/draft`, 'POST', { revision: p.revision });
  expect(result.status).toBe(200);
  expect(result.body.lines.map((line: any) => line.group)).toEqual(draft.map(line => line.group));
  expect(result.body.lines.map((line: any) => line.text)).toEqual(draft.map(line => line.text));
  expect(getChatSongProject(owner, p.id)).toEqual(p);
  mock.llm.mockResolvedValueOnce({ text: JSON.stringify({ lines }), finishReason: 'length' });
  expect((await request(`/${p.id}/draft`, 'POST', { revision: p.revision })).status).toBe(502);
});
it('requires bound audio, complete timing and a current revision before composition', async () => {
  const p = await locked();
  expect((await request(`/${p.id}/render`, 'POST', { revision: p.revision })).status).toBe(409);
  const confirmed = await withSong();
  expect((await request(`/${confirmed.id}/render`, 'POST', { revision: confirmed.revision })).status).toBe(400);
  expect((await request(`/${confirmed.id}/render`, 'POST', { revision: confirmed.revision - 1 })).status).toBe(409);
  expect((await request(`/${confirmed.id}/render`, 'GET', undefined, 'other-owner')).status).toBe(404);
  expect((await request(`/${confirmed.id}/render`)).body.render).toBeNull();
});
it('publishes only a verified render, reuses its receipt and rejects changed source files', async () => {
  const p = (await action(await withSong(), 'set-timings', timeRows)).body;
  mock.media.mockImplementation(async (binary, args) => {
    if (binary === 'ffmpeg') { fs.writeFileSync(args.at(-1), 'mock encoder output; real encoding covered by UI smoke'); return ''; }
    return JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1440 }, { codec_type: 'audio' }], format: { duration: 12.5 } });
  });
  const result = await request(`/${p.id}/render`, 'POST', { revision: p.revision });
  expect(result.status).toBe(200); expect(fs.existsSync(path.join(dir, result.body.render.fileId))).toBe(true);
  expect((await request(`/${p.id}/render`)).body).toEqual({ ...result.body, animation: null });
  expect((await request(`/${p.id}/render`, 'POST', { revision: p.revision })).body).toEqual(result.body);
  expect(mock.media.mock.calls.filter(([binary]) => binary === 'ffmpeg')).toHaveLength(1);
  saveChatSongRender(owner, p.id, { ...result.body.render, templateVersion: undefined });
  const refreshed = await request(`/${p.id}/render`, 'POST', { revision: p.revision });
  expect(refreshed.body.render.fileId).not.toBe(result.body.render.fileId);
  expect(refreshed.body.render.templateVersion).toBe(CHAT_SONG_TEMPLATE.version);
  expect(mock.media.mock.calls.filter(([binary]) => binary === 'ffmpeg')).toHaveLength(2);
  const source = fs.readFileSync(path.join(dir, 'song.wav'));
  try { fs.writeFileSync(path.join(dir, 'song.wav'), 'replaced'); expect((await request(`/${p.id}/render`, 'POST', { revision: p.revision })).status).toBe(409); }
  finally { fs.writeFileSync(path.join(dir, 'song.wav'), source); }
});
it('does not publish cancelled renders or an output made while the project changed', async () => {
  let p = (await action(await withSong(), 'set-timings', timeRows)).body;
  const controller = new AbortController();
  mock.media.mockImplementation(async (_binary, _args, signal) => { controller.abort(); signal.throwIfAborted(); });
  await expect(renderChatSongVideo(owner, p.id, p.revision, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect((await request(`/${p.id}/render`)).body.render).toBeNull();
  mock.media.mockImplementation(async (binary, args) => {
    if (binary === 'ffmpeg') {
      fs.writeFileSync(args.at(-1), 'mock encoder output');
      await changeChatSongProject(owner, p.id, p.revision, draft => { draft.title = 'Changed during render'; }); return '';
    }
    return JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1440 }, { codec_type: 'audio' }], format: { duration: 12.5 } });
  });
  expect((await request(`/${p.id}/render`, 'POST', { revision: p.revision })).status).toBe(409);
  expect((await request(`/${p.id}/render`)).body.render).toBeNull();
});
it('rounds lyric reveals forward to frame boundaries', async () => {
  const p = (await action(await withSong(), 'set-timings', [{ ...timeRows[0], start: 1.01 }, ...timeRows.slice(1)])).body;
  expect(chatSongRenderTimeline(p)[1].seconds).toBe(1.04);
});
it('renders long Chinese and escaped markup without cropping or parsing it as instructions', async () => {
  const bytes = await renderChatSongStrip({ id: '01', role: 'B', group: 1, reaction: '', text: '这是一句中文对白。<b>原样排版 & 不执行标记</b>。'.repeat(3) });
  const info = await sharp(bytes).metadata(); expect(info.width).toBe(1080); expect(info.height).toBeGreaterThan(128);
});

it('rejects a silent video as a song while accepting a measured audio stream in a video container', async () => {
  fs.writeFileSync(path.join(dir, 'native-song.mp4'), 'container fixture; probe mocked');
  const p = await locked();
  mock.media.mockResolvedValueOnce(JSON.stringify({ streams: [{ codec_type: 'video', width: 720, height: 1280 }], format: { duration: '12.5' } }));
  expect((await action(p, 'select-song', { fileId: 'native-song.mp4' })).status).toBe(400);
  expect(getChatSongProject(owner, p.id)).toEqual(p);
  mock.media.mockResolvedValueOnce(JSON.stringify({ streams: [{ codec_type: 'video', width: 720, height: 1280 }, { codec_type: 'audio' }], format: { duration: '12.5' } }));
  const selected = await action(p, 'select-song', { fileId: 'native-song.mp4' });
  expect(selected.status).toBe(200);
  expect(selected.body.song).toMatchObject({ fileId: 'native-song.mp4', duration: 12.5, confirmed: false });
});
it.each([{ video: true, explicitImage: false }, { video: false, explicitImage: false }, { video: true, explicitImage: true }])('preserves native audio and chooses the correct background: %j', async ({ video, explicitImage }) => {
  fs.writeFileSync(path.join(dir, 'native-background.mp4'), 'container fixture; probe mocked');
  let p = await locked();
  p = (await action(p, 'select-song', { fileId: 'native-background.mp4' })).body;
  p = (await action(p, 'confirm-song', { noOmissions: true, noRewrites: true, noRepeats: true, correctOrder: true })).body;
  p = (await action(p, 'set-timings', timeRows)).body;
  if (explicitImage) p = (await action(p, 'attach-asset', { fileId: 'avatar.png', kind: 'background' })).body;
  let encoderArgs: string[] = [], filter = '';
  mock.media.mockImplementation(async (binary, args) => {
    if (binary === 'ffmpeg') { encoderArgs = args; filter = fs.readFileSync(args[args.indexOf('-filter_complex_script') + 1], 'utf8'); fs.writeFileSync(args.at(-1), 'mock encoder output'); return ''; }
    if (args.at(-1).endsWith('result.mp4')) return JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1440 }, { codec_type: 'audio' }], format: { duration: 12.5 } });
    return JSON.stringify({ streams: [{ codec_type: 'audio' }, ...(video ? [{ codec_type: 'video', width: 720, height: 1280, disposition: { attached_pic: 0 } }] : [])] });
  });
  const result = await request('/' + p.id + '/render', 'POST', { revision: p.revision });
  expect(result.status).toBe(200);
  const sources = encoderArgs.flatMap((arg, index) => arg === '-i' ? [encoderArgs[index + 1]] : []);
  expect(encoderArgs).toContain('2:a:0');
  if (video && !explicitImage) { expect(sources[0]).toBe(sources[2]); expect(filter).toContain('force_original_aspect_ratio=decrease'); expect(filter).not.toContain('crop='); }
  else expect(sources[0]).toMatch(/background\.png$/);
});


it('binds an owned finished animation beside the main render without changing project content or revision', async () => {
  let p = await locked(); p = (await action(p, 'select-song', { fileId: 'song.wav' })).body;
  const original = structuredClone(p);
  fs.writeFileSync(path.join(dir, 'animation.mp4'), 'owned complete animation');
  fs.writeFileSync(path.join(dir, 'main.mp4'), 'owned main render');
  const main = { fileId: 'main.mp4', sha256: 'main-sha', sourceRevision: p.revision, templateVersion: 1, duration: 12.5, width: 1080, height: 1440, createdAt: new Date().toISOString(), warnings: [] };
  saveChatSongRender(owner, p.id, main);
  mock.media.mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }], format: { duration: 12.5 } }));
  const bound = await action(p, 'attach-asset', { kind: 'animation', fileId: 'animation.mp4' });
  expect(bound.status).toBe(200); expect(bound.body).toEqual(original);
  expect(getChatSongProject(owner, p.id)).toEqual(original); expect(bound.body.song.confirmed).toBe(false);
  const result = (await request(`/${p.id}/render`)).body;
  expect(result.render).toEqual(main); expect(result.animation).toMatchObject({ fileId: 'animation.mp4', sourceRevision: p.revision, scriptRevision: p.scriptRevision, songSha256: p.song!.sha256, duration: 12.5 });
  expect(result.animation.sha256).toMatch(/^[a-f0-9]{64}$/); expect(mock.llm).not.toHaveBeenCalled();
  saveChatSongRender(owner, p.id, { ...main, fileId: 'main-new.mp4' });
  fs.writeFileSync(path.join(dir, 'main-new.mp4'), 'replacement main');
  expect((await request(`/${p.id}/render`)).body.animation).toEqual(result.animation);
});

it('binds an animation before a main render and keeps its source association after edits', async () => {
  let p = await withSong(); fs.writeFileSync(path.join(dir, 'animation.mp4'), 'owned animation only');
  mock.media.mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: 12.5 } }));
  expect((await action(p, 'attach-asset', { kind: 'animation', fileId: 'animation.mp4' })).status).toBe(200);
  const animation = (await request(`/${p.id}/render`)).body.animation;
  expect((await request(`/${p.id}/render`)).body.render).toBeNull();
  const changed = await edit(p, { lines: [{ ...lines[0], text: 'New dialogue' }, ...lines.slice(1)] });
  expect(changed.status).toBe(200); expect(changed.body.scriptRevision).not.toBe(animation.scriptRevision);
  expect((await request(`/${p.id}/render`)).body.animation).toEqual(animation);
});

it('rejects stale revision, cross-owner/work scope and unsafe animation file IDs', async () => {
  const p = await withSong(); fs.writeFileSync(path.join(dir, 'animation.mp4'), 'owned animation');
  mock.media.mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: 12.5 } }));
  const value = { kind: 'animation', fileId: 'animation.mp4' }; mock.media.mockClear();
  expect((await request(`/${p.id}/action`, 'POST', { revision: p.revision - 1, action: 'attach-asset', value })).status).toBe(409);
  expect((await request(`/${p.id}/action`, 'POST', { revision: p.revision, action: 'attach-asset', value }, 'other-owner')).status).toBe(404);
  expect((await request(`/${p.id}/action`, 'POST', { revision: p.revision, action: 'attach-asset', value }, owner, 'work-org')).status).toBe(403);
  expect((await action(p, 'attach-asset', { ...value, fileId: '../animation.mp4' })).status).toBe(400);
  expect((await action(p, 'attach-asset', { ...value, fileId: 'missing.mp4' })).status).toBe(404);
  expect(mock.media).not.toHaveBeenCalled(); expect(getChatSongProject(owner, p.id)).toEqual(p);
});

it('requires a measured video of the selected song duration and does not trust client metadata', async () => {
  const p = await withSong(); fs.writeFileSync(path.join(dir, 'animation.mp4'), 'owned animation');
  expect((await action(p, 'attach-asset', { kind: 'animation', fileId: 'animation.mp4' })).status).toBe(400);
  mock.media.mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: 3 } }));
  expect((await action(p, 'attach-asset', { kind: 'animation', fileId: 'animation.mp4' })).status).toBe(400);
  expect((await action(p, 'attach-asset', { kind: 'animation', fileId: 'animation.mp4', sha256: 'invented', confirmed: true })).status).toBe(400);
  expect((await request(`/${p.id}/render`)).body.animation).toBeNull();
});

it('does not publish a replaced or cancelled animation and preserves the main receipt', async () => {
  const p = await withSong(); fs.writeFileSync(path.join(dir, 'animation.mp4'), 'owned animation'); fs.writeFileSync(path.join(dir, 'main.mp4'), 'main');
  const main = { fileId: 'main.mp4', sha256: 'main-sha', sourceRevision: p.revision, duration: 12.5, width: 1080, height: 1440, createdAt: new Date().toISOString(), warnings: [] };
  saveChatSongRender(owner, p.id, main);
  mock.media.mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: 12.5 } }));
  expect((await action(p, 'attach-asset', { kind: 'animation', fileId: 'animation.mp4' })).status).toBe(200);
  fs.writeFileSync(path.join(dir, 'animation.mp4'), 'same name replaced');
  const read = await request(`/${p.id}/render`); expect(read.body.render).toEqual(main); expect(read.body.animation).toBeNull(); expect(read.body.animationError).toContain('changed');
  const abort = new AbortController();
  mock.media.mockImplementation(async () => { abort.abort(); return JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: 12.5 } }); });
  const { applyChatSongAction } = await import('../server/creative/chat_song');
  await expect(applyChatSongAction(owner, p.id, p.revision, 'attach-asset', { kind: 'animation', fileId: 'animation.mp4' }, abort.signal)).rejects.toThrow();
  expect(getChatSongProject(owner, p.id)).toEqual(p); expect((await request(`/${p.id}/render`)).body.render).toEqual(main);
});


it('cancels an actual HTTP animation binding before committing output metadata', async () => {
  const p = await withSong(); fs.writeFileSync(path.join(dir, 'http-animation.mp4'), 'own cancelled request');
  let start!: () => void, observedSignal: AbortSignal | undefined, cancelled = false;
  const started = new Promise<void>(resolve => { start = resolve; });
  mock.media.mockImplementation(async (_binary, _args, signal?: AbortSignal) => {
    observedSignal = signal; start();
    if (!signal) return JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: 12.5 } });
    return await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true }); });
  });
  const abort = new AbortController();
  const pending = fetch(`${app.url}/api/creative/chat-songs/${p.id}/action`, { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: p.revision, action: 'attach-asset', value: { kind: 'animation', fileId: 'http-animation.mp4' } }), signal: abort.signal }).catch(error => error);
  await started; expect(observedSignal).toBeInstanceOf(AbortSignal); abort.abort(); await pending;
  await vi.waitFor(() => expect(cancelled).toBe(true));
  expect((await request(`/${p.id}/render`)).body.animation).toBeNull(); expect(getChatSongProject(owner, p.id)).toEqual(p);
});

it('keeps the real song and timings when changing names, layout and the selected output format', async () => {
  let p = await withSong(); p = (await action(p, 'set-timings', timeRows)).body;
  const result = await edit(p, { brief: { ...p.brief, displayNameA: '林律师', displayNameB: '来访者', messageLayout: 'single', outputStyle: 'animation' } });
  expect(result.status).toBe(200); expect(result.body.song).toEqual(p.song); expect(result.body.timings).toEqual(p.timings);
  expect(result.body.scriptRevision).toBe(p.scriptRevision); expect(result.body.scriptLocked).toBe(true);
  expect((await edit(result.body, { brief: { ...result.body.brief, outputStyle: 'both' } })).status).toBe(400);
});
it('delivers only a selected bound animation without invoking the chat encoder or generating another file', async () => {
  let p = await withSong();
  p = (await edit(p, { brief: { ...p.brief, outputStyle: 'animation' } })).body;
  expect((await request('/' + p.id + '/render', 'POST', { revision: p.revision })).status).toBe(409);
  fs.writeFileSync(path.join(dir, 'selected-animation.mp4'), 'owned animation fixture');
  mock.media.mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'video', width: 720, height: 1280 }, { codec_type: 'audio' }], format: { duration: '12.5' } }));
  const bound = await action(p, 'attach-asset', { kind: 'animation', fileId: 'selected-animation.mp4' }); expect(bound.status).toBe(200);
  const before = fs.readdirSync(dir);
  const delivered = await request('/' + p.id + '/render', 'POST', { revision: p.revision });
  expect(delivered.status).toBe(200); expect(delivered.body.render).toMatchObject({ fileId: 'selected-animation.mp4', width: 720, height: 1280 });
  expect(mock.media.mock.calls.some(([name]) => name === 'ffmpeg')).toBe(false); expect(fs.readdirSync(dir)).toEqual(before);
  expect((await request('/' + p.id + '/render')).body.render).toBeNull();
  mock.media.mockResolvedValueOnce(JSON.stringify({ streams: [{ codec_type: 'video', width: 720, height: 1280 }], format: { duration: '12.5' } }));
  expect((await request('/' + p.id + '/render', 'POST', { revision: p.revision })).status).toBe(409);
});
it('uses transparent message strips with personal names and role-dependent nearby reaction positions', async () => {
  const line = { id: '01', role: 'A' as const, group: 1, text: '这是当前消息', reaction: '' };
  const bytes = await renderChatSongStrip(line, undefined, '林律师 <&>');
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(4); expect(data[3]).toBe(0);
  const left = chatSongGroupLayout([line], true, true), right = chatSongGroupLayout([{ ...line, id: '02', role: 'B' }], true, true);
  expect(left.reaction.left).not.toBe(right.reaction.left); expect(left.strips[0].top).not.toBe(right.strips[0].top);
  for (const layout of [left, right]) expect(layout.reaction.top + layout.reaction.height).toBeLessThanOrEqual(1440);
});

it('reuses the same chat file after selecting another output format and returning without changing visual inputs', async () => {
  let p = await withSong(); p = (await action(p, 'set-timings', timeRows)).body;
  mock.media.mockImplementation(async (binary: string, args: string[]) => {
    if (binary === 'ffmpeg') { fs.writeFileSync(args.at(-1)!, 'verified cache fixture'); return ''; }
    return JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1440 }, { codec_type: 'audio' }], format: { duration: 12.5 } });
  });
  const first = await request('/' + p.id + '/render', 'POST', { revision: p.revision }); expect(first.status).toBe(200);
  p = (await edit(p, { brief: { ...p.brief, outputStyle: 'animation' } })).body;
  p = (await edit(p, { brief: { ...p.brief, outputStyle: 'chat' } })).body;
  const again = await request('/' + p.id + '/render', 'POST', { revision: p.revision });
  expect(again.status).toBe(200); expect(again.body.render.fileId).toBe(first.body.render.fileId); expect(again.body.render.sha256).toBe(first.body.render.sha256);
  expect(again.body.render.sourceRevision).toBe(p.revision); expect(mock.media.mock.calls.filter(([binary]) => binary === 'ffmpeg')).toHaveLength(1);
  p = (await edit(p, { brief: { ...p.brief, displayNameA: '新昵称' } })).body;
  const renamed = await request('/' + p.id + '/render', 'POST', { revision: p.revision });
  expect(renamed.status).toBe(200); expect(renamed.body.render.fileId).not.toBe(first.body.render.fileId);
});

it('keeps lawyer right and client left with flat WeChat bubble colors in exported PNGs', async () => {
  for (const role of ['A', 'B'] as const) {
    const line = { id: '01', role, text: '位置与颜色核对', group: 1, reaction: '' };
    const layout = chatSongStripLayout(line);
    expect(layout.avatarX > 540).toBe(role === 'A');
    const {data, info} = await sharp(await renderChatSongStrip(line)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const offset = (65 * info.width + layout.bubbleX + 24) * 4;
    expect([...data.subarray(offset, offset + 4)]).toEqual(role === 'A' ? [149,236,105,255] : [237,237,237,255]);
  }
});
it('keeps tall conversations and delayed reactions inside the video frame', () => {
  const panel = { top: 0, height: CHAT_SONG_TEMPLATE.height };
  for (const single of [false, true]) for (const hasReaction of [false, true]) {
    const group = [1,2,3].slice(0,single ? 1 : 3).map(n=>({id:String(n),role:(n%2 ? 'A' : 'B') as 'A'|'B',text:'长段落'.repeat(35),group:1,reaction:''}));
    const layout = chatSongGroupLayout(group,hasReaction,single);
    for (const strip of layout.strips) {
      expect(strip.top).toBeGreaterThanOrEqual(panel.top);
      expect(strip.top + strip.height).toBeLessThanOrEqual(panel.top + panel.height);
    }
    if(hasReaction) expect(layout.reaction.top + layout.reaction.height).toBeLessThanOrEqual(panel.top + panel.height);
  }
});
it('keeps the background uncovered before the first message appears', async () => {
  let p = await withSong(); p = (await action(p, 'set-timings', timeRows)).body;
  let pixel: number[] = [];
  mock.media.mockImplementation(async (binary: string,args: string[]) => {
    if(binary === 'ffmpeg') {
      const filterPath = args[args.indexOf('-filter_complex_script') + 1];
      const frame = path.join(path.dirname(filterPath),'frame-0.png');
      const {data} = await sharp(frame).extract({left:540,top:1050,width:1,height:1}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      pixel=[...data]; fs.writeFileSync(args.at(-1)!, 'verified white panel fixture'); return '';
    }
    return JSON.stringify({streams:[{codec_type:'video',width:1080,height:1440},{codec_type:'audio'}],format:{duration:12.5}});
  });
  expect((await request('/'+p.id+'/render','POST',{revision:p.revision})).status).toBe(200);
  expect(pixel).toEqual([0,0,0,0]);
});

it('crops each screenshot around only its own avatar and message instead of filling the whole canvas', async () => {
  for(const role of ['A','B'] as const) {
    const line={id:'01',role,text:'单句截图',group:1,reaction:''};
    const strip=chatSongStripLayout(line);
    expect(strip.screenshot.width).toBeLessThan(600);
    expect(strip.screenshot.left).toBeGreaterThanOrEqual(0);
    expect(strip.screenshot.left+strip.screenshot.width).toBeLessThanOrEqual(1080);
    const {data,info}=await sharp(await renderChatSongStrip(line)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const inside=(10*info.width+strip.screenshot.left+2)*4;
    expect([...data.subarray(inside,inside+4)]).toEqual([247,247,247,255]);
    const outside=(10*info.width+(role==='A'?20:1060))*4;
    expect(data[outside+3]).toBe(0);
    expect(strip.height).toBeLessThanOrEqual(180);
  }
});

vi.mock('../server/creative/chat_song_reactions', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/creative/chat_song_reactions')>();
  return { ...actual, searchChatSongReactions: vi.fn(async (_scope, lines) => lines.map((line: {id:string;reaction:string}) => ({lineId:line.id,query:line.reaction,status:line.reaction ? 'no_match' : 'empty',candidates:[]}))) };
});

it('expands a single-message screenshot only as needed to retain a custom long nickname', async () => {
  const line={id:'01',role:'A' as const,text:'好',group:1,reaction:''},name='这是用于检验截图昵称边界的较长称呼';
  const regular=chatSongStripLayout(line),named=chatSongStripLayout(line,name);
  expect(named.screenshot.width).toBeGreaterThan(regular.screenshot.width);
  expect(named.screenshot.left).toBeLessThanOrEqual(926-Array.from(name).length*28);
  const {data,info}=await sharp(await renderChatSongStrip(line,undefined,name)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const pixel=(5*info.width+named.screenshot.left+2)*4;
  expect([...data.subarray(pixel,pixel+4)]).toEqual([247,247,247,255]);
});
