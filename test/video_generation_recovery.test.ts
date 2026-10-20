vi.mock('../server/llm/official_api', async original => ({ ...await original<typeof import('../server/llm/official_api')>(),
  listOfficialApiModels: vi.fn(async () => ({ models: [], byRole: { video_generation: ['aliyun/wan3.0-video', 'aliyun/Wan2.2-T2V-A14B'], image_to_video: ['aliyun/wan3.0-video', 'aliyun/Wan2.2-I2V-A14B'] } })) }));
import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { saveKeys } from '../server/config/keys';
import { getDataPath } from '../server/config/data_path';
import { getGeneratedOutputDir } from '../server/config/data_path';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { registerVideoTools } from '../server/tools/definitions/video_tools';
import { ToolRegistry, resetExternalCommitRuntimeCacheForTests } from '../server/tools/registry';
import { readVideoGenerationTask, videoGenerationRecoveryId } from '../server/tools/media_generation_journal';
import { createOrg, addMember, removeMember } from '../server/org/db';
import { buildMediaArtifactReceipt } from '../server/socket/media_artifact_receipt';
import { VALID_FRAGMENTED_MP4, VALID_MP4 } from './fixtures/synthetic_video';
const uid = 'video-recovery-fixture', key = 'synthetic-private-api-key';
const runIdentity = Math.random().toString(36).slice(2);
let app: Awaited<ReturnType<typeof makeApp>>, serial = 0;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const registry = () => { const r = new ToolRegistry(); registerVideoTools(r); return r; };
const owner = (orgId = '') => ({ userId: uid, authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local' as const,
  domain: orgId ? 'work' as const : 'personal' as const, orgId, orgRole: orgId ? 'owner' : undefined,
  idempotencyKey: 'video-test-' + runIdentity + '-' + ++serial, taskId: 'video-fixture-task-' + serial,
  currentTurnExecutionRequested: true, actionIntent: 'Recover the original video artifact.', requestConfirmation: async () => true });
