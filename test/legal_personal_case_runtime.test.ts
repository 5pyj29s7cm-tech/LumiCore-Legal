import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import * as LegalCases from '../server/org/legal_cases';
import { bindIndustryWorkspaceContext } from '../server/industry/workspace_context';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

describe('personal legal case runtime continuity', () => {
  it('upserts one exact client case and resolves it from an empty-argument legal status call', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = `legal_runtime_${suffix}`;
    const orgId = `personal:${userId}`;
    const caseId = `case_runtime_${suffix}`;
    const snapshot = {
      id: caseId,
      title: '矩衡律师版验收案',
      caseNumber: '（2026）验收字001号',
      party: '甲公司（原告）；乙公司（被告）',
      cause: '买卖合同纠纷',
      court: '',
      judge: '',
      stage: 'consultation' as const,
      hearingDate: '',
      judgmentDate: '',
      appealDeadline: '',
      enforcementDeadline: '',
      notes: '甲公司已经履行交付义务，乙公司尚欠货款35万元。',
      materials: [{
        id: `material_${suffix}`,
        type: 'evidence' as const,
        title: '合同与签收材料',
        content: '现有合同、订单、签收单、发票、银行流水和催款聊天记录。',
        source: 'manual' as const,
        createdAt: new Date().toISOString(),
        createdBy: userId,
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    LegalCases.upsertCaseSnapshot(orgId, userId, snapshot);
    LegalCases.upsertCaseSnapshot(orgId, userId, { ...snapshot, notes: `${snapshot.notes} 待核对诉讼时效。` });
    expect(LegalCases.listCases(orgId, '矩衡律师版验收案', 10, userId)).toHaveLength(1);

    bindIndustryWorkspaceContext({ userId, domain: 'personal', orgId: '' }, {
      name: snapshot.title,
      attributes: {
        caseId,
        caseName: snapshot.title,
        caseNumber: snapshot.caseNumber,
        clientName: snapshot.party,
        stage: snapshot.stage,
      },
    });

    const registry = new ToolRegistry();
    registerLegalTools(registry);
    const result = await registry.execute('legal_case_workflow_status', {}, {
      userId,
      domain: 'personal',
      orgId: '',
    } as any);
    expect(result).toContain('矩衡律师版验收案 案件闭环状态');
    expect(result).toContain(caseId);
    expect(result).toContain('尚欠货款35万元');
    expect(result).toContain('合同与签收材料');
    expect(result).toContain('证据缺口');
  });
});
