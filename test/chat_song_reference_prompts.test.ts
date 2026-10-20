import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { mountChatSongRoutes } from '../server/routes/chat_song_routes';
import { getChatSongProject } from '../server/creative/chat_song';
import { generatedKnowledgeDirectory } from '../server/files/knowledge_directory';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { CHAT_SONG_EXPORT_NAMES } from '../server/regions/packs/cn/chat_song';
import type { ChatSongProject } from '../shared/chat_song';
const mock = vi.hoisted(() => ({ llm: vi.fn(), search: vi.fn(), media: vi.fn() }));
vi.mock('../server/llm/providers', () => ({ makeLLMCall: (...args: any[]) => mock.llm(...args), makeLLMCallStreaming: (...args: any[]) => mock.llm(...args) }));
vi.mock('../server/media/process', () => ({ runMediaProcess: (...args: any[]) => mock.media(...args) }));
vi.mock('../server/creative/chat_song_reactions', async original => ({ ...await original<typeof import('../server/creative/chat_song_reactions')>(), searchChatSongReactions: (...args: any[]) => mock.search(...args) }));
const owner = 'original-reference-style-test';
const lines = [
  { role: 'A', text: '先别急。', group: 1, reaction: '' },
  { role: 'A', text: '我把那张票根留到了今天。', group: 2, reaction: '疑惑' },
  { role: 'A', text: '但故事还没有说完。', group: 3, reaction: '' },
  { role: 'B', text: '原来等的人就是你。', group: 4, reaction: '惊讶' },
  { role: 'B', text: '这次一起回家。', group: 5, reaction: '' },
  { role: 'B', text: '这次一起回家。', group: 6, reaction: '' },
];
let app: Awaited<ReturnType<typeof makeApp>>;
async function request(url = '', method = 'GET', body?: unknown) {
  const response = await fetch(app.url + '/api/creative/chat-songs' + url, { method, headers: { Authorization: 'Bearer ' + jwt.sign({ uid: owner, username: owner, role: 'user' }, JWT_SECRET), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function create(musicStyle = '', messageLayout: 'single' | 'conversation' = 'single', targetSeconds = 40) {
  let p: ChatSongProject = (await request('', 'POST', { id: randomUUID(), title: 'Original station reunion' })).body;
  p = (await request('/' + p.id, 'PATCH', { revision: p.revision, project: { title: p.title, brief: { ...p.brief, theme: '车站重逢', relationship: '两位老朋友', twist: '一直等着对方', roleA: '旧友甲', roleB: '旧友乙', musicStyle, messageLayout, targetSeconds }, lines: [] } })).body;
  return p;
}
function draftMessages() {
  const messages = mock.llm.mock.calls[0][0];
  expect(messages.map((message: any) => message.role)).toEqual(['system', 'user']);
  return { system: messages[0].content as string, user: messages[1].content as string };
}
function promptTaskData(): any { return JSON.parse(draftMessages().user); }
beforeAll(async () => { app = await makeApp(); mountChatSongRoutes(app.apiRouter, LLM_GETTERS); upsertUserPreferredLLM(owner, { provider: 'relay', model: 'synthetic-official' }); });
beforeEach(() => {
  mock.llm.mockReset().mockResolvedValue({ text: JSON.stringify({ lines }), finishReason: 'stop' });
  mock.search.mockReset().mockImplementation(async (_scope, source) => source.map((line: any) => ({ lineId: line.id, query: line.reaction, status: line.reaction ? 'no_match' : 'empty', candidates: [] })));
  mock.media.mockReset().mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '12.5' } }));
});
afterAll(() => app.cleanup());

