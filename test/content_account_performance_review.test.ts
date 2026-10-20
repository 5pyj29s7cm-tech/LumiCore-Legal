import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const state = vi.hoisted(() => ({ tools: new Map<string, { config: any; handler: (args: any) => Promise<any> }>(), connects: 0 }));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {
  registerTool(name: string, config: any, handler: (args: any) => Promise<any>) { state.tools.set(name, { config, handler }); }
  async connect() { state.connects++; }
} }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
import '../server/skills/bundled/content-ops/index';

const csv = fs.readFileSync(new URL('./fixtures/content-video-statistics.csv', import.meta.url), 'utf8');
const oracle = JSON.parse(fs.readFileSync(new URL('./fixtures/content-video-statistics-oracle.json', import.meta.url), 'utf8'));
const tool = () => state.tools.get('account_performance_review')!;
async function run(args: Record<string, unknown>) {
  const registered = tool();
  const validated = z.object(registered.config.inputSchema).parse(args);
  const response = await registered.handler(validated);
  return JSON.parse(response.content[0].text);
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network or model allowed in CSV analysis.'); })));
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('actual registered account_performance_review', () => {
  it('calculates all 25 exported records and view-weighted completion using exact source headers', async () => {
    const result = await run({ metricsText: csv, columnMapping: oracle.mapping, period: 'fictional export interval' });
    expect(result.source).toMatchObject({ rowCount: oracle.expected.rowCount, columnMapping: oracle.mapping });
    for (const [field, expected] of Object.entries(oracle.expected.totals)) expect(result.totals[field]).toEqual({ value: expected, knownSum: expected, validRows: 25, unknownRows: 0 });
    for (const [field, expected] of Object.entries(oracle.expected.ratesPercent)) expect(result.ratesPercent[field]).toEqual({ value: expected, reason: null });
    expect(result.rows).toHaveLength(25);
    expect(result.rows[24]).toMatchObject({ recordNumber: 25, videoId: 'v25', title: '虚构标题,最后一条', metrics: { completionRate: 90 }, raw: { views: '1000', completionRate: '90%' } });
    expect(result.period).toBe('fictional export interval');
    expect(result.dataQuality).toEqual({ missingColumns: [], missingValueCount: 0, invalidValueCount: 0, zeroViewRecords: [] });
    expect(result).not.toHaveProperty('likelyWeakLinks');
    expect(result).not.toHaveProperty('experimentBacklog');
    expect(fs.readFileSync(new URL('./fixtures/content-video-statistics.csv', import.meta.url), 'utf8')).toBe(csv);
  });
  it('uses canonical headers without guessing an unrelated Chinese column alias', async () => {
    const result = await run({ metricsText: '播放量,likes,comments,saves,shares,completionRate\n100,5,2,1,1,60%' });
    expect(result.source.columnMapping.views).toBeNull();
    expect(result.totals.views).toEqual({ value: null, knownSum: null, validRows: 0, unknownRows: 1 });
    expect(result.dataQuality.missingColumns).toEqual(['views']);
    expect(result.ratesPercent.engagement).toEqual({ value: null, reason: 'incomplete_data' });
    expect(result.rows[0].metrics.likes).toBe(5);
  });
  it('keeps zero playback as known zero while every zero-denominator rate remains unavailable', async () => {
    const result = await run({ metricsText: 'views,likes,comments,saves,shares,completionRate\n0,0,0,0,0,0%' });
    expect(result.totals.views.value).toBe(0);
    expect(result.totals.likes.value).toBe(0);
    expect(result.rows[0].metrics.completionRate).toBe(0);
    expect(Object.values(result.rows[0].ratesPercent)).toEqual([null, null, null, null, null]);
    expect(Object.values(result.ratesPercent)).toEqual(Array(6).fill({ value: null, reason: 'zero_denominator' }));
    expect(result.dataQuality.zeroViewRecords).toEqual([1]);
  });
  it('does not fabricate missing saves and completion columns or a complete total', async () => {
    const result = await run({ metricsText: 'views,likes,comments,shares\n100,5,2,1\n200,8,3,2' });
    expect(result.dataQuality.missingColumns).toEqual(['saves', 'completionRate']);
    expect(result.totals.saves).toEqual({ value: null, knownSum: null, validRows: 0, unknownRows: 2 });
    expect(result.ratesPercent.engagement).toEqual({ value: null, reason: 'incomplete_data' });
    expect(result.ratesPercent.completionWeightedByViews).toEqual({ value: null, reason: 'incomplete_data' });
    expect(result.ratesPercent.likes).toEqual({ value: 4.333333, reason: null });
  });
  it('distinguishes an empty cell from a numeric zero and reports partial coverage', async () => {
    const result = await run({ metricsText: 'views,likes,comments,saves,shares,completionRate\n100,,0,0,0,50%\n200,0,0,0,0,80%' });
    expect(result.rows[0].metrics.likes).toBeNull();
    expect(result.rows[1].metrics.likes).toBe(0);
    expect(result.rows[0].issues).toEqual([{ field: 'likes', reason: 'missing_value' }]);
    expect(result.totals.likes).toEqual({ value: null, knownSum: 0, validRows: 1, unknownRows: 1 });
    expect(result.ratesPercent.likes).toEqual({ value: null, reason: 'incomplete_data' });
    expect(result.dataQuality.missingValueCount).toBe(1);
  });
  it('rejects nonnumeric, negative, fractional, and unsafe counts instead of extracting a number from text', async () => {
    const result = await run({ metricsText: 'views,likes,comments,saves,shares,completionRate\n100,about 3,Infinity,-1,3.5,70%\n100,9007199254740992,0,0,0,60%' });
    expect(result.rows[0].metrics).toEqual({ views: 100, likes: null, comments: null, saves: null, shares: null, completionRate: 70 });
    expect(result.rows[1].metrics.likes).toBeNull();
    expect(result.dataQuality.invalidValueCount).toBe(5);
    expect(result.totals.likes.knownSum).toBeNull();
    expect(result.ratesPercent.engagement.value).toBeNull();
  });
  it('accepts exact grouped CSV counts and integral decimal counts without losing quoted title records', async () => {
    const result = await run({ metricsText: 'title,views,likes,comments,saves,shares,completionRate\n"quoted, title\nsecond line","1,000",3.0,0,0,0,50%' });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('quoted, title\nsecond line');
    expect(result.rows[0].metrics.views).toBe(1000);
    expect(result.rows[0].metrics.likes).toBe(3);
    expect(result.ratesPercent.likes.value).toBe(0.3);
  });
  it('requires an explicit unit for bare fractions while an explicit percent sign keeps its own unit', async () => {
    const input = 'views,likes,comments,saves,shares,completionRate\n100,0,0,0,0,0.8\n100,0,0,0,0,50%';
    const fraction = await run({ metricsText: input, completionRateUnit: 'fraction' });
    const percent = await run({ metricsText: input });
    expect(fraction.rows.map((row: any) => row.metrics.completionRate)).toEqual([80, 50]);
    expect(fraction.ratesPercent.completionWeightedByViews.value).toBe(65);
    expect(percent.rows.map((row: any) => row.metrics.completionRate)).toEqual([0.8, 50]);
    expect(percent.ratesPercent.completionWeightedByViews.value).toBe(25.4);
  });
  it('keeps out-of-range or malformed completion values unknown', async () => {
    const result = await run({ metricsText: 'views,likes,comments,saves,shares,completionRate\n100,0,0,0,0,101%\n100,0,0,0,0,60% junk\n100,0,0,0,0,-5%' });
    expect(result.rows.map((row: any) => row.metrics.completionRate)).toEqual([null, null, null]);
    expect(result.dataQuality.invalidValueCount).toBe(3);
    expect(result.ratesPercent.completionWeightedByViews).toEqual({ value: null, reason: 'incomplete_data' });
    const fraction = await run({ metricsText: 'views,completionRate\n100,1.1', completionRateUnit: 'fraction' });
    expect(fraction.rows[0].metrics.completionRate).toBeNull();
  });
  it('fails for an unknown explicit mapping rather than silently choosing another column', async () => {
    await expect(run({ metricsText: 'views,likes\n100,5', columnMapping: { views: 'absent' } })).rejects.toThrow('Mapped column does not exist');
  });
  it('fails when one source column is reused for different metrics', async () => {
    await expect(run({ metricsText: 'views,likes\n100,5', columnMapping: { views: 'views', likes: 'views' } })).rejects.toThrow('distinct source column');
  });
  it('reuses the CSV library for an explicitly selected TSV export with exact provenance', async () => {
    const result = await run({ metricsText: '旧播放量\t本期播放量\t点赞量\n100\t200\t4', delimiter: '\t', columnMapping: { views: '本期播放量', likes: '点赞量' } });
    expect(result.source.headers).toEqual(['旧播放量', '本期播放量', '点赞量']);
    expect(result.rows[0].raw.views).toBe('200');
    expect(result.totals.views.value).toBe(200);
    expect(result.ratesPercent.likes.value).toBe(2);
  });
  it('does not return a rounded unsafe count total', async () => {
    const result = await run({ metricsText: 'views,likes\n9007199254740991,1\n1,1' });
    expect(result.totals.views.value).toBeNull();
    expect(result.totals.views.knownSum).toBeNull();
    expect(result.rows[0].metrics.views).toBe(9007199254740991);
    expect(result.ratesPercent.likes).toEqual({ value: null, reason: 'unsafe_aggregate' });
  });
  it('refuses an export over the row cap instead of returning a silently truncated total', async () => {
    await expect(run({ metricsText: 'views\n' + '1\n'.repeat(50001) })).rejects.toThrow('CSV row limit exceeded');
  });
  it('rejects duplicate source headers instead of guessing which column was intended', async () => {
    await expect(run({ metricsText: 'views,views,likes\n100,200,4' })).rejects.toThrow('Duplicate headers');
  });
  it('retains the other four actual tool registrations and declares local read-only analysis', () => {
    expect([...state.tools.keys()]).toEqual(['content_topic_pipeline', 'short_video_script', 'account_performance_review', 'comment_insight_report', 'content_calendar_builder']);
    expect(state.connects).toBe(1);
    expect(tool().config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });
});
