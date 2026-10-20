import { guardModelTerminalResponse } from '../server/llm/tool_loop/projection';
import { isVerifiedCurrentTurnRecord } from '../server/cognition/result_finalizer_support';
import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ makeLLMCall: vi.fn() }));
vi.mock('../server/llm/providers', async importOriginal => {
  const callMock = async (...args: any[]) => {
    const response = await mocks.makeLLMCall(...args);
    if (!response?.text || response.toolCalls?.length) return response;
    const fields = args[0].find((m:any) => m.promptBlock?.id === 'current-execution-authorization')?.promptBlock?.fields;
    if (!fields?.completionEvidence) return response;
    const text = [...args[0]].reverse().find((m:any) => m.role === 'user')?.content;
    const evidence = fields.completionEvidence.filter((r:any) => r.status === 'verified_success');
    return {...response, text:JSON.stringify({answer:response.text,goals:evidence.length ? evidence.map((r:any) => ({text,operation:r.operation,effects:r.effects,status:'completed',evidenceIds:[r.id]})) : [{text,operation:'respond',effects:[],status:'incomplete',evidenceIds:[]}]})};
  };
  return {...await importOriginal<typeof import('../server/llm/providers')>(),makeLLMCall:callMock,makeLLMCallStreaming:callMock};
});

import { initDatabase } from '../db_layer';
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { registerImageTools } from '../server/tools/definitions/image_tools';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { resolveAcceptedTaskTarget } from '../server/conversation/task_target_anchor';
import type { LumiTurnFlow } from '../server/cognition/turn_flow';
import type { ToolContext, ToolExecutionRecord } from '../server/tools/types';

const getters = [() => null, () => null, () => null, () => null, () => null] as const;
const root = String(process.env.LUMI_DATA_DIR);
let serial = 0;
beforeAll(() => initDatabase());
beforeEach(() => {mocks.makeLLMCall.mockReset();vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('WAREHOUSE_FIXTURE_NETWORK_FORBIDDEN'));});

function fixture() {
  serial += 1;
  const registry = new ToolRegistry();
  registerFileOpsTools(registry);
  const context: ToolContext = {
    userId: 'bounded-action-user', authRole: 'admin', domain: 'personal',
    taskId: `bounded-task-${serial}`, requestId: `bounded-request-${serial}`,
    userConfirmed: true, localExecution: true, source: 'command-center-chat',
  };
  const target = path.join(root, `bounded-${serial}.txt`);
  return { registry, context, target };
}

async function run(task: string, value: ReturnType<typeof fixture>, onToolCall?: (record: ToolExecutionRecord) => void) {
  value.context.currentTurnExecutionRequested = true;
  value.context.completionRequest = { currentText: task };
  return runWithTools([{ role: 'user', content: task }], value.registry,
    { provider: 'deepseek', model: 'test-model' }, onToolCall, 4,
    ...getters, undefined, value.context);
}

