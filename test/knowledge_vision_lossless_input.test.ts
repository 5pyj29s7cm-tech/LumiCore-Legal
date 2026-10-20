import './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { extractImageKnowledge, knowledgeExtractionDeps } from '../server/files/knowledge/extraction';
import { ocrImageFile } from '../server/tools/definitions/ocr_tools';
import { upsertUserPreferredVision } from '../server/llm/vision_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';

const userId = 'knowledge-vision-lossless-owner';
const returnedText = '20000元仅是算术差额，不是我方确认的欠款。';
const create = vi.fn();
const unavailable = () => null;
const getters = { getDeepSeek: unavailable, getGemini: unavailable, getOpenAI: () => ({ chat: { completions: { create } } }) };
const roots: string[] = [];
beforeAll(() => initDatabase());
beforeEach(() => {
  vi.stubEnv('LUMI_PRIVACY', 'standard'); resetCircuit();
  upsertUserPreferredVision(userId, { provider: 'openai', model: 'synthetic-lossless-vision' });
  knowledgeExtractionDeps.llmGetters = getters;
  create.mockReset().mockResolvedValue({ choices: [{ message: { role: 'assistant', content: returnedText }, finish_reason: 'stop' }] });
});
afterEach(() => { vi.unstubAllEnvs(); resetCircuit(); knowledgeExtractionDeps.llmGetters = {}; });
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe('actual vision SDK input preserves available source pixels', () => {
  for (const mode of ['knowledge', 'ocr'] as const) {
    it.each([{ width: 96, height: 64 }, { width: 3600, height: 1200 }])(
      mode + ' preserves lossless bounded pixels for $width x $height without changing the original',
      async ({ width, height }) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-vision-lossless-')); roots.push(root);
        const raw = Buffer.alloc(width * height * 3);
        for (let i = 0; i < raw.length; i++) raw[i] = (i * 73 + Math.floor(i / 17) * 41) % 256;
        const original = await (sharp as any)(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
        const file = path.join(root, 'synthetic-evidence.png'); fs.writeFileSync(file, original);
        const before = crypto.createHash('sha256').update(original).digest('hex');
        const result = mode === 'knowledge'
          ? await extractImageKnowledge(file, userId)
          : JSON.parse(await ocrImageFile({ imagePath: file, query: '仅逐字提取虚构材料原文，不推测结论。' }, { userId, llmGetters: getters }));
        expect(mode === 'knowledge' ? result.content : result.analysis).toContain(returnedText);
        expect(create).toHaveBeenCalledOnce();
        const params = create.mock.calls[0][0];
        const image = params.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
          .find((part: any) => part.type === 'image_url');
        expect(image).toBeTruthy();
        const sent = Buffer.from(image.image_url.url.split(',')[1], 'base64');
        const metadata = await sharp(sent).metadata();
        expect(metadata.width).toBe(Math.min(width, 1800));
        expect(metadata.height).toBe(width > 1800 ? 600 : height);
        const expectedPixels = await sharp(original).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer();
        const sentPixels = await sharp(sent).ensureAlpha().raw().toBuffer();
        expect(Buffer.compare(sentPixels, expectedPixels)).toBe(0);
        expect(image.image_url.url).toMatch(/^data:image\/png;base64,/);
        expect(metadata.format).toBe('png');
        expect(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(before);
      },
    );
  }
});
