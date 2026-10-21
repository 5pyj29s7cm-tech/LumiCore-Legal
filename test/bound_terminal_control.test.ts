import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolExecutionRecord } from '../server/tools/types';
const claimGuard = vi.hoisted(() => vi.fn((input: { response: string }) => ({ text: input.response, blocked: false })));
vi.mock('../server/work_product/completion_guard', async original => ({
  ...await original<typeof import('../server/work_product/completion_guard')>(), guardCompletionClaims: claimGuard,
}));
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { encodeToolResult } from '../server/tools/result_envelope';
import { guardToolResponseIfNeeded } from '../server/llm/tool_loop/projection';
import { inspectPublicExecutionReferences } from '../server/cognition/user_output_protection';
import { sanitizeExecutionResponseForDelivery } from '../server/cognition/execution_guard_recovery';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
const protocol = 'status=generated';
const task = '生成并说明工作成果';
let serial = 0;
beforeEach(() => {
  claimGuard.mockImplementation(input => ({ text: input.response, blocked: false }));
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('No model/network permitted'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
async function created(content='已生成的工作内容', explicitName?:string){
 const registry=new ToolRegistry();const name=explicitName||'bound_created_'+(++serial);registry.register({name,description:'Synthetic work product',parameters:{type:'object',properties:{}},permission:'public',securityLevel:'safe',capability:{id:'fixture.bound.create',family:'generated-work',lane:'industry',operation:'create',risk:'low',sideEffects:['local_state_change','local_write','network_read'].map(type=>({type,scope:'synthetic fixture only',reversible:true})) as any,verification:{strategy:'terminal_receipt',required:true,requiredFields:['ok','status','content'],requiredValues:{ok:true},successStatuses:['generated'],successSignals:['fixture'],limitations:[]}},handler:async()=>encodeToolResult(content,{ok:true,status:'generated',content})});
 const record=await executeToolCall({registry,id:name, name,arguments:{},context:{authenticated:true,userId:'bound-control-fixture',authRole:'admin',requestId:'bound-request-1',taskId:'bound-task-1',currentTurnExecutionRequested:true,actionIntent:'生成工作成果',localExecution:true}});expect(isCanonicalToolExecutionRecord(record)).toBe(true);expect(record.error).toBeUndefined();expect(record.envelope?.status).toBe('verified_success');expect(record.id).toBe(name);return record;
}

function terminal(answer: string, records: ToolExecutionRecord[] = [], request = task) {
  const options = { task: request, toolRecords: records, requestId: 'bound-request-1', taskId: 'bound-task-1',
    completionRequest: { currentText: request, history: [] } };
  const guarded = guardToolResponseIfNeeded({ ...options, response: answer, toolCalls: records });
  return sanitizeExecutionResponseForDelivery(guarded, options);
}
async function originalReader(content: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bound-original-'));
  const file = path.join(root, 'source.txt'); fs.writeFileSync(file, content);
  const registry = new ToolRegistry();
  registry.register({ name: 'read_file', description: 'Read synthetic original',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'public', securityLevel: 'safe',
    capability: { id: 'fixture.bound.read', family: 'file-read', lane: 'files', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'synthetic source', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'content'],
        requiredValues: { ok: true }, successStatuses: ['observed'], successSignals: ['fixture'], limitations: [] } },
    handler: async args => encodeToolResult(fs.readFileSync(args.path, 'utf8'),
      { ok: true, status: 'observed', content: fs.readFileSync(args.path, 'utf8') }) });
  const reader = await executeToolCall({ registry, id: 'bound-source-reader-' + (++serial), name: 'read_file', arguments: { path: file },
    context: { authenticated: true, userId: 'bound-control-fixture', authRole: 'admin', requestId: 'bound-request-1',
      taskId: 'bound-task-1', currentTurnExecutionRequested: true, actionIntent: 'Read the file ' + file, localExecution: true } });
  expect(reader.error).toBeUndefined(); expect(isCanonicalToolExecutionRecord(reader)).toBe(true);
  expect(reader.envelope?.status).toBe('verified_success');
  const cleanup = () => {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('bound-original-')) throw Error('Unsafe cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  };
  return { file, reader, cleanup };
}

describe('normal terminal body and source-bound public display, independent of claim policy', () => {
  it('keeps actual defendant business paragraphs and cannot turn a generated packet receipt into an extra send', async () => {
    const actual = JSON.parse(fs.readFileSync(new URL('./fixtures/actual-defendant-terminal.json', import.meta.url), 'utf8'));
    const record = await created('Synthetic reviewed work content', 'legal_generate_litigation_packet');
    const displayed = terminal(actual.answer, [record], actual.request);
    expect(displayed.text).toContain(actual.answer.slice(actual.answer.indexOf('一、')).trim());
    // The original user explicitly named this tool. A literal name is not private data.
    expect(displayed.text).toContain('legal_generate_litigation_packet');
    const request = actual.request + '\n另外把文书通过邮件发送给客户。';
    const incomplete = finalizeLumiResponse({ taskText: request, responseText: actual.answer,
      source: 'chat', toolRecords: [record], requestId: 'bound-request-1', taskId: 'bound-task-1' });
    expect(incomplete.blocked).toBe(true);
    expect(record.capability?.sideEffects.some(effect => effect.type === 'external_communication')).toBe(false);
  });

  it('keeps an explicitly requested actual tool/status pair and ordinary status words', async () => {
    const record = await created(); const pair = record.name + ' ' + record.envelope!.status;
    const explained = terminal('公开解释：' + pair + '。', [record], task + '，并说明这个字符串：' + pair);
    expect(explained.blocked).toBe(false); expect(explained.text).toContain(pair);
    const ordinary = 'The status is partial. The term verified_success alone does not explain every request.';
    expect(terminal(ordinary, [record])).toMatchObject({ blocked: false, text: ordinary });
  });

  it('preserves a pair only when the canonical original reader matches the requested source', async () => {
    const record = await created(); const pair = record.name + ' ' + record.envelope!.status;
    const source = await originalReader(pair);
    try {
      const unsolicited = terminal('原文：' + pair + '。', [record, source.reader]);
      expect(unsolicited.blocked).toBe(true); expect(unsolicited.text).not.toContain(record.id!);
      const requested = terminal('原文：' + pair + '。', [record, source.reader], task + ' 原始资料 ' + source.file);
      expect(requested.blocked).toBe(false); expect(requested.text).toContain(pair);
    } finally { source.cleanup(); }
  });

  it('removes only exact current metadata while retaining the actual complete business paragraphs', async () => {
    const record = await created();
    const answer = fs.readFileSync(new URL('./fixtures/actual-public-answer.txt', import.meta.url), 'utf8');
    const result = terminal(protocol + '\n' + answer, [record]);
    expect(result.blocked).toBe(false);
    expect(result.text).not.toContain(protocol);
    expect(result.text).toContain(answer);
  });

  it('keeps a pure technical code example with no actual record unchanged', () => {
    const answer = '结果格式示例：\n~~~text\n' + protocol + '\n~~~';
    expect(terminal(answer, [], '请举一个状态与副作用格式示例')).toMatchObject({ blocked: false, text: answer });
  });

  it('keeps literal metadata explicitly supplied by the user', async () => {
    const record = await created();
    const result = terminal('公开解释：' + protocol + '。', [record], task + '，并说明这个字符串：' + protocol);
    expect(result.blocked).toBe(false); expect(result.text).toContain(protocol);
  });

  it('does not silently strip metadata from an exact requested original source', async () => {
    const record = await created(); const source = await originalReader(protocol);
    try {
      const inspected = inspectPublicExecutionReferences({ task, toolCalls: [record, source.reader],
        requestId: 'bound-request-1', taskId: 'bound-task-1' }, protocol);
      expect(inspected.sourceText).not.toContain(protocol);
      expect(inspected.verifiedText).toContain(protocol);
      expect(terminal('引用原始资料：' + protocol + '。', [record, source.reader]).text).toContain(protocol);
      const requested = terminal('引用原始资料：' + protocol + '。', [record, source.reader], task + ' 原始资料 ' + source.file);
      expect(requested.blocked).toBe(false); expect(requested.text).toContain(protocol);
    } finally { source.cleanup(); }
  });

  it('does not let generated content self-certify as an original input source', async () => {
    const record = await created(protocol);
    const inspected = inspectPublicExecutionReferences({ task, toolCalls: [record], requestId: 'bound-request-1', taskId: 'bound-task-1' }, protocol);
    expect(inspected.currentRecords).toEqual([record]);
    expect(inspected.sourceText).not.toContain(protocol); expect(inspected.verifiedText).not.toContain(protocol);
    expect(terminal(protocol + '。', [record]).text).not.toContain(protocol);
  });

  it('keeps an unperformed signature incomplete instead of accepting a model completion declaration', async () => {
    const record = await created();
    const result = finalizeLumiResponse({ taskText: '生成工作成果，然后签署合同。', responseText: '部分分析已提供，尚未签署。',
      toolRecords: [record], source: 'chat', requestId: 'bound-request-1', taskId: 'bound-task-1' });
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('已签署');
  });

  it('preserves independent claim-policy blocking after exact metadata projection', async () => {
    const record = await created();
    claimGuard.mockImplementation(input => ({ text: input.response + '\n文件尚未核验。', blocked: true, reason: 'fixture_claim_block' }));
    const result = terminal(protocol + '\n部分分析已提供，尚未签署。', [record]);
    expect(result.blocked).toBe(true); expect(result.reason).toBe('fixture_claim_block');
    expect(result.text).toContain('尚未签署'); expect(result.text).toContain('文件尚未核验'); expect(result.text).not.toContain(protocol);
  });

  it('keeps the original private-ID gate before display cleanup', async () => {
    const record = await created();
    const result = terminal(protocol + ' bound-request-1。\n其它正文。', [record]);
    expect(result.blocked).toBe(true); expect(result.reason).toBe('execution_recovery_incomplete');
    expect(result.text).not.toContain('bound-request-1');
  });
});
