import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('Legal desktop shell', () => {
  it('exposes seven legal outcome workspaces on the primary desktop', () => {
    const desktop = read('src/components/DesktopUI.tsx');
    const copy = read('src/i18n/regions/cn/legal.ts');
    for (const id of [
      'legal-workspace',
      'legal-packet',
      'legal-contract-review',
      'legal-research',
      'legal-asset-trace',
      'legal-verify',
      'legal-bid',
    ]) {
      expect(desktop).toContain(`id: '${id}'`);
    }
    for (const label of ['案件工作台', '文书生成', '合同审查', '法条与类案', '财产线索', '交付核验', '标书制作']) {
      expect(copy).toContain(label);
    }
  });

  it('opens the existing LegalHub workspaces instead of a prompt-only placeholder', () => {
    const desktop = read('src/components/DesktopUI.tsx');
    const wrapper = read('src/components/LegalDesktopWorkspace.tsx');
    const hub = read('src/components/org/LegalHub.tsx');
    expect(desktop).toContain('<LegalDesktopWorkspace initialView=');
    expect(wrapper).toContain('<LegalHub');
    expect(hub).toContain('runLegalTool');
    expect(hub).toContain('LegalContractReview');
    expect(hub).toContain('LegalAssetTrace');
  });

  it('keeps every primary outcome mapped to a distinct legal workspace', () => {
    const desktop = read('src/components/DesktopUI.tsx');
    const hub = read('src/components/org/LegalHub.tsx');
    const routes = [
      { windowId: 'legal-packet', view: 'packet', component: 'LegalPacketView' },
      { windowId: 'legal-contract-review', view: 'contract-review', component: 'LegalContractReview' },
      { windowId: 'legal-research', view: 'research', component: 'LegalResearchWorkspace' },
      { windowId: 'legal-asset-trace', view: 'asset-trace', component: 'LegalAssetTrace' },
      { windowId: 'legal-verify', view: 'verify', component: 'LegalVerifyView' },
      { windowId: 'legal-bid', view: 'bid', component: 'LegalBidWorkbench' },
    ];

    expect(desktop).toContain(": 'workspace'");
    expect(hub).toContain("case 'workspace':");
    expect(hub).toContain('<LegalCaseWorkspace');
    for (const route of routes) {
      expect(desktop).toContain(`windowId === '${route.windowId}' ? '${route.view}'`);
      expect(hub).toContain(`case '${route.view}':`);
      expect(hub).toContain(`<${route.component}`);
    }
    expect(new Set(routes.map(route => route.component)).size).toBe(routes.length);
  });
});
