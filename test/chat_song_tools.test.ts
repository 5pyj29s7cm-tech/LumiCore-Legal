import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { CHAT_SONG_TEMPLATE } from '../shared/chat_song_layout';
import { collectChatArtifacts, publicChatArtifactDelivery } from '../server/conversation/chat_artifacts';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { initDatabase, readDB, querySQL, readDatabaseTables, commitDatabaseTables, flushDBOrThrow } from '../db_layer';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { runLumiEntryTurn, type LumiEntryTurnInput, type ExecutedLumiTurn } from '../server/cognition/turn_execution';
import { ToolRegistry, getToolExecutionTimeoutMs } from '../server/tools/registry';
import { registerProductVariantTools } from '../server/tools/definitions';
import { registerChatSongTools } from '../server/tools/definitions/chat_song_tools';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { executeConfirmedToolStep } from '../server/tools/confirmed_step';
import { createTurnConfirmation } from '../server/tools/turn_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import { buildTransportNeutralConfirmationScope, clearAllPendingConfirmationsForTests, formatPendingConfirmationRequest, type PendingToolConfirmation } from '../server/tools/pending_confirmation';
import { generatedKnowledgeDirectory } from '../server/files/knowledge_directory';
import { registerGeneratedKnowledgeFile } from '../server/files/generated_archive';
import { getChatSongProject, saveChatSongRender, chatSongRenderInputSha } from '../server/creative/chat_song';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import type { ToolContext } from '../server/tools/types';
import type { ChatSongProject } from '../shared/chat_song';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { CHAT_SONG_RENDER_COPY } from '../server/regions/packs/cn/chat_song';
const mock = vi.hoisted(() => ({ llm: vi.fn(), media: vi.fn() }));
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: (...args: any[]) => mock.llm(...args), makeLLMCallStreaming: (...args: any[]) => mock.llm(...args) }));
vi.mock('../server/media/process', () => ({ runMediaProcess: (...args: any[]) => mock.media(...args) }));
const uid = 'synthetic-chat-song-tools-owner';
const lines = [{ role: 'A', text: '星光落在我的窗前', group: 1, reaction: '' }, { role: 'B', text: '我把晚风唱成明天', group: 1, reaction: '' }];
const registry = new ToolRegistry();
registerChatSongTools(registry);
const getters = { getDeepSeek: () => null, getGemini: () => null, getRelay: () => null };
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ userId: uid, authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local', domain: 'personal', requestId: randomUUID(), taskId: randomUUID(), currentTurnExecutionRequested: true, allowLocalFileWrites: true, llmGetters: getters, requestConfirmation: createTurnConfirmation({ userId: uid, source: 'chat', requestId: randomUUID(), actionIntent: 'Create the requested project deliverable.', consumeScope: () => undefined, proposalScope: () => undefined, onPending: () => undefined }), ...extra });
async function call(name: string, args: any, extra: Partial<ToolContext> = {}) { return JSON.parse(await registry.execute(name, args, ctx(extra))); }
async function project(): Promise<ChatSongProject> {
  let p = (await call('chat_song_project', { action: 'create', projectId: randomUUID(), title: 'Synthetic singing project' })).project;
  p = (await call('chat_song_project', { action: 'save', projectId: p.id, revision: p.revision, value: { title: p.title, brief: p.brief, lines } })).project;
  p = (await call('chat_song_project', { action: 'lock-script', projectId: p.id, revision: p.revision })).project;
  return (await call('chat_song_project', { action: 'select-song', projectId: p.id, revision: p.revision, value: { fileId: 'tool-song.wav' } })).project;
}
function checksFor(p: ChatSongProject) { return { projectId: p.id, revision: p.revision, songSha256: p.song!.sha256, scriptRevision: p.scriptRevision, checks: { noOmissions: true, noRewrites: true, noRepeats: true, correctOrder: true } }; }
async function propose(p: ChatSongProject) {
  const args = checksFor(p), scope = buildTransportNeutralConfirmationScope({ conversationId: randomUUID(), taskId: randomUUID(), domain: 'personal' });
  let pending: PendingToolConfirmation | undefined;
  const requestConfirmation = createTurnConfirmation({ userId: uid, source: 'chat', requestId: randomUUID(), actionIntent: 'Finish this singing project.', consumeScope: () => scope, proposalScope: () => scope, onPending: value => { pending = value; } });
  const result = await registry.execute('chat_song_confirm_song', args, ctx({ requestConfirmation }));
  expect(result).toMatch(/requires user confirmation/);
  expect(pending?.exactArgs).toMatchObject(args);
  const visible = formatPendingConfirmationRequest(pending!);
  for (const text of [p.id, p.song!.sha256, p.lines[0].text, 'no omitted words', 'no rewritten words', 'no repeated lines', 'correct order']) expect(visible).toContain(text);
  expect(getChatSongProject(uid, p.id).song?.confirmed).toBe(false);
  return { args, scope, pending: pending! };
}
beforeAll(async () => { await initDatabase(); await ensurePendingConfirmationPersistenceInitialized(); upsertUserPreferredLLM(uid, { provider: 'relay', model: 'relay-synthetic' }); });
beforeEach(() => {
  clearAllPendingConfirmationsForTests();
  fs.writeFileSync(path.join(generatedKnowledgeDirectory({ userId: uid, domain: 'personal' }), 'tool-song.wav'), 'Synthetic audio bytes; ffprobe is mocked, this suite does not certify singing.');
  mock.llm.mockReset().mockResolvedValue({ text: JSON.stringify({ lines }), finishReason: 'stop' });
  mock.media.mockReset().mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '15' } }));
});

