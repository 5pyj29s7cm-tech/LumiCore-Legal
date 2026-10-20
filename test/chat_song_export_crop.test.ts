import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { generatedKnowledgeDirectory } from '../server/files/knowledge_directory';
import { registerGeneratedKnowledgeFile, listGeneratedArchive } from '../server/files/generated_archive';
import { getChatSongProject, renderChatSongStrip } from '../server/creative/chat_song';
import { mountChatSongRoutes } from '../server/routes/chat_song_routes';
import { CHAT_SONG_TEMPLATE, chatSongStripLayout } from '../shared/chat_song_layout';
import { CHAT_SONG_EXPORT_NAMES as names } from '../server/regions/packs/cn/chat_song';
import type { ChatSongProject } from '../shared/chat_song';

const calls = vi.hoisted(() => ({ model: vi.fn(), media: vi.fn() }));
vi.mock('../server/llm/providers', () => ({ makeLLMCall: (...args: unknown[]) => calls.model(...args), makeLLMCallStreaming: (...args: unknown[]) => calls.model(...args) }));
vi.mock('../server/media/process', () => ({ runMediaProcess: (...args: unknown[]) => calls.media(...args) }));
let app: Awaited<ReturnType<typeof makeApp>>, dir: string;
const owner = 'isolated-export-crop-owner', sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const token = jwt.sign({ uid: owner, username: owner, role: 'user' }, JWT_SECRET);
const inputs = new Map<string, Buffer>();
async function request(url: string, method: string, body?: unknown) {
  const response = await fetch(app.url + '/api/creative/chat-songs' + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  app = await makeApp(); mountChatSongRoutes(app.apiRouter, LLM_GETTERS);
  dir = generatedKnowledgeDirectory({ userId: owner, domain: 'personal' });
  for (const [name, color] of [['avatar-a.png', '#e12425'], ['avatar-b.png', '#176dd0'], ['background.png', '#8a6574']]) {
    const bytes = await (sharp as any)({ create: { width: 100, height: 100, channels: 3, background: color } }).png().toBuffer();
    inputs.set(name, bytes); fs.writeFileSync(path.join(dir, name), bytes);
  }
});
afterAll(() => app.cleanup());

it.each([
  { title: 'short sentences', a: '请坐。', b: '我来咨询。', nameA: '律师', nameB: '客户' },
  { title: 'multiline text and long nicknames', a: '逐句展示原文与头像，姓名不能被切掉。'.repeat(4), b: 'Original <b>text</b> & 中文必须原样保留。'.repeat(3), nameA: 'W'.repeat(30), nameB: '很长的用户昵称用于验证完整边界'.repeat(2).slice(0, 30) },
])('exports physically tight per-line PNGs while preserving source identity: $title', async ({ title, a, b, nameA, nameB }) => {
  const created = await request('', 'POST', { id: randomUUID(), title }); expect(created.status).toBe(201);
  const lines = [{ role: 'A', text: a, group: 1, reaction: '' }, { role: 'B', text: b, group: 2, reaction: '' }];
  let result = await request('/' + created.body.id, 'PATCH', { revision: created.body.revision, project: { title, brief: { ...created.body.brief, displayNameA: nameA, displayNameB: nameB }, lines } });
  expect(result.status).toBe(200); let project = result.body as ChatSongProject;
  for (const [kind, fileId] of [['avatarA', 'avatar-a.png'], ['avatarB', 'avatar-b.png'], ['background', 'background.png']]) {
    result = await request('/' + project.id + '/action', 'POST', { revision: project.revision, action: 'attach-asset', value: { kind, fileId } });
    expect(result.status).toBe(200); project = result.body;
  }
  result = await request('/' + project.id + '/action', 'POST', { revision: project.revision, action: 'lock-script' }); expect(result.status).toBe(200); project = result.body;
  const snapshot = structuredClone(project);
  const exported = await request('/' + project.id + '/export', 'POST', { revision: project.revision });
  expect(exported.status).toBe(200); expect(exported.body.timed).toBe(false);
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, exported.body.fileId)));
  expect(await zip.file(names.lyrics)!.async('string')).toBe(a + '\n' + b);
  expect(JSON.parse(await zip.file('project.json')!.async('string'))).toMatchObject(snapshot);
  for (const line of project.lines) {
    const displayName = line.role === 'A' ? nameA : nameB, avatar = inputs.get(line.role === 'A' ? 'avatar-a.png' : 'avatar-b.png')!;
    const full = await renderChatSongStrip(line, avatar, displayName), layout = chatSongStripLayout(line, displayName);
    expect((await sharp(full).metadata()).width).toBe(CHAT_SONG_TEMPLATE.stripWidth); // full-strip API remains unchanged for MP4 crop consumers
    const png = await zip.file(names.images + '/' + names.strips + '_' + line.id + '.png')!.async('nodebuffer');
    expect(await sharp(png).metadata()).toMatchObject({ format: 'png', width: layout.screenshot.width, height: layout.height });
    expect(layout.screenshot.width).toBeLessThan(CHAT_SONG_TEMPLATE.stripWidth);
    const expected = await sharp(full).extract({ left: layout.screenshot.left, top: 0, width: layout.screenshot.width, height: layout.height }).ensureAlpha().raw().toBuffer();
    expect(await sharp(png).ensureAlpha().raw().toBuffer()).toEqual(expected); // complete avatar, nickname, bubble, tail and text pixels retained
    expect(fs.readFileSync(path.join(dir, exported.body.fileId.replace('.zip', '-' + line.id + '.png')))).toEqual(png);
  }
  for (const [name, bytes] of inputs) expect(sha(fs.readFileSync(path.join(dir, name)))).toBe(sha(bytes));
  expect(getChatSongProject(owner, project.id)).toEqual(snapshot);
  expect(calls.model).not.toHaveBeenCalled(); expect(calls.media).not.toHaveBeenCalled();
});


