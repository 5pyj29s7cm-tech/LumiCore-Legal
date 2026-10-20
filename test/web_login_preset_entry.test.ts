import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataPath } from '../server/config/data_path';
import { initDatabase } from '../db_layer';
import * as OrgDB from '../server/org/db';
import { ToolRegistry } from '../server/tools/registry';
import { registerWebLoginTools } from '../server/tools/definitions/web_login_tools';
import { listWebLoginProfiles, runWebLogin, saveWebLoginProfile } from '../server/web_login/manager';
const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright-core', () => ({ chromium: { launchPersistentContext: (...args: unknown[]) => mocks.launch(...args) } }));
const originalExecutable = process.env.LUMI_BROWSER_EXECUTABLE;
const preset = 'china-judgments-online';
const owner = 'preset-org-owner', viewer = 'preset-org-viewer';
let orgId = '';
beforeAll(async () => {
  await initDatabase();
  const executable = getDataPath('synthetic-browser-executable'); fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, 'not executed'); process.env.LUMI_BROWSER_EXECUTABLE = executable;
  const org = OrgDB.createOrg('Synthetic preset scope', 'preset-entry-scope', owner); orgId = org.id;
  OrgDB.addMember(orgId, owner, 'owner'); OrgDB.addMember(orgId, viewer, 'viewer');
});
afterAll(() => { if (originalExecutable === undefined) delete process.env.LUMI_BROWSER_EXECUTABLE; else process.env.LUMI_BROWSER_EXECUTABLE = originalExecutable; });
beforeEach(() => { mocks.launch.mockReset(); mocks.launch.mockRejectedValue(new Error('synthetic browser boundary reached')); });
function registry() { const value = new ToolRegistry(); registerWebLoginTools(value); return value; }
describe('existing web-login preset first-use entry', () => {
  it('materializes a missing known preset without credentials in the personal caller scope', async () => {
    const scope = { userId: 'preset-new-personal', domain: 'personal' };
    await expect(runWebLogin({ profileId: preset, headless: false, autoSubmit: false }, scope)).rejects.toThrow('synthetic browser boundary reached');
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    const profiles = listWebLoginProfiles(scope); expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ id: preset, ownerUid: scope.userId, domain: 'personal', orgId: '', hasPassword: false, username: '' });
    expect(new URL(profiles[0].loginUrl).hostname).toBe('wenshu.court.gov.cn');
  });
  it('fails an unknown profile without writing or starting a browser', async () => {
    const scope = { userId: 'preset-unknown-personal', domain: 'personal' };
    await expect(runWebLogin({ profileId: 'unknown-not-a-preset' }, scope)).rejects.toThrow(/not found|No matching web login profile/);
    expect(listWebLoginProfiles(scope)).toEqual([]); expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('does not borrow an unknown custom profile or credentials from another personal owner or organization', async () => {
    saveWebLoginProfile({ id: 'private-cross-scope', loginUrl: 'https://example.com/login', username: 'not-for-another-scope' }, { userId: owner, domain: 'work', orgId: 'separate-cross-org' });
    const scope = { userId: 'preset-cross-personal', domain: 'personal' };
    await expect(runWebLogin({ profileId: 'private-cross-scope' }, scope)).rejects.toThrow(/not found|No matching web login profile/);
    expect(listWebLoginProfiles(scope)).toEqual([]); expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('does not let a shared-profile viewer create a preset on first use', async () => {
    const scope = { userId: viewer, domain: 'work', orgId, userConfirmed: true };
    await expect(registry().execute('web_login_run', { profileId: preset, headless: false, autoSubmit: false }, scope)).rejects.toThrow(/owner or administrator/);
    expect(listWebLoginProfiles(scope)).toEqual([]); expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('allows the organization owner to initialize and a viewer to reuse the same shared preset', async () => {
    const own = { userId: owner, domain: 'work', orgId, userConfirmed: true };
    await expect(registry().execute('web_login_run', { profileId: preset, headless: false, autoSubmit: false }, own)).rejects.toThrow('synthetic browser boundary reached');
    expect(listWebLoginProfiles(own)).toHaveLength(1);
    const before = JSON.stringify(listWebLoginProfiles(own)); mocks.launch.mockClear();
    await expect(registry().execute('web_login_run', { profileId: preset, headless: false, autoSubmit: false }, { ...own, userId: viewer })).rejects.toThrow('synthetic browser boundary reached');
    expect(mocks.launch).toHaveBeenCalledTimes(1); expect(JSON.stringify(listWebLoginProfiles(own))).toBe(before);
    expect(listWebLoginProfiles({ userId: viewer, domain: 'personal' })).toEqual([]);
  });
});