it('exposes five actual product tools with explicit verification and a non-auto-approved song check', () => {
  const all = new ToolRegistry(); registerProductVariantTools(all);
  for (const name of ['chat_song_read', 'chat_song_project', 'chat_song_draft_dialogue', 'chat_song_render', 'chat_song_confirm_song']) {
    expect(all.get(name)?.handler).toBeTypeOf('function');
    expect(all.getCapabilityManifestEntry(name)?.metadataSources.sideEffects).toBe('tool_definition');
    expect(all.getCapabilityManifestEntry(name)?.verification.required).toBe(true);
  }
  expect(all.findRelevant('按完整脚本生成唱歌对白', { limit: 20 }).map(t => t.name)).toContain('chat_song_draft_dialogue');
  expect(all.get('chat_song_draft_dialogue')?.description).toContain('first save new chat requirements through chat_song_project action=save and use its returned revision');
  expect(all.get('chat_song_confirm_song')?.securityLevel).toBe('confirm');
  expect(all.getCapabilityManifestEntry('chat_song_confirm_song')?.risk).toBe('high');
  const routed = routeToolsForTurn("请读取并合成聊天唱歌工程 a590fef2-1d8f-4cea-a2b6-6a3ed5567e6a 的第 18 版。这是已经定好的聊天记录＋表情包主版本，使用工程已有的音轨、对白和全部素材，通过 chat_song_render 在本地合成并返回真实MP4。不要重新生成模型画面，也无需申请人工核词确认；歌曲的人工核对标记保持原值，不能代勾。", all.getToolDeclarations(), { maxTools: 32, capabilityManifest: all.getCapabilityManifest(), enableMcpHealthGate: false });
  expect(routed.toolNames).toContain('chat_song_render');
  expect(getToolExecutionTimeoutMs('chat_song_render')).toBe(660000);
  expect(getToolExecutionTimeoutMs('chat_song_draft_dialogue')).toBe(180000);
});
it('executes a model-selected project call through the canonical engine and reuses an exact creation ID', async () => {
  const args = { action: 'create', projectId: randomUUID(), title: 'One owned project' };
  const record = await executeToolCall({ registry, name: 'chat_song_project', arguments: args, executionOrigin: 'model_selected', context: ctx() });
  expect(isCanonicalToolExecutionRecord(record)).toBe(true); expect(record.error).toBeFalsy();
  expect(record.executionOrigin).toBe('model_selected'); expect(record.envelope).toBeTruthy();
  const saved = getChatSongProject(uid, args.projectId);
  expect((await call('chat_song_project', args)).project).toEqual(saved);
  const read = await call('chat_song_read', { projectId: args.projectId });
  expect(read.project).toEqual(saved); expect(read.handoff).toBeUndefined(); expect(read.library).toBeUndefined(); expect(read.outputPath).toBeUndefined(); expect(read.artifacts).toBeUndefined();
});
it.each([{ domain: 'work' as const }, { orgId: 'synthetic-org' }, { localExecution: false }])('rejects a non-personal or non-admitted workspace %j without creating a project', async extra => {
  const id = randomUUID();
  await expect(call('chat_song_project', { action: 'create', projectId: id, title: 'Forbidden' }, extra)).rejects.toThrow();
  expect(() => getChatSongProject(uid, id)).toThrow();
});
it('rejects another owner, stale revisions, filesystem traversal and manage-confirm injection', async () => {
  const p = await project();
  await expect(call('chat_song_read', { projectId: p.id }, { userId: 'different-owner' })).rejects.toThrow();
  await expect(call('chat_song_project', { action: 'lock-script', projectId: p.id, revision: p.revision - 1 })).rejects.toThrow(/changed/i);
  await expect(call('chat_song_project', { action: 'select-song', projectId: p.id, revision: p.revision, value: { fileId: '../tool-song.wav' } })).rejects.toThrow(/file ID/);
  await expect(call('chat_song_project', { action: 'confirm-song', ...checksFor(p) })).rejects.toThrow(/arguments/);
  expect(getChatSongProject(uid, p.id).song?.confirmed).toBe(false);
});
it('never accepts model-supplied userConfirmed or bypassing the confirmation handler', async () => {
  const p = await project(), args = checksFor(p);
  await expect(call('chat_song_confirm_song', { ...args, userConfirmed: true })).rejects.toThrow(/arguments/);
  await expect(registry.get('chat_song_confirm_song')!.handler(args, ctx())).rejects.toThrow(/user must confirm/);
  await propose(p);
  expect(getChatSongProject(uid, p.id).song?.confirmed).toBe(false);
});
it('consumes one exact durable human confirmation and saves only its exact song/script binding', async () => {
  const p = await project(), { pending, scope, args } = await propose(p);
  const record = await executeConfirmedToolStep({ registry, id: randomUUID(), userId: uid, pending, scope, context: ctx() });
  expect(record.error).toBeFalsy(); expect(record.executionOrigin).toBe('confirmed_action_resume');
  expect(record.arguments).toEqual(pending.exactArgs);
  expect(record.arguments).toMatchObject(args);
  const saved = getChatSongProject(uid, p.id); expect(saved.song?.confirmed).toBe(true); expect(saved.revision).toBe(p.revision + 1);
  const replay = await executeConfirmedToolStep({ registry, id: randomUUID(), userId: uid, pending, scope, context: ctx() });
  expect(replay.error).toBeTruthy(); expect(getChatSongProject(uid, p.id)).toEqual(saved);
});
it.each(['revision', 'lyrics', 'song', 'source-bytes'] as const)('rejects an old exact confirmation after %s changes', async kind => {
  const p = await project(), { pending, scope } = await propose(p);
  if (kind === 'revision' || kind === 'lyrics') await call('chat_song_project', { action: 'save', projectId: p.id, revision: p.revision, value: { title: p.title + ' changed', brief: p.brief, lines: kind === 'lyrics' ? [{ ...lines[0], text: 'Changed original lyric' }, lines[1]] : lines } });
  else if (kind === 'song') await call('chat_song_project', { action: 'select-song', projectId: p.id, revision: p.revision, value: { fileId: 'tool-song.wav' } });
  else fs.appendFileSync(path.join(generatedKnowledgeDirectory({ userId: uid, domain: 'personal' }), 'tool-song.wav'), ' changed');
  const record = await executeConfirmedToolStep({ registry, id: randomUUID(), userId: uid, pending, scope, context: ctx() });
  expect(record.error).toBeTruthy(); expect(getChatSongProject(uid, p.id).song?.confirmed).toBe(false);
});
it('rejects incomplete lyric checks before asking for confirmation', async () => {
  const p = await project(), requestConfirmation = vi.fn();
  await expect(call('chat_song_confirm_song', { ...checksFor(p), checks: { ...checksFor(p).checks, correctOrder: false } }, { requestConfirmation })).rejects.toThrow(/arguments/);
  expect(requestConfirmation).not.toHaveBeenCalled();
});
it('uses the shared one-call official draft and returns a candidate without overwriting saved dialogue', async () => {
  const p = await project();
  const draft = await call('chat_song_draft_dialogue', { projectId: p.id, revision: p.revision });
  expect(mock.llm).toHaveBeenCalledTimes(1); expect(mock.llm.mock.calls[0][2]).toMatchObject({ provider: 'relay', reasoningEffort: 'low', responseFormat: 'json_object', selectionMode: 'pinned', noImplicitFailover: true });
  expect(draft.saved).toBe(false); expect(draft.lines.map((l: any) => l.text)).toEqual(lines.map(l => l.text));
  expect(getChatSongProject(uid, p.id)).toEqual(p);
});
it('preserves local_only before the draft SDK call and never treats a truncated response as saved', async () => {
  const p = await project();
  await expect(call('chat_song_draft_dialogue', { projectId: p.id, revision: p.revision }, { dataRoutingPolicy: 'local_only' })).rejects.toThrow(/local-only/);
  expect(mock.llm).not.toHaveBeenCalled();
  mock.llm.mockResolvedValueOnce({ text: JSON.stringify({ lines }), finishReason: 'length' });
  await expect(call('chat_song_draft_dialogue', { projectId: p.id, revision: p.revision })).rejects.toThrow(/incomplete/);
  expect(getChatSongProject(uid, p.id)).toEqual(p);
});
it('propagates parent cancellation before a mutation or draft and leaves owned state intact', async () => {
  const p = await project(), controller = new AbortController(); controller.abort(new Error('Synthetic caller cancelled'));
  await expect(call('chat_song_project', { action: 'lock-script', projectId: p.id, revision: p.revision }, { executionSignal: controller.signal })).rejects.toThrow(/cancel/i);
  await expect(call('chat_song_draft_dialogue', { projectId: p.id, revision: p.revision }, { executionSignal: controller.signal })).rejects.toThrow(/cancel/i);
  expect(mock.llm).not.toHaveBeenCalled(); expect(getChatSongProject(uid, p.id)).toEqual(p);
});
it('rejects incomplete actual timings even when optional song review is skipped', async () => {
  const p = await project();
  await expect(call('chat_song_render', { projectId: p.id, revision: p.revision })).rejects.toMatchObject({ status: 400 });
  expect(getChatSongProject(uid, p.id).song?.confirmed).toBe(false);
  expect(mock.media).toHaveBeenCalledTimes(1); // selection probe only; no encoder started
});

