import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { getDataPath } from '../server/config/data_path';

describe('desktop bundle source inputs', () => {
  it('keeps generated platform schemas out of Git while retaining permission inputs', () => {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', windowsHide: true }).trim();
    expect(run('ls-files', 'src-tauri/gen/schemas')).toBe('');
    expect(run('check-ignore', 'src-tauri/gen/schemas/macos-schema.json')).toBe('src-tauri/gen/schemas/macos-schema.json');
    expect(run('ls-files', 'src-tauri/capabilities')).not.toBe('');
  });

  it.skipIf(process.platform !== 'win32')('copies WebView2 without rewriting the reviewed installer hook', async () => {
    const root = getDataPath(`bundle-input-${crypto.randomUUID()}`);
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(root, 'src-tauri/target/release'), { recursive: true });
    await fs.mkdir(path.join(root, 'src-tauri/includes'), { recursive: true });
    await fs.mkdir(path.join(root, 'desktop-resources'), { recursive: true });
    await fs.copyFile('scripts/copy-webview2-dll.mjs', path.join(root, 'scripts/copy-webview2-dll.mjs'));
    const hook = await fs.readFile('src-tauri/includes/include-dll.nsh');
    const hookPath = path.join(root, 'src-tauri/includes/include-dll.nsh');
    await fs.writeFile(hookPath, hook);
    const dll = Buffer.from('synthetic DLL bytes for a file-copy regression');
    await fs.writeFile(path.join(root, 'src-tauri/target/release/WebView2Loader.dll'), dll);
    execFileSync(process.execPath, [path.join(root, 'scripts/copy-webview2-dll.mjs')], { cwd: root, windowsHide: true });
    expect(await fs.readFile(hookPath)).toEqual(hook);
    expect(await fs.readFile(path.join(root, 'desktop-resources/WebView2Loader.dll'))).toEqual(dll);
    await fs.unlink(path.join(root, 'src-tauri/target/release/WebView2Loader.dll'));
    expect(() => execFileSync(process.execPath, [path.join(root, 'scripts/copy-webview2-dll.mjs')], { cwd: root, windowsHide: true, stdio: 'pipe' })).toThrow();
    expect(await fs.readFile(hookPath)).toEqual(hook);
  });
});
