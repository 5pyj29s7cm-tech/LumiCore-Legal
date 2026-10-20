import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { getDataPath } from '../server/config/data_path';
import { buildTaskCapsuleV1 } from '../server/conversation/task_capsule';
import { explicitFile } from '../server/conversation/targets/instruction_targets';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { ToolRegistry } from '../server/tools/registry';
import { prepareToolLoop } from '../server/llm/tool_loop/loop_setup';
import { runWithTools } from '../server/llm/adapter';
import { compactToolResultForModel, wrapToolOutputForModel } from '../server/llm/tool_loop/receipts';
import type { LLMConfig } from '../server/llm/tool_loop/contracts';
import type { ToolContext } from '../server/tools/types';

beforeAll(initDatabase);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const query = '请只依据个人知识库这三份文件：KB-a35cd51b6ae6-A.pdf（fileId=KB-a35cd51b6ae6-A.pdf）；KB-a35cd51b6ae6-B.docx（fileId=KB-a35cd51b6ae6-B.docx）；KB-a35cd51b6ae6-C.txt（fileId=KB-a35cd51b6ae6-C.txt）。引用来源，不猜本地路径。';
describe('knowledge target replay uses explicit names and bounded searches', () => {
  it('does not turn the native multi-file request and parentheses into a basename', () => {
    expect(explicitFile(query)).toBe('KB-a35cd51b6ae6-A.pdf');
    expect(explicitFile('请读原文内容：虚构合同.docx（fileId=虚构合同.docx）')).toBe('');
  });
  it.each(['读取“虚构合同.docx”', '准确文件名是虚构合同.docx', '读取 D:/virtual/虚构合同.docx'])('keeps quoted, named, or absolute Chinese targets: %s', text => {
    expect(explicitFile(text)).toContain('虚构合同.docx');
  });
  it('preserves a Chinese filename supplied by a verified foreground-window receipt', () => {
    const file = '会议安排.docx', now = '2026-10-14T00:00:00.000Z';
    const capsule = buildTaskCapsuleV1({ taskId: 'virtual-current-document', revision: 1, status: 'executing', unfinished: true, goal: '分析 WPS 当前打开的这份文件。', latestInstruction: '分析 WPS 当前打开的这份文件。', appTarget: 'WPS', sourcePaths: [], toolSummaries: [], updatedAt: now, receipts: [{ id: 'verified-window', key: 'desktop_active_window:current', name: 'desktop_active_window', arguments: {}, result: JSON.stringify({ ok: true, processName: 'wps.exe', windowTitle: file + ' - WPS Office' }), error: '', outcome: 'success', terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'virtual foreground observed' }, recordedAt: now }] });
    expect(capsule!.target.object).toBe(file); expect(capsule!.target.source).toBe('active_window');
  });
  it('rejects grep without a directory before a filesystem traversal and uses only an explicit directory', async () => {
    const registry = new ToolRegistry(); registerFileOpsTools(registry); const tool = registry.get('grep_files')!;
    const dir = getDataPath('grep-source-fixture'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'fixture.txt'), 'VIRTUAL-GREP-SOURCE');
    const scan = vi.spyOn(fs, 'readdirSync');
    await expect(tool.handler({ pattern: 'VIRTUAL-GREP-SOURCE' }, { cwd: process.cwd(), localExecution: true })).rejects.toThrow(/directory/);
    expect(scan).not.toHaveBeenCalled(); expect(tool.parameters.required).toContain('directory');
    const result = await tool.handler({ pattern: 'VIRTUAL-GREP-SOURCE', directory: dir }, { localExecution: true });
    expect(result).toContain('VIRTUAL-GREP-SOURCE'); expect(result).not.toContain('dist-server');
  });
});

describe('bound local_only policy reaches the existing model and tool contexts', () => {
  const messages = [{ role: 'user' as const, content: '只回答此虚构程序状态。' }];
  it.each([{ model: 'policy_scoped', context: 'local_only' }, { model: 'local_only', context: 'policy_scoped' }] as const)('prevents cloud SDK dispatch when config=$model and context=$context', async policies => {
    vi.stubEnv('LUMI_PRIVACY', 'standard');
    const create = vi.fn(async () => ({ choices: [{ message: { role: 'assistant', content: 'MUST NOT SEND' }, finish_reason: 'stop' }] }));
    const getter = vi.fn(() => ({ chat: { completions: { create } } }));
    const config: LLMConfig = { provider: 'openai', model: 'synthetic-cloud', dataRoutingPolicy: policies.model, noImplicitFailover: true };
    const context: ToolContext = { dataRoutingPolicy: policies.context };
    const registry = new ToolRegistry(); const prepared = prepareToolLoop(messages, registry, config, { getOpenAI: getter }, undefined, 1, undefined, context);
    expect(prepared.state!.config.dataRoutingPolicy).toBe('local_only'); expect(prepared.state!.toolExecutionContext!.dataRoutingPolicy).toBe('local_only'); expect(config.dataRoutingPolicy).toBe(policies.model); expect(context.dataRoutingPolicy).toBe(policies.context);
    await expect(runWithTools(messages, registry, config, undefined, 1, undefined, undefined, getter, undefined, undefined, undefined, context)).rejects.toThrow(/Local-only/);
     expect(getter).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it('keeps ordinary standard routing available and strict mode cloud-blocked', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'standard'); const create = vi.fn(async () => ({ choices: [{ message: { role: 'assistant', content: 'SYNTHETIC STANDARD ANSWER' }, finish_reason: 'stop' }] })); const getter = vi.fn(() => ({ chat: { completions: { create } } })); const registry = new ToolRegistry();
    const result = await runWithTools(messages, registry, { provider: 'openai', model: 'synthetic-standard', noImplicitFailover: true }, undefined, 1, undefined, undefined, getter, undefined, undefined, undefined, {});
    expect(result.text).toBe('SYNTHETIC STANDARD ANSWER'); expect(create).toHaveBeenCalledOnce(); create.mockClear(); getter.mockClear();
    vi.stubEnv('LUMI_PRIVACY', 'strict'); await expect(runWithTools(messages, registry, { provider: 'openai', model: 'synthetic-standard', noImplicitFailover: true }, undefined, 1, undefined, undefined, getter, undefined, undefined, undefined, {})).rejects.toThrow(/Strict mode/);
     expect(getter).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
});

describe('knowledge original text remains untrusted and honest about model-context compaction', () => {
  it('preserves the actual three-source capacity and marks data as untrusted', () => {
    const source = JSON.stringify({ mode: 'source_text', files: [{ fileId: 'A.pdf', text: 'a'.repeat(11453) + 'KB-END-A', truncated: false }, { fileId: 'B.docx', text: 'KB-END-B', truncated: false }, { fileId: 'C.txt', text: 'KB-END-C', truncated: false }] });
    expect(compactToolResultForModel('knowledge_file_stats', source)).toBe(source);
    expect(wrapToolOutputForModel('knowledge_file_stats', source)).toContain('[BEGIN UNTRUSTED DATA');
  });
  it('does not label a model-context excerpt as complete source text', () => {
    const source = JSON.stringify({ mode: 'source_text', files: [{ fileId: 'A.pdf', text: 'a'.repeat(40000) + 'KB-END-A', truncated: false }] });
    const excerpt = compactToolResultForModel('knowledge_file_stats', source);
    expect(excerpt).toContain('compacted for model context'); expect(excerpt).toContain('KB-END-A'); expect(excerpt).toContain('"truncated":true'); expect(excerpt).not.toContain('"truncated":false');
  });
});
