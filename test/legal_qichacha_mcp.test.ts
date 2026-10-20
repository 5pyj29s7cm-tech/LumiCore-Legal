import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { mcpManager } from '../server/mcp/client';
import { searchCompanySources, listLegalSourceCapabilities, queryQichachaMcp, QICHACHA_QUERY_TOOLS, searchLegalAuthorityDatabase } from '../server/legal/sources';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { createCase, getCase, legalWorkspaceNamespace } from '../server/org/legal_cases';
const raw = JSON.stringify({企业名称:'虚构MCP验收企业',统一社会信用代码:'SYNTHETIC-ID',法定代表人:'虚构某',登记状态:'存续',成立日期:'2024-01-02',注册资本:'10万元',注册地址:'虚构地址',经营范围:'仅用于程序验收。MCP-SOURCE-TAIL'});
let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry(), userId = 'qcc-mcp-fixture-owner';
const context = { userId, domain:'personal', authenticated:true, authRole:'user' } as any;
const keys = ['QICHACHA_API_KEY','QICHACHA_APP_KEY','QICHACHA_SECRET_KEY','QICHACHA_BASE_URL','TIANYANCHA_API_KEY','QIXINBAO_API_KEY','PKULAW_API_KEY','FARUI_API_KEY'];
beforeAll(async()=>{app=await makeApp();registerLegalTools(registry);});afterAll(()=>app.cleanup());
beforeEach(()=>{for(const key of keys)vi.stubEnv(key,'');vi.stubEnv('QICHACHA_API_KEY','fixture-mcp-only');vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('No network in offline fixture');}));vi.spyOn(mcpManager,'callToolForServer').mockResolvedValue(raw);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
const run = (args: Record<string,unknown>) => executeToolCall({registry,name:'legal_company_database_lookup',arguments:{name:'虚构MCP验收企业',sourceIds:['qichacha'],...args},context});
describe('Qichacha official MCP uses the existing legal query and lifecycle',()=>{
 it('uses the single saved MCP key and exact official Chinese registration record',async()=>{
  const result=await searchCompanySources('虚构MCP验收企业',['qichacha']);
  expect(result).toHaveLength(1);expect(result[0]).toMatchObject({name:'虚构MCP验收企业',legalPerson:'虚构某',unifiedCode:'SYNTHETIC-ID',registeredCapital:'10万元',sourceMode:'mcp',sourceText:raw,sourceTool:'get_company_registration_info',riskInfo:{enforcementCount:null,dishonestyCount:null,restrictionsCount:null}});
  expect(mcpManager.callToolForServer).toHaveBeenCalledExactlyOnceWith('qcc-company','get_company_registration_info',{searchKey:'虚构MCP验收企业'},expect.objectContaining({configuration:expect.objectContaining({url:'https://agent.qcc.com/mcp/company/stream',headers:{Authorization:'Bearer fixture-mcp-only'}})}));
  expect(listLegalSourceCapabilities().find(s=>s.id==='qichacha')).toMatchObject({configured:true,canAutoQuery:true});expect(fetch).not.toHaveBeenCalled();
 });
 it.each(Object.entries(QICHACHA_QUERY_TOOLS || {}))('calls only the explicitly requested %s tool',async(kind,target)=>{
  await queryQichachaMcp('虚构唯一主体',kind as keyof typeof QICHACHA_QUERY_TOOLS);
  expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);expect(mcpManager.callToolForServer).toHaveBeenCalledWith('qcc-'+target[0],target[1],{searchKey:'虚构唯一主体'},expect.objectContaining({configuration:expect.objectContaining({url:'https://agent.qcc.com/mcp/'+target[0]+'/stream'})}));expect(fetch).not.toHaveBeenCalled();
 });
 it('never falls back to the old signed API or another query when MCP fails',async()=>{
  vi.stubEnv('QICHACHA_APP_KEY','legacy-app');vi.stubEnv('QICHACHA_SECRET_KEY','legacy-secret');vi.mocked(mcpManager.callToolForServer).mockRejectedValueOnce(Error('controlled unauthorized'));
  await expect(searchCompanySources('虚构失败企业',['qichacha'])).rejects.toThrow('[QCC_AUTHORIZATION]');expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);expect(fetch).not.toHaveBeenCalled();
 });
 it('keeps the legacy API a separate explicitly configured product',async()=>{
  vi.stubEnv('QICHACHA_API_KEY','');vi.stubEnv('QICHACHA_APP_KEY','legacy-app');vi.stubEnv('QICHACHA_SECRET_KEY','legacy-secret');vi.stubEnv('QICHACHA_BASE_URL','https://old-product.invalid');
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({Status:'200',Result:{Name:'虚构旧版企业'}}),{status:200}));
  expect((await searchCompanySources('虚构旧版企业',['qichacha']))[0].sourceMode).toBe('api');expect(mcpManager.callToolForServer).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1);
 });
 it.each([{},[],{error:{message:'unknown'}},{code:403,message:'unauthorized'},{Status:'403',Message:'Denied'}])('keeps unreadable/error MCP data partial without adding a material: %j',async payload=>{
  vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(JSON.stringify(payload));const item=createCase(legalWorkspaceNamespace(userId),userId,{title:'虚构失败主体'});
  const result=await run({caseId:item.id,persistCase:true});expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(getCase(item.orgId,item.id,userId)!.materials).toHaveLength(0);expect(getCase(item.orgId,item.id,userId)!.workflowRuns?.at(-1)).toMatchObject({ok:false,status:'partial'});expect(fetch).not.toHaveBeenCalled();
 });
 it('archives one real requested raw receipt with full time/source and does not perform a basic lookup first',async()=>{
  const text=JSON.stringify({企业名称:'虚构MCP验收企业',风险提示:[{原文:'仅为虚构风险原句。RISK-TAIL'}]});vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(text);const item=createCase(legalWorkspaceNamespace(userId),userId,{title:'虚构风险单次'});
  const result=await run({caseId:item.id,queryType:'risk',persistCase:true});expect(result.receipt).toMatchObject({ok:true,status:'observed',persisted:true});expect(result.result).toContain(text);expect(result.result).toContain('get_company_risk_scan');expect(result.result).toContain('https://agent.qcc.com/mcp/risk/stream');expect(result.result).toMatch(/查询时间：\d{4}-\d{2}-\d{2}T/);expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);expect(getCase(item.orgId,item.id,userId)!.materials).toHaveLength(1);expect(result.result).not.toContain('实际控制人:');
 });
 it('does not copy a caller-provided endpoint or configuration into the manager',async()=>{
  await run({queryType:'registration',configuration:{enabled:true,url:'https://attacker.invalid',headers:{Authorization:'bad'}},baseUrl:'https://attacker.invalid',persistCase:false});
  expect(vi.mocked(mcpManager.callToolForServer).mock.calls[0][3]?.configuration?.url).toBe('https://agent.qcc.com/mcp/company/stream');
 });
 it.each(['unknown','__proto__'])('rejects an unsupported explicit query scope %s without a network query',async queryType=>{const result=await run({queryType,persistCase:false});expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(mcpManager.callToolForServer).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();});
 it.each(['case','law'] as const)('uses a selected Qichacha %s lane only on the existing authority lookup',async type=>{
  const payload={items:[{案例标题:'虚构类案检索候选',法规名称:'虚构法源候选',摘要:'仅为检索候选，不是核准法律。',summary:'FULL-EXCERPT-TAIL'}]};
  vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(JSON.stringify(payload));
  const result=await executeToolCall({registry,name:'legal_search_external_authorities',arguments:{query:'虚构检索',type,sourceIds:['qichacha'],persistCase:false},context});
  expect(result.receipt).toMatchObject({ok:true,status:'observed',persisted:false});
  expect(result.result).toContain('FULL-EXCERPT-TAIL'); expect(result.result).toContain(type==='case'?'get_judicial_case_search':'get_legal_regulation_search');
  expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);expect(vi.mocked(mcpManager.callToolForServer).mock.calls[0][0]).toBe(type==='case'?'qcc-case':'qcc-regulation');expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects a pre-cancelled request before any query and never archives a late result after cancellation',async()=>{
  const item=createCase(legalWorkspaceNamespace(userId),userId,{title:'虚构取消查询'}),controller=new AbortController();controller.abort();
  const cancelled=await executeToolCall({registry,name:'legal_company_database_lookup',arguments:{name:'虚构主体',caseId:item.id,sourceIds:['qichacha']},context:{...context,executionSignal:controller.signal}});
  expect(cancelled.terminalVerification?.status).not.toBe('verified');expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
  const liveController=new AbortController();let release!:(value:string)=>void;vi.mocked(mcpManager.callToolForServer).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const pending=executeToolCall({registry,name:'legal_company_database_lookup',arguments:{name:'虚构主体',caseId:item.id,sourceIds:['qichacha']},context:{...context,executionSignal:liveController.signal}});
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));liveController.abort();release(raw);const late=await pending;
  expect(late.terminalVerification?.status).not.toBe('verified');expect(getCase(item.orgId,item.id,userId)!.materials).toHaveLength(0);expect(mcpManager.callToolForServer).toHaveBeenCalledTimes(1);
 });
 it.each(['pkulaw','farui','national-law-regulations'])('blocks every selected external authority source %s in local-only and strict modes',async sourceId=>{
  vi.stubEnv('PKULAW_API_KEY','fixture-law-key');vi.stubEnv('PKULAW_BASE_URL','https://law-source.invalid');
  vi.stubEnv('FARUI_API_KEY','fixture-farui-key');vi.stubEnv('FARUI_BASE_URL','https://farui-source.invalid');
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({items:[{title:'虚构返回候选'}]}),{status:200}));
  const args={query:'虚构查询',type:'law' as const,sourceIds:[sourceId],includeOfficialWeb:true};
  await expect(searchLegalAuthorityDatabase({...args,localOnly:true})).rejects.toThrow('local-only');
  vi.stubEnv('LUMI_PRIVACY','strict');await expect(searchLegalAuthorityDatabase({...args,localOnly:false})).rejects.toThrow('local-only');
  expect(fetch).not.toHaveBeenCalled();expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
 });
 it('retains a selected non-QCC authorized source in standard mode',async()=>{
  vi.stubEnv('PKULAW_API_KEY','fixture-law-key');vi.stubEnv('PKULAW_BASE_URL','https://law-source.invalid');
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({items:[{title:'虚构标准模式法源',summary:'仅原文候选'}]}),{status:200}));
  expect((await searchLegalAuthorityDatabase({query:'standard-'+Date.now(),type:'law',sourceIds:['pkulaw'],localOnly:false}))[0].title).toBe('虚构标准模式法源');
  expect(fetch).toHaveBeenCalledTimes(1);expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
 });
 it('blocks strict and explicit local-only requests before MCP or HTTP dispatch',async()=>{
  await expect(searchCompanySources('虚构主体',['qichacha'],{localOnly:true})).rejects.toThrow('local-only');expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
  vi.stubEnv('LUMI_PRIVACY','strict');await expect(queryQichachaMcp('虚构主体','risk')).rejects.toThrow('local-only');expect(mcpManager.callToolForServer).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 });
});