it('keeps all forty original lines and shows their complete checks in the exact human proposal', async () => {
  let p = await project();
  const full = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'B' : 'A', text: String(i + 1).padStart(2, '0') + ' original lyric '.repeat(6), group: Math.floor(i / 2) + 1, reaction: '' }));
  p = (await call('chat_song_project', { action: 'save', projectId: p.id, revision: p.revision, value: { title: p.title, brief: p.brief, lines: full } })).project;
  p = (await call('chat_song_project', { action: 'lock-script', projectId: p.id, revision: p.revision })).project;
  p = (await call('chat_song_project', { action: 'select-song', projectId: p.id, revision: p.revision, value: { fileId: 'tool-song.wav' } })).project;
  const { pending } = await propose(p), visible = formatPendingConfirmationRequest(pending);
  expect(getChatSongProject(uid, p.id).lines).toHaveLength(40);
  for (const line of p.lines) expect(visible).toContain(line.text);
});
it('cancels after an asynchronous media probe without committing its selection', async () => {
  const p = await project(), controller = new AbortController();
  mock.media.mockImplementationOnce(async () => { controller.abort(new Error('Synthetic probe cancellation')); return JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '15' } }); });
  await expect(call('chat_song_project', { action: 'select-song', projectId: p.id, revision: p.revision, value: { fileId: 'tool-song.wav' } }, { executionSignal: controller.signal })).rejects.toThrow(/cancel/i);
  expect(getChatSongProject(uid, p.id)).toEqual(p);
});
it('renders an unreviewed bound song through the real registry and cache without marking human review done', async () => {
  let p = await project();
  expect(p.song?.confirmed).toBe(false);
  p = (await call('chat_song_project', { action: 'set-timings', projectId: p.id, revision: p.revision, value: [{ lineId: '01', start: 1, end: 5 }, { lineId: '02', start: 6, end: 10 }] })).project;
  mock.media.mockImplementation(async (binary, args) => {
    if (binary === 'ffmpeg') { fs.writeFileSync(args.at(-1), 'Synthetic encoder bytes; this test verifies wiring, not singing quality.'); return ''; }
    return JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1440 }, { codec_type: 'audio' }], format: { duration: 15 } });
  });
  const rendered = await call('chat_song_render', { projectId: p.id, revision: p.revision });
  expect(rendered.render.sourceRevision).toBe(p.revision);
  expect(rendered.outputPath).toBe(path.join(generatedKnowledgeDirectory({ userId: uid, domain: 'personal' }), rendered.render.fileId));
  expect(rendered.artifacts).toEqual([{ type: 'video', path: rendered.outputPath }]);
  expect(registry.getCapabilityManifestEntry('chat_song_render')?.verification).toMatchObject({ strategy: 'artifact', requiredArtifacts: ['outputPath'], successStatuses: ['rendered'] });
  expect(rendered.render.warnings).toContain(CHAT_SONG_RENDER_COPY.lyricsUnreviewed);
  expect(getChatSongProject(uid, p.id).song?.confirmed).toBe(false);
  expect(fs.existsSync(path.join(generatedKnowledgeDirectory({ userId: uid, domain: 'personal' }), rendered.render.fileId))).toBe(true);
  expect((await call('chat_song_read', { projectId: p.id })).render).toEqual(rendered.render);
  expect((await call('chat_song_render', { projectId: p.id, revision: p.revision }, {})).render).toEqual(rendered.render);
  expect(mock.media.mock.calls.filter(([binary]) => binary === 'ffmpeg')).toHaveLength(1);
});

