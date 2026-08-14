import { readDB, writeDB } from '../../db_layer';
import { PRODUCT_VARIANT } from '../../shared/product_variant';
import { mcpManager } from '../mcp';
import type { MCPServerConfig } from '../mcp/client';

const BUILT_IN_DOMAIN_SKILLS = Object.freeze([
  'cad-drafting',
  'data-bi',
  'design-studio-pack',
  'ecommerce-ops',
  'executive-ops',
  'finance-office',
  'legal-casework',
  'stockbot',
]);

const MIGRATION_KEY = `product_variant_skill_baseline_v1:${PRODUCT_VARIANT.variantId}`;

export function selectNonDefaultVariantSkillsToDisable(
  configured: Record<string, MCPServerConfig>,
  defaults: readonly string[],
): string[] {
  const retained = new Set(defaults);
  return BUILT_IN_DOMAIN_SKILLS.filter(name => {
    const server = configured[name];
    return Boolean(server?.enabled && server.source !== 'external' && !retained.has(name));
  });
}

/**
 * One-time edition migration. It removes inherited built-in domain runtimes,
 * but never touches third-party connectors and never overrides later opt-ins.
 */
export function enforceProductVariantSkillBaseline(): string[] {
  const db = readDB();
  if ((db.settings || []).some((row: any) => row.key === MIGRATION_KEY && row.value === '1')) return [];

  const configured = mcpManager.getConfig();
  const disabled = selectNonDefaultVariantSkillsToDisable(
    configured,
    PRODUCT_VARIANT.runtime.defaultSkills,
  );
  for (const name of disabled) configured[name].enabled = false;
  if (disabled.length > 0) mcpManager.saveConfig(configured);

  if (!Array.isArray(db.settings)) db.settings = [];
  db.settings.push({ key: MIGRATION_KEY, value: '1' });
  writeDB(db);
  return disabled;
}
