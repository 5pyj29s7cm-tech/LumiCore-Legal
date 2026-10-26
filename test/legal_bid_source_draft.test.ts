import { sdkCompletion } from './legal_bid_fixture';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { readBidRequirementInput } from '../server/regions/packs/cn/legal_tools/documents';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import { parseDocument } from '../server/legal/parser';

let app: Awaited<ReturnType<typeof makeApp>>, directory: string;
const registry = new ToolRegistry(), userId = 'bid-source-registered-owner';
const promptOf = (params: any) => String(params.messages.find((message: any) => message.role === 'user')?.content || '');
const proposal = '# 模拟投标工作稿\n\n## 服务方案\n\n仅依本次原文拟议，资格、数量、签章及付款凭证待责任人确认。\n\n## 报价说明\n\n报价采用原文240000元未税、14400元税额、254400元含税；条件和计算仍待核实。';
const args = () => ({ projectName, folderPath: directory, persistCase: false });
const originals = {
  clarification: 'C01：工作日4小时远程响应，到场时间未提供。',
  facts: '投标人虚构甲公司；许可证、履约记录和签章均未提供。BID-ORIGINAL-FACTS-28473',
  quote: '条目,未税,税额,含税\n服务,240000,14400,254400\n"带逗号,报价说明",待确认,待确认,待确认',
  missing: 'D01：专项资质原件未提供，不能认定已经满足。BID-ORIGINAL-MISSING-28473',
  schedule: '条目,阶段,期限\nT01,启动清点,5个工作日\nT02,培训,2次每次2小时',
};
let create: ReturnType<typeof vi.fn>, projectName = '';
const context = () => ({ userId, domain: 'personal', source: 'legal-direct-tool', authenticated: true, authRole: 'admin',
  localExecution: true, executionBoundary: 'trusted_local', llmGetters: { getRelay: () => ({ chat: { completions: { create } } }) } } as any);
const run = async (extra = {}) => decodeToolResult(await registry.execute('legal_generate_bid', { ...args(), ...extra }, context()));

beforeAll(async () => {
  app = await makeApp(); registerLegalTools(registry);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-bid-source-'));
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= 8; page++) pdf.addPage().drawText(page === 1 ? 'R01: supplied test scope, service only.' : page === 8 ? 'R25: original return requires authorization. TAIL-BID-PDF-SOURCE-892413' : 'Virtual supplied page ' + page, { size: 10 });
  fs.writeFileSync(path.join(directory, '01-tender.pdf'), await pdf.save());
  for (const [name, value] of Object.entries(originals)) fs.writeFileSync(path.join(directory, name + (name === 'quote' || name === 'schedule' ? '.csv' : '.txt')), value);
});
afterAll(() => { fs.rmSync(directory, { recursive: true, force: true }); app.cleanup(); });
beforeEach(() => {
  resetCircuit(); vi.stubEnv('LUMI_PRIVACY', 'standard'); projectName = '虚构来源完整输入项目-' + crypto.randomUUID();
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'pinned', allowCloudFallback: false, fallbackCandidates: [] });
  create = vi.fn(async (params: any) => sdkCompletion(params, { choices: [{ message: { role: 'assistant', content: proposal }, finish_reason: 'stop' }] }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetCircuit(); });