it('rejects executable fields before the fixed local encoder can run', async () => {
  const p = await project();
  const before = mock.media.mock.calls.length;
  await expect(call('chat_song_render', { projectId: p.id, revision: p.revision, command: 'do not execute this synthetic sentinel' })).rejects.toThrow(/arguments/);
  expect(mock.media.mock.calls).toHaveLength(before);
});

it('does not consume an exact song grant in another conversation scope', async () => {
  const p = await project(), { pending, scope } = await propose(p);
  const rejected = await executeConfirmedToolStep({ registry, id: randomUUID(), userId: uid, pending, scope: { ...scope, channelId: 'conversation:different-owned-test' }, context: ctx() });
  expect(rejected.error).toBeTruthy(); expect(getChatSongProject(uid, p.id).song?.confirmed).toBe(false);
  const accepted = await executeConfirmedToolStep({ registry, id: randomUUID(), userId: uid, pending, scope, context: ctx() });
  expect(accepted.error).toBeFalsy(); expect(getChatSongProject(uid, p.id).song?.confirmed).toBe(true);
});
it('cancelled confirmation cannot manufacture approval or modify the song', async () => {
  const p = await project(), requestConfirmation = vi.fn(), controller = new AbortController(); controller.abort(new Error('Synthetic confirmation cancelled'));
  await expect(call('chat_song_confirm_song', checksFor(p), { executionSignal: controller.signal, requestConfirmation })).rejects.toThrow(/cancel/i);
  expect(requestConfirmation).not.toHaveBeenCalled(); expect(getChatSongProject(uid, p.id).song?.confirmed).toBe(false);
});


