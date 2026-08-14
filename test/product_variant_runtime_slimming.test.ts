import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_VARIANT } from '../shared/product_variant';
import { ToolRegistry } from '../server/tools/registry';
import {
  registerAllTools,
  registerProductVariantTools,
} from '../server/tools/definitions';

const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

function toolNames(register: (registry: ToolRegistry) => void): string[] {
  const registry = new ToolRegistry();
  register(registry);
  return registry.list().map(tool => tool.name);
}

describe('product variant runtime slimming', () => {
  it('boots the edition registry instead of the unrestricted core registry', () => {
    const runtimeNames = toolNames(registerProductVariantTools);
    const fullNames = toolNames(registerAllTools);
    expect(runtimeNames.length).toBeLessThan(fullNames.length);
    expect(new Set(runtimeNames).size).toBe(runtimeNames.length);

    for (const required of [
      'client_get_state',
      'model_configuration_get',
      'computer_use',
      'industry_capability_profile_get',
      'industry_workflow_start',
      'industry_workflow_complete',
      'work_takeover_task_create',
      'external_ai_collaborate',
    ]) {
      expect(runtimeNames).toContain(required);
    }

    expect(runtimeNames).not.toContain('git_status');
    expect(runtimeNames).not.toContain('git_commit');
  });

  it('keeps only the domain-heavy families needed by this edition', () => {
    const names = toolNames(registerProductVariantTools);
    if (PRODUCT_VARIANT.productLine === 'design') {
      expect(names).toContain('cad_draw_floorplan_in_autocad');
      expect(names).toContain('python_exec');
      expect(names).not.toContain('legal_review_contract');
    } else if (PRODUCT_VARIANT.productLine === 'legal') {
      expect(names).toContain('legal_review_contract');
      expect(names).toContain('legal_verify_citation');
      expect(names).not.toContain('python_exec');
      expect(names).not.toContain('cad_draw_floorplan_in_autocad');
    } else if (PRODUCT_VARIANT.productLine === 'finance') {
      expect(names).toContain('python_exec');
      expect(names).toContain('authority_research');
      expect(names).not.toContain('legal_review_contract');
      expect(names).not.toContain('cad_draw_floorplan_in_autocad');
    } else {
      throw new Error(`Unexpected product line: ${PRODUCT_VARIANT.productLine}`);
    }
  });

  it('prevents natural-language auto-install from silently expanding the edition', () => {
    const bootstrap = read('server/runtime/bootstrap.ts');
    const autoInstaller = read('server/agents/auto_installer.ts');
    expect(bootstrap).toContain('registerProductVariantTools(toolRegistry');
    expect(bootstrap).not.toContain('registerAllTools(toolRegistry');
    expect(autoInstaller).toContain('PRODUCT_VARIANT.runtime.defaultSkills.includes(dirName)');
    expect(PRODUCT_VARIANT.runtime.defaultSkills.length).toBeGreaterThan(0);
    expect(PRODUCT_VARIANT.runtime.defaultSkills.length).toBeLessThanOrEqual(3);
  });
});
