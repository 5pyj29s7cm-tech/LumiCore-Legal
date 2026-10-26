import { describe, expect, it } from 'vitest';
import { mapQichachaCompanyRegistration, pickQichachaResult } from '../shared/legal_company_info';
import sourceFixture from './fixtures/legal_property_source_live_20261021.json';

const savedRegistration = JSON.parse(sourceFixture.sources.find(source => source.queryType === 'registration')!.text);

describe('shared QCC registration projection', () => {
  it('projects the saved official object without mutating it or dropping its supplied capital unit', () => {
    const original = JSON.stringify(savedRegistration);
    const projected = mapQichachaCompanyRegistration(Object.freeze(savedRegistration));
    expect(projected).toMatchObject({
      name: savedRegistration['企业名称'], legalPerson: savedRegistration['法定代表人'],
      registeredCapital: savedRegistration['注册资本'], paidInCapital: savedRegistration['实缴资本'],
      enterpriseType: savedRegistration['企业类型'], registrationAuthority: savedRegistration['登记机关'],
      status: savedRegistration['登记状态'], establishDate: savedRegistration['成立日期'],
      unifiedCode: savedRegistration['统一社会信用代码'], address: savedRegistration['注册地址'],
      businessScope: savedRegistration['经营范围'],
    });
    expect(JSON.stringify(savedRegistration)).toBe(original);
  });

  it.each([
    (first: unknown, second: unknown) => ({ Result: [first, second] }),
    (first: unknown, second: unknown) => ({ result: [first, second] }),
    (first: unknown, second: unknown) => ({ Data: [first, second] }),
    (first: unknown, second: unknown) => ({ data: [first, second] }),
    (first: unknown, second: unknown) => ({ Result: { Result: [first, second] } }),
    (first: unknown, second: unknown) => ({ data: { Items: [first, second] } }),
    (first: unknown, second: unknown) => ({ data: { items: [first, second] } }),
  ])('retains the existing first-result selection without borrowing another company’s fields (%#)', wrap => {
    const first = { 企业名称: '第一主体', 注册资本: '3万元' };
    const other = { 企业名称: '另一主体', 实缴资本: '900万元', 企业类型: '其他类型', 登记机关: '其他机关' };
    const selected = pickQichachaResult(wrap(first, other));
    expect(selected).toBe(first);
    const projected = mapQichachaCompanyRegistration(selected);
    expect(projected?.name).toBe(first['企业名称']);
    expect(projected).not.toHaveProperty('paidInCapital');
    expect(projected).not.toHaveProperty('enterpriseType');
    expect(projected).not.toHaveProperty('registrationAuthority');
  });

  it('keeps direct objects and the existing basic-field aliases unchanged', () => {
    const raw = { Name: '别名主体', OperName: '代表', RegistCapi: '12万元', Status: '存续', StartDate: '2020-01-02', CreditCode: 'SYNTHETIC-CREDIT', Address: '虚构地址', Scope: '虚构业务' };
    expect(pickQichachaResult(raw)).toBe(raw);
    expect(mapQichachaCompanyRegistration(raw)).toEqual({
      name: raw.Name, legalPerson: raw.OperName, registeredCapital: raw.RegistCapi, status: raw.Status,
      establishDate: raw.StartDate, unifiedCode: raw.CreditCode, address: raw.Address, businessScope: raw.Scope,
    });
  });

  it('does not manufacture zero or textual values for absent, blank or non-scalar new details', () => {
    for (const value of [undefined, null, '', '  ', false, {}, []]) {
      const projected = mapQichachaCompanyRegistration({ 企业名称: '虚构主体', 注册资本: '100万元', 实缴资本: value, 企业类型: value, 登记机关: value });
      expect(projected).not.toHaveProperty('paidInCapital');
      expect(projected).not.toHaveProperty('enterpriseType');
      expect(projected).not.toHaveProperty('registrationAuthority');
    }
    expect(mapQichachaCompanyRegistration({ 企业名称: '虚构主体', 实缴资本: 0 })?.paidInCapital).toBe('0');
  });

  it('does not mistake receipt status or unrelated prose for an enterprise registration object', () => {
    expect(mapQichachaCompanyRegistration({ status: 'observed', subject: '请求主体', queryType: 'registration' })).toBeNull();
    expect(mapQichachaCompanyRegistration('企业名称：正文中的另一主体')).toBeNull();
    expect(mapQichachaCompanyRegistration(null)).toBeNull();
  });
});
