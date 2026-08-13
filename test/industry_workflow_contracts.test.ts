import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_VARIANT } from '../shared/product_variant';
import {
  getIndustryWorkflowContract,
  getIndustryWorkflowContracts,
} from '../server/industry/workflow_contracts';
import {
  getIndustryWorkflowTask,
  recordIndustryWorkflowExecution,
  startIndustryWorkflow,
} from '../server/industry/workflow_service';
import { readDB } from '../db_layer';
import { updateWorkTakeoverTask } from '../server/work_takeover/tasks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

const EXPECTED_ENTRY_IDS: Record<string, string[]> = {
  ecommerce: ['today-operations', 'trend-discovery', 'store-data', 'listing-automation', 'ai-customer-service'],
  design: ['project', 'cad', 'visualization', 'presentation', 'handoff'],
  legal: ['workspace', 'packet', 'contract-review', 'research', 'asset-trace', 'verify', 'bid'],
  finance: ['business-dashboard', 'invoice-tax', 'accounting', 'tax-filing', 'cash-risk', 'report-delivery'],
};

describe('industry workflow contracts', () => {
  it('exposes only the exact result entries for the current product line', () => {
    const contracts = getIndustryWorkflowContracts(PRODUCT_VARIANT.productLine);
    expect(contracts.map(contract => contract.entryId)).toEqual(EXPECTED_ENTRY_IDS[PRODUCT_VARIANT.productLine]);
    expect(new Set(contracts.map(contract => contract.entryId)).size).toBe(contracts.length);
    expect(contracts.every(contract => contract.confirmationBoundaries.length > 0)).toBe(true);
    expect(contracts.every(contract => contract.requiredArtifactLabels.length > 0)).toBe(true);
  });

  it('keeps file-mandatory design and finance outputs explicit', () => {
    for (const entryId of ['cad', 'visualization', 'presentation', 'handoff']) {
      const contract = getIndustryWorkflowContract('design', entryId);
      expect(contract?.requiresFileArtifact).toBe(true);
      expect(contract?.acceptedFileExtensions.length).toBeGreaterThan(0);
    }
    for (const entryId of ['tax-filing', 'report-delivery']) {
      const contract = getIndustryWorkflowContract('finance', entryId);
      expect(contract?.requiresFileArtifact).toBe(true);
      expect(contract?.acceptedFileExtensions.length).toBeGreaterThan(0);
    }
  });

  it('creates a linked persistent takeover task and action-ledger task without storing raw input', () => {
    const userId = 'industry_contract_start_user';
    const rawInput = 'PRIVATE_SOURCE_VALUE_4417 sales report for the current period';
    const started = startIndustryWorkflow({
      userId,
      domain: 'personal',
      orgId: '',
      entryId: EXPECTED_ENTRY_IDS[PRODUCT_VARIANT.productLine][0],
      sourceInput: rawInput,
      source: 'contract_test',
    });

    expect(started.task.id).toMatch(/^wt_task_/);
    expect(started.conversationTaskId).toBe(`industry_${started.task.id}`);
    expect(started.handoffPrompt).toContain(started.task.id);
    expect(started.task.summary).not.toContain('PRIVATE_SOURCE_VALUE_4417');
    expect(started.task.metadata.industryWorkflow.inputDigest).toMatch(/^[a-f0-9]{64}$/);

    const db = readDB();
    const actionTask = db.conversationActionTasks.find((task: any) => task.id === started.conversationTaskId);
    expect(actionTask).toMatchObject({
      userId,
      conversationId: started.conversationId,
      status: 'executing',
      target: `${PRODUCT_VARIANT.productLine}:${started.contract.entryId}`,
    });
    expect(JSON.stringify(actionTask)).not.toContain('PRIVATE_SOURCE_VALUE_4417');
  });

  it('rejects entries from another product and cross-user task access', () => {
    expect(() => startIndustryWorkflow({
      userId: 'industry_wrong_entry_user',
      domain: 'personal',
      orgId: '',
      entryId: 'not-an-entry',
    })).toThrow(/not available/i);

    const started = startIndustryWorkflow({
      userId: 'industry_owner_user',
      domain: 'personal',
      orgId: '',
      entryId: EXPECTED_ENTRY_IDS[PRODUCT_VARIANT.productLine][0],
    });
    expect(getIndustryWorkflowTask({ userId: 'industry_other_user', domain: 'personal', orgId: '' }, started.task.id)).toBeNull();
  });

  it('does not count planned artifacts or model narration as verified delivery', () => {
    const started = startIndustryWorkflow({
      userId: 'industry_planned_artifact_user',
      domain: 'personal',
      orgId: '',
      entryId: EXPECTED_ENTRY_IDS[PRODUCT_VARIANT.productLine][0],
      sourceInput: 'source records are ready',
    });
    const recorded = recordIndustryWorkflowExecution({
      userId: 'industry_planned_artifact_user',
      domain: 'personal',
      orgId: '',
      taskId: started.task.id,
      resultText: 'Everything is complete.',
      source: 'contract_test',
    });

    expect(recorded.verification.passed).toBe(false);
    expect(recorded.task.status).not.toBe('delivered');
    expect(recorded.verification.checks.find(check => check.id === 'artifact_content_quality')?.passed).toBe(false);
    const db = readDB();
    const actionTask = db.conversationActionTasks.find((task: any) => task.id === started.conversationTaskId);
    expect(actionTask.status).toBe('blocked');
    expect(db.conversationActionReceipts.some((receipt: any) => (
      receipt.taskId === started.conversationTaskId && receipt.outcome === 'verified_success'
    ))).toBe(false);
  });

  it('settles the linked action ledger only after the canonical verification tool passes', async () => {
    const userId = 'industry_canonical_verifier_user';
    const entryId = EXPECTED_ENTRY_IDS[PRODUCT_VARIANT.productLine][0];
    const contract = getIndustryWorkflowContract(PRODUCT_VARIANT.productLine, entryId)!;
    const started = startIndustryWorkflow({
      userId,
      domain: 'personal',
      orgId: '',
      entryId,
      sourceInput: 'A scoped source record is ready for a reviewable result.',
    });
    const content = [
      ...contract.expectedContentTerms,
      'The source scope, material facts, current status, risks, review notes and next actions are archived for human review.',
    ].join(' ');
    updateWorkTakeoverTask(userId, started.task.id, {
      result: content,
      artifact: {
        type: 'document',
        label: contract.requiredArtifactLabels[0],
        content,
        status: 'prepared',
      },
    });

    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerWorkTakeoverTools } = await import('../server/tools/definitions/work_takeover_tools');
    const registry = new ToolRegistry();
    registerWorkTakeoverTools(registry);
    const raw = await registry.execute('work_takeover_task_verify_result', {
      id: started.task.id,
      requireScreenEvidence: false,
      requireExternalOutcome: false,
      requiredArtifactLabels: contract.requiredArtifactLabels,
      expectedContentTerms: contract.expectedContentTerms,
      minMatchedContentTerms: 1,
    }, {
      userId,
      domain: 'personal',
      orgId: '',
    } as any);
    const result = JSON.parse(raw);
    expect(result.verification.passed).toBe(true);
    expect(result.task.status).toBe('delivered');

    const db = readDB();
    const actionTask = db.conversationActionTasks.find((task: any) => task.id === started.conversationTaskId);
    expect(actionTask.status).toBe('completed');
    expect(db.conversationActionReceipts.some((receipt: any) => (
      receipt.taskId === started.conversationTaskId && receipt.outcome === 'verified_success'
    ))).toBe(true);
  });

  it('requires a real accepted file for file-mandatory workflows', () => {
    if (!['design', 'finance', 'legal'].includes(PRODUCT_VARIANT.productLine)) return;
    const entryId = PRODUCT_VARIANT.productLine === 'design'
      ? 'presentation'
      : PRODUCT_VARIANT.productLine === 'finance'
        ? 'report-delivery'
        : 'packet';
    const started = startIndustryWorkflow({
      userId: 'industry_file_gate_user',
      domain: 'personal',
      orgId: '',
      entryId,
      sourceInput: 'Create a reviewable delivery with sources, period, risks, and approval notes.',
    });

    const missing = recordIndustryWorkflowExecution({
      userId: 'industry_file_gate_user',
      domain: 'personal',
      orgId: '',
      taskId: started.task.id,
      resultText: 'The requested file has been created and verified.',
    });
    expect(missing.verification.passed).toBe(false);
    expect(missing.task.status).toBe('blocked');

    const extension = PRODUCT_VARIANT.productLine === 'design' ? '.pptx' : '.pdf';
    const filePath = path.join(os.tmpdir(), `lumi-industry-${Date.now()}${extension}`);
    fs.writeFileSync(filePath, Buffer.alloc(128, 7));
    try {
      const recorded = recordIndustryWorkflowExecution({
        userId: 'industry_file_gate_user',
        domain: 'personal',
        orgId: '',
        taskId: started.task.id,
        resultText: PRODUCT_VARIANT.productLine === 'design'
          ? 'Proposal storyline, layout, material, implementation, PPT and review notes are archived.'
          : PRODUCT_VARIANT.productLine === 'finance'
            ? 'Statement period, currency, source differences and review notes are archived.'
            : 'Case facts, evidence, legal authority, risk and lawyer review notes are archived.',
        filePaths: [filePath],
      });
      expect(recorded.archivedFilePaths).toContain(filePath);
      expect(recorded.verification.checks.find(check => check.id === 'files_exist')?.passed).toBe(true);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});
