import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools, registerProductVariantTools } from '../server/tools/definitions';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { registerComputerUseTool } from '../server/tools/definitions/computer_use_tool';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { buildCapabilityExecutionPlan, buildScheduledCapabilityExecutionPlan, authorizeCapabilityPlanTool } from '../server/cognition/capability_execution_plan';
import { executeToolCall } from '../server/tools/execution_engine';
import { createTurnConfirmation } from '../server/tools/turn_confirmation';
import { saveStoredDesktopExecutionPreference } from '../server/cognition/operation_mode_store';
import { saveGateConfig } from '../server/autonomy/safety_gate';
import { evaluateCapabilityRollout } from '../server/cognition/capability_rollout';
const calls = vi.hoisted(() => ({ computer: vi.fn(), network: vi.fn(), desktop: vi.fn(), sdk: vi.fn() }));
vi.mock('../server/agents/computer_use', () => ({ computerUseLoop: calls.computer }));
const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/knowledge_core_e240_capture.json'), 'utf8'));
const matrix = { "informational": [{ "id": "contract-date-query", "text": "请查询合同签署日期。" }, { "id": "contract-date-unprovided", "text": "合同签署日期未提供。" }, { "id": "confirm-contract-date", "text": "请确认合同签署日期。" }, { "id": "contract-date-question", "text": "能从材料确认合同签署日期吗？" }, { "id": "source-three-ten-questions", "text": "只依据个人知识库中的这三份虚构资料回答，逐题引用对应文件及原句；没有取得或仅是计划的内容请按原文区分，不自行补充。文件：KB-QA-20261016-7D42-A-原告陈述.txt（fileId=KB-QA-20261016-7D42-A-原告陈述.txt）；KB-QA-20261016-7D42-B-被告陈述.txt（fileId=KB-QA-20261016-7D42-B-被告陈述.txt）；KB-QA-20261016-7D42-C-材料核对记录.txt（fileId=KB-QA-20261016-7D42-C-材料核对记录.txt）。\nQ01 原告请求的金额是多少，这个数字能否直接当作已核实的合同总价？\nQ02 谁自述向谁付款多少，当前是否取得了可核实这笔款项的银行原始流水？\nQ03 两份陈述的金额相减后，是否能认定被告承认了剩余债务？\nQ04 本轮实际收到过货物照片或转账截图的图片像素吗，可以描述画面或交易信息吗？\nQ05 4箱的记录究竟证明了什么，能认定双方已验收或质量合格吗？\nQ06 两次排期表中的拟交付日期有什么变化，哪一天可以写成实际交货日？\nQ07 能从现有材料确认合同签署日期、具体付款到期条件和管辖法院吗，未提供等不等于双方未约定？\nQ08 质量异议由谁提出，原告承认了吗，缺陷有鉴定或双方复检记录支持吗？\nQ09 下一次材料复核会是什么时间，这个日期能代替合同生效、付款到期或法院立案时间吗？\nQ10 请分别给出三份文件各自尾段的核验码，并引用每个代码实际所在的文件。" }, { "id": "bare-date-field", "text": "签署日期未提供。" }, { "id": "preposition-read-date", "text": "请在文档中查看合同签署日期。" }, { "id": "explain-sign-button", "text": "请解释“点击签署按钮”是什么意思。" }] };
const evidence: any[] = [];
let sourcePath = '';
const bytes = '仅程序验收虚构材料。合同签署日期未提供。不表示原告承认存在质量问题。\n末行AUTHORITY-SELECTED-CALL-TAIL';
beforeAll(async () => { await initDatabase(); const dir = fs.mkdtempSync(path.join(process.env.LUMI_DATA_DIR!, 'actual-calls-')); sourcePath = path.join(dir, 'synthetic-original.txt'); fs.writeFileSync(sourcePath, bytes); });
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', calls.network.mockRejectedValue(new Error('UNEXPECTED_NETWORK'))); calls.computer.mockRejectedValue(new Error('OFFLINE_COMPUTER_SENTINEL')); calls.desktop.mockRejectedValue(new Error('UNEXPECTED_DESKTOP')); calls.sdk.mockRejectedValue(new Error('UNEXPECTED_SDK')); });
afterEach(() => vi.unstubAllGlobals());
function pipeline(text: string) { const registry = new ToolRegistry(); registerAllTools(registry); return { registry, flow: buildLumiExecutionPipeline({ requestId: crypto.randomUUID(), dispatch: { userId: 'selected-call-audit', channel: 'chat', source: 'offline-selected-call', text, operationMode: 'assistant', targetIsLumi: true }, registry, personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 10 }, executionBoundary: 'trusted_local' }) }; }
async function scope(text: string) { const userId = 'selected-' + crypto.randomUUID(); await saveStoredDesktopExecutionPreference(userId, 'external'); return { userId, requestId: crypto.randomUUID(), taskId: crypto.randomUUID(), domain: 'personal', source: 'offline-selected-call', authenticated: true, localExecution: true, executionBoundary: 'trusted_local', currentTurnExecutionRequested: true, actionIntent: text, routedTaskText: text, desktopRelay: calls.desktop, requestConfirmation: vi.fn(async () => false), llmGetters: { getOpenAI: () => ({ chat: { completions: { create: calls.sdk } } }) } } as any; }
const media = ['generate_image', 'generate_image_dalle', 'ai_edit_image', 'generate_video'];
function args(name: string) { return name === 'desktop_ai_ask' ? { question: 'synthetic', send: true } : name === 'ai_edit_image' ? { filePath: 'C:/synthetic/input.png', prompt: 'synthetic' } : { prompt: 'synthetic', to: 'synthetic', subject: 'synthetic', body: 'synthetic' }; }
describe('actual-call authority, not eligible candidates', () => {
    it.each(matrix.informational)('no synthetic authorization framing: $id', ({ id, text }: any) => { const { flow } = pipeline(text); expect(flow.resolution.userText).toBe(text); expect(flow.executionPlan).toBeUndefined(); expect(flow.intentTrace.blockedBy).not.toContain('external_commit_route_divergence'); expect(flow.capabilityPlan.promptOverlay).not.toContain('## Capability Execution Plan'); expect(flow.execution.promptOverlay).not.toContain('normalized signature requires an external commit'); evidence.push({ id, diagnosticKind: flow.normalizedIntent.kind, executionRequested: flow.executionRequested, syntheticPlan: !!flow.executionPlan, blockedBy: flow.intentTrace.blockedBy }); });
    it('keeps the same three-source ten questions and full-source tool declaration', () => { const { flow } = pipeline(captured.taskText); expect(flow.resolution.userText).toBe(captured.taskText); expect(flow.modelToolProjection.toolNames).toContain('knowledge_file_stats'); expect(flow.authorizationPolicy.allowedTools).toContain('knowledge_file_stats'); expect(flow.turnIntent.flow.acceptedActionContract?.contract.label).toBe('Exact read-only file inspection'); });
    it('reads exact source bytes, then records only the actual bound read manifest', async () => { const text = '请读取 ' + sourcePath + '，回答合同签署日期是否已提供。'; const s = await scope(text); const registry = new ToolRegistry(); registerFileOpsTools(registry); const record = await executeToolCall({ registry, id: 'actual-read', name: 'read_file', arguments: { path: sourcePath }, context: s }); expect(record.result).toBe(bytes); expect(s.requestConfirmation).not.toHaveBeenCalled(); const capability = registry.getCapabilityManifestEntry('read_file', undefined, s)!; const p = buildCapabilityExecutionPlan({ record, capability, taskId: s.taskId }); expect(p.decisionAuthority).toBe('registry_bound_call'); expect(p.risk.sideEffectClass).toBe('none'); expect(p.intent.kind).not.toBe('signature'); expect(p.nodes).toHaveLength(1); expect(p.nodes[0].toolName).toBe('read_file'); expect(p.nodes[0].state).toBe('terminal'); expect(p.nodes.every(n => n.executionRole === 'adapter')).toBe(true); expect(p.risk.confirmationBinding).toBeUndefined(); expect(calls.sdk).not.toHaveBeenCalled(); expect(calls.computer).not.toHaveBeenCalled(); });
    it.each(media)('pure explanation cannot invoke paid media %s', async (name) => { const { registry, flow } = pipeline('解释这份虚构资料内容。'); const handler = vi.fn(async () => { throw Error('OFFLINE_PAID_HANDLER_REACHED'); }); registry.get(name)!.handler = handler; let outcome = ''; try {
        outcome = await registry.execute(name, args(name), { ...await scope('解释这份虚构资料内容。'), toolPolicy: flow.authorizationPolicy });
    }
    catch (e) {
        outcome = String((e as Error).message);
    } expect(handler).not.toHaveBeenCalled(); expect(outcome).toContain('forbidden'); });
    it('keeps the exact requested media family while forbidding alternate paid generators', async () => { const { registry, flow } = pipeline('请生成一张圣诞玩具宣传图片。'); expect(flow.normalizedIntent.kind).toBe('media_generation'); expect(flow.authorizationPolicy.forbiddenTools).not.toContain('generate_image'); for (const name of ['generate_image_dalle', 'generate_video']) {
        expect(flow.authorizationPolicy.forbiddenTools).toContain(name);
        const handler = vi.fn(async () => { throw Error('OFFLINE_PAID_HANDLER_REACHED'); });
        registry.get(name)!.handler = handler;
        await expect(registry.execute(name, args(name), { ...await scope('请生成一张圣诞玩具宣传图片。'), toolPolicy: flow.authorizationPolicy })).rejects.toThrow('forbidden');
        expect(handler).not.toHaveBeenCalled();
    } });
    it('autonomy checks actual external manifests, including safe paid-media definitions', async () => { const registry = new ToolRegistry(); registerProductVariantTools(registry); const external = registry.getCapabilityManifest().filter(m => m.sideEffects.some(e => ['external_state_change', 'external_communication'].includes(e.type))); expect(external.length).toBeGreaterThan(10); for (const m of external) {
        const handler = vi.fn(async () => { throw Error('OFFLINE_EXTERNAL_HANDLER'); });
        registry.get(m.toolName)!.handler = handler;
        const s = { ...await scope('读取虚构资料。'), autonomous: true };
        await expect(registry.execute(m.toolName, args(m.toolName), s)).rejects.toThrow('Autonomous external commit blocked');
        expect(handler).not.toHaveBeenCalled();
        expect(s.requestConfirmation).not.toHaveBeenCalled();
    } });
    it('actual external calls still require exact confirmation; a read grant is not reused', async () => { const registry = new ToolRegistry(); registerProductVariantTools(registry); for (const name of ['wechat_send_message', 'desktop_ai_ask']) {
        const handler = vi.fn(async () => { throw Error('OFFLINE_EXTERNAL_HANDLER'); });
        registry.get(name)!.handler = handler;
        const s = await scope('只读虚构合同。');
        const confirm = createTurnConfirmation({ userId: s.userId, source: s.source, requestId: s.requestId, actionIntent: s.actionIntent, consumeScope: () => undefined, proposalScope: () => undefined, onPending: () => { } });
        const r = await registry.execute(name, name === 'wechat_send_message' ? { contact: '模拟接收者', message: '模拟正文' } : args(name), { ...s, requestConfirmation: confirm });
        expect(handler).not.toHaveBeenCalled();
        expect(r).toContain('requires user confirmation');
    } });
    it.each(['builtin', 'mcp'])('media aliases retain the ceiling through static family even outside the media lane: %s', async (source) => { const registry = new ToolRegistry(); registerProductVariantTools(registry); const original = registry.get('generate_image')!; const name = 'offline_' + source + '_media_alias'; const handler = vi.fn(async () => { throw Error('OFFLINE_ALIAS_HANDLER'); }); registry.register({ ...original, name, semanticToolName: 'generate_image', capability: { ...original.capability, source: source as any, lane: 'general', family: 'media-generation' }, handler }); const text = '解释这份虚构资料内容。'; const flow = buildLumiExecutionPipeline({ requestId: crypto.randomUUID(), dispatch: { userId: 'media-alias-owner', channel: 'chat', text, operationMode: 'assistant', targetIsLumi: true }, registry, personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 4 }, executionBoundary: 'trusted_local' }); expect(flow.authorizationPolicy.forbiddenTools).toContain(name); await expect(registry.execute(name, { prompt: 'synthetic' }, { ...await scope(text), toolPolicy: flow.authorizationPolicy })).rejects.toThrow('forbidden'); expect(handler).not.toHaveBeenCalled(); });
    it('scheduler declared rollout is unchanged and still fail-closed', () => { const p = buildScheduledCapabilityExecutionPlan({ taskId: 'scheduled-task', scheduledTaskId: 'policy-id', lane: 'knowledge', operation: 'observe', sideEffectClass: 'none', sideEffects: [{ type: 'local_read', scope: 'fixture', reversible: true }] }); expect(p.decisionAuthority).toBe('semantic_planner'); expect(authorizeCapabilityPlanTool(p, 'scheduler_task_handler').allowed).toBe(true); const n = p.nodes.find(n => n.executionRole === 'adapter')!; expect(evaluateCapabilityRollout(p, n, { LUMI_CAPABILITY_ROLLOUT_STAGE: 'shadow' } as any).allowed).toBe(false); expect(evaluateCapabilityRollout({ ...p, risk: { ...p.risk, sideEffectClass: 'external_commit' } }, n, { LUMI_CAPABILITY_ROLLOUT_STAGE: 'external_commit', LUMI_CAPABILITY_ROLLBACK_DISABLE_EXTERNAL: 'true' } as any).allowed).toBe(false); });
});

 it('preserves explicit non-submit preparation but blocks true and default submit in autonomy',async()=>{for(const [label,input,expected] of [['false',{send:false},1],['true',{send:true},0],['omitted',{},0]] as const){const registry=new ToolRegistry();registerProductVariantTools(registry);const handler=vi.fn(async()=>{throw Error('OFFLINE_PREPARATION_HANDLER');});registry.get('desktop_ai_ask')!.handler=handler;const userId='autonomy-preparation-'+crypto.randomUUID();saveGateConfig({autonomyLevel:'full'},userId);const context:any={userId,requestId:crypto.randomUUID(),taskId:crypto.randomUUID(),autonomous:true,localExecution:true,authenticated:true,actionIntent:'请在DeepSeek桌面应用中准备提问，不要提交。',requestConfirmation:async()=>false};await registry.execute('desktop_ai_ask',{question:'synthetic',...input},context).catch(()=>undefined);expect(handler.mock.calls.length,label).toBe(expected);}});
