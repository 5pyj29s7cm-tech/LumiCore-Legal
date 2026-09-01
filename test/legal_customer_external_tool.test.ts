import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { matchQuickCommand } from '../server/cognition/quick_commands';
import { getWebLoginSitePreset } from '../server/web_login/legal_presets';
import {
  AIVID_EXTERNAL_TOOL,
  normalizeExternalToolUrl,
  openExternalToolUrl,
} from '../src/lib/externalToolLauncher';

describe('law-firm customer external tool integration', () => {
  it('registers Aivid as a launch-only authorized-session preset', () => {
    expect(AIVID_EXTERNAL_TOOL).toEqual({
      id: 'aivid-comic-drama',
      url: 'https://aivid.cn/',
    });
    expect(getWebLoginSitePreset('aivid-comic-drama')).toMatchObject({
      loginUrl: AIVID_EXTERNAL_TOOL.url,
      matchHosts: ['aivid.cn'],
    });
    expect(getWebLoginSitePreset('aivid-comic-drama')?.notes).toContain('launch and session assistance only');
  });

  it('renders a localized desktop icon without registering a fake internal window', () => {
    const desktop = fs.readFileSync(path.join(process.cwd(), 'src/components/DesktopUI.tsx'), 'utf8');
    const copy = fs.readFileSync(path.join(process.cwd(), 'src/i18n/regions/cn/legal.ts'), 'utf8');
    expect(desktop).toContain('id: AIVID_EXTERNAL_TOOL.id');
    expect(desktop).toContain('externalUrl: AIVID_EXTERNAL_TOOL.url');
    expect(desktop).toContain('openExternalToolUrl(def.externalUrl)');
    expect(copy).toContain("comicDramaCreation: '一镜AI漫剧'");
    expect(desktop).not.toContain("windowId: 'aivid-comic-drama'");
  });

  it('routes a direct open request to the system browser tool', async () => {
    const command = await matchQuickCommand('打开一镜AI漫剧', 'legal-customer-tool');
    expect(command?.toolCall).toEqual({
      name: 'browser_open_task',
      arguments: { url: 'https://aivid.cn/', open: true },
    });
  });

  it('opens HTTPS customer tools through Tauri shell or an external browser', async () => {
    expect(normalizeExternalToolUrl('https://aivid.cn')).toBe('https://aivid.cn/');
    expect(() => normalizeExternalToolUrl('http://aivid.cn')).toThrow(/HTTPS/);

    const invokeCommand = vi.fn(async () => ({}));
    await openExternalToolUrl('https://aivid.cn', { tauri: true, invokeCommand });
    expect(invokeCommand).toHaveBeenCalledWith('plugin:shell|open', { path: 'https://aivid.cn/' });

    const browserOpen = vi.fn();
    await openExternalToolUrl('https://aivid.cn', { tauri: false, browserOpen });
    expect(browserOpen).toHaveBeenCalledWith('https://aivid.cn/', '_blank', 'noopener,noreferrer');
  });
});
