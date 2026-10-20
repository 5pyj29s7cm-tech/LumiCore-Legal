import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { JWT_SECRET, makeApp } from './helpers';
import { mountPreferencesRoutes } from '../server/routes/preferences_routes';
import { getStoredDesktopExecutionPreference, getStoredOperationMode, saveStoredOperationMode } from '../server/cognition/operation_mode_store';
import { ToolRegistry } from '../server/tools/registry';
import { registerClientActionTools } from '../server/tools/definitions/client_action_tools';
import { initMemorySync, registerUserSocket, broadcastPreferenceChange, unregisterUserSocket } from '../server/memory/sync';
import * as db from '../db_layer';
import { extractSourceExpression } from './source_expression';

let cleanup = () => {}, baseUrl = '';
const owner = 'desktop-preference-http-owner';
const headers = (uid = owner) => ({ 'Content-Type': 'application/json', Cookie: `token=${jwt.sign({ uid, username: uid, role: 'user' }, JWT_SECRET)}` });
beforeAll(async () => { const app = await makeApp(); cleanup = app.cleanup; baseUrl = app.url; mountPreferencesRoutes(app.apiRouter, JWT_SECRET); });
afterAll(() => cleanup());
it('uses the existing authenticated preference API, rejects invalid values and cannot choose another owner', async () => {
  expect((await fetch(`${baseUrl}/api/preferences/desktop_execution`)).status).toBe(401);
  expect((await fetch(`${baseUrl}/api/preferences/desktop_execution`, { method: 'PUT', headers: headers(), body: JSON.stringify({ preference: 'wallpaper' }) })).status).toBe(400);
  expect(getStoredDesktopExecutionPreference(owner)).toBe('internal');
  const save = await fetch(`${baseUrl}/api/preferences/desktop_execution`, { method: 'PUT', headers: headers(), body: JSON.stringify({ preference: 'external', userId: 'forged-other-user', domain: 'work', orgId: 'forged-org' }) });
  expect(await save.json()).toEqual({ ok: true, preference: 'external' });
  expect(await (await fetch(`${baseUrl}/api/preferences/desktop_execution`, { headers: headers() })).json()).toEqual({ preference: 'external' });
  expect(getStoredDesktopExecutionPreference('forged-other-user')).toBe('internal');
  expect(getStoredOperationMode(owner)).toBe('assistant');
});
it('keeps meeting state and execution preference independent across both existing settings routes', async () => {
  saveStoredOperationMode(owner, 'meeting');
  const set = await fetch(`${baseUrl}/api/preferences/desktop_execution`, { method: 'PUT', headers: headers(), body: JSON.stringify({ preference: 'internal' }) });
  expect((await set.json()).ok).toBe(true); expect(getStoredOperationMode(owner)).toBe('meeting');
  await fetch(`${baseUrl}/api/preferences/desktop_execution`, { method: 'PUT', headers: headers(), body: JSON.stringify({ preference: 'external' }) });
  await fetch(`${baseUrl}/api/preferences/operation_mode`, { method: 'PUT', headers: headers(), body: JSON.stringify({ mode: 'assistant' }) });
  expect(getStoredDesktopExecutionPreference(owner)).toBe('external');
});
it('rolls back an actual durable write failure and does not broadcast success', async () => {
  const emit = vi.fn(), to = vi.fn(() => ({ emit })); initMemorySync({ to } as any); registerUserSocket(owner, 'owner-connection');
  const flush = vi.spyOn(db, 'flushDBOrThrow').mockRejectedValueOnce(new Error('synthetic disk failure'));
  try {
    const response = await fetch(`${baseUrl}/api/preferences/desktop_execution`, { method: 'PUT', headers: headers(), body: JSON.stringify({ preference: 'internal' }) });
    expect(response.status).toBe(500); expect(getStoredDesktopExecutionPreference(owner)).toBe('external');
    expect(emit).not.toHaveBeenCalled();
  } finally { flush.mockRestore(); unregisterUserSocket('owner-connection'); initMemorySync(null as any); }
});
it('synchronizes only authenticated sockets of the same user across personal and organization displays', () => {
  const emit = vi.fn(), to = vi.fn(() => ({ emit })); initMemorySync({ to } as any);
  registerUserSocket(owner, 'personal-socket'); registerUserSocket(owner, 'work-socket'); registerUserSocket('other-owner', 'other-socket');
  try {
    broadcastPreferenceChange(owner, 'desktop_execution', { preference: 'external' }, { domain: 'work', orgId: 'org-a' });
    expect(to).toHaveBeenCalledExactlyOnceWith(['personal-socket', 'work-socket']);
    expect(emit).toHaveBeenCalledWith('preferences:changed', expect.objectContaining({ userId: owner, key: 'desktop_execution' }));
  } finally { for (const id of ['personal-socket', 'work-socket', 'other-socket']) unregisterUserSocket(id); initMemorySync(null as any); }
});
it('exposes execution preference through the existing client_action schema without wallpaper relay or meeting normalization', async () => {
  const registry = new ToolRegistry(); registerClientActionTools(registry);
  const tool = registry.get('client_action')!;
  expect(tool.parameters.properties.action.enum).toContain('set_desktop_execution_preference');
  saveStoredOperationMode(owner, 'meeting');
  const relay = vi.fn();
  const context = { userId: owner, authenticated: true, authRole: 'admin' as const, localExecution: true, desktopRelay: relay };
  const result = JSON.parse(await registry.execute('client_action', { action: 'set_desktop_execution_preference', preference: 'internal' }, context));
  expect(result).toMatchObject({ ok: true, preference: 'internal', verification: { status: 'verified' } });
  expect(getStoredOperationMode(owner)).toBe('meeting'); expect(relay).not.toHaveBeenCalled();
  await expect(registry.execute('client_action', { action: 'set_desktop_execution_preference', preference: 'external' }, { ...context, autonomous: true })).rejects.toThrow();
});
function setterHarness() {
  const deps: any = { AbortSignal, user: { uid: 'owner' }, uid: 'owner', generation: 0, cancelled: false, normalizeDesktopExecutionPreference: (v: unknown) => v === 'external' ? 'external' : 'internal', authGenerationRef: { current: 0 }, desktopPreferenceWriteTailRef: { current: Promise.resolve() }, desktopPreferenceRequestRef: { current: 0 }, setDesktopPreferenceState: vi.fn(), apiJson: vi.fn(async (_url, init) => ({ ok: true, ...JSON.parse(init.body) })) };
  return { ...deps, set: extractSourceExpression('src/contexts/AppContext.tsx', 'setDesktopExecutionPreference', deps), refresh: extractSourceExpression('src/contexts/AppContext.tsx', 'refresh', deps) };
}
it('waits for an in-flight preference write before a focus/socket refresh can read or supersede its acknowledgement', async () => {
  const h = setterHarness(); let resolve!: (value: any) => void;
  h.apiJson.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce({ preference: 'external' });
  const saving = h.set('external');
  await vi.waitFor(() => expect(h.apiJson).toHaveBeenCalledOnce());
  const refreshing = h.refresh();
  await Promise.resolve(); await Promise.resolve();
  expect(h.apiJson).toHaveBeenCalledOnce();
  resolve({ ok: true, preference: 'external' });
  expect(await saving).toBe(true); await refreshing;
  expect(h.apiJson).toHaveBeenCalledTimes(2);
  expect(h.setDesktopPreferenceState).toHaveBeenLastCalledWith({ userId: 'owner', preference: 'external' });
});
it('orders actual AppContext preference writes and ignores late results and queued writes from a former account', async () => {
  const h = setterHarness(); let resolve!: (value: any) => void;
  h.apiJson.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const first = h.set('external'), queued = h.set('internal');
  await vi.waitFor(() => expect(h.apiJson).toHaveBeenCalledOnce());
  h.authGenerationRef.current++;
  resolve({ ok: true, preference: 'external' });
  expect(await first).toBe(false); expect(await queued).toBe(false);
  expect(h.setDesktopPreferenceState).not.toHaveBeenCalled(); expect(h.apiJson).toHaveBeenCalledOnce();
});
it('publishes only a confirmed preference, retains old state after a rejected save and permits retry', async () => {
  const h = setterHarness(); h.apiJson.mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('offline'));
  expect(await h.set('external')).toBe(false); expect(await h.set('external')).toBe(false);
  expect(h.setDesktopPreferenceState).not.toHaveBeenCalled();
  expect(await h.set('external')).toBe(true);
  expect(h.setDesktopPreferenceState).toHaveBeenCalledExactlyOnceWith({ userId: 'owner', preference: 'external' });
});
