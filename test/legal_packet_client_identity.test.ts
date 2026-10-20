import { buildEvidenceReviewRows } from '../server/regions/packs/cn/legal_tools/case_workflow';
import { describe, expect, it } from 'vitest';
import { buildLitigationPacketDrafts } from '../server/regions/packs/cn/legal_tools/litigation_drafts';

const parties = '模拟甲公司/模拟乙公司';
const caseArgs = Object.freeze({ caseName: '虚构委托身份回归', caseType: '买卖合同纠纷', parties,
  facts: '双方各自主张仍待原件核对。', evidence: '虚构合同和付款记录。', claims: '仅核对模板字段映射。',
  stage: '咨询', lawFirmName: '虚构律所', lawyerName: '虚构律师' });
const principalPending = '［委托人名称及身份待确认］';
function draft(role: '原告' | '被告' | '通用', name: string, args: Record<string, unknown> = caseArgs) {
  const result = buildLitigationPacketDrafts(args, role, buildEvidenceReviewRows(args)).find(item => item.baseName === name);
  expect(result, name).toBeDefined();
  return result!.markdown;
}

describe('litigation packet principal identity boundary', () => {
  it.each([
    ['原告', '12', '10_civil-complaint'],
    ['被告', '24', '20_statement-of-defense'],
  ] as const)('%s keeps the opposing-party summary out of principal fields', (role, prefix, pleading) => {
    const engagement = draft(role, prefix + '_engagement-agreement');
    const power = draft(role, prefix + '_power-of-attorney');
    expect(engagement).toContain('- 甲方/委托人：' + principalPending);
    expect(power).toContain('委托人：' + principalPending);
    expect(engagement).not.toContain('- 甲方/委托人：' + parties);
    expect(power).not.toContain('委托人：' + parties);
    expect(draft(role, pleading)).toContain('## 当事人\n' + parties);
    expect(engagement).toContain('- 乙方：虚构律所');
    expect(power).toContain('受托人：虚构律师，虚构律所律师。');
    expect(engagement).toContain('- 代理阶段：［一审/二审/执行/再审/其他，待勾选］');
    expect(power).toContain('- 授权期限：［起止日期或至本代理阶段终结，待确认］');
  });

  it('keeps a specific service-address confirmer pending instead of naming both opponents', () => {
    const address = draft('原告', '15_service-address-confirmation');
    expect(address).toContain('- 当事人：［确认送达地址的当事人待确认］');
    expect(address).not.toContain('- 当事人：' + parties);
    expect(address).toContain('- 收件人：［待填写］');
    expect(address).toContain('- 送达地址及邮编：［待填写］');
  });

  it('does not turn a sole party summary plus procedural role into verified instructions', () => {
    const soleParty = { ...caseArgs, parties: '模拟甲公司' };
    expect(draft('原告', '12_power-of-attorney', soleParty)).toContain('委托人：' + principalPending);
    expect(draft('原告', '10_civil-complaint', soleParty)).toContain('## 当事人\n模拟甲公司');
  });

  it('keeps both authorization branches unconfirmed in a general packet', () => {
    for (const prefix of ['12', '24']) {
      expect(draft('通用', prefix + '_engagement-agreement')).toContain('- 甲方/委托人：' + principalPending);
      expect(draft('通用', prefix + '_power-of-attorney')).toContain('委托人：' + principalPending);
    }
    expect(caseArgs.parties).toBe(parties);
  });
});
