import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_VARIANT } from '../shared/product_variant';
import { getIndustryWorkflowContracts } from '../server/industry/workflow_contracts';
import {
  getIndustryWorkflowTask,
  reconcileInterruptedIndustryWorkflowTasks,
  startIndustryWorkflow,
} from '../server/industry/workflow_service';
import { readDB, writeDB } from '../db_layer';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});
describe('interrupted industry workflow reconciliation', () => {
  it('aligns a stale active industry task with its blocked persistent conversation task without replay', () => {
    const contract = getIndustryWorkflowContracts(PRODUCT_VARIANT.productLine)[0];
    const userId = `industry_reconcile_${PRODUCT_VARIANT.productLine}`;
    const started = startIndustryWorkflow({
      userId,
      domain: 'personal',
      orgId: '',
      entryId: contract.entryId,
      sourceInput: 'Interrupted reconciliation test input.',
    });
    const db = readDB();
    const actionTask = db.conversationActionTasks.find((task: any) => task.id === started.conversationTaskId);
    actionTask.status = 'blocked';
    actionTask.blocker = 'The previous runtime ended before this task reached a terminal receipt.';
    writeDB(db);

    expect(reconcileInterruptedIndustryWorkflowTasks()).toBeGreaterThanOrEqual(1);
    expect(getIndustryWorkflowTask({ userId, domain: 'personal', orgId: '' }, started.task.id)).toMatchObject({
      status: 'blocked',
      blockedBy: [expect.stringContaining('previous runtime ended')],
    });
  });
});
