import { describe, expect, it } from 'vitest';
import { PRODUCT_VARIANT } from '../shared/product_variant';
import { selectNonDefaultVariantSkillsToDisable } from '../server/runtime/product_variant_skills';

describe('product variant skill baseline', () => {
  it('disables inherited built-in domain skills without touching edition defaults or external connectors', () => {
    const configured: any = {
      'cad-drafting': { enabled: true, source: 'local' },
      'design-studio-pack': { enabled: true, source: 'local' },
      'ecommerce-ops': { enabled: true, source: 'local' },
      'legal-casework': { enabled: true, source: 'local' },
      'finance-office': { enabled: true, source: 'local' },
      'data-bi': { enabled: true, source: 'local' },
      'executive-ops': { enabled: true, source: 'local' },
      stockbot: { enabled: true, source: 'external' },
    };

    const disabled = selectNonDefaultVariantSkillsToDisable(
      configured,
      PRODUCT_VARIANT.runtime.defaultSkills,
    );
    expect(disabled).not.toContain('stockbot');
    for (const retained of PRODUCT_VARIANT.runtime.defaultSkills) expect(disabled).not.toContain(retained);
    expect(disabled.length).toBeGreaterThan(0);
  });
});