async function cachedVideo(withImage = false) {
  let p = await project();
  p = (await call('chat_song_project', { action: 'set-timings', projectId: p.id, revision: p.revision, value: [{ lineId: '01', start: 1, end: 5 }, { lineId: '02', start: 6, end: 10 }] })).project;
  const directory = generatedKnowledgeDirectory({ userId: uid, domain: 'personal' });
  if (withImage) {
    fs.writeFileSync(path.join(directory, 'retrieval-avatar.png'), await (sharp as any)({ create: { width: 8, height: 8, channels: 3, background: '#4c6470' } }).png().toBuffer());
    p = (await call('chat_song_project', { action: 'attach-asset', projectId: p.id, revision: p.revision, value: { kind: 'avatarA', fileId: 'retrieval-avatar.png' } })).project;
  }
  const fileId = 'retrieval-' + randomUUID() + '.mp4', filePath = path.join(directory, fileId);
  fs.writeFileSync(filePath, 'Synthetic existing video; retrieval tests prove owner/hash binding, not audio or visual quality.');
  const render = { fileId, sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), sourceRevision: p.revision, sourceInputsSha256: chatSongRenderInputSha(p), templateVersion: CHAT_SONG_TEMPLATE.version, duration: 15, width: 1080, height: 1440, createdAt: new Date().toISOString(), warnings: [] };
  saveChatSongRender(uid, p.id, render);
  await registerGeneratedKnowledgeFile({ userId: uid, domain: 'personal' }, fileId);
  mock.media.mockClear(); return { p: p as ChatSongProject, render, filePath, directory };
}