it('preserves authored dramatic groups, consecutive speakers and explicit final repeats in the actual draft path', async () => {
  const p = await create(), result = await request('/' + p.id + '/draft', 'POST', { revision: p.revision });
  expect(result.status).toBe(200);
  expect(result.body.lines.map((line: any) => [line.role, line.text, line.group])).toEqual(lines.map(line => [line.role, line.text, line.group]));
  expect(mock.search).toHaveBeenCalledTimes(1); expect(mock.search.mock.calls[0][1]).toEqual(result.body.lines);
  expect(mock.llm).toHaveBeenCalledTimes(1); expect(mock.llm.mock.calls[0][1]).toEqual([]);
  expect(mock.llm.mock.calls[0][2]).toMatchObject({ provider: 'relay', reasoningEffort: 'low', responseFormat: 'json_object', selectionMode: 'pinned', noImplicitFailover: true });
  expect(getChatSongProject(owner, p.id)).toEqual(p);
});
it('keeps custom musical direction dominant through the actual SDK prompt, handoff and exported lyric contract', async () => {
  const musicStyle = '仅木吉他，温和慢速，不要说唱', p = await create(musicStyle);
  const draft = await request('/' + p.id + '/draft', 'POST', { revision: p.revision });
  expect(draft.status).toBe(200); const prompt = draftMessages().system;
  expect(promptTaskData().musicStyle).toBe(musicStyle); expect(prompt).toContain('优先'); expect(prompt).toContain('节奏念白'); expect(prompt).toContain('短句旋律');
  let saved = (await request('/' + p.id + '/action', 'POST', { revision: p.revision, action: 'save', value: { title: p.title, brief: p.brief, lines: draft.body.lines.map(({ id: _id, ...line }: any) => line) } })).body;
  saved = (await request('/' + p.id + '/action', 'POST', { revision: saved.revision, action: 'lock-script' })).body;
  const handoff = (await request('/' + p.id + '/handoff')).body;
  expect(handoff.lyrics).toBe(lines.map(line => line.text).join('\n'));
  expect(handoff.singing).toContain(musicStyle); expect(handoff.singing).toContain('优先');
  expect(handoff.singing).toContain('不漏词、改词、调序'); expect(handoff.singing).toContain('不唱编号和角色标签');
  expect(handoff.singing).not.toMatch(/134\s*BPM|120[-–]130|130[-–]140/i);
  expect(handoff.prompts.some((row: any) => row.kind === 'reaction')).toBe(false);
  const bundle = await request('/' + p.id + '/export', 'POST', { revision: saved.revision });
  expect(bundle.status).toBe(200); const zip = await JSZip.loadAsync(fs.readFileSync(path.join(generatedKnowledgeDirectory({ userId: owner, domain: 'personal' }), bundle.body.fileId)));
  expect(await zip.file(CHAT_SONG_EXPORT_NAMES.lyrics)!.async('string')).toBe(handoff.lyrics);
  expect(await zip.file(CHAT_SONG_EXPORT_NAMES.singing)!.async('string')).toBe(handoff.singing);
  expect(getChatSongProject(owner, p.id)).toEqual(saved); expect(mock.llm).toHaveBeenCalledTimes(1);
});
it('continues rejecting nonconsecutive model groups without saving, reinterpreting or re-generating the draft', async () => {
  const p = await create(); mock.llm.mockResolvedValueOnce({ text: JSON.stringify({ lines: [{ ...lines[0], group: 1 }, { ...lines[3], group: 3 }] }), finishReason: 'stop' });
  const result = await request('/' + p.id + '/draft', 'POST', { revision: p.revision });
  expect(result.status).toBe(400); expect(getChatSongProject(owner, p.id)).toEqual(p); expect(mock.llm).toHaveBeenCalledTimes(1); expect(mock.search).not.toHaveBeenCalled();
});