describe('verified bounded actions in the real shared tool loop', () => {
  it('keeps the single verified image and lets the primary model deliver the full reply', async () => {
    const value = fixture();
    registerImageTools(value.registry);
    const output = value.target.replace(/\.txt$/, '.png');
    fs.writeFileSync(output, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'generated', provider: 'fixture', model: 'fixture',
      verified: true, verificationStatus: 'verified', images: [output], artifacts: [{ type: 'image', path: output }] }));
    value.registry.get('generate_image')!.handler = handler;
    const task = '生成一张蓝色杯子的图片。只提交一次。';
    value.context.routedTaskText = task;
    value.context.priorToolRecords = [{ name: 'generate_image', arguments: { prompt: 'blue cup' }, result: '',
      error: 'Lumi Official API request failed (400): rejected', requestId: 'old-attempt', taskId: value.context.taskId }];
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'image', name: 'generate_image', arguments: { prompt: 'blue cup' } },
      { id: 'duplicate-image', name: 'generate_image', arguments: { prompt: 'unwanted alternative' } },
    ] }).mockResolvedValueOnce({text:'图片已生成。',toolCalls:[]});
    const result = await run(task, value);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('图片已生成。');
    const current = result.toolCalls.filter(record => record.requestId === value.context.requestId);
    expect(current).toHaveLength(1);
    expect(current[0].terminalVerification?.status).toBe('verified');
    const input = { taskText: task, responseText: '', toolRecords: result.toolCalls, source: 'chat',
      requestId: value.context.requestId, taskId: value.context.taskId };
    expect(finalizeLumiResponse(input)).toMatchObject({ blocked: false, text: '图片已生成。' });
    const mixed='生成一张蓝色杯子的图片并发送邮件。';
    expect(guardModelTerminalResponse({task:mixed,response:JSON.stringify({answer:'图片已生成；邮件尚未发送。',goals:[{text:'生成一张蓝色杯子的图片',operation:current[0].capability!.operation,effects:current[0].capability!.sideEffects.map(e=>e.type),status:'completed',evidenceIds:[current[0].id]},{text:'发送邮件',operation:'communicate',effects:['external_communication'],status:'incomplete',evidenceIds:[]}]}),structured:true,completionRequest:{currentText:mixed},toolCalls:current,requestId:input.requestId,taskId:input.taskId,source:'chat'})).toMatchObject({blocked:true});
    expect(finalizeLumiResponse({ ...input, taskText: '生成两张蓝色杯子的图片。' }))
      .toMatchObject({ blocked: true, reason: 'media_settings_mismatch' });
    expect(isVerifiedCurrentTurnRecord({...input,requestId:'other-turn'},current[0])).toBe(false);
    expect(finalizeLumiResponse({ ...input, requestId: 'other-turn' }).text).not.toContain('图片已生成');
  });

  it('creates the exact XLSX and reads that real workbook before delivering its contents', async () => {
    const value = fixture();
    registerDocumentTools(value.registry);
    const output = value.target.replace(/\.txt$/, '.xlsx');
    const task = `新建 ${output}，只有一个工作表“订单”，表头为商品、数量、单价、金额，只有一条数据：水杯，2，12，24。实际保存后回读表格并告诉我内容。`;
    value.context.actionIntent = task;
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'xlsx', name: 'create_xlsx', arguments: { filename: 'orders', sheets: [{ name: '订单', headers: ['商品', '数量', '单价', '金额'], data: [['水杯', 2, 12, 24]] }] } },
    ] }).mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'readback', name: 'read_xlsx', arguments: { filePath: output } },
    ] }).mockResolvedValueOnce({ text: '已保存并回读订单表格：水杯，数量2，单价12，金额24。', toolCalls: [] });
    const result = await run(task, value);
    expect(result.toolCalls.map(record => record.name)).toEqual(['create_xlsx', 'read_xlsx']);
    expect(result.toolCalls.every(record => !record.error && record.terminalVerification?.status === 'verified')).toBe(true);
    expect(result.toolCalls[0].arguments?.outputPath).toBe(path.resolve(output));
    expect(result.toolCalls[1].result).toContain('水杯');
    const { loadXlsxWorkbook } = await import('../server/utils/spreadsheet');
    const sheet = (await loadXlsxWorkbook(output)).getWorksheet('订单')!;
    expect(sheet.getCell('D2').value).toBe(24);
    expect(result.completionGuard, JSON.stringify(result.completionGuard)).not.toMatchObject({ blocked: true });
    expect(result.text).toContain('24');
    expect(mocks.makeLLMCall.mock.calls.length).toBeLessThanOrEqual(3);
    const claim = { task, response: '已保存并回读订单表格：金额24。' };
    expect(guardCompletionClaims({ ...claim, toolCalls: [result.toolCalls[1]] }).blocked).toBe(true);
    expect(guardCompletionClaims({ ...claim, toolCalls: [
      { ...result.toolCalls[0], terminalVerification: { status: 'unverified', strategy: 'artifact', reason: 'missing verified output' } },
      result.toolCalls[1],
    ] }).blocked).toBe(true);
  });

  it('keeps the exact saved bytes, denies the queued overwrite, and obtains the primary reply', async () => {
    const value = fixture();
    const content = 'LC bounded write';
    const entry=value.registry.get('write_file')!; const writer=vi.fn(entry.handler); entry.handler=writer;
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'write', name: 'write_file', arguments: { path: value.target, content } },
      { id: 'duplicate', name: 'write_file', arguments: { path: value.target, content: 'unwanted duplicate' } },
    ] }).mockResolvedValueOnce({text:'已写入 '+value.target,toolCalls:[]});
    const result = await run(`在 ${value.target} 新建文本文件，只写入“${content}”。`, value);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.filter(record=>record.terminalVerification?.status==='verified')).toHaveLength(1);
    expect(result.toolCalls?.[0].terminalVerification?.status).toBe('verified');
    expect(fs.readFileSync(value.target, 'utf8')).toBe(content);
    expect(result.text).toContain(value.target);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('waits for the bound same-path readback before the primary terminal reply', async () => {
    const value = fixture();
    const content = 'LC bounded readback';
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'write', name: 'write_file', arguments: { path: value.target, content } },
    ] }).mockResolvedValueOnce({text:content,toolCalls:[]});
    const result = await run(`在 ${value.target} 新建文本文件，只写入“${content}”，写完回读并告诉我全文。`, value);
    expect(result.toolCalls?.map(record => record.name)).toEqual(['write_file', 'read_file']);
    expect(result.text).toContain(content);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1); // Bound readback plus the original primary terminal reply.
  });

  it('does not confuse reading the source with delivering the requested calculation', async () => {
    const value = fixture();
    fs.writeFileSync(value.target, '商品,数量,单价\n水杯,2,12\n');
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'read', name: 'read_file', arguments: { path: value.target } },
    ] }).mockResolvedValueOnce({ text: '水杯：2 × 12 = 24，总额为24。', toolCalls: [] });
    const result = await run(`读取 ${value.target}，按数量乘单价告诉我总额，保留原文件。`, value);
    expect(result.toolCalls?.[0].name).toBe('read_file');
    expect(result.text).toContain('24');
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(2);
  });

  it('keeps cancellation ahead of the primary terminal reply and retains the real write receipt', async () => {
    const value = fixture();
    let cancelled = false;
    value.context.isCancelled = () => cancelled;
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'write', name: 'write_file', arguments: { path: value.target, content: 'LC cancelled write' } },
    ] });
    const result = await run(`在 ${value.target} 新建文本文件，只写入“LC cancelled write”。`, value,
      () => { cancelled = true; });
    expect(fs.readFileSync(value.target, 'utf8')).toBe('LC cancelled write');
    expect(result.toolCalls?.[0].terminalVerification?.status).toBe('verified');
    expect(result.text).toMatch(/cancelled/i);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('keeps the verified app launch and obtains the primary terminal reply', async () => {
    const value = fixture();
    registerDesktopTools(value.registry);
    value.context.desktopRelay = vi.fn(async command => JSON.stringify(command === 'desktop_active_window'
      ? { processName: 'notepad.exe', title: 'Notepad', pid: 42 }
      : { ok: true, opened: true, target: 'Notepad' }));
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'open', name: 'desktop_open', arguments: { target: 'Notepad' } },
    ] }).mockResolvedValueOnce({text:'已打开 Notepad。',toolCalls:[]});
    const result = await run('打开 Notepad。', value);
    expect(vi.mocked(value.context.desktopRelay).mock.calls.map(call => call[0]))
      .toEqual(['desktop_open', 'desktop_active_window']);
    expect(result.toolCalls?.[0].terminalVerification?.status).toBe('verified');
    expect(result.text).toContain('Notepad');
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a different turn receipt or prematurely finish a compound action', async () => {
    const value = fixture();
    const content = 'LC compound';
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'write', name: 'write_file', arguments: { path: value.target, content } },
    ] }).mockResolvedValueOnce({text:'已写入 '+value.target,toolCalls:[]});
    const result = await run(`在 ${value.target} 新建文本文件，只写入“${content}”。`, value);
    const base = { taskText: `在 ${value.target} 新建文本文件，只写入“${content}”。`,
      responseText: '', toolRecords: result.toolCalls, source: 'chat',
      taskId: value.context.taskId, requestId: value.context.requestId };
    expect(guardCompletionClaims({task:base.taskText,response:'已完成文件写入。',toolCalls:result.toolCalls,requestId:'different-request',taskId:base.taskId}).blocked).toBe(true);
    expect(finalizeLumiResponse({ ...base,
      taskText: `在 ${value.target} 新建文本文件，只写入“${content}”，然后打开文件。` })).toMatchObject({ blocked: true });
  });

  it('separates a verified current output readback from input identity without accepting unrelated reads', () => {
    const taskId = 'produced-readback-task';
    const requestId = 'produced-readback-request';
    const source = path.join(root, 'source.csv');
    const output = path.join(root, 'output.xlsx');
    const task = '根据原文件生成表格，回读产物后说明差异。';
    const acceptedTaskTarget = resolveAcceptedTaskTarget({
      text: task, persistedHistory: [{ id: 'source-user', role: 'user', message: `读取 ${source} 并生成新的表格。` }],
    });
    expect(acceptedTaskTarget?.target.path).toBe(source);
    const verified = { taskId, requestId, turnId: requestId,
      terminalVerification: { status: 'verified' as const, strategy: 'artifact' as const, reason: 'fixture producer/readback receipt' } };
    const write: ToolExecutionRecord = { ...verified, id: 'producer', name: 'create_xlsx',
      arguments: { filePath: output }, result: JSON.stringify({ filePath: output, ok: true }) };
    const read: ToolExecutionRecord = { ...verified, id: 'readback', name: 'read_xlsx',
      arguments: { filePath: output }, result: JSON.stringify({ ok: true, sheets: [{ name: 'Sheet1', data: [['amount'], [24]] }] }) };
    const check = (toolRecords: ToolExecutionRecord[]) => finalizeLumiResponse({
      taskText: task, responseText: '回读结果已经记录，还未完成差异分析。', source: 'chat',
      taskId, requestId, flow: { routeText: task, acceptedTaskTarget } as LumiTurnFlow, toolRecords,
    });
    expect(check([write, read]).reason).not.toBe('Verified document read target did not match the requested document.');
    expect(check([{ ...write, error: 'producer failed' }, read]).reason)
      .toBe('Verified document read target did not match the requested document.');
    expect(check([{ ...write, requestId: 'other-request' }, read]).reason)
      .toBe('Verified document read target did not match the requested document.');
    const wrongInput: ToolExecutionRecord = { ...read, id: 'wrong-input', name: 'read_file',
      arguments: { path: path.join(root, 'wrong-source.csv') }, result: 'amount\n999\n' };
    expect(check([write, read, wrongInput]).reason)
      .toBe('Verified document read target did not match the requested document.');
  });
});
