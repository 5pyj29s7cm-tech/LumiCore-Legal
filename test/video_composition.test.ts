import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const media = vi.hoisted(() => ({ run: vi.fn(), measurements: new Map<string, any>(), png: Buffer.alloc(0), unavailable: false, failComposition: false, durationOffset: 0, hasAudio: false, dropComposedAudio: false, clipDuration: 5, width: 832, height: 480, nativeI2V: true }));
vi.mock('../server/media/process', () => ({ runMediaProcess: media.run }));
vi.mock('../server/llm/official_api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../server/llm/official_api')>(),
  listOfficialApiModels: vi.fn(async () => ({ models: [], byRole: { video_generation: ['aliyun/Wan2.2-T2V-A14B', 'aliyun/wan3.0-video', 'aliyun/wan3.0-video-prime'], image_to_video: ['aliyun/Wan2.2-I2V-A14B', ...(media.nativeI2V ? ['aliyun/wan3.0-video', 'aliyun/wan3.0-video-prime'] : [])] } })),
}));
import { initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { getGeneratedOutputDir } from '../server/config/data_path';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { registerVideoTools } from '../server/tools/definitions/video_tools';
import { ToolRegistry, getToolExecutionTimeoutMs } from '../server/tools/registry';
import { readVideoGenerationTask, videoGenerationRecoveryId } from '../server/tools/media_generation_journal';
import { VALID_MP4 } from './fixtures/synthetic_video';
const realRename = fs.renameSync.bind(fs);
const originals = Object.fromEntries(['RELAY_VIDEO_MODEL', 'RELAY_IMAGE_TO_VIDEO_MODEL', 'RELAY_VIDEO_REQUEST_FORMAT'].map(key => [key, process.env[key]]));
let user: string; let source: string; let before: Set<string>; let posts: any[]; let failPost = 0;
const directory = getGeneratedOutputDir();
beforeAll(async () => {
  await initDatabase();
  media.png = await sharp(Buffer.from('<svg width="4" height="4"><rect width="4" height="4" fill="#dd5522"/></svg>')).png().toBuffer();
});
beforeEach(() => {
  user = 'video-sequence-' + crypto.randomUUID(); source = path.join(process.env.LUMI_DATA_DIR!, user + '.png');
  fs.writeFileSync(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  before = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []); posts = []; failPost = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((sourcePath, targetPath) => { realRename(sourcePath, targetPath); const measured = media.measurements.get(String(sourcePath)); if (measured) { media.measurements.set(String(targetPath), measured); media.measurements.delete(String(sourcePath)); } });
  media.unavailable = media.failComposition = media.hasAudio = media.dropComposedAudio = false; media.durationOffset = 0; media.clipDuration = 5; media.width = 832; media.height = 480; media.nativeI2V = true; media.measurements.clear(); media.run.mockReset();
  media.run.mockImplementation(async (binary: string, args: string[]) => {
    if (args.includes('-version')) { if (media.unavailable) throw new Error('ffmpeg unavailable'); return 'media tool ready'; }
    const output = args.at(-1)!;
    if (binary === 'ffprobe') { const m = media.measurements.get(output) || { width: media.width, height: media.height, duration: media.clipDuration }; return JSON.stringify({ streams: [{ codec_type: 'video', ...m }, ...(media.hasAudio && !(media.dropComposedAudio && output.endsWith('composed.partial.mp4')) ? [{ codec_type: 'audio' }] : [])] }); }
    if (args.includes('-frames:v')) { fs.writeFileSync(output, media.png); return ''; }
    const concat = args.includes('concat');
    if (concat && media.failComposition) { fs.writeFileSync(output, 'partial'); throw new Error('injected composition failure'); }
    fs.writeFileSync(output, VALID_MP4);
    const size = (args[args.indexOf('-vf') + 1] || '').match(/scale=(\d+):(\d+)/);
    media.measurements.set(output, { width: Number(size?.[1] || media.width), height: Number(size?.[2] || media.height), duration: concat ? Number(args[args.indexOf('-t') + 1]) + media.durationOffset : media.clipDuration });
    return '';
  });
  process.env.RELAY_VIDEO_MODEL = 'aliyun/Wan2.2-T2V-A14B'; process.env.RELAY_IMAGE_TO_VIDEO_MODEL = 'aliyun/Wan2.2-I2V-A14B'; process.env.RELAY_VIDEO_REQUEST_FORMAT = 'json';
  saveKeys({ RELAY_API_KEY: 'video-test-key', RELAY_BASE_URL: 'https://official.example.test/v1' });
  upsertUserPreferredGenerationModels(user, { video: { provider: 'relay', model: 'aliyun/Wan2.2-T2V-A14B' }, imageToVideo: { provider: 'relay', model: 'aliyun/Wan2.2-I2V-A14B' } });
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); if (posts.length === failPost) throw new Error('injected provider failure'); return new Response(JSON.stringify({ id: 'clip-' + posts.length, status: 'queued' })); }
    return new Response(JSON.stringify({ status: 'completed', video_base64: VALID_MP4.toString('base64') }));
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } saveKeys({ RELAY_API_KEY: '', RELAY_BASE_URL: '' }); });
async function generate(duration = 30, image = true, context: any = {}, overrides: Record<string, any> = {}) {
  const registry = new ToolRegistry(); registerVideoTools(registry);
  return JSON.parse(await registry.execute('generate_video', { prompt: 'Show the product with slow camera motion', size: '832x480', duration, ...(image ? { first_frame_image: source } : {}), ...overrides }, { userId: user, ...context }));
}
function manifest() {
  const folder = fs.readdirSync(directory).find(name => !before.has(name) && name.startsWith('.video-assembly-'));
  const location = path.join(directory, folder!);
  return { location, value: JSON.parse(fs.readFileSync(path.join(location, 'progress.json'), 'utf8')) };
}
describe('automatic long video generation', () => {
  it('generates six real provider tasks with end-frame continuation and returns one measured 30-second artifact', async () => {
    const result = await generate();
    expect(posts).toHaveLength(6); expect(posts.every(post => post.duration === 5)).toBe(true);
    expect(posts[0].image).toBe('data:image/png;base64,' + fs.readFileSync(source).toString('base64'));
    expect(posts.slice(1).every(post => post.image === 'data:image/png;base64,' + media.png.toString('base64'))).toBe(true);
    expect(posts[5].prompt).toContain('segment 6 of 6');
    expect(result).toMatchObject({ ok: true, requestedSettings: { duration: 30, size: '832x480' }, actualSettings: { duration: 30, size: '832x480' }, settingsMatch: true, generationMode: 'image_to_video', composition: { clipCount: 6, sourceTaskIds: ['clip-1','clip-2','clip-3','clip-4','clip-5','clip-6'] } });
    expect(result.artifacts).toEqual([{ type: 'video', path: result.outputPath }]);
    expect(manifest().value).toMatchObject({ state: 'completed', userId: user, outputPath: result.outputPath });
    expect(fs.readdirSync(manifest().location)).toEqual(['progress.json']);
  });
  it('starts text-to-video with T2V then uses I2V for continuous subsequent segments', async () => {
    const result = await generate(10, false);
    expect(posts[0]).toMatchObject({ model: 'aliyun/Wan2.2-T2V-A14B' }); expect(posts[0]).not.toHaveProperty('image');
    expect(posts[1]).toMatchObject({ model: 'aliyun/Wan2.2-I2V-A14B', image: 'data:image/png;base64,' + media.png.toString('base64') });
    expect(result).toMatchObject({ generationMode: 'text_to_video', inputReferenceAccepted: false, actualSettings: { duration: 10 } });
  });
  it('trims the final composition to an exact requested duration that is not a multiple of five', async () => {
    expect(await generate(13)).toMatchObject({ actualSettings: { duration: 13 }, settingsMatch: true, composition: { clipCount: 3 } });
    expect(posts).toHaveLength(3);
  });
  it('fails before paying for any clip if the local media tools are unavailable', async () => {
    media.unavailable = true; await expect(generate()).rejects.toThrow(/unavailable/); expect(posts).toHaveLength(0);
    expect(fs.readdirSync(directory).filter(name => !before.has(name))).toHaveLength(0);
  });
  it('preserves completed clips and stops without retrying or submitting later clips on provider failure', async () => {
    failPost = 2;
    expect(await generate()).toMatchObject({ status: 'unknown', verified: false, compositionSegment: true, wholeTaskCompleted: false });
    expect(posts).toHaveLength(2);
    expect(manifest().value).toMatchObject({ state: 'failed', currentClip: 2, clips: [{ taskId: 'clip-1' }] });
    expect(fs.existsSync(manifest().value.clips[0].path)).toBe(true); expect(fs.readdirSync(manifest().location)).toEqual(['progress.json']);
  });
  it('cancels between clips without submitting the next paid request', async () => {
    const controller = new AbortController();
    await expect(generate(30, true, { executionSignal: controller.signal, onProgress: (message: string) => { if (message === '长视频第 1/6 段已保存。') controller.abort(); } })).rejects.toThrow();
    expect(posts).toHaveLength(1); expect(manifest().value).toMatchObject({ state: 'cancelled', clips: [{ taskId: 'clip-1' }] });
  });
  it('retains all paid clips and removes temporary files if local composition fails', async () => {
    media.failComposition = true; await expect(generate()).rejects.toThrow(/composition failure/); expect(posts).toHaveLength(6);
    expect(manifest().value).toMatchObject({ state: 'failed', clips: expect.any(Array) }); expect(manifest().value.clips).toHaveLength(6);
    expect(fs.readdirSync(manifest().location)).toEqual(['progress.json']);
  });
  it('rejects an incorrectly measured final duration instead of manufacturing a 30-second success', async () => {
    media.durationOffset = -1; await expect(generate()).rejects.toThrow(/do not match/); expect(manifest().value.state).toBe('failed');
    expect(fs.readdirSync(manifest().location)).toEqual(['progress.json']);
  });
  it('allows a bounded generation deadline for longer sequences', () => {
    expect(getToolExecutionTimeoutMs('generate_video')).toBe(15 * 60_000);
    expect(getToolExecutionTimeoutMs('generate_video', { duration: 30 })).toBe(17 * 60_000);
    expect(getToolExecutionTimeoutMs('generate_video', { duration: 120 })).toBe(53 * 60_000);
  });
});

