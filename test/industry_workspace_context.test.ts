import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerIndustryWorkflowTools } from '../server/tools/definitions/industry_workflow_tools';
import { getIndustryWorkflowContracts } from '../server/industry/workflow_contracts';
import { PRODUCT_VARIANT } from '../shared/product_variant';
import { executeToolCall } from '../server/tools/execution_engine';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

describe('industry workspace context continuity', () => {
  it('verifies an empty but successfully observed workspace list', async () => {
    const registry = new ToolRegistry();
    registerIndustryWorkflowTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'industry_workspace_status',
      arguments: {},
      context: {
        userId: `empty_workspace_${PRODUCT_VARIANT.productLine}_${Date.now()}`,
        domain: 'personal',
        orgId: '',
      },
    });
    expect(record.error).toBeUndefined();
    expect(record.terminalVerification).toMatchObject({ status: 'verified', strategy: 'terminal_receipt' });
  });

  it('binds one edition-specific business subject and inherits it into voice/chat workflows', async () => {
    const registry = new ToolRegistry();
    registerIndustryWorkflowTools(registry);
    const userId = `industry_subject_${PRODUCT_VARIANT.productLine}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const context = { userId, domain: 'personal' as const, source: 'voice', actionIntent: 'continue current business work' } as any;
    const fields: Record<string, Record<string, string>> = {
      ecommerce: { name: 'North store', platform: 'douyin', storeId: 'store-001', reportingPeriod: '2026-08' },
      legal: { name: 'Zhang contract case', caseId: 'case-001', caseNumber: '(2026) test 1', court: 'Test Court' },
      finance: { name: 'North company', entityName: 'North company', taxpayerId: 'tax-001', accountingPeriod: '2026-08', jurisdiction: 'CN' },
    };
    const bound = JSON.parse(await registry.execute('industry_workspace_bind', fields[PRODUCT_VARIANT.productLine], context));
    expect(bound).toMatchObject({ ok: true, persisted: true });
    expect(bound.active.productLine).toBe(PRODUCT_VARIANT.productLine);

    const status = JSON.parse(await registry.execute('industry_workspace_status', {}, context));
    expect(status.active.id).toBe(bound.active.id);
    expect(status.available.some((item: any) => item.id === bound.active.id)).toBe(true);

    const entry = getIndustryWorkflowContracts(PRODUCT_VARIANT.productLine)[0];
    const started = JSON.parse(await registry.execute('industry_workflow_start', { entryId: entry.entryId }, context));
    expect(started.task.metadata.industryWorkflow.context.industryWorkspace).toMatchObject({
      id: bound.active.id,
      name: bound.active.name,
    });
    expect(started.handoffPrompt).toContain(bound.active.id);

    const isolated = JSON.parse(await registry.execute('industry_workspace_status', {}, {
      ...context,
      userId: `${userId}_other`,
    }));
    expect(isolated.active).toBeNull();
  });
});
