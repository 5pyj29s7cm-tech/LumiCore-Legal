import { invoke, isTauri } from '@tauri-apps/api/core';

export const AIVID_EXTERNAL_TOOL = Object.freeze({
  id: 'aivid-comic-drama',
  url: 'https://aivid.cn/',
});

type ExternalToolLauncherOptions = {
  tauri?: boolean;
  invokeCommand?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  browserOpen?: (url: string, target?: string, features?: string) => unknown;
};

export function normalizeExternalToolUrl(value: string): string {
  const parsed = new URL(String(value || '').trim());
  if (parsed.protocol !== 'https:') {
    throw new Error('External customer tools must use HTTPS.');
  }
  return parsed.href;
}

/**
 * Open a customer-provided web tool outside the Lumi WebView. This preserves
 * the client surface even when the third-party page redirects or fails.
 */
export async function openExternalToolUrl(
  value: string,
  options: ExternalToolLauncherOptions = {},
): Promise<void> {
  const url = normalizeExternalToolUrl(value);
  const tauri = options.tauri ?? isTauri();

  if (tauri) {
    const invokeCommand = options.invokeCommand ?? invoke;
    await invokeCommand('plugin:shell|open', { path: url });
    return;
  }

  const browserOpen = options.browserOpen
    ?? (typeof window === 'undefined' ? undefined : window.open.bind(window));
  if (!browserOpen) throw new Error('No external browser opener is available.');
  browserOpen(url, '_blank', 'noopener,noreferrer');
}