const args = () => ({ prompt: 'Fictional video test ' + ++serial, model: 'aliyun/wan3.0-video', size: '1280x720', duration: 2 });
const inline = () => ({ status: 'completed', video_base64: 'data:video/mp4;base64,' + VALID_MP4.toString('base64') });
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
beforeEach(() => { resetExternalCommitRuntimeCacheForTests(); saveKeys({ RELAY_API_KEY: key, RELAY_BASE_URL: 'https://official.example.test/v1' });
  upsertUserPreferredGenerationModels(uid, { video: { provider: 'relay', model: 'aliyun/wan3.0-video' }, imageToVideo: { provider: 'relay', model: 'aliyun/wan3.0-video' } }); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function accepted(orgId = '') {
  const ctx = owner(orgId), input = args();
  const fetcher = vi.fn().mockResolvedValueOnce(json({ id: 'original-task-' + serial, status: 'queued' })).mockRejectedValueOnce(new Error('Synthetic status transport failure'));
  vi.stubGlobal('fetch', fetcher);
  const first = JSON.parse(await registry().execute('generate_video', input, ctx));
  expect(first).toMatchObject({ status: 'unknown', verified: false, recoveryTool: 'get_video_generation_status', automaticResubmissionBlocked: true });
  return { first, ctx, input, fetcher };
}
describe('official video uses the existing durable media journal', () => {
  it('writes the task identity before polling and recovers across new registries without another POST', async () => {
    const { first, ctx, input, fetcher } = await accepted();
    expect(readVideoGenerationTask(first.recoveryId, ctx)).toMatchObject({ state: 'accepted', providerTaskId: first.taskId });
    resetExternalCommitRuntimeCacheForTests();
    fetcher.mockResolvedValueOnce(json(inline()));
    const recovered = JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx));
    expect(recovered).toMatchObject({ verified: true, taskId: first.taskId, recoveryId: first.recoveryId, reconciliationStatus: 'committed' });
    expect(fs.readFileSync(recovered.outputPath)).toEqual(VALID_MP4);
    const repeated = JSON.parse(await registry().execute('generate_video', input, ctx));
    expect(repeated.outputPath).toBe(recovered.outputPath);
    expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
    const persisted = fs.readFileSync(path.join(getDataPath('media-generation-tasks'), first.recoveryId + '.json'), 'utf8');
    expect(persisted).not.toContain(key);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(getDataPath('media-generation-tasks'), first.recoveryId + '.json')).mode & 0o077).toBe(0);
  });
  it('binds a real local PNG to the original I2V request while recovering after source normalization and restart', async () => {
    const ctx = owner(), input = { ...args(), first_frame_image: getDataPath('i2v-source-' + serial + '.png') };
    const source = await sharp(Buffer.from('<svg width="4" height="4"><rect width="4" height="4" fill="#dd5522"/></svg>')).png().toBuffer();
    fs.writeFileSync(input.first_frame_image, source);
    const fetcher = vi.fn().mockResolvedValueOnce(json({ id: 'original-i2v-' + serial, status: 'queued' }))
      .mockRejectedValueOnce(new Error('Synthetic I2V status transport failure'));
    vi.stubGlobal('fetch', fetcher);
    const first = JSON.parse(await registry().execute('generate_video', input, ctx));
    expect(first).toMatchObject({ status: 'unknown', verified: false, recoveryId: videoGenerationRecoveryId(input, ctx) });
    const post = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(post.image).toMatch(/^data:image\/png;base64,/);
    expect(await sharp(Buffer.from(post.image.split(',')[1], 'base64')).metadata()).toMatchObject({ width: 1280, height: 720 });
    expect(fs.readFileSync(input.first_frame_image)).toEqual(source);
    expect(readVideoGenerationTask(first.recoveryId, ctx)?.settings).toMatchObject({ generationMode: 'image_to_video', inputReferenceAccepted: true });
    resetExternalCommitRuntimeCacheForTests();
    fetcher.mockResolvedValueOnce(json(inline()));
    const recovered = JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx));
    expect(recovered).toMatchObject({ verified: true, taskId: first.taskId, generationMode: 'image_to_video', inputReferenceAccepted: true,
      requestedSettings: { size: '1280x720', duration: 2 }, actualSettings: { size: '16x16', duration: 2 }, settingsMatch: false });
    expect(fs.readFileSync(recovered.outputPath)).toEqual(VALID_MP4);
    fs.unlinkSync(input.first_frame_image);
    expect(JSON.parse(await registry().execute('generate_video', input, ctx)).outputPath).toBe(recovered.outputPath);
    expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
    const persisted = fs.readFileSync(path.join(getDataPath('media-generation-tasks'), first.recoveryId + '.json'), 'utf8');
    expect(persisted).not.toContain(post.image);
    expect(persisted).not.toContain(key);
  });
  it('keeps no-ID submission unknown and refuses both status and generate resubmission', async () => {
    const ctx = owner(), input = args(), fetcher = vi.fn().mockRejectedValueOnce(new Error('Synthetic POST transport failure'));
    vi.stubGlobal('fetch', fetcher);
    const first = JSON.parse(await registry().execute('generate_video', input, ctx));
    expect(first).toMatchObject({ taskId: '', status: 'unknown', verified: false });
    expect(JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx)).status).toBe('unknown');
    await expect(registry().execute('generate_video', input, ctx)).rejects.toThrow(/unknown|resend/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('recovers download failure and a later missing completed file from the original task only', async () => {
    const { first, ctx, fetcher } = await accepted();
    const complete = { status: 'completed', video_url: 'https://8.8.8.8/original-video.mp4' };
    fetcher.mockResolvedValueOnce(json(complete)).mockRejectedValueOnce(new Error('Synthetic download failure'));
    const still = JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx));
    expect(still).toMatchObject({ status: 'unknown', taskId: first.taskId });
    fetcher.mockResolvedValueOnce(json(complete)).mockResolvedValueOnce(new Response(new Uint8Array(VALID_MP4), { headers: { 'content-type': 'video/mp4' } }));
    const ready = JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx));
    const cached = JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx));
    expect(cached.outputPath).toBe(ready.outputPath);
    fs.unlinkSync(ready.outputPath);
    fetcher.mockResolvedValueOnce(json(complete)).mockResolvedValueOnce(new Response(new Uint8Array(VALID_MP4), { headers: { 'content-type': 'video/mp4' } }));
    const restored = JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx));
    expect(restored).toMatchObject({ verified: true, taskId: first.taskId });
    expect(restored.outputPath).not.toBe(ready.outputPath);
    expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('retrieves the original after a completed artifact changes without overwriting the changed local file', async () => {
    const { first, ctx, fetcher } = await accepted(); fetcher.mockResolvedValueOnce(json(inline()));
    const ready = JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx));
    fs.writeFileSync(ready.outputPath, VALID_FRAGMENTED_MP4);
    fetcher.mockResolvedValueOnce(json(inline()));
    const restored = JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx));
    expect(restored).toMatchObject({ verified: true, taskId: first.taskId });
    expect(restored.outputPath).not.toBe(ready.outputPath);
    expect(fs.readFileSync(restored.outputPath)).toEqual(VALID_MP4);
    expect(fs.readFileSync(ready.outputPath)).toEqual(VALID_FRAGMENTED_MP4);
    expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('does not query a different official gateway origin or changed task path', async () => {
    const { first, ctx, fetcher } = await accepted(), query = { recoveryId: first.recoveryId };
    const count = fetcher.mock.calls.length;
    saveKeys({ RELAY_API_KEY: key, RELAY_BASE_URL: 'https://another-official.example.test/v1' });
    expect(JSON.parse(await registry().execute('get_video_generation_status', query, ctx))).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/original official gateway/) });
    expect(fetcher).toHaveBeenCalledTimes(count);
    saveKeys({ RELAY_API_KEY: key, RELAY_BASE_URL: 'https://official.example.test/v1' });
    vi.stubEnv('RELAY_VIDEO_STATUS_PATH', '/different-task/{id}');
    expect(JSON.parse(await registry().execute('get_video_generation_status', query, ctx)).status).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it('coalesces concurrent status queries and treats a still-running provider task as pending', async () => {
    const { first, ctx, fetcher } = await accepted();
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const r = registry();
    const one = r.execute('get_video_generation_status', { recoveryId: first.recoveryId }, { ...ctx, idempotencyKey: 'query-one' });
    const two = r.execute('get_video_generation_status', { recoveryId: first.recoveryId }, { ...ctx, idempotencyKey: 'query-two' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release(json({ status: 'processing' }));
    expect((await Promise.all([one, two])).map(result => JSON.parse(result).status)).toEqual(['pending', 'pending']);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('keeps the existing local-write confirmation boundary before recovering a video artifact', async () => {
    const { first, ctx, fetcher } = await accepted();
    const confirmation = vi.fn(async () => false), before = fetcher.mock.calls.length;
    const result = await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, { ...ctx, requestConfirmation: confirmation });
    expect(result).toMatch(/requires user confirmation and was not approved/);
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(before);
    expect(readVideoGenerationTask(first.recoveryId, ctx)?.state).toBe('accepted');
  });
  it('refuses cross-user, cross-domain, cross-organization and revoked membership before querying', async () => {
    const org = createOrg('Virtual recovery organization', 'video-recovery-org-' + serial, uid); addMember(org.id, uid, 'owner');
    const { first, ctx, fetcher } = await accepted(org.id), query = { recoveryId: first.recoveryId };
    for (const wrong of [{ ...ctx, userId: 'another-owner' }, { ...ctx, domain: 'personal' as const }, { ...ctx, orgId: 'another-organization' }]) {
      await expect(registry().execute('get_video_generation_status', query, wrong)).rejects.toThrow(/owner scope|permission|member|organization/i);
    }
    removeMember(org.id, uid);
    await expect(registry().execute('get_video_generation_status', query, ctx)).rejects.toThrow(/owner scope|permission|member|organization/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('checks membership again after a remote download, before writing a recovered artifact', async () => {
    const org = createOrg('Virtual revoke-during-download', 'video-revoke-download-' + serial, uid); addMember(org.id, uid, 'owner');
    const { first, ctx, fetcher } = await accepted(org.id);
    let release!: (response: Response) => void;
    fetcher.mockResolvedValueOnce(json({ status: 'completed', video_url: 'https://8.8.8.8/original.mp4' }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const before = fs.existsSync(getGeneratedOutputDir()) ? fs.readdirSync(getGeneratedOutputDir()).sort() : [];
    const query = registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx);
    const settled = query.catch(error => error);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    removeMember(org.id, uid);
    release(new Response(new Uint8Array(VALID_MP4), { headers: { 'content-type': 'video/mp4' } }));
    expect(String(await settled)).toMatch(/owner scope|member|organization/i);
    expect(fs.readdirSync(getGeneratedOutputDir()).sort()).toEqual(before);
  });

  it.each(['failed', 'cancelled'])('records provider %s as terminal without allowing a new paid submission', async status => {
    const { first, ctx, input, fetcher } = await accepted();
    fetcher.mockResolvedValueOnce(json({ status }));
    expect(JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx)).status).toBe(status);
    expect(readVideoGenerationTask(first.recoveryId, ctx)?.state).toBe(status);
    await expect(registry().execute('generate_video', input, ctx)).rejects.toThrow(/unknown|resend/i);
    expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('records an actual rejected POST and never invents an accepted task identity', async () => {
    const ctx = owner(), input = args(), fetcher = vi.fn().mockResolvedValueOnce(json({ error: { message: 'Synthetic input rejected' } }, 400));
    vi.stubGlobal('fetch', fetcher);
    await expect(registry().execute('generate_video', input, ctx)).rejects.toThrow(/rejected/i);
    const recoveryId = videoGenerationRecoveryId(input, ctx);
    expect(readVideoGenerationTask(recoveryId, ctx)).toMatchObject({ state: 'rejected', providerTaskId: '' });
    expect(JSON.parse(await registry().execute('get_video_generation_status', { recoveryId }, ctx)).status).toBe('rejected');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not certify rejection when an HTTP error contains an inline artifact without a task identity', async () => {
    const ctx = owner(), input = args(), fetcher = vi.fn().mockResolvedValueOnce(json(inline(), 400));
    vi.stubGlobal('fetch', fetcher);
    const first = JSON.parse(await registry().execute('generate_video', input, ctx));
    expect(first).toMatchObject({ status: 'unknown', taskId: '', verified: false, automaticResubmissionBlocked: true });
    expect(readVideoGenerationTask(first.recoveryId, ctx)?.state).toBe('unknown');
    await expect(registry().execute('generate_video', input, ctx)).rejects.toThrow(/unknown|resend/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not merge a composition segment into proof of the entire requested video', async () => {
    vi.stubEnv('RELAY_IMAGE_TO_VIDEO_MODEL', 'aliyun/Wan2.2-I2V-A14B');
    upsertUserPreferredGenerationModels(uid, { video: { provider: 'relay', model: 'aliyun/Wan2.2-T2V-A14B' }, imageToVideo: { provider: 'relay', model: 'aliyun/Wan2.2-I2V-A14B' } });
    const ctx = owner(), fetcher = vi.fn().mockResolvedValueOnce(json({ id: 'first-segment', status: 'queued' })).mockRejectedValueOnce(new Error('Synthetic segment polling failure'));
    vi.stubGlobal('fetch', fetcher);
    const receipt = JSON.parse(await registry().execute('generate_video', { prompt: 'Fictional composition', duration: 10, model: 'aliyun/Wan2.2-T2V-A14B' }, ctx));
    expect(receipt, JSON.stringify({ receipt, calls: fetcher.mock.calls.map(call => ({ url: call[0], method: call[1]?.method })) })).toMatchObject({ verified: false, compositionSegment: true, wholeTaskCompleted: false, taskId: 'first-segment' });
    fetcher.mockResolvedValueOnce(json(inline()));
    const segment = JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: receipt.recoveryId }, ctx));
    expect(segment).toMatchObject({ verified: true, compositionSegment: true, wholeTaskCompleted: false });
    expect(segment.reconciliationStatus).toBeUndefined();
    expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('does not turn arbitrary query taskId or URL into an unowned provider request', async () => {
    const { first, ctx, fetcher } = await accepted();
    fetcher.mockResolvedValueOnce(json({ status: 'processing' }));
    await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId, taskId: 'forged-task', url: 'https://127.0.0.1/private' }, ctx);
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain(first.taskId);
    expect(fetcher.mock.calls.at(-1)?.[0]).not.toContain('forged-task');
  });
  it('keeps recovered measured settings and reference identity in the existing socket receipt', async () => {
    const { first, ctx, fetcher } = await accepted(); fetcher.mockResolvedValueOnce(json(inline()));
    const recovered = JSON.parse(await registry().execute('get_video_generation_status', { recoveryId: first.recoveryId }, ctx));
    const receipt = buildMediaArtifactReceipt('get_video_generation_status', { recoveryId: first.recoveryId, size: 'forged-size', duration: 999, first_frame_image: 'forged-reference' }, recovered);
    expect(receipt?.toolName).toBe('generate_video');
    expect(receipt?.settings.hasReference).toBe(false);
    expect(receipt?.settings.size).not.toBe('forged-size');
    expect(receipt?.settings.duration).not.toBe(999);
  });
});