async function deliverExistingVideoThroughChat(p: ChatSongProject, language: 'en' | 'zh' = 'en') {
  const requestId = randomUUID(), conversationId = getOrCreateActiveConversation(uid, 'lumi', 'personal', '').id;
  const identity = { userId: uid, requestId, conversationId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
  const text = language === 'en' ? 'Return the existing video for chat-song project ' + p.id + ', revision ' + p.revision + ', as an attachment. Do not regenerate or modify any file.'
    : '请取回聊天唱歌工程 ' + p.id + ' 第 ' + p.revision + ' 版已有成片，作为视频附件返回。不要重新生成或修改任何文件。';
  const authorization = captureRequestAuthorization(() => true, 'Synthetic request is no longer current'); let diagnostic: unknown;
  mock.llm.mockReset().mockImplementation(async (messages: Array<{ promptBlock?: { id: string; fields?: Record<string, unknown> } }>, declarations: Array<{ function: { name: string } }>) => {
    const fields = messages.find(message => message.promptBlock?.id === 'current-execution-authorization')?.promptBlock?.fields;
    if (mock.llm.mock.calls.length === 1) {
      expect(declarations.map(item => item.function.name), JSON.stringify(diagnostic)).toContain('chat_song_read');
      return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'accepted-existing-song-read', name: 'chat_song_read', arguments: { projectId: p.id, revision: p.revision, includeOutput: true } }] };
    }
    const evidence = fields?.completionEvidence as Array<{ id: string; operation: string; effects: unknown[] }>;
    return { text: JSON.stringify({ answer: 'Here is the selected existing video.', goals: [{ text, operation: evidence[0].operation, effects: evidence[0].effects, status: 'completed', evidenceIds: [evidence[0].id] }] }), finishReason: 'stop', toolCalls: [] };
  });
  const input: LumiEntryTurnInput<ExecutedLumiTurn> = {
    entry: { source: 'chat', channel: 'chat', historyLimit: 10, failureText: 'Synthetic existing video request did not finish.', failureReason: 'existing_song_fixture' },
    identity, userText: text, authorization, controller: new AbortController(),
    planning: { dispatch: { ...identity, text, source: 'chat', channel: 'chat', operationMode: 'assistant', targetIsLumi: true }, registry,
      personalityToolPolicy: { allowedTools: ['chat_song_read'], forbiddenTools: ['chat_song_render', 'chat_song_project', 'chat_song_draft_dialogue'], requireConfirmation: [], maxIterations: 3 }, executionBoundary: 'trusted_local' },
    assemble: execution => {
      diagnostic = { flow: { mode: execution.turnIntent.flow.effectiveOperationMode, tools: execution.turnIntent.flow.allowToolUseForTurn, selfRepair: execution.turnIntent.flow.selfRepairTurn, clientOnly: execution.turnIntent.flow.clientActionOnlyTurn }, requested: execution.executionRequested, execution: execution.execution, projection: execution.modelToolProjection,
        scopedManifest: registry.getCapabilityManifest(undefined, { context: { ...identity, source: 'chat', autonomous: false } }).map(item => ({ name: item.toolName, executable: item.executable, modes: item.modes })) };
      return { systemPrompt: 'Return the requested existing video from a genuine current receipt, without rendering.', model: { registry, config: { provider: 'deepseek', model: 'offline-existing-song', userId: uid, requestId }, getters: {}, maxIterations: 3,
        context: ctx({ allowLocalFileWrites: false, actionIntent: text, routedTaskText: text }) } };
    }, deliver: result => result,
  };
  const result = await runLumiEntryTurn(input); return { result, identity, text, diagnostic };
}

