import './helpers';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import { initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { getUserPreferredGenerationModels, upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { mountSystemRoutes } from '../server/routes/system_routes';
import { registerVideoTools } from '../server/tools/definitions/video_tools';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { inspectExternalCommitAttempt } from '../server/tools/external_commit_journal';
import { normalizeStructuredMediaRequest, structuredMediaToolCall } from '../shared/media_generation';
import { VALID_MP4 } from './fixtures/synthetic_video';

const USER = 'media-catalog-boundary-user';
const LIVE = 'aliyun/wan3.0-video';
const STALE = 'aliyun/Wan2.2-T2V-A14B';
const nativeFetch = globalThis.fetch;
const originalVideoEnv = process.env.RELAY_VIDEO_MODEL;
const originalI2vEnv = process.env.RELAY_IMAGE_TO_VIDEO_MODEL;
const catalogModels = [
  { id: LIVE, capability: 'video_generation' },
  { id: 'aliyun/wan3.0-video-prime', capability: 'video_generation' },
  { id: 'aliyun/qwen-image', capability: 'image_generation' },
  { id: 'aliyun/qwen-image-edit-2509', capability: 'image_edit' },
];
let localUrl = '', cleanup = () => {};
let requests: Array<{ url: string; method: string; body: any }>;
let catalogFails = false;
let submissionStatus = 200, submissionBody: any = null, pollStatus = 400, pollFails = false, requestSequence = 0, requestIdentity = '';
let fetchMock: ReturnType<typeof vi.fn>;
const token = jwt.sign({ uid: USER, username: USER, role: 'admin' }, JWT_SECRET);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  await initDatabase();
  const app = await makeApp(); localUrl = app.url; cleanup = app.cleanup;
  mountSystemRoutes(app.apiRouter, JWT_SECRET, { emit: () => {} });
});
afterAll(() => cleanup());
beforeEach(() => {
  requests = []; catalogFails = false;
  submissionStatus = 200; submissionBody = null; pollStatus = 400; pollFails = false; requestIdentity = 'media-catalog-request-' + (++requestSequence);
  process.env.RELAY_VIDEO_MODEL = STALE;
  process.env.RELAY_IMAGE_TO_VIDEO_MODEL = 'aliyun/Wan2.2-I2V-A14B';
  saveKeys({ RELAY_API_KEY: 'synthetic-key', RELAY_BASE_URL: 'https://media-catalog.invalid/v1' });
  upsertUserPreferredGenerationModels(USER, {
    video: { provider: 'relay', model: STALE, models: { relay: STALE } },
    imageToVideo: { provider: 'relay', model: 'aliyun/Wan2.2-I2V-A14B' },
  });
  fetchMock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.startsWith(localUrl)) return nativeFetch(input, init);
    const method = init.method || 'GET';
    requests.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/models')) {
      if (catalogFails) throw new Error('Synthetic timeout reading catalog');
      return json({ data: catalogModels });
    }
    if (url.endsWith('/videos/generations')) return json(submissionBody || { video_base64: VALID_MP4.toString('base64') }, submissionStatus);
    if (url.includes('/videos/generations/job-fixture')) {
      if (pollFails) { pollFails = false; throw new Error('Lumi Official API request timed out after 90000ms'); }
      return json({ error: { message: 'Synthetic status lookup failed' } }, pollStatus);
    }
    throw new Error('Unexpected external request: ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals(); saveKeys({ RELAY_API_KEY: '', RELAY_BASE_URL: '' });
  for (const [key, value] of [['RELAY_VIDEO_MODEL', originalVideoEnv], ['RELAY_IMAGE_TO_VIDEO_MODEL', originalI2vEnv]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});
async function execute(args: Record<string, unknown>) {
  const registry = new ToolRegistry(); registerVideoTools(registry);
  return executeToolCall({ registry, name: 'generate_video', arguments: { prompt: 'Synthetic video fixture', ...args },
    context: { userId: USER, requestId: requestIdentity, idempotencyKey: requestIdentity + '-' + createHash('sha256').update(JSON.stringify(args)).digest('hex'), allowLocalFileWrites: true, localWriteIntentReason: 'Synthetic media acceptance.' } });
}
async function expectNotSubmitted(record: Awaited<ReturnType<typeof execute>>) {
  expect(record.adapterStarted).toBe(false);
  expect(record.terminalVerification?.status).toBe('failed');
  expect(record.envelope?.status).toBe('failed');
  expect(record.error).toContain('本次未提交视频生成请求');
  expect(record.error).not.toMatch(/outcome is unknown|external commit/i);
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
  expect((await inspectExternalCommitAttempt(record.idempotencyKey!)).entry).toBeNull();
}

describe('official video catalog admission and one-request selection', () => {
  it('rejects a saved retired model before a paid adapter or durable claim starts', async () => {
    const before = getUserPreferredGenerationModels(USER);
    await expectNotSubmitted(await execute({ size: '832x480', duration: 5 }));
    expect(getUserPreferredGenerationModels(USER)).toEqual(before);
  });
  it.each(['aliyun/unknown-video', 'aliyun/qwen-image'])('rejects unknown or wrong-role ids: %s', async model => {
    await expectNotSubmitted(await execute({ model, size: '854x480', duration: 5 }));
  });
  it('keeps directory failures distinct from an unknown paid generation outcome', async () => {
    catalogFails = true;
    await expectNotSubmitted(await execute({ model: LIVE, size: '854x480', duration: 5 }));
  });
  it('forwards an explicit live model without changing saved preferences or using a deployment override', async () => {
    const before = getUserPreferredGenerationModels(USER);
    const record = await execute({ model: LIVE, size: '854x480', duration: 15 });
    expect(record.error).toBeUndefined();
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({ model: LIVE, size: '854x480', duration: 15 });
    expect(JSON.parse(record.result!)).toMatchObject({ model: LIVE, selectionReason: 'explicit_model', generationMode: 'text_to_video' });
    expect(getUserPreferredGenerationModels(USER)).toEqual(before);
  });
  it.each([LIVE, 'aliyun/wan3.0-video-prime'])('preserves the first frame for the documented unified route %s and rejects an unadvertised id', async model => {
    const firstFrame = path.join(process.env.LUMI_DATA_DIR!, 'catalog-first-frame.png');
    fs.writeFileSync(firstFrame, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    const record = await execute({ model, first_frame_image: firstFrame, size: '854x480', duration: 5 });
    expect(record.error).toBeUndefined();
    expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({ model, image: expect.stringMatching(/^data:image/), duration: 5, size: '854x480' });
    expect(JSON.parse(record.result!)).toMatchObject({ generationMode: 'image_to_video', inputReferenceAccepted: true, selectionReason: 'explicit_model' });
    requests = [];
    await expectNotSubmitted(await execute({ model: 'aliyun/wan3.0-video-unsupported', first_frame_image: firstFrame, size: '854x480', duration: 5 }));
  });
  it.each([{ duration: 31, size: '854x480' }, { duration: 5, size: '999x999' }, { duration: 5, size: '832x480' }])('keeps native duration and size restrictions before catalog or paid requests', async invalid => {
    const record = await execute({ model: LIVE, ...invalid });
    expect(record.adapterStarted).toBe(false); expect(record.terminalVerification?.status).toBe('failed');
    expect(requests).toHaveLength(0);
  });
  it('rejects saving stale official generation preferences without changing persistence', async () => {
    const before = getUserPreferredGenerationModels(USER);
    const response = await nativeFetch(localUrl + '/api/preferences/generation', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(before) });
    expect(response.status).toBe(400);
    expect(getUserPreferredGenerationModels(USER)).toEqual(before);
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });
  it('settles a definite submission 400 without inventing an unknown provider outcome', async () => {
    submissionStatus = 400; submissionBody = { error: { message: 'Synthetic request rejected' } };
    const record = await execute({ model: LIVE, size: '854x480', duration: 5 });
    expect(record.adapterStarted).toBe(true); expect(record.terminalVerification?.status).toBe('failed');
    expect(record.envelope?.status).toBe('failed'); expect(record.error).toContain('request failed (400)');
    expect(record.error).not.toContain('outcome is unknown');
    expect((await inspectExternalCommitAttempt(record.idempotencyKey!)).entry?.state).toBe('not_started');
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it('keeps a rejected HTTP response with an assigned job id unknown and non-replayable', async () => {
    submissionStatus = 400; submissionBody = { jobId: 'job-fixture', error: { message: 'Synthetic ambiguous rejection' } };
    const args = { model: LIVE, size: '854x480', duration: 5 };
    const record = await execute(args);
    expect(JSON.parse(record.result!)).toMatchObject({ status: 'unknown', taskId: 'job-fixture', recoveryTool: 'get_video_generation_status' });
    expect((await inspectExternalCommitAttempt(record.idempotencyKey!)).entry?.state).toBe('unknown');
    await execute(args);
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it.each([400, 404])('keeps status lookup %s unknown after a job was created and never resubmits', async status => {
    submissionBody = { id: 'job-fixture', status: 'queued' }; pollStatus = status;
    const args = { model: LIVE, size: '854x480', duration: 5 };
    const record = await execute(args);
    expect(JSON.parse(record.result!)).toMatchObject({ status: 'unknown', taskId: 'job-fixture', recoveryTool: 'get_video_generation_status' }); expect(record.terminalVerification?.status).toBe('failed');
    expect((await inspectExternalCommitAttempt(record.idempotencyKey!)).entry?.state).toBe('unknown');
    await execute(args);
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it('keeps a transient status timeout followed by inaccessible lookup unknown without automatic resend', async () => {
    submissionBody = { id: 'job-fixture', status: 'queued' }; pollFails = true;
    const args = { model: LIVE, size: '854x480', duration: 5 };
    const record = await execute(args);
    expect(JSON.parse(record.result!)).toMatchObject({ status: 'unknown', taskId: 'job-fixture', recoveryTool: 'get_video_generation_status' });
    expect((await inspectExternalCommitAttempt(record.idempotencyKey!)).entry?.state).toBe('unknown');
    expect(requests.filter(request => request.url.includes('/videos/generations/job-fixture'))).toHaveLength(2);
    await execute(args);
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it('keeps legacy direct-provider saves independent from omitted official roles', async () => {
    catalogFails = true;
    const response = await nativeFetch(localUrl + '/api/preferences/generation', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ image: { provider: 'qwen', model: 'direct-image' }, video: { provider: 'minimax', model: 'direct-video' } }) });
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(0);
  });
  it('carries only a bounded per-request video model through the structured envelope', () => {
    const request = normalizeStructuredMediaRequest({ operation: 'text_to_video', prompt: 'Fixture', size: '854x480', duration: 5, model: LIVE, officialOnly: true, provider: 'untrusted' })!;
    expect(structuredMediaToolCall(request).arguments).toMatchObject({ model: LIVE, officialOnly: true, size: '854x480', duration: 5 });
    expect(structuredMediaToolCall(request).arguments).not.toHaveProperty('provider');
    expect(normalizeStructuredMediaRequest({ ...request, model: 'x'.repeat(201) })).toBeNull();
  });
});
