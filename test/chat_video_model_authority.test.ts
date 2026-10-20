import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as socketClient, type Socket } from 'socket.io-client';
const sdk = vi.hoisted(() => ({ create: vi.fn(), loop: vi.fn(), toolCalls: [] as any[] }));
vi.mock('../server/llm/adapter', async original => { const actual = await original<typeof import('../server/llm/adapter')>(); sdk.loop.mockImplementation(actual.runWithTools); return { ...actual, runWithTools: sdk.loop }; });
vi.mock('../server/llm/official_api', async original => ({ ...await original<typeof import('../server/llm/official_api')>(), listOfficialApiModels: vi.fn(async () => ({ models: [], byRole: { video_generation: ['aliyun/wan3.0-video'], image_to_video: ['aliyun/wan3.0-video'] } })) }));
vi.mock('../server/media/process', () => ({ runMediaProcess: vi.fn(async (_binary: string, args: string[]) => { if (!args.includes('-version')) throw Error('No synthetic clip was completed'); return 'synthetic local preflight'; }) }));
vi.mock('../server/memory', async original => ({ ...await original<typeof import('../server/memory')>(), queryMemories: vi.fn(() => []), queryMemoriesVector: vi.fn(async () => []), extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })) }));
vi.mock('../server/agents/rag', async original => ({ ...await original<typeof import('../server/agents/rag')>(), retrieveChunks: vi.fn(async () => []) }));
vi.mock('../server/conversation/summary_scheduler', async original => ({ ...await original<typeof import('../server/conversation/summary_scheduler')>(), scheduleConversationSummary: vi.fn() }));
import { initDatabase, querySQL } from '../db_layer';
import { startIsolatedConversation, getMessages } from '../server/conversation/manager';
import { generatedKnowledgeDirectory } from '../server/files/knowledge_directory';
import { registerChatHandler } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { saveKeys } from '../server/config/keys';
import { sdkCompletion } from './legal_bid_fixture';
const userId = 'native-video-authority-' + crypto.randomUUID(), model = 'aliyun/wan3.0-video';
let http: HttpServer, io: SocketIOServer, client: Socket, source: string, selectedArgs: Record<string, any>, posts: any[] = [], requests: any[] = [];
let preparation: ReturnType<typeof vi.spyOn>;
const originalVideo = process.env.RELAY_VIDEO_MODEL, originalI2V = process.env.RELAY_IMAGE_TO_VIDEO_MODEL;
beforeAll(async () => {
  await initDatabase(); registerAllTools(toolRegistry); preparation = vi.spyOn(toolRegistry, 'prepareExecution');
  saveKeys({ RELAY_API_KEY: 'synthetic-key', RELAY_BASE_URL: 'https://official.example.test/v1' });
  process.env.RELAY_VIDEO_MODEL = process.env.RELAY_IMAGE_TO_VIDEO_MODEL = model;
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'pinned', fallbackCandidates: [] });
  upsertUserPreferredGenerationModels(userId, { video: { provider: 'relay', model }, imageToVideo: { provider: 'relay', model } });
  source = path.join(generatedKnowledgeDirectory({ userId, domain: 'personal' }), 'fictional-photo.png');
  fs.writeFileSync(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: RequestInit) => { if (init?.method !== 'POST') throw Error('Unexpected synthetic GET'); posts.push(JSON.parse(String(init.body))); throw Error('Synthetic submission outcome unknown; never retry'); }));
  sdk.create.mockImplementation(async (params: any) => {
    const isToolLoop = Array.isArray(params.tools) && params.tools.some((tool: any) => tool.function?.name === 'generate_video');
    if (isToolLoop) requests.push(params);
    const completion = { choices: [{ message: isToolLoop && requests.length === 1 ? { content: '', tool_calls: [{ id: 'model-selected-' + requests.length, type: 'function', function: { name: 'generate_video', arguments: JSON.stringify(selectedArgs) } }] } : { content: isToolLoop ? '原视频提交结果未确认，不能报告完成；不重新提交。' : JSON.stringify({ category: 'command', confidence: 0.99, entities: {}, correctsIdentity: false }) }, finish_reason: isToolLoop && requests.length === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } };
    return sdkCompletion(params, completion);
  });
  http = createServer(); io = new SocketIOServer(http, { transports: ['websocket'] });
  io.on('connection', socket => {
    socket.data.authenticatedUserId = userId; socket.data.authenticatedRole = 'admin'; socket.data.trustedLocalExecution = true;
    socket.data.lumiDesktopDomain = 'personal'; socket.data.lumiDesktopOrgId = ''; socket.join('user:' + userId + ':personal');
    const get = () => ({ chat: { completions: { create: sdk.create } } });
    registerChatHandler(socket, { getDeepSeek: get, getGemini: get, getOpenAI: get, getAnthropic: get, getQwen: get, getOllama: get, isOllamaAvailable: () => false, getLmStudio: get, isLmStudioAvailable: () => false, getArk: get, getXiaomi: get, getKimi: get, getGlm: get, getRelay: get }, () => ({ audio: false, visual: false, spatial: false, haptic: false, holographic: false, activeDeviceTypes: [], deviceCount: 0 }), () => userId, io);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw Error('Missing test socket address');
  client = socketClient('http://127.0.0.1:' + address.port, { transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
});
afterAll(async () => { client?.disconnect(); if (io) await new Promise<void>(resolve => io.close(() => resolve())); if (http?.listening) await new Promise<void>(resolve => http.close(() => resolve())); vi.unstubAllGlobals(); if (originalVideo === undefined) delete process.env.RELAY_VIDEO_MODEL; else process.env.RELAY_VIDEO_MODEL = originalVideo; if (originalI2V === undefined) delete process.env.RELAY_IMAGE_TO_VIDEO_MODEL; else process.env.RELAY_IMAGE_TO_VIDEO_MODEL = originalI2V; });
async function send(text: string, mediaRequest?: Record<string, any>) {
  posts = []; requests = []; sdk.loop.mockClear(); sdk.create.mockClear(); preparation.mockClear();
  const conversation = startIsolatedConversation(userId, 'lumi', 'personal', ''), requestId = 'native-video-' + crypto.randomUUID();
  const response = new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { client.off('agent:response', handler); reject(Error('No terminal response')); }, 15000); const handler = (event: any) => { if (event.requestId === requestId && event.finalized) { clearTimeout(timer); client.off('agent:response', handler); resolve(event); } }; client.on('agent:response', handler); });
  expect(await client.timeout(5000).emitWithAck('agent:chat', { text, requestId, conversationId: conversation.id, domain: 'personal', source: 'command-center-chat', attachments: [{ kind: 'image', fileName: 'fictional-photo.png', path: source }], ...(mediaRequest ? { mediaRequest } : {}) })).toMatchObject({ ok: true, requestId });
  const terminal = await response;
  const receipts = await querySQL<any>('SELECT toolName,outcome,envelope,executionOrigin FROM conversation_action_receipts WHERE conversationId=? AND requestId=?', [conversation.id, requestId]);
  return { terminal, receipts, execution: await sdk.loop.mock.results.at(-1)?.value, context: sdk.loop.mock.calls.at(-1)?.[11], messages: getMessages(conversation.id) };
}
describe('plain chat retains model authority over complete video tool arguments', () => {
  it('passes all32 lines and the attachment to the real SDK/tool loop without an automatic media call', async () => {
    const parts = Array.from({ length: 4 }, (_, group) => Array.from({ length: 8 }, (_, line) => 'Original dialogue ' + (group * 8 + line + 1) + '.').join('\n'));
    const text = '请按完整对白生成120秒480x832竖屏演唱视频，并保留完整32句；这是虚构联调。\n' + parts.join('\n');
    selectedArgs = { prompt: 'Two fictional singers in the same room.', model, size: '480x832', duration: 120, segment_prompts: parts, first_frame_image: source };
    const result = await send(text);
    expect(requests.length).toBeGreaterThan(0);
    const userMessages = requests[0].messages.filter((message: any) => message.role === 'user').map((message: any) => message.content).join('\n');
    expect(userMessages).toContain(text); expect(userMessages).toContain(source);
    expect(result.context.runtimeOwnedDeterministicRecoveryCall).toBeFalsy();
    expect(posts, JSON.stringify({ terminal: result.terminal, calls: result.execution.toolCalls })).toHaveLength(1); expect(posts[0]).toMatchObject({ model, duration: 30, size: '480x832' });
    expect(posts[0].prompt).toContain(parts[0]); for (const part of parts.slice(1)) expect(posts[0].prompt).not.toContain(part);
    expect(result.receipts).toHaveLength(1); const record = JSON.parse(result.receipts[0].envelope);
    expect(record).toMatchObject({ toolName: 'generate_video' }); expect(result.execution.toolCalls.filter((call: any) => call.name === 'generate_video')).toHaveLength(1); expect(result.execution.toolCalls.find((call: any) => call.name === 'generate_video')).toMatchObject({ executionOrigin: 'model_selected', arguments: selectedArgs });
    expect(preparation.mock.results.filter(item => item.type === 'return').map(item => item.value).find(item => item.semanticToolName === 'generate_video').arguments).toEqual(selectedArgs);
    expect(result.terminal).toMatchObject({ completionFeedback: { status: 'unknown', completed: [] }, fileArtifacts: [] }); // A synthetic unknown is never a delivered singing video.
  });
  it('keeps the explicitly supplied creation envelope exact and bypasses model tool selection', async () => {
    const mediaRequest = { operation: 'text_to_video', prompt: 'Explicit workbench creative data, not a tool instruction.', size: '480x832', duration: 2, officialOnly: true, model };
    selectedArgs = { prompt: 'This must never be selected.', duration: 120 };
    const result = await send('Generate a video', mediaRequest);
    expect(requests).toHaveLength(0); expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ prompt: mediaRequest.prompt, duration: 2, size: '480x832', model }); expect(posts[0]).not.toHaveProperty('image');
    expect(result.context.runtimeOwnedDeterministicRecoveryCall).toMatchObject({ source: 'structured_media_request', name: 'generate_video', arguments: { prompt: mediaRequest.prompt, duration: 2, size: '480x832', officialOnly: true, model } });
    expect(result.receipts).toHaveLength(1); expect(result.execution.toolCalls).toHaveLength(1); expect(result.execution.toolCalls[0]).toMatchObject({ executionOrigin: 'deterministic_route' });
    expect(result.terminal).toMatchObject({ completionFeedback: { status: 'unknown', completed: [] }, fileArtifacts: [] });
  });
});