it.each(['en', 'zh'] as const)('delivers an explicitly requested existing video through a canonical read-only receipt and the normal chat attachment collector (%s)', async language => {
  const { p, render, filePath, directory } = await cachedVideo();
  const before = fs.readdirSync(directory), original = structuredClone(getChatSongProject(uid, p.id));
  const ordinary = await call('chat_song_read', { projectId: p.id });
  expect(ordinary).toMatchObject({ status: 'read', project: original, render });
  expect(ordinary.artifacts).toBeUndefined(); expect(ordinary.outputPath).toBeUndefined(); expect(ordinary.library).toBeUndefined(); expect(ordinary.handoff).toBeUndefined();
  const entry = await deliverExistingVideoThroughChat(p, language);
  expect(entry.result.toolRecords, JSON.stringify(entry.diagnostic)).toHaveLength(1);
  const record = entry.result.toolRecords[0];
  expect(record.error).toBeFalsy(); expect(record.terminalVerification?.status).toBe('verified');
  expect(isCanonicalToolExecutionRecord(record)).toBe(true);
  expect(record).toMatchObject({ requestId: entry.identity.requestId, taskId: entry.result.taskId });
  expect(entry.result.finalized.blocked).toBe(false);
  expect(readDB().conversationActionTasks.find(row => row.id === entry.result.taskId)?.status).toBe('completed');
  const durable = await querySQL<{ taskId: string; requestId: string; toolName: string }>('SELECT taskId, requestId, toolName FROM conversation_action_receipts WHERE requestId = ?', [entry.identity.requestId]);
  expect(durable).toEqual([{ taskId: entry.result.taskId, requestId: entry.identity.requestId, toolName: 'chat_song_read' }]);
  const result = JSON.parse(record.result!);
  expect(result).toMatchObject({ ok: true, verified: true, status: 'retrieved', selectedStyle: 'chat', outputPath: filePath, artifacts: [{ type: 'video', path: filePath, sha256: render.sha256, size: fs.statSync(filePath).size }] });
  expect(result.project).toBeUndefined(); expect(result.library).toBeUndefined(); expect(result.handoff).toBeUndefined();
  expect(fs.readdirSync(directory)).toEqual(before);
  const artifacts = collectChatArtifacts([record]); expect(artifacts).toHaveLength(1); expect(artifacts[0].kind).toBe('video'); expect(artifacts[0].fileName).toBe(render.fileId);
  expect(registry.getCapabilityManifestEntry('chat_song_read')).toMatchObject({ operation: 'observe', sideEffects: [{ type: 'local_read' }] });
  expect(mock.media).not.toHaveBeenCalled(); expect(mock.llm).toHaveBeenCalledTimes(2); expect(mock.llm.mock.calls.every(args => args[2].model === 'offline-existing-song')).toBe(true); expect(fs.readdirSync(directory)).toEqual(before); expect(getChatSongProject(uid, p.id)).toEqual(original); expect(original.song?.confirmed).toBe(false);
});
it.each(['stale-request', 'visual-change', 'replaced-video', 'replaced-song', 'replaced-input', 'wrong-receipt-sha', 'old-template'] as const)('rejects %s for existing-output retrieval without rendering or changing lyric approval', async kind => {
  const { p, render, filePath, directory } = await cachedVideo(kind === 'replaced-input');
  if (kind === 'visual-change') await call('chat_song_project', { action: 'save', projectId: p.id, revision: p.revision, value: { title: p.title, brief: { ...p.brief, displayNameA: 'Changed visible name' }, lines } });
  if (kind === 'replaced-video') fs.appendFileSync(filePath, ' replaced');
  if (kind === 'replaced-song') fs.appendFileSync(path.join(directory, p.song!.fileId), ' replaced');
  if (kind === 'replaced-input') fs.appendFileSync(path.join(directory, 'retrieval-avatar.png'), ' replaced');
  if (kind === 'wrong-receipt-sha') saveChatSongRender(uid, p.id, { ...render, sha256: '0'.repeat(64) });
  if (kind === 'old-template') saveChatSongRender(uid, p.id, { ...render, templateVersion: CHAT_SONG_TEMPLATE.version - 1 });
  const latest = getChatSongProject(uid, p.id);
  await expect(call('chat_song_read', { projectId: p.id, revision: kind === 'stale-request' ? p.revision - 1 : latest.revision, includeOutput: true })).rejects.toMatchObject({ status: 409 });
  expect(mock.media).not.toHaveBeenCalled(); expect(mock.llm).not.toHaveBeenCalled(); expect(getChatSongProject(uid, p.id)).toEqual(latest); expect(latest.song?.confirmed).toBe(false);
});
it('requires an exact owned project and never attaches a video for a normal list query', async () => {
  const { p } = await cachedVideo();
  const list = await call('chat_song_read', {}); expect(list.library).toBeTruthy(); expect(list.artifacts).toBeUndefined(); expect(list.outputPath).toBeUndefined();
  await expect(call('chat_song_read', { includeOutput: true })).rejects.toMatchObject({ status: 400 });
  await expect(call('chat_song_read', { projectId: p.id, includeOutput: true }, { userId: 'different-owner' })).rejects.toMatchObject({ status: 404 });
  expect(mock.media).not.toHaveBeenCalled();
});
it('returns only the selected bound animation, preserves both files, and rejects a replaced or stale binding without a media process', async () => {
  const { p: initial, render, directory } = await cachedVideo();
  let p = (await call('chat_song_project', { action: 'save', projectId: initial.id, revision: initial.revision, value: { title: initial.title, brief: { ...initial.brief, outputStyle: 'animation' }, lines } })).project;
  fs.writeFileSync(path.join(directory, 'retrieval-animation.mp4'), 'Synthetic owned animation fixture');
  mock.media.mockResolvedValueOnce(JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: '15' } }));
  await call('chat_song_project', { action: 'attach-asset', projectId: p.id, revision: p.revision, value: { kind: 'animation', fileId: 'retrieval-animation.mp4' } });
  mock.media.mockClear(); const before = fs.readdirSync(directory);
  const selected = await call('chat_song_read', { projectId: p.id, revision: p.revision, includeOutput: true });
  expect(selected.selectedStyle).toBe('animation'); expect(selected.output.fileId).toBe('retrieval-animation.mp4'); expect(selected.output.fileId).not.toBe(render.fileId); expect(fs.readdirSync(directory)).toEqual(before);
  fs.appendFileSync(path.join(directory, 'retrieval-animation.mp4'), ' replaced');
  await expect(call('chat_song_read', { projectId: p.id, includeOutput: true })).rejects.toMatchObject({ status: 409 });
  fs.writeFileSync(path.join(directory, 'retrieval-animation.mp4'), 'Synthetic owned animation fixture');
  p = (await call('chat_song_project', { action: 'save', projectId: p.id, revision: p.revision, value: { title: p.title, brief: p.brief, lines: [{ ...lines[0], text: 'Different current script' }, lines[1]] } })).project;
  await expect(call('chat_song_read', { projectId: p.id, includeOutput: true })).rejects.toMatchObject({ status: 409 });
  expect(mock.media).not.toHaveBeenCalled(); expect(mock.llm).not.toHaveBeenCalled(); expect(getChatSongProject(uid, p.id).song?.confirmed).not.toBe(true);
});

