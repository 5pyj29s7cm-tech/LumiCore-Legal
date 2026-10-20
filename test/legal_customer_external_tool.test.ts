import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
    const desktop = ['src/components/desktop/state/use_desktop_capture_and_identity.tsx', 'src/components/desktop/desktop_grid_view.tsx'].map(file => fs.readFileSync(path.join(process.cwd(), file), 'utf8')).join('\n');
    const copy = fs.readFileSync(path.join(process.cwd(), 'src/i18n/regions/cn/legal.ts'), 'utf8');
    expect(desktop).toContain('id: AIVID_EXTERNAL_TOOL.id');
    expect(desktop).toContain('externalUrl: AIVID_EXTERNAL_TOOL.url');
    expect(desktop).toContain('openExternalToolUrl(def.externalUrl)');
    expect(copy).toContain("comicDramaCreation: '一镜AI漫剧'");
    expect(desktop).not.toContain("windowId: 'aivid-comic-drama'");
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
