import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import { transcribe } from '../server/stt/providers/official';

const envKeys = ['RELAY_API_KEY', 'RELAY_BASE_URL', 'RELAY_STT_MODEL', 'RELAY_STT_STREAM_PATH'] as const;
let previousEnv: Partial<Record<(typeof envKeys)[number], string | undefined>>;
let gateway: WebSocketServer;

function captureUpload() {
  const frames: Buffer[] = [];
  const actions: string[] = [];
  let complete!: (value: { socket: WebSocket; taskId: string }) => void;
  const finished = new Promise<{ socket: WebSocket; taskId: string }>(resolve => { complete = resolve; });
  gateway.on('connection', socket => {
    socket.on('error', () => {}); // A rejected oversized frame closes only this test connection.
    let taskId = '';
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        frames.push(Buffer.from(raw as Buffer));
        actions.push('audio');
        return;
      }
      const message = JSON.parse(String(raw));
      actions.push(message.header.action);
      if (message.header.action === 'run-task') {
        taskId = message.header.task_id;
        socket.send(JSON.stringify({ header: { event: 'task-started', task_id: taskId }, payload: {} }));
      } else if (message.header.action === 'finish-task') {
        complete({ socket, taskId });
      }
    });
  });
  return { frames, actions, finished };
}

function sentence(socket: WebSocket, taskId: string, text: string, final = true, beginMs = 0, endMs = 1000) {
  socket.send(JSON.stringify({ header: { event: 'result-generated', task_id: taskId },
    payload: { output: { sentence: { text, sentence_end: final, begin_time: beginMs, end_time: endMs } } } }));
}

function completeTask(socket: WebSocket, taskId: string) {
  socket.send(JSON.stringify({ header: { event: 'task-finished', task_id: taskId }, payload: {} }));
}

async function receivedPreviousMessages(socket: WebSocket) {
  const pong = once(socket, 'pong');
  socket.ping();
  await pong;
  await nextTurn();
}

function wavFile(bytes: number) {
  const audio = Buffer.alloc(bytes);
  for (let index = 44; index < bytes; index += 1) audio[index] = (index * 31 + (index >>> 8)) & 255;
  audio.write('RIFF', 0, 'ascii');
  audio.writeUInt32LE(bytes - 8, 4);
  audio.write('WAVEfmt ', 8, 'ascii');
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36, 'ascii');
  audio.writeUInt32LE(bytes - 44, 40);
  return audio;
}

describe('official file ASR through the production binary WebSocket transport', () => {
  beforeEach(async () => {
    resetCircuit();
    previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    gateway = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 262144 });
    await once(gateway, 'listening');
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback gateway address');
    process.env.RELAY_API_KEY = 'synthetic-asr-test-key';
    process.env.RELAY_BASE_URL = 'http://127.0.0.1:' + address.port + '/v1';
    delete process.env.RELAY_STT_MODEL;
    delete process.env.RELAY_STT_STREAM_PATH;
  });

  afterEach(async () => {
    for (const client of gateway.clients) client.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    resetCircuit();
  });

  it('sends a 645418-byte WAV in ordered bounded binary frames in one task, then returns every sentence', async () => {
    const upload = captureUpload();
    const audio = wavFile(645418);
    const pending = transcribe(audio, 'zh', { fileName: 'synthetic-20s.wav' });
    void pending.catch(() => {});
    // If the real transport sends an oversized frame, reject promptly instead of waiting for finish-task.
    const uploaded = await Promise.race([upload.finished, pending.then(() => { throw new Error('Completed before input finish'); })]);
    sentence(uploaded.socket, uploaded.taskId, '第一句。', true, 0, 1000);
    sentence(uploaded.socket, uploaded.taskId, '第二句。', true, 1200, 2400);
    completeTask(uploaded.socket, uploaded.taskId);
    const result = await pending;
    expect(upload.frames.length).toBeGreaterThan(1);
    expect(upload.frames.every(frame => frame.length > 0 && frame.length <= 64 * 1024)).toBe(true);
    expect(Buffer.concat(upload.frames)).toEqual(audio);
    expect(upload.actions).toEqual(['run-task', ...upload.frames.map(() => 'audio'), 'finish-task']);
    expect(result).toMatchObject({ text: '第一句。\n第二句。', isFinal: true, speechFinal: true, taskId: uploaded.taskId,
      segments: [{ text: '第一句。', beginMs: 0, endMs: 1000 }, { text: '第二句。', beginMs: 1200, endMs: 2400 }] });
  });

  it('waits beyond the first sentence and preserves the trailing partial when the task finishes', async () => {
    const upload = captureUpload();
    let settled = false;
    const pending = transcribe(wavFile(2048), 'zh', { fileName: 'multi-sentence.wav' });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const { socket, taskId } = await upload.finished;
    sentence(socket, taskId, '已结束的一句。');
    await receivedPreviousMessages(socket);
    expect(settled).toBe(false);
    sentence(socket, taskId, '文件结尾的一句。', false);
    completeTask(socket, taskId);
    await expect(pending).resolves.toMatchObject({ text: '已结束的一句。\n文件结尾的一句。', isFinal: true });
  });

  it.each(['normal', 'abnormal'] as const)('rejects a %s close before task-finished even after a sentence result', async kind => {
    const upload = captureUpload();
    const outcome = transcribe(wavFile(2048), 'zh', { fileName: 'unfinished.wav' })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
    const { socket, taskId } = await upload.finished;
    sentence(socket, taskId, '这只是第一句。');
    await receivedPreviousMessages(socket);
    if (kind === 'normal') socket.close(1000, 'closed without task-finished');
    else socket.terminate();
    const result = await outcome;
    expect(result.value).toBeUndefined();
    expect(result.error?.message).toContain('closed before completion');
  });

  it('cancels after a sentence instead of returning a truncated success and closes the owned connection', async () => {
    const upload = captureUpload();
    const controller = new AbortController();
    const outcome = transcribe(wavFile(2048), 'zh', { fileName: 'cancel.wav', signal: controller.signal })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
    const { socket, taskId } = await upload.finished;
    sentence(socket, taskId, '取消前的第一句。');
    await receivedPreviousMessages(socket);
    const closed = once(socket, 'close');
    controller.abort(new DOMException('cancel file transcription', 'AbortError'));
    const result = await outcome;
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ name: 'AbortError', message: 'cancel file transcription' });
    await closed;
  });
});