it('preserves registered legacy v6 ZIP and PNG bytes at the same revision when exporting the current template', async () => {
  const created = await request('', 'POST', { id: randomUUID(), title: 'Synthetic versioned export preservation' }); expect(created.status).toBe(201);
  let result = await request('/' + created.body.id, 'PATCH', { revision: created.body.revision, project: { title: created.body.title, brief: created.body.brief, lines: [
    { role: 'A', text: '先保留原件。', group: 1, reaction: '' }, { role: 'B', text: '再生成新版。', group: 2, reaction: '' },
  ] } }); expect(result.status).toBe(200);
  result = await request('/' + result.body.id + '/action', 'POST', { revision: result.body.revision, action: 'lock-script' }); expect(result.status).toBe(200);
  const project = result.body as ChatSongProject, snapshot = structuredClone(project), legacyPrefix = 'chat-song-' + project.id + '-r' + project.revision;
  const legacyZip = await new JSZip().file('v6-original.txt', 'SYNTHETIC_V6_ORIGINAL_MUST_REMAIN').generateAsync({ type: 'nodebuffer' });
  const originals = new Map([[legacyPrefix + '.zip', legacyZip], ...project.lines.map((line, index) => [legacyPrefix + '-' + line.id + '.png', inputs.get(index ? 'avatar-b.png' : 'avatar-a.png')!] as [string, Buffer])]);
  const scope = { userId: owner, domain: 'personal' as const };
  for (const [filename, bytes] of originals) { fs.writeFileSync(path.join(dir, filename), bytes); await registerGeneratedKnowledgeFile(scope, filename); }
  const oldIndex = await listGeneratedArchive(scope, legacyPrefix + '.zip'); expect(oldIndex).toHaveLength(1);
  const exported = await request('/' + project.id + '/export', 'POST', { revision: project.revision }); expect(exported.status).toBe(200);
  for (const [filename, bytes] of originals) expect(fs.readFileSync(path.join(dir, filename))).toEqual(bytes);
  expect(await listGeneratedArchive(scope, legacyPrefix + '.zip')).toEqual(oldIndex);
  expect(exported.body.fileId).not.toBe(legacyPrefix + '.zip');
  expect(exported.body.fileId).toBe(legacyPrefix + '-v' + CHAT_SONG_TEMPLATE.version + '.zip');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, exported.body.fileId)));
  expect(await zip.file(names.lyrics)!.async('string')).toBe('先保留原件。\n再生成新版。');
  for (const line of project.lines) {
    const published = fs.readFileSync(path.join(dir, exported.body.fileId.replace('.zip', '-' + line.id + '.png')));
    expect(published).toEqual(await zip.file(names.images + '/' + names.strips + '_' + line.id + '.png')!.async('nodebuffer'));
  }
  expect(getChatSongProject(owner, project.id)).toEqual(snapshot);
  expect(calls.model).not.toHaveBeenCalled(); expect(calls.media).not.toHaveBeenCalled();
});
