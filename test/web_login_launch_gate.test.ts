import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { getDataPath } from '../server/config/data_path';
import { buildDesktopExecutionPlan } from '../server/desktop/execution_plan';
import { DesktopExecutionTracker } from '../server/desktop/execution_runtime';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { registerWebLoginTools } from '../server/tools/definitions/web_login_tools';
import { listWebLoginProfiles } from '../server/web_login/manager';
const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright-core', () => ({ chromium: { launchPersistentContext: (...args: unknown[]) => mocks.launch(...args) } }));
const originalExecutable = process.env.LUMI_BROWSER_EXECUTABLE;
beforeAll(async () => {
  await initDatabase();
  const executable = getDataPath('synthetic-launch-browser');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'not executed');
  process.env.LUMI_BROWSER_EXECUTABLE = executable;
});
afterAll(() => { if (originalExecutable === undefined) delete process.env.LUMI_BROWSER_EXECUTABLE; else process.env.LUMI_BROWSER_EXECUTABLE = originalExecutable; });
beforeEach(() => { mocks.launch.mockReset(); mocks.launch.mockRejectedValue(new Error('synthetic browser launch reached')); });
function tracker(id: string) {
  return new DesktopExecutionTracker(buildDesktopExecutionPlan({ text: 'Open the authorized browser login session', lane: 'desktop_control', taskId: id }));
}
function registry() { const value = new ToolRegistry(); registerWebLoginTools(value); return value; }
describe('managed website login uses the existing launch gate', () => {
  it('reaches the real run handler without a pre-existing foreground observation and does not authorize later raw input', async () => {
    const desktopExecutionTracker = tracker('login-run');
    const context = { userId: 'launch-gate-personal', domain: 'personal', userConfirmed: true, desktopExecutionTracker };
    const record = await executeToolCall({ registry: registry(), name: 'web_login_run', arguments: { profileId: 'china-judgments-online', headless: false, autoSubmit: false }, context });
    expect(record.error).toContain('synthetic browser launch reached');
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(listWebLoginProfiles(context)).toHaveLength(1);
    expect(desktopExecutionTracker.authorize('desktop_keyboard_type').allowed).toBe(false);
    expect(desktopExecutionTracker.authorize('desktop_open').allowed).toBe(true);
  });
  it('also permits the registered managed-site learning launch, retaining the real handler', async () => {
    const record = await executeToolCall({ registry: registry(), name: 'web_login_learn_site', arguments: { url: 'https://example.com/login', headless: false, autoSubmit: false }, context: { userId: 'launch-learn-personal', domain: 'personal', userConfirmed: true, desktopExecutionTracker: tracker('login-learn') } });
    expect(record.error).toContain('synthetic browser launch reached');
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });
  it('uses registered family metadata rather than the run tool name', async () => {
    const value = registry();
    const original = value.get('web_login_run')!;
    value.register({ ...original, name: 'managed_session_start' });
    const record = await executeToolCall({ registry: value, name: 'managed_session_start', arguments: { profileId: 'china-judgments-online', headless: false, autoSubmit: false }, context: { userId: 'launch-renamed-personal', domain: 'personal', userConfirmed: true, desktopExecutionTracker: tracker('renamed-login') } });
    expect(record.error).toContain('synthetic browser launch reached');
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });
  it.each(['other_family', 'external_state_change', 'external_communication'])('does not exempt %s from foreground and commit authority', async (variant) => {
    const value = registry();
    const original = value.get('web_login_run')!;
    const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'logged_in', loginState: 'authenticated' }));
    value.register({ ...original, name: 'managed_sensitive_action', handler, capability: { ...original.capability!, family: variant === 'other_family' ? 'other_family' : 'web_login', sideEffects: [...original.capability!.sideEffects, ...(variant === 'other_family' ? [] : [{ type: variant as 'external_state_change' | 'external_communication', scope: 'synthetic commit', reversible: false }])] } });
    const record = await executeToolCall({ registry: value, name: 'managed_sensitive_action', arguments: {}, context: { userId: 'launch-negative-personal', domain: 'personal', userConfirmed: true, desktopExecutionTracker: tracker(variant) } });
    expect(record.error).toMatch(/fresh observation|certified application identity/);
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
