import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('industry settings shell', () => {
  it('layers industry configuration over the complete Lumi settings', () => {
    const shell = source('src/components/IndustrySettings.tsx');
    const desktop = source('src/components/DesktopUI.tsx');
    expect(shell).toContain("import { Settings } from './Settings'");
    expect(shell).toContain('<Settings t={t} lang={lang} setLang={setLang}');
    expect(shell).toContain("activeSection !== 'general'");
    expect(shell).toContain("apiFetch('/api/mcp/health')");
    expect(desktop).toContain("import('./IndustrySettings')");
    expect(desktop).not.toContain('<EcommerceSettings');
  });

  it('uses product metadata instead of replacing the Lumi foundation', () => {
    const shell = source('src/components/IndustrySettings.tsx');
    expect(shell).toContain('PRODUCT_VARIANT.runtime.defaultSkills');
    expect(shell).toContain('PRODUCT_VARIANT.runtime.modules');
    expect(shell).toContain('copy.corePreserved');
  });
});