describe('registered bid generation reads actual originals and delivers Markdown', () => {
  it('passes all six complete originals including the PDF tail to one normal generation and preserves the response in DOCX', async () => {
    const input = await readBidRequirementInput(args());
    const files = fs.readdirSync(directory).map(name => ({ name, bytes: fs.readFileSync(path.join(directory, name)) }));
    expect(input.sources).toHaveLength(6); expect(input.materials).toHaveLength(6); expect(input.skipped).toEqual([]);
    const result = await run();
    expect(result.receipt).toMatchObject({ ok: true, status: 'generated' }); expect(create).toHaveBeenCalledOnce();
    const [params] = create.mock.calls[0];
    expect(params).toMatchObject({ model: 'aliyun/deepseek-v4-flash' }); expect(params).not.toHaveProperty('max_tokens');
    expect(params).not.toHaveProperty('response_format');
    const prompt = promptOf(params);
    for (const material of input.materials) expect(prompt).toContain(material.content);
    expect(prompt).toContain('TAIL-BID-PDF-SOURCE-892413');
    expect(result.content).toContain(proposal);
    const artifact = result.content.split('\n').find(line => line.startsWith('- DOCX 文件：'))!.slice('- DOCX 文件：'.length);
    const docx = await parseDocument(artifact);
    for (const text of proposal.split('\n').filter(line => line && !line.startsWith('#'))) expect(docx?.text).toContain(text);
    for (const original of Object.values(originals)) for (const line of original.split('\n')) expect(result.content).toContain(line);
    for (const file of files) expect(fs.readFileSync(path.join(directory, file.name))).toEqual(file.bytes);
  });

  it('reports the file limit as an unread source and does not generate from an incomplete set', async () => {
    const input = await readBidRequirementInput({ ...args(), maxFiles: 1 });
    expect(input.sources).toHaveLength(1); expect(input.skipped).toEqual([expect.stringContaining('仍有材料未读取')]);
    const result = await run({ maxFiles: 1, useModel: false });
    expect(create).not.toHaveBeenCalled(); expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(result.content).toContain('文件数量超过本次读取上限 1'); expect(result.content).toContain('## 未读取材料');
  });

  it('keeps source-only output explicit without manufacturing a model response', async () => {
    const original = '未编号原件：资料量、工期、报价和签章未提供。UNNUMBERED-BID-SOURCE-98321';
    const result = await run({ requirements: original, folderPath: '', useModel: false });
    expect(create).not.toHaveBeenCalled(); expect(result.content).toContain(original);
    expect(result.content).toContain('未生成模型投标方案'); expect(result.content).not.toContain(proposal);
  });
  it.each([
    { label: 'unique repeated source fields', names: ['虚构清泉项目', '虚构清泉项目'], numbers: ['BID-SOURCE-001', 'BID-SOURCE-001'], expectedName: '虚构清泉项目', expectedNumber: 'BID-SOURCE-001' },
    { label: 'conflicting source numbers', names: ['虚构清泉项目', '虚构清泉项目'], numbers: ['BID-SOURCE-001', 'BID-SOURCE-002'], expectedName: '虚构清泉项目', expectedNumber: '编号待核实' },
    { label: 'conflicting source names and numbers', names: ['虚构清泉项目', '虚构云桥项目'], numbers: ['BID-SOURCE-001', 'BID-SOURCE-002'], expectedName: '', expectedNumber: '编号待核实' },
  ])('binds the exported page header to $label without silently selecting a conflicting original', async sample => {
    const requirements = sample.names.map((name, index) => '项目名称：' + name + '\n项目编号：' + sample.numbers[index] + '\nR0' + (index + 1) + '：仅用于页眉来源验收，未作事实核准。').join('\n');
    const result = await run({ requirements, folderPath: '', useModel: false });
    expect(create).not.toHaveBeenCalled();
    expect(result.content).toContain('未生成模型投标方案');
    const artifact = result.content.split('\n').find(line => line.startsWith('- DOCX 文件：'))!.slice('- DOCX 文件：'.length);
    const zip = await JSZip.loadAsync(fs.readFileSync(artifact));
    const headers = await Promise.all(zip.file(/^word\/header\d+\.xml$/).map(file => file.async('string')));
    const footers = await Promise.all(zip.file(/^word\/footer\d+\.xml$/).map(file => file.async('string')));
    expect(headers).toHaveLength(1); expect(footers).toHaveLength(1);
    expect(headers[0]).toContain(sample.expectedName || projectName); expect(headers[0]).toContain(sample.expectedNumber);
    if (!sample.expectedName) for (const name of new Set(sample.names)) expect(headers[0]).not.toContain(name);
    if (sample.expectedName) expect(headers[0]).not.toContain(projectName);
    if (sample.expectedNumber === '编号待核实') for (const number of sample.numbers) expect(headers[0]).not.toContain(number);
    expect(footers[0]).toMatch(/<w:instrText\b[^>]*>\s*PAGE\s*<\/w:instrText>/);
    const body = await zip.file('word/document.xml')!.async('string');
    for (const sourceText of [...new Set(sample.names), ...new Set(sample.numbers)]) expect(body).toContain(sourceText);
  });

  it.each([
    { requirement: 'R07：每页含项目名称、项目编号和“虚构验收草稿”。', expected: ['虚构验收草稿'] },
    { requirement: 'R07：每页不得包含“内部机密”。', expected: [] },
    { requirement: 'R07：每页注明“内部稿”。\nR08：每页注明“正式稿”。', expected: [] },
  ])('prints only a unique explicitly required page label: $requirement', async sample => {
    const result = await run({ requirements: '项目名称：虚构清泉项目\n项目编号：BID-LABEL-001\n' + sample.requirement, folderPath: '', useModel: false });
    expect(create).not.toHaveBeenCalled();
    const artifact = result.content.split('\n').find(line => line.startsWith('- DOCX 文件：'))!.slice('- DOCX 文件：'.length);
    const zip = await JSZip.loadAsync(fs.readFileSync(artifact));
    const header = await zip.file(/^word\/header\d+\.xml$/)[0].async('string');
    expect(header).toContain('虚构清泉项目'); expect(header).toContain('BID-LABEL-001');
    for (const label of ['虚构验收草稿', '内部机密', '内部稿', '正式稿']) {
      if (sample.expected.includes(label)) expect(header).toContain(label);
      else expect(header).not.toContain(label);
    }
  });
});
