import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import { buildLumiCapabilitySelection } from '../server/cognition/capability_selection';
import { getStoredDesktopExecutionPreference, saveStoredDesktopExecutionPreference } from '../server/cognition/operation_mode_store';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';
import { guardCurrentAppToolCall } from '../server/cognition/current_app_execution';
import { prepareToolLoop } from '../server/llm/tool_loop/loop_setup';
import { executePlannedToolBatch } from '../server/llm/tool_loop/tool_batch';

const declarations = ['computer_use', 'desktop_capture_screen', 'desktop_active_window', 'desktop_ui_snapshot', 'desktop_open', 'create_docx', 'write_file', 'read_file', 'client_get_state', 'client_action'].map(name => ({
  type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } },
}));
const userId = 'desktop-execution-routing';
function pipeline(text: string, extra: Record<string, any> = {}, decision: Record<string, any> = {}) {
  const dispatch = buildLumiTurnDispatch({ userId, text, channel: 'chat', source: 'chat', operationMode: 'assistant', targetIsLumi: true, ...extra });
  const execution = buildLumiExecutionDecision({ flow: dispatch.flow, text: dispatch.flow.routeText, toolDeclarations: declarations, ...decision });
  const selection = buildLumiCapabilitySelection({ dispatch, execution, text: dispatch.flow.routeText });
  return { dispatch, execution, selection };
}
beforeAll(async () => { await initDatabase(); });
describe('the actual turn, policy and capability pipeline consume server-owned execution preference', () => {
  it('removes the artifact-first conflict and prefers visible vision work without removing API choices', async () => {
    await saveStoredDesktopExecutionPreference(userId, 'internal');
    const internal = pipeline('Create a document report');
    expect(internal.dispatch.flow.workSurfaceRoute.artifactFirst).toBe(true);
    expect(internal.dispatch.flow.workSurfaceRoute.forbidComputerUse).toBe(true);
    await saveStoredDesktopExecutionPreference(userId, 'external');
    const external = pipeline('Create a document report');
    expect(external.dispatch.flow.workSurfaceRoute).toMatchObject({ artifactFirst: false, directDesktop: true, forbidComputerUse: false });
    expect(external.dispatch.flow.workSurfaceRoute.promptOverlay).toContain('fresh screenshot/target evidence');
    expect(external.dispatch.flow.workSurfaceRoute.promptOverlay).not.toContain('Default to an artifact-first');
    expect(external.execution.toolPolicy.forbiddenTools).not.toContain('computer_use');
    expect(external.selection.preferredTools[0]).toBe('computer_use');
    expect(external.selection.promptOverlay).toContain('Explicit user requests for an API or artifact override');
    expect(external.execution.toolPolicy.allowedTools).toContain('create_docx');
  });
  it('keeps ordinary conversation and explicit no-tool requests free of desktop work', async () => {
    await saveStoredDesktopExecutionPreference(userId, 'external');
    for (const text of ['just talk with me for a minute', 'Do not use tools. Explain what a spreadsheet is.']) {
      const p = pipeline(text);
      expect(p.execution.allowToolUse).toBe(false);
      expect(p.dispatch.flow.workSurfaceRoute.directDesktop).toBe(false);
      expect(p.selection.preferredTools).not.toContain('computer_use');
    }
  });
  it('keeps hard personality restrictions authoritative and isolates actors', async () => {
    await saveStoredDesktopExecutionPreference(userId, 'external');
    const p = pipeline('Create a document report', {}, { personalityToolPolicy: { allowedTools: ['create_docx'], forbiddenTools: ['computer_use'], requireConfirmation: [], maxIterations: 3 } });
    expect(p.execution.toolPolicy.allowedTools).not.toContain('computer_use');
    expect(p.selection.preferredTools).not.toContain('computer_use');
    expect(getStoredDesktopExecutionPreference('other-desktop-owner')).toBe('internal');
    expect(pipeline('Create a document report', { userId: 'other-desktop-owner', desktopExecutionPreference: 'external' }).dispatch.flow.workSurfaceRoute.artifactFirst).toBe(true);
  });
  it('keeps an exact recovered application target but removes the conflicting UIA-only ban in external execution', async () => {
    await saveStoredDesktopExecutionPreference(userId, 'external');
    const p = pipeline('在这里面新建一个空白文档并写入：Lumi端到端回归测试。', { continuationAppTarget: 'WPS Office' });
    expect(p.dispatch.flow.currentAppEditTarget).toBe('WPS Office');
    expect(p.execution.toolPolicy.forbiddenTools).not.toContain('computer_use');
    expect(p.selection.preferredTools[0]).toBe('computer_use');
    expect(p.execution.promptOverlay).not.toContain('Never repeat the same New/Blank');
    expect(p.dispatch.flow.workSurfaceRoute.promptOverlay).toContain('(WPS Office)');
    const guard = { taskText: '在这里面新建一个空白文档并写入：测试。', toolName: 'computer_use', arguments: { task: '在 WPS 输入测试' }, currentAppTarget: 'WPS Office' };
    expect(guardCurrentAppToolCall(guard).allowed).toBe(false);
    expect(guardCurrentAppToolCall({ ...guard, desktopExecutionPreference: 'external' }).allowed).toBe(true);
  });
  it.each(['chat', 'voice'] as const)('keeps external vision in the actual %s manifest and keeps Feishu/remote desktop forbidden', async channel => {
    const registry = new ToolRegistry(); registerAllTools(registry);
    await saveStoredDesktopExecutionPreference(userId, 'external');
    const input = { dispatch: { userId, channel, source: channel, operationMode: 'assistant', text: 'Create a document report' }, registry,
      personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 10 } };
    const p = buildLumiExecutionPipeline(input);
    expect(p.modelToolProjection.toolNames).toContain('computer_use');
    expect(p.capabilityPlan.preferredTools[0]).toBe('computer_use');
    expect(p.authorizationPolicy.forbiddenTools).not.toContain('computer_use');
    const remote = buildLumiExecutionPipeline({ ...input, executionBoundary: 'remote_restricted', dispatch: { ...input.dispatch, source: 'feishu' } });
    expect(remote.modelToolProjection.toolNames).not.toContain('computer_use');
    expect(remote.authorizationPolicy.allowedTools).not.toContain('desktop_open');
    expect(remote.capabilityPlan.preferredTools).not.toContain('computer_use');
  });
  it.each(['internal', 'external'] as const)('the real tool batch obtains %s preference from its server context owner', async preference => {
    await saveStoredDesktopExecutionPreference(userId, preference);
    const registry = new ToolRegistry(), handler = vi.fn(async () => '{"ok":true}');
    registry.register({ name: 'computer_use', description: 'Offline adapter fixture', permission: 'user', securityLevel: 'safe', parameters: { type: 'object', properties: {} }, handler });
    const task = '在这里面新建一个空白文档并写入：测试。';
    const loop = prepareToolLoop([{ role: 'user', content: task }], registry, { provider: 'openai', model: 'offline-fixture' }, {}, undefined, 1, undefined, {
      userId, authenticated: true, localExecution: true, userConfirmed: true, currentTurnExecutionRequested: true, currentAppTarget: 'WPS', routedTaskText: task,
      toolPolicy: { allowedTools: ['computer_use'], forbiddenTools: [], requireConfirmation: [], maxIterations: 1 },
    });
    expect(loop.state).toBeDefined();
    await executePlannedToolBatch(loop.state!, { normalizedToolCalls: [{ id: 'mode-guard-fixture', name: 'computer_use', arguments: { task: '输入测试', desktopExecutionPreference: preference === 'internal' ? 'external' : 'internal' } }], exposedToolNames: new Set(['computer_use']), response: { text: '', toolCalls: [] } });
    expect(handler).toHaveBeenCalledTimes(preference === 'external' ? 1 : 0);
    if (preference === 'internal') expect(loop.state!.executionLog[0].error).toContain('disabled for current-app editing');
  });
});
