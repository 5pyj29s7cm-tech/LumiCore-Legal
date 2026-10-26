import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sourceFixture from './fixtures/legal_property_source_live_20261021.json';
import { mcpManager } from '../server/mcp/client';
import { searchCompany } from '../server/legal/sources';

vi.mock('../server/config/keys', () => ({ getKey: vi.fn(() => '') }));
vi.mock('../server/mcp/client', () => ({ mcpManager: { callToolForServer: vi.fn() } }));

const registration = sourceFixture.sources.find(source => source.queryType === 'registration')!;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const syntheticName = '虚构字段映射主体';

beforeEach(() => {
  for (const key of ['QICHACHA_API_KEY', 'QICHACHA_APP_KEY', 'QICHACHA_SECRET_KEY', 'QICHACHA_BASE_URL', 'TIANYANCHA_API_KEY', 'QIXINBAO_API_KEY']) vi.stubEnv(key, '');
  vi.stubEnv('QICHACHA_API_KEY', 'synthetic-offline-mapping-key');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External HTTP forbidden in mapping fixture'); }));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('company source field preservation', () => {
  it('preserves source-provided registration details through the actual MCP mapper without changing the original text', async () => {
    const raw = JSON.parse(registration.text);
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(registration.text);
    const company = await searchCompany(raw['企业名称']);
    expect(company).toMatchObject({
      name: raw['企业名称'], registeredCapital: raw['注册资本'],
      paidInCapital: raw['实缴资本'], enterpriseType: raw['企业类型'], registrationAuthority: raw['登记机关'],
      sourceMode: 'mcp', sourceTool: 'get_company_registration_info',
      sourceEndpoint: 'https://agent.qcc.com/mcp/company/stream', queriedAt: '2026-01-02T03:04:05.000Z',
      sourceText: registration.text,
    });
    expect(sha(company!.sourceText!)).toBe(registration.sourceTextSha256);
    expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, '0元', '7.50万港元'])('preserves an actual paid-in value and its unit (%s), independently of registered capital', async paidIn => {
    const original = JSON.stringify({ 企业名称: syntheticName, 注册资本: '100万元', 实缴资本: paidIn });
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(original);
    const company = await searchCompany(syntheticName);
    expect(company).toMatchObject({ registeredCapital: '100万元', paidInCapital: String(paidIn), sourceText: original });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps unavailable details absent instead of copying registered capital or inventing zero', async () => {
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(JSON.stringify({ 企业名称: syntheticName, 注册资本: '100万元' }));
    const company = await searchCompany(syntheticName);
    expect(company).not.toHaveProperty('paidInCapital');
    expect(company).not.toHaveProperty('enterpriseType');
    expect(company).not.toHaveProperty('registrationAuthority');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not guess new provider aliases for fields not present in the actual source contract', async () => {
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(JSON.stringify({
      企业名称: syntheticName, paidInCapital: 'invented alias', enterpriseType: 'invented alias', registrationAuthority: 'invented alias',
    }));
    const company = await searchCompany(syntheticName);
    expect(company).not.toHaveProperty('paidInCapital');
    expect(company).not.toHaveProperty('enterpriseType');
    expect(company).not.toHaveProperty('registrationAuthority');
  });

  it('retains the existing Result first-row selection while preserving the selected company details', async () => {
    vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(JSON.stringify({ Result: [
      { 企业名称: syntheticName, 实缴资本: '3万元', 企业类型: '第一主体类型', 登记机关: '第一主体机关' },
      { 企业名称: '另一主体', 实缴资本: '999万元', 企业类型: '另一主体类型', 登记机关: '另一主体机关' },
    ] }));
    const company = await searchCompany(syntheticName);
    expect(company).toMatchObject({ name: syntheticName, paidInCapital: '3万元', enterpriseType: '第一主体类型', registrationAuthority: '第一主体机关' });
    expect(company?.name).not.toBe('另一主体');
  });
});
