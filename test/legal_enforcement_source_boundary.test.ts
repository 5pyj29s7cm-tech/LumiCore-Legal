import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { getDataDirectory } from '../server/config/data_path';
import { searchEnforcementRecords, type CompanyInfo } from '../server/legal/sources';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';

const fixtures = vi.hoisted(() => ({ searchCompany: vi.fn() }));
vi.mock('../server/legal/sources', async importOriginal => ({
  ...await importOriginal<typeof import('../server/legal/sources')>(),
  searchCompany: fixtures.searchCompany,
}));

let cleanup = () => {};
let registerLegalTools: (registry: ToolRegistry) => void;
beforeAll(async () => {
  const app = await makeApp();
  cleanup = app.cleanup;
  ({ registerLegalTools } = await import('../server/tools/definitions/legal_tools'));
});
afterAll(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  fixtures.searchCompany.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this regression'); }));
});
afterEach(() => vi.unstubAllGlobals());

async function trace(name: string) {
  const registry = new ToolRegistry();
  registerLegalTools(registry);
  return executeToolCall({
    registry, name: 'legal_trace_assets',
    arguments: { name, orgId: 'enforcement-source-boundary', userId: 'vitest', persistCase: false },
  });
}

describe('enforcement sources require authorized webpage evidence', () => {
  it('rejects missing evidence instead of returning a stale cached empty result or fetching the old website', async () => {
    const name = 'Cached empty enforcement fixture';
    const cacheDir = getDataDirectory('legal_cache');
    const cacheName = 'zhixing_' + Buffer.from(name).toString('base64').replace(/[/+=]/g, '_').slice(0, 80) + '.json';
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, cacheName);
    fs.writeFileSync(cached, '[]');
    const modifiedAt = fs.statSync(cached).mtimeMs;
    await expect(searchEnforcementRecords(name)).rejects.toThrow(/authorized webpage.*empty result/i);
    expect(fs.readFileSync(cached, 'utf8')).toBe('[]');
    expect(fs.statSync(cached).mtimeMs).toBe(modifiedAt);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a missing enforcement source partial through the registered tool and terminal verification', async () => {
    const record = await trace('验收主体');
    expect(record.result).toContain('查询状态: 待补来源');
    expect(record.result).toContain('数据状态: 待补来源');
    expect(record.result).toContain('已取得来源记录: 0');
    expect(record.result).toContain('公开执行来源未取得（待授权网页核验）');
    expect(record.result).not.toContain('被执行记录: 0 条');
    expect(record.result).not.toContain('zhixing.court.gov.cn');
    expect(record.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(record.terminalVerification?.status).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves verified enterprise evidence without completing the separate enforcement query', async () => {
    const company: CompanyInfo = {
      name: '验收企业', legalPerson: '甲', registeredCapital: '100万元', status: '存续',
      establishDate: '2020-01-01', unifiedCode: 'TEST-VERIFIED-CODE', address: '测试地址',
      businessScope: '测试业务', shareholders: [{ name: '甲', ratio: 100, type: '自然人' }],
      branches: [], riskInfo: { enforcementCount: 2, dishonestyCount: 3, restrictionsCount: 4 },
      url: 'https://example.invalid/verified-company', sourceMode: 'api',
      sourceName: '已核验企业 API 来源', queriedAt: '2026-10-13T00:00:00Z',
    };
    fixtures.searchCompany.mockResolvedValue(company);
    const record = await trace(company.name);
    expect(record.result).toContain('名称: 验收企业');
    expect(record.result).toContain('统一社会信用代码: TEST-VERIFIED-CODE');
    expect(record.result).toContain('被执行记录: 2 条');
    expect(record.result).toContain('查询来源: 已核验企业 API 来源');
    expect(record.result).toContain('已取得来源记录: 1');
    expect(record.result).toContain('数据状态: 待补来源');
    expect(record.result).toContain('公开执行查询尚未完成');
    expect(record.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(record.terminalVerification?.status).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
  });
});
