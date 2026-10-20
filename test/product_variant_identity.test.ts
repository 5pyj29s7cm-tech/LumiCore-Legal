import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_VARIANT } from '../shared/product_variant';
import { productVariantRuntime, resolveVariantDataRoot } from '../scripts/lib/product-variant-runtime.mjs';

describe('legal product identity', () => {
  it('keeps legal UI identity while sharing the canonical backend data root', () => {
    const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    const dataPath = fs.readFileSync('server/config/data_path.ts', 'utf8');
    const localWhisper = fs.readFileSync('server/stt/providers/local-whisper.ts', 'utf8');
    const nativeShell = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
    const nativeBootstrap = fs.readFileSync('src-tauri/src/local_bootstrap.rs', 'utf8');
    const nativeApps = fs.readFileSync('src-tauri/src/native_apps.rs', 'utf8');
    expect(PRODUCT_VARIANT.runtime.productName).toBe('Lumi Legal');
    expect(PRODUCT_VARIANT.runtime.dataDirectoryName).toBe('LumiCore');
    expect(PRODUCT_VARIANT.runtime.legacyDataDirectoryName).toBe('LumiOS');
    expect(tauri).toMatchObject({ productName: 'Lumi Legal', version: packageVersion, identifier: 'com.lumiai.legal' });
    expect(dataPath).toContain('PRODUCT_VARIANT.runtime.dataDirectoryName');
    expect(dataPath).toContain('PRODUCT_VARIANT.runtime.legacyDataDirectoryName');
    expect(localWhisper).toContain('PRODUCT_VARIANT.runtime.legacyDataDirectoryName');
    expect(localWhisper).not.toContain("os.homedir(), 'LumiOS'");
    expect(nativeShell).toContain('const AUTOSTART_VALUE_NAME: &str = "LumiLegal";');
    expect(nativeShell).toContain('const LEGACY_AUTOSTART_VALUE_NAME: &str = "LumiOS-Legal";');
    expect(nativeBootstrap).toContain('home.join(PRODUCT_DATA_DIRECTORY)');
    expect(nativeApps).toContain('.join("LumiCore")');
    expect(nativeApps).toContain('base.join("LumiOS")');
    expect(nativeBootstrap).toContain('const PRODUCT_DATA_DIRECTORY: &str = "LumiCore";');
  });

  it('keeps maintenance tooling and user-facing packaging on the legal identity', () => {
    const runtime = productVariantRuntime();
    const testHome = path.resolve('test-product-home');
    expect(runtime.dataDirectoryName).toBe(PRODUCT_VARIANT.runtime.dataDirectoryName);
    expect(resolveVariantDataRoot('', testHome)).toBe(path.join(testHome, 'LumiCore'));
    expect(() => resolveVariantDataRoot('relative/data-root', testHome)).toThrow(/absolute path/i);

    for (const script of ['scripts/check-sqlite-integrity.mjs', 'scripts/repair-knowledge-filenames.mjs']) {
      expect(fs.readFileSync(script, 'utf8')).toContain('resolveVariantDataRoot');
    }
    const infoPlist = fs.readFileSync('src-tauri/Info.plist', 'utf8');
    expect(infoPlist).toContain('Lumi Legal 需要');
    expect(infoPlist).not.toContain('LumiCore 需要');

    const updaterEndpoints = tauriUpdaterEndpoints();
    expect(updaterEndpoints).toEqual([
      'https://releases.lumiai.asia/lumi-legal/{{target}}/{{arch}}/{{current_version}}',
    ]);
    expect(fs.readFileSync('scripts/deploy-windows.ps1', 'utf8')).toContain('LumiCore\\data');
    expect(fs.readFileSync('scripts/deploy-macos.sh', 'utf8')).toContain('~/LumiCore/data/');
    expect(fs.readFileSync('scripts/deploy-linux.sh', 'utf8')).toContain('~/LumiCore/data/');
  });
});

function tauriUpdaterEndpoints(): string[] {
  const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
    plugins: { updater: { endpoints: string[] } };
  };
  return tauri.plugins.updater.endpoints;
}
