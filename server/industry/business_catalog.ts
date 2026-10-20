import { PRODUCT_VARIANT } from '../../shared/product_variant';
import { getIndustryWorkflowContracts } from './workflow_contracts';
export const BUSINESS_LINES = ['ecommerce', 'finance', 'legal'] as const;
export type BusinessLine = typeof BUSINESS_LINES[number];
export function businessContract(entryId: unknown) {
  return BUSINESS_LINES.flatMap(getIndustryWorkflowContracts).find(item => item.entryId === String(entryId || '')) || null;
}
export function getCurrentIndustryCapabilityProfile() {
  return { variantId: PRODUCT_VARIANT.variantId, productLine: PRODUCT_VARIANT.productLine, entries: getIndustryWorkflowContracts(PRODUCT_VARIANT.productLine).map(contract => ({ ...contract, displayName: contract.title })) };
}
export function matchCurrentIndustryWorkflow(request: unknown) {
  const text = String(request || '').toLowerCase();
  const entry = getCurrentIndustryCapabilityProfile().entries.find(item => text.includes(item.entryId) || text.includes(item.title.toLowerCase()));
  return entry ? { entry, score: 1, matchedTerms: [entry.entryId] } : null;
}
