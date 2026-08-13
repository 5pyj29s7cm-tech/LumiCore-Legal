import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCT_VARIANT } from '../shared/product_variant';

describe('legal product identity', () => {
  it('keeps installer, runtime, and data identities isolated from main Lumi OS', () => {
    const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const dataPath = fs.readFileSync('server/config/data_path.ts', 'utf8');
    expect(PRODUCT_VARIANT.runtime.productName).toBe('Lumi Legal');
    expect(PRODUCT_VARIANT.runtime.dataDirectoryName).toBe('LumiOS-Legal');
    expect(tauri).toMatchObject({ productName: 'Lumi Legal', identifier: 'com.lumiai.legal' });
    expect(dataPath).toContain('PRODUCT_VARIANT.runtime.dataDirectoryName');
  });
});