it('frontloads the total line budget, explicit duration and repeat accounting before user brief data in the actual SDK request', async () => {
  const p = await create('整段32句，以剧情对白和短唱句推进；结尾两句呼应也计入32句', 'single', 120);
  const original = Array.from({ length: 32 }, (_, index) => ({ ...lines[index % lines.length], role: index % 4 < 2 ? 'A' : 'B', text: index >= 30 ? '这次一起回家。' : `第${index + 1}段原创话语`, group: Math.floor(index / 2) + 1 }));
  mock.llm.mockResolvedValueOnce({ text: JSON.stringify({ lines: original }), finishReason: 'stop' });
  const result = await request('/' + p.id + '/draft', 'POST', { revision: p.revision });
  expect(result.status).toBe(200); expect(result.body.lines).toHaveLength(32);
  expect(result.body.lines.map((line: any) => [line.role, line.text, line.group])).toEqual(original.map(line => [line.role, line.text, line.group]));
  const prefix = draftMessages().system, data = promptTaskData();
  expect(prefix).toContain('2至40'); expect(prefix).toContain('targetSeconds'); expect(data.targetSeconds).toBe(120);
  expect(prefix).toContain('重复'); expect(prefix).toContain('总句数'); expect(prefix).toContain('指定句数'); expect(prefix).toContain('必须精确'); expect(prefix).toContain('仅未指定时');
  expect(data.musicStyle).toBe(p.brief.musicStyle); expect(getChatSongProject(owner, p.id)).toEqual(p);
  expect(mock.llm).toHaveBeenCalledTimes(1); expect(mock.search).toHaveBeenCalledTimes(1);
});
it('rejects forty-one model lines without truncating, saving, searching or automatically retrying', async () => {
  const p = await create('整段32句', 'single', 120);
  const tooMany = Array.from({ length: 41 }, (_, index) => ({ ...lines[index % lines.length], group: Math.floor(index / 2) + 1 }));
  mock.llm.mockResolvedValueOnce({ text: JSON.stringify({ lines: tooMany }), finishReason: 'stop' });
  const result = await request('/' + p.id + '/draft', 'POST', { revision: p.revision });
  expect(result.status).toBe(400); expect(result.body.error).toContain('40'); expect(result.body.lines).toBeUndefined();
  expect(getChatSongProject(owner, p.id)).toEqual(p); expect(mock.llm).toHaveBeenCalledTimes(1); expect(mock.search).not.toHaveBeenCalled();
});

it.each(['single', 'conversation'] as const)('keeps the %s display rule consistent in the draft, exported notes and real edit handoff', async mode => {
  let p = await create('', mode);
  const drafted = await request('/' + p.id + '/draft', 'POST', { revision: p.revision });
  expect(drafted.status).toBe(200);
  const prompt = mock.llm.mock.calls[0][0][0].content;
  p = (await request('/' + p.id + '/action', 'POST', { revision: p.revision, action: 'save', value: { title: p.title, brief: p.brief, lines: drafted.body.lines.map(({ id: _id, ...line }: any) => line) } })).body;
  p = (await request('/' + p.id + '/action', 'POST', { revision: p.revision, action: 'lock-script' })).body;
  const dir = generatedKnowledgeDirectory({ userId: owner, domain: 'personal' }); fs.writeFileSync(path.join(dir, 'display-rule-song.wav'), 'synthetic audio; ffprobe mocked');
  p = (await request('/' + p.id + '/action', 'POST', { revision: p.revision, action: 'select-song', value: { fileId: 'display-rule-song.wav' } })).body;
  p = (await request('/' + p.id + '/action', 'POST', { revision: p.revision, action: 'set-timings', value: p.lines.map((line, index) => ({ lineId: line.id, start: index * 2, end: index * 2 + 1.5 })) })).body;
  const exported = await request('/' + p.id + '/export', 'POST', { revision: p.revision });
  expect(exported.status).toBe(200); expect(exported.body.timed).toBe(true); expect(exported.body.handoffs.edit).toBeTruthy();
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, exported.body.fileId))), notes = await zip.file(CHAT_SONG_EXPORT_NAMES.notes)!.async('string');
  for (const instruction of [prompt, notes, exported.body.handoffs.edit]) {
    if (mode === 'single') { expect(instruction).toContain('每次只显示当前一句'); expect(instruction).not.toMatch(/同组.{0,8}累积/); }
    else { expect(instruction).toMatch(/同组.{0,8}累积/); expect(instruction).toMatch(/换组.{0,8}清除/); }
    expect(instruction).toMatch(/不提前/);
  }
  expect(await zip.file(CHAT_SONG_EXPORT_NAMES.lyrics)!.async('string')).toBe(lines.map(line => line.text).join('\n'));
  expect(getChatSongProject(owner, p.id)).toEqual(p); expect(mock.llm).toHaveBeenCalledTimes(1);
});

