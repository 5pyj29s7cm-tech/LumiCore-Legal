import { makeApp } from './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchCompanySources } from '../server/legal/sources';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
let cleanup = () => {};
const sourceKeys = ['QICHACHA_APP_KEY','QICHACHA_API_KEY','QICHACHA_SECRET_KEY','QICHACHA_BASE_URL','TIANYANCHA_API_KEY','TIANYANCHA_BASE_URL','QIXINBAO_API_KEY','QIXINBAO_BASE_URL','PKULAW_API_KEY','PKULAW_BASE_URL','FARUI_API_KEY','FARUI_BASE_URL','TENDER_DATA_API_KEY','TENDER_DATA_BASE_URL'];
const providers = [
  { id: 'qichacha', env: { QICHACHA_APP_KEY:'test', QICHACHA_SECRET_KEY:'test', QICHACHA_BASE_URL:'https://qcc.invalid' }, wrap: (raw: any) => ({ Status:'200', Result:raw }), name: (name: string) => ({ Name:name }) },
  { id: 'tianyancha', env: { TIANYANCHA_API_KEY:'test', TIANYANCHA_BASE_URL:'https://tyc.invalid/api/company' }, wrap: (raw: any) => ({ error_code:0, result:raw }), name: (name: string) => ({ name }) },
  { id: 'qixinbao', env: { QIXINBAO_API_KEY:'test', QIXINBAO_BASE_URL:'https://qxb.invalid' }, wrap: (raw: any) => ({ items:[raw] }), name: (name: string) => ({ companyName:name }) },
];
beforeAll(async () => { const app=await makeApp(); cleanup=app.cleanup; });
afterAll(() => cleanup());
beforeEach(() => { for (const key of sourceKeys) vi.stubEnv(key,''); vi.stubGlobal('fetch',vi.fn(async () => { throw Error('External network forbidden'); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function configure(p: typeof providers[number]) { for(const [k,v] of Object.entries(p.env)) vi.stubEnv(k,v as string); }
async function tool(name: string, args: Record<string, unknown>) { const r=new ToolRegistry();registerLegalTools(r);return executeToolCall({registry:r,name,arguments:{...args,persistCase:false},context:{userId:'external-boundary-user',domain:'personal',authenticated:true} as any}); }
describe('external query truth and absence boundaries', () => {
  it.each(providers)('$id never turns absent risk counts into zero', async p => {
    configure(p); const name=p.id+' missing risks '+Date.now(); vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(p.wrap(p.name(name))),{status:200}));
    const rows=await searchCompanySources(name,[p.id]);expect(rows).toHaveLength(1);expect(rows[0].riskInfo).toEqual({enforcementCount:null,dishonestyCount:null,restrictionsCount:null});
  });
  it.each(providers)('$id preserves source zero and rejects invalid counts', async p => {
    configure(p);const name=p.id+' zero risks '+Date.now();const raw={...p.name(name),EnforcementCount:0,enforcementCount:0,zhixingCount:0,DishonestyCount:'-1',dishonestyCount:'-1',RestrictionsCount:'unknown',restrictionsCount:'unknown'};
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(p.wrap(raw)),{status:200}));const rows=await searchCompanySources(name,[p.id]);expect(rows[0].riskInfo).toEqual({enforcementCount:0,dishonestyCount:null,restrictionsCount:null});
  });
  it.each(providers)('$id does not invent a company from the search keyword when source is empty',async p=> {
    configure(p);vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(p.wrap({})),{status:200}));expect(await searchCompanySources(p.id+' nonexistent '+Date.now(),[p.id])).toEqual([]);
  });
  it('keeps long queries with the same prefix in independent cache entries',async()=> {
    const p=providers[1];configure(p);const prefix='Common shared company prefix '.repeat(8)+Date.now();let calls=0;
    vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify(p.wrap({name:++calls===1?'First actual company':'Second actual company'})),{status:200}));
    expect((await searchCompanySources(prefix+' A',[p.id]))[0].name).toBe('First actual company');expect((await searchCompanySources(prefix+' B',[p.id]))[0].name).toBe('Second actual company');expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    {name:'legal_company_database_lookup',scope:'registration',extra:{}},
    {name:'legal_search_external_authorities',scope:'authorities',extra:{includeOfficialWeb:false}},
    {name:'legal_search_tender_projects',scope:'tender',extra:{}},
    {name:'legal_company_database_lookup',scope:'controller',extra:{queryType:'controller',sourceIds:['qichacha']}},
  ])('$scope retains an incomplete receipt when no source is configured', async ({name,extra})=> {
    const record=await tool(name,{name:'Synthetic no-source company',keyword:'Synthetic no-source project',query:'Synthetic no-source legal query',...extra});expect(record.receipt).toMatchObject({ok:false,status:'partial'});expect(record.terminalVerification?.status).toBe('failed');expect(fetch).not.toHaveBeenCalled();
  });
  it('shows unavailable risks separately from actual zeros in the registered execution report',async()=> {
    const p=providers[0];configure(p);vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(p.wrap({Name:'Synthetic partially observed company',EnforcementCount:0})),{status:200}));
    const record=await tool('legal_trace_assets',{name:'Synthetic partially observed company'});expect(record.result).toContain('被执行记录: 0 条');expect(record.result).toContain('失信记录: 未取得该项来源');expect(record.result).not.toContain('失信记录: 0 条');expect(record.receipt).toMatchObject({ok:false});
  });
});