vi.mock('../server/creative/chat_song_reactions', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/creative/chat_song_reactions')>();
  return { ...actual, searchChatSongReactions: vi.fn(async (_scope, lines) => lines.map((line: {id:string;reaction:string}) => ({lineId:line.id,query:line.reaction,status:line.reaction ? 'no_match' : 'empty',candidates:[]}))) };
});

it('searches existing reaction keywords through the existing dialogue tool without another dialogue model call', async () => {
  const p = await project(); const before=structuredClone(p); mock.llm.mockClear();
  const result=await call('chat_song_draft_dialogue',{projectId:p.id,revision:p.revision,searchOnly:true});
  expect(result).toMatchObject({ok:true,verified:true,status:'searched',saved:false,projectId:p.id,revision:p.revision});
  expect(result.reactions).toHaveLength(p.lines.length);
  expect(mock.llm).not.toHaveBeenCalled(); expect(getChatSongProject(uid,p.id)).toEqual(before);
  await expect(call('chat_song_draft_dialogue',{projectId:p.id,revision:p.revision-1,searchOnly:true})).rejects.toThrow(/current project|changed|Reload/i);
});


it('does not expose an unpersisted canonical existing-output read as a public attachment', async () => {
  const { p } = await cachedVideo();
  const record = await executeToolCall({ registry, name: 'chat_song_read', arguments: { projectId: p.id, revision: p.revision, includeOutput: true }, executionOrigin: 'model_selected', context: ctx({ allowLocalFileWrites: false, toolPolicy: { allowedTools: ['chat_song_read'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 } }) });
  expect(record.error).toBeFalsy(); expect(isCanonicalToolExecutionRecord(record)).toBe(true);
  expect(collectChatArtifacts([record])).toEqual([]);
});

it('preserves the public owner boundary and rebuilds only the durable selected artifact', async () => {
  const { p, filePath } = await cachedVideo(); const entry = await deliverExistingVideoThroughChat(p);
  const context = { ...entry.identity, taskId: entry.result.taskId };
  expect(collectChatArtifacts(entry.result.toolRecords, entry.identity.conversationId)).toHaveLength(1);
  for (const invalid of [{ userId: 'another-owner' }, { domain: 'work' as const }, { orgId: 'another-organization' }]) {
    expect(publicChatArtifactDelivery(entry.result.toolRecords, entry.identity.conversationId, { ...context, ...invalid }).artifacts).toEqual([]);
  }
  const record = entry.result.toolRecords[0];
  const forged = { ...record, id: randomUUID(), taskId: randomUUID(), requestId: randomUUID() };
  expect(collectChatArtifacts([forged], entry.identity.conversationId)).toEqual([]);
  const altered = { ...record, result: JSON.stringify({ ok: true, verified: true, status: 'retrieved', outputPath: filePath + '.forged.mp4', artifacts: [{ type: 'video', path: filePath + '.forged.mp4' }] }) };
  const rebuilt = collectChatArtifacts([altered], entry.identity.conversationId);
  expect(rebuilt).toHaveLength(1); expect(rebuilt[0].path).toBe(filePath);
});

it.each(['missing-receipt', 'turn-user', 'turn-domain', 'turn-org'] as const)('withholds the existing video when %s no longer proves accepted durable ownership', async kind => {
  const { p } = await cachedVideo(); const entry = await deliverExistingVideoThroughChat(p);
  expect(collectChatArtifacts(entry.result.toolRecords, entry.identity.conversationId)).toHaveLength(1);
  const tables = readDatabaseTables(['conversationActionReceipts', 'conversationActionTurns']);
  const savedReceipts = structuredClone(tables.conversationActionReceipts), savedTurns = structuredClone(tables.conversationActionTurns);
  if (kind === 'missing-receipt') tables.conversationActionReceipts = tables.conversationActionReceipts.filter((row: { requestId: string }) => row.requestId !== entry.identity.requestId);
  else {
    const turn = tables.conversationActionTurns.find((row: { requestId: string }) => row.requestId === entry.identity.requestId)!;
    if (kind === 'turn-user') turn.userId = 'another-owner'; if (kind === 'turn-domain') turn.domain = 'work'; if (kind === 'turn-org') turn.orgId = 'another-organization';
  }
  commitDatabaseTables(tables); await flushDBOrThrow();
  try { expect(collectChatArtifacts(entry.result.toolRecords, entry.identity.conversationId)).toEqual([]); }
  finally { const restore = readDatabaseTables(['conversationActionReceipts', 'conversationActionTurns']); restore.conversationActionReceipts = savedReceipts; restore.conversationActionTurns = savedTurns; commitDatabaseTables(restore); await flushDBOrThrow(); }
});