it('sends saved identity, twist and every edited source line through HTTP to the draft SDK without adopting the candidate', async () => {
  let p = await create('32句原稿，木吉他与节奏念白；不唱角色名', 'single', 120);
  const source = Array.from({ length: 32 }, (_, index) => ({ role: index % 2 ? 'B' : 'A', text: index === 31 ? '是我瞒着丈夫约会，律师只负责听取陈述。' : '用户已修改第' + (index + 1) + '句：我的原话只作本次修订资料。', group: Math.floor(index / 2) + 1, reaction: '' }));
  const brief = { ...p.brief, roleA: '男律师林先生', roleB: '女客户周女士', relationship: '律师与委托咨询客户，双方并非夫妻', theme: '离婚财产咨询', twist: '结尾由女客户亲口承认自己出轨，律师始终不是婚姻当事人' };
  const saved = await request('/' + p.id, 'PATCH', { revision: p.revision, project: { title: p.title, brief, lines: source } });
  expect(saved.status).toBe(200); p = saved.body;
  p = (await request('/' + p.id + '/action', 'POST', { revision: p.revision, action: 'lock-script' })).body;
  const dir = generatedKnowledgeDirectory({ userId: owner, domain: 'personal' });
  fs.writeFileSync(path.join(dir, 'private-source-song.wav'), 'private test song; ffprobe mocked');
  p = (await request('/' + p.id + '/action', 'POST', { revision: p.revision, action: 'select-song', value: { fileId: 'private-source-song.wav' } })).body;
  p = (await request('/' + p.id + '/action', 'POST', { revision: p.revision, action: 'set-timings', value: p.lines.map((line, index) => ({ lineId: line.id, start: index * 0.3, end: index * 0.3 + 0.2 })) })).body;
  const candidate = source.map((line, index) => ({ ...line, text: '候选第' + (index + 1) + '句，尚未由用户采用。' }));
  mock.llm.mockResolvedValueOnce({ text: JSON.stringify({ lines: candidate }), finishReason: 'stop' });
  const result = await request('/' + p.id + '/draft', 'POST', { revision: p.revision });
  expect(result.status).toBe(200); expect(result.body.lines.map((line: any) => line.text)).toEqual(candidate.map(line => line.text));
  const prompt = draftMessages().system, data = promptTaskData();
  expect(data.roles).toEqual({ A: brief.roleA, B: brief.roleB });
  expect(data).toMatchObject({ theme: brief.theme, relationship: brief.relationship, twist: brief.twist, musicStyle: brief.musicStyle, targetSeconds: 120 });
  expect(data.currentDialogue).toEqual({ lineCount: 32, scriptLocked: true, lines: source.map(({ role, text, group }) => ({ role, text, group })) });
  expect(Object.keys(data).sort()).toEqual(['currentDialogue', 'musicStyle', 'relationship', 'roles', 'targetSeconds', 'theme', 'twist'].sort());
  expect(prompt).not.toContain('private-source-song.wav'); expect(prompt).not.toContain(p.song!.sha256);
  expect(prompt).not.toContain('timings'); expect(prompt).not.toContain('assets');
  expect(prompt).toContain('逐条保留现稿角色与原文'); expect(prompt).toContain('不压缩、合并或删句');
  expect(prompt).toContain('成立条件'); expect(prompt).not.toContain('当前保存稿的句数只是上下文');
  expect(prompt).toContain('反转只在用户指定位置揭晓'); expect(prompt).toContain('专业角色下一次发言须直接否定');
  expect(getChatSongProject(owner, p.id)).toEqual(p); expect(p.lines.map(line => line.text)).toEqual(source.map(line => line.text));
  expect(mock.llm).toHaveBeenCalledTimes(1); expect(mock.search).toHaveBeenCalledTimes(1);
});
it('supplies an explicit empty source context while a new project can still return a candidate', async () => {
  const p = await create('用户自选慢歌');
  const result = await request('/' + p.id + '/draft', 'POST', { revision: p.revision });
  expect(result.status).toBe(200); expect(result.body.lines.map((line: any) => [line.role, line.text, line.group])).toEqual(lines.map(line => [line.role, line.text, line.group]));
  const data = promptTaskData();
  expect(data.roles).toEqual({ A: p.brief.roleA, B: p.brief.roleB });
  expect(data.currentDialogue).toEqual({ lineCount: 0, scriptLocked: false, lines: [] });
  expect(getChatSongProject(owner, p.id)).toEqual(p); expect(mock.llm).toHaveBeenCalledTimes(1);
});
