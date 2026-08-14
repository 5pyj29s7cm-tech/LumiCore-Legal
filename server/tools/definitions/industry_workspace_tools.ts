import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { bindIndustryWorkspaceContext, getActiveIndustryWorkspaceContext, listIndustryWorkspaceContexts, selectIndustryWorkspaceContext } from '../../industry/workspace_context';

function scope(context?: ToolContext) {
  return { userId: context?.userId || 'anonymous', domain: context?.domain === 'work' ? 'work' as const : 'personal' as const, orgId: context?.domain === 'work' ? String(context?.orgId || '') : '' };
}

export function registerIndustryWorkspaceTools(registry: ToolRegistry): void {
  registry.register({
    name: 'industry_workspace_status',
    description: 'Read the active persistent business workspace for this exact industry edition: store/account for e-commerce, case for legal, or entity/tax period for finance. Use before interpreting this store, this case, this company, current period, or continue the previous work.',
    // i18n-allow: Reviewed Chinese industry workspace input-recognition phrases; not user-visible copy.
    routingHints: ['current store', 'current case', 'current company', 'current tax period', '当前店铺', '当前案件', '当前企业', '当前账期', '这家店', '这个案件'],
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, context) => { const activeScope = scope(context); return JSON.stringify({ ok: true, status: 'observed', active: getActiveIndustryWorkspaceContext(activeScope), available: listIndustryWorkspaceContexts(activeScope) }, null, 2) },
    permission: 'user', securityLevel: 'safe',
    capability: capabilityContract({ id: 'industry.workspace.observe', family: 'industry', lane: 'industry', operation: 'observe', risk: 'low', sideEffects: [{ type: 'local_read', scope: 'edition-scoped persistent business workspace', reversible: true }], verification: { strategy: 'measured', required: true, requiredFields: ['ok', 'status', 'available'], requiredValues: { ok: true }, successStatuses: ['observed'], successSignals: ['server-owned active workspace state'], limitations: ['An unbound workspace must not be guessed from model memory.'] } }),
    evidence: capabilityEvidence({ id: 'industry.workspace.observe', operation: 'observe', limitations: ['Reads local workspace identity only.'] }),
  });
  registry.register({
    name: 'industry_workspace_bind',
    description: 'Create, update, or select the persistent business workspace used by voice, chat, and industry tasks. Fields are edition-filtered: e-commerce store/platform/account/period, legal case identity, or finance entity/taxpayer/jurisdiction/accounting period.',
    // i18n-allow: Reviewed Chinese industry workspace input-recognition phrases; not user-visible copy.
    routingHints: ['bind store', 'select store', 'bind case', 'select case', 'bind company', 'select company', '绑定店铺', '切换店铺', '设为当前案件', '绑定企业', '切换账期'],
    parameters: { type: 'object', properties: {
      id: { type: 'string' }, name: { type: 'string' }, platform: { type: 'string' }, storeId: { type: 'string' }, accountLabel: { type: 'string' }, reportingPeriod: { type: 'string' }, timezone: { type: 'string' },
      caseId: { type: 'string' }, caseName: { type: 'string' }, caseNumber: { type: 'string' }, clientName: { type: 'string' }, court: { type: 'string' }, stage: { type: 'string' },
      entityName: { type: 'string' }, taxpayerId: { type: 'string' }, jurisdiction: { type: 'string' }, taxpayerType: { type: 'string' }, accountingPeriod: { type: 'string' }, currency: { type: 'string' }, accountingBasis: { type: 'string' },
    }, required: [] },
    handler: async (args, context) => { const activeScope = scope(context); const id = String(args.id || '').trim(); const workspace = id ? selectIndustryWorkspaceContext(activeScope, id) : bindIndustryWorkspaceContext(activeScope, { name: args.name, attributes: args }); return JSON.stringify({ ok: true, status: id ? 'selected' : 'bound', persisted: true, active: workspace }, null, 2) },
    permission: 'user', securityLevel: 'safe',
    capability: capabilityContract({ id: 'industry.workspace.bind', family: 'industry', lane: 'industry', operation: 'mutate', risk: 'low', sideEffects: [{ type: 'local_state_change', scope: 'edition-scoped active business workspace selection', reversible: true }], verification: { strategy: 'state_diff', required: true, requiredFields: ['ok', 'status', 'persisted', 'active.id', 'active.productLine'], requiredValues: { ok: true, persisted: true }, successStatuses: ['bound', 'selected'], successSignals: ['persisted active workspace returned'], limitations: ['Does not log in to or mutate an external business system.'] } }),
    evidence: capabilityEvidence({ id: 'industry.workspace.bind', operation: 'mutate', subjectArgument: 'name', limitations: ['Binds local business identity only.'] }),
  });
}