it('rejects a composition that lost source audio and preserves paid source clips without retry', async () => {
  media.hasAudio = media.dropComposedAudio = true;
  await expect(generate()).rejects.toThrow(/audio does not match/);
  expect(posts).toHaveLength(6); expect(manifest().value.state).toBe('failed');
  expect(manifest().value.clips.every((clip: { path: string }) => fs.existsSync(clip.path))).toBe(true);
  expect(fs.readdirSync(manifest().location)).toEqual(['progress.json']);
});

const WAN3 = 'aliyun/wan3.0-video';
function configureNativeSequence(model = WAN3) {
  process.env.RELAY_VIDEO_MODEL = model; process.env.RELAY_IMAGE_TO_VIDEO_MODEL = 'aliyun/Wan2.2-I2V-A14B';
  upsertUserPreferredGenerationModels(user, { video: { provider: 'relay', model }, imageToVideo: { provider: 'relay', model: 'aliyun/Wan2.2-I2V-A14B' } });
  media.clipDuration = 30; media.width = 480; media.height = 832;
}
function nativePlan() {
  return { prompt: 'Two fictional characters sing a continuous dialogue in the same room.', size: '480x832',
    segment_prompts: Array.from({ length: 4 }, (_, segment) => Array.from({ length: 8 }, (_, line) => 'Exact lyric ' + (segment * 8 + line + 1) + '.').join('\n')) };
}
describe('explicit native video segments use the existing sequence and journal', () => {
  it.each([WAN3, 'aliyun/wan3.0-video-prime'])('submits exactly four native30s clips and only each ordered lyric group: %s', async model => {
    configureNativeSequence(model); media.hasAudio = true;
    const input = nativePlan(), context = { idempotencyKey: 'native-sequence-' + user, taskId: 'native-task-' + user };
    const result = await generate(120, false, context, { ...input, prompt_extend: true });
    expect(posts).toHaveLength(4);
    for (let index = 0; index < 4; index++) {
      expect(posts[index]).toMatchObject({ model, duration: 30, size: '480x832', extra_body: { parameters: { duration: 30, prompt_extend: false } } });
      expect(posts[index].prompt).toContain(input.prompt);
      for (let group = 0; group < 4; group++) expect(posts[index].prompt.includes(input.segment_prompts[group])).toBe(group === index);
      expect(posts[index].prompt).not.toContain('aliyun/Wan2.2');
      const journalArgs = { prompt: input.prompt, size: input.size, duration: 120, segment_prompts: input.segment_prompts, prompt_extend: true, __videoSegment: index };
      const child = readVideoGenerationTask(videoGenerationRecoveryId(journalArgs, { userId: user, ...context, idempotencyKey: context.idempotencyKey + ':segment:' + index }), { userId: user, ...context });
      expect(child).toMatchObject({ state: 'completed', providerTaskId: 'clip-' + (index + 1), model, compositionSegment: true });
    }
    expect(posts[0]).not.toHaveProperty('image');
    expect(posts.slice(1).every(post => post.image === 'data:image/png;base64,' + media.png.toString('base64'))).toBe(true);
    expect(result).toMatchObject({ verified: true, actualSettings: { duration: 120, size: '480x832', hasAudio: true }, composition: { clipDuration: 30, clipCount: 4, sourceTaskIds: ['clip-1', 'clip-2', 'clip-3', 'clip-4'], models: [model] } });
    expect(manifest().value).toMatchObject({ state: 'completed', count: 4, clipDuration: 30 });
  });

  it.each([2, 24])('accepts the bounded %i-segment edge only at an admitted native duration', async count => {
    configureNativeSequence(); media.clipDuration = 2;
    const result = await generate(count * 2, false, {}, { ...nativePlan(), segment_prompts: Array.from({ length: count }, (_, index) => 'Ordered part ' + index) });
    expect(posts).toHaveLength(count); expect(posts.every(post => post.duration === 2 && post.model === WAN3)).toBe(true);
    expect(result).toMatchObject({ verified: true, actualSettings: { duration: count * 2 }, composition: { clipDuration: 2, clipCount: count } });
  });
  it('keeps an explicit reference on the same native model from the first segment onward', async () => {
    configureNativeSequence(); process.env.RELAY_IMAGE_TO_VIDEO_MODEL = WAN3;
    const result = await generate(120, true, {}, nativePlan());
    expect(posts).toHaveLength(4); expect(posts.every(post => post.model === WAN3 && typeof post.image === 'string')).toBe(true);
    expect(posts[0].image).toMatch(/^data:image\/png;base64,/);
    expect(result).toMatchObject({ verified: true, generationMode: 'image_to_video', composition: { models: [WAN3] } });
  });
  it('fails local composition-tool preflight before any native paid segment', async () => {
    configureNativeSequence(); media.unavailable = true;
    await expect(generate(120, false, {}, nativePlan())).rejects.toThrow(/unavailable/); expect(posts).toHaveLength(0);
  });
  it('does not reinterpret the existing fixed-duration model as an explicit native plan', async () => {
    await expect(generate(120, false, {}, nativePlan())).rejects.toThrow(/native variable-duration/);
    expect(posts).toHaveLength(0); expect(media.run).not.toHaveBeenCalled();
  });
  it('requires the same selected model in the current I2V catalog before the first paid segment', async () => {
    configureNativeSequence(); media.nativeI2V = false;
    await expect(generate(120, false, {}, nativePlan())).rejects.toThrow(/未提交|不可用|available/);
    expect(posts).toHaveLength(0); expect(media.run).not.toHaveBeenCalled();
  });
  it('does not implicitly create a long native sequence without the explicit array', async () => {
    configureNativeSequence(); await expect(generate(120, false, {}, { size: '480x832' })).rejects.toThrow(/2 to 30/);
    expect(posts).toHaveLength(0); expect(media.run).not.toHaveBeenCalled();
  });
  it.each([
    ['null', null, 30], ['object', {}, 30], ['empty', [], 30], ['one', ['one'], 30],
    ['too many', Array(25).fill('segment'), 30], ['empty text', ['first', '  '], 30],
    ['not text', ['first', 2], 30], ['too long', ['first', 'x'.repeat(4001)], 30],
    ['non-divisible', ['first', 'second', 'third', 'fourth'], 119], ['too short', ['first', 'second'], 2],
    ['too long native clip', ['first', 'second'], 120], ['over total', Array(5).fill('segment'), 150],
    ['fractional total', ['first', 'second'], 5.5], ['nonfinite', ['first', 'second'], Infinity],
  ])('rejects %s segment plans before any network or local process', async (_label, segment_prompts, duration) => {
    configureNativeSequence(); await expect(generate(duration as number, false, {}, { ...nativePlan(), segment_prompts })).rejects.toThrow(/segment|duration/i);
    expect(posts).toHaveLength(0); expect(media.run).not.toHaveBeenCalled();
  });
  it('rejects explicit plans for providers without admitted native options', async () => {
    upsertUserPreferredGenerationModels(user, { video: { provider: 'qwen' } });
    await expect(generate(120, false, {}, nativePlan())).rejects.toThrow(/official|native|segment/i);
    expect(posts).toHaveLength(0); expect(media.run).not.toHaveBeenCalled();
  });
  it('checks the requested size before paying for an explicit plan', async () => {
    configureNativeSequence(); await expect(generate(120, false, {}, { ...nativePlan(), size: '3840x2160' })).rejects.toThrow(/supported size/);
    expect(posts).toHaveLength(0); expect(media.run).not.toHaveBeenCalled();
  });
  it('retains the first paid clip and the second unknown recovery without submitting any later clip', async () => {
    configureNativeSequence(); failPost = 2;
    const input = nativePlan(), context = { idempotencyKey: 'unknown-native-' + user };
    const result = await generate(120, false, context, input);
    expect(result).toMatchObject({ status: 'unknown', verified: false, compositionSegment: true, wholeTaskCompleted: false, automaticResubmissionBlocked: true });
    expect(posts).toHaveLength(2); expect(result.recoveryId).toEqual(expect.any(String));
    expect(readVideoGenerationTask(result.recoveryId, { userId: user })).toMatchObject({ state: 'unknown', compositionSegment: true });
    expect(manifest().value).toMatchObject({ state: 'failed', currentClip: 2, clips: [{ taskId: 'clip-1' }] });
    expect(fs.existsSync(manifest().value.clips[0].path)).toBe(true);
    await expect(generate(120, false, context, input)).rejects.toThrow(/unknown|resend/i);
    expect(posts).toHaveLength(2);
  });
  it('stops between explicit clips on parent cancellation and keeps the completed clip', async () => {
    configureNativeSequence(); const controller = new AbortController();
    await expect(generate(120, false, { executionSignal: controller.signal, onProgress: (message: string) => { if (message === '长视频第 1/4 段已保存。') controller.abort(); } }, nativePlan())).rejects.toThrow();
    expect(posts).toHaveLength(1); expect(manifest().value).toMatchObject({ state: 'cancelled', clips: [{ taskId: 'clip-1' }] });
  });
});

describe('accepted original-task read recovery', () => {
  it('continues the existing status loop after a transient GET and submits exactly one paid task', async () => {
    const api = await import('../server/llm/official_api'), original = api.officialApiRequest; let gets = 0;
    vi.spyOn(api, 'officialApiRequest').mockImplementation(async (url: any, options: any = {}) => {
      if (options.method !== 'POST' && ++gets === 1) throw Object.assign(new Error('HTTP 503 unavailable'), { status: 503 });
      return original(url, options);
    });
    const result = await generate(5, false);
    expect(result).toMatchObject({ ok: true, verified: true, status: 'generated' });
    expect(posts).toHaveLength(1); expect(gets).toBe(2);
  });
  it('does not turn authentication failure into repeated status polling or generation', async () => {
    const api = await import('../server/llm/official_api'), original = api.officialApiRequest; let gets = 0;
    vi.spyOn(api, 'officialApiRequest').mockImplementation(async (url: any, options: any = {}) => {
      if (options.method !== 'POST') { gets++; throw Object.assign(new Error('HTTP 401 unauthorized'), { status: 401 }); }
      return original(url, options);
    });
    const result = await generate(5, false);
    expect(result).toMatchObject({ status: 'unknown', automaticResubmissionBlocked: true });
    expect(result.queryRetryable).not.toBe(true); expect(posts).toHaveLength(1); expect(gets).toBe(1);
  });
  it('bounds continued original-task queries by the existing parent cancellation signal', async () => {
    const api = await import('../server/llm/official_api'), original = api.officialApiRequest; let gets = 0; const controller = new AbortController();
    vi.spyOn(api, 'officialApiRequest').mockImplementation(async (url: any, options: any = {}) => {
      if (options.method !== 'POST') { if (++gets === 2) controller.abort(); throw Object.assign(new Error('HTTP 503 unavailable'), { status: 503 }); }
      return original(url, options);
    });
    await expect(generate(5, false, { executionSignal: controller.signal })).rejects.toThrow();
    expect(posts).toHaveLength(1); expect(gets).toBe(2);
  });
});

it('stops on an invalid returned artifact instead of labeling it a retryable status query', async () => {
  let gets = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: 'invalid-artifact-task', status: 'queued' })); }
    gets++; return new Response(JSON.stringify({ status: 'completed', video_base64: Buffer.alloc(512, 1).toString('base64') }));
  }));
  const result = await generate(5, false);
  expect(result).toMatchObject({ status: 'unknown', verified: false, automaticResubmissionBlocked: true });
  expect(result.queryRetryable).not.toBe(true); expect(posts).toHaveLength(1); expect(gets).toBe(1);
});
