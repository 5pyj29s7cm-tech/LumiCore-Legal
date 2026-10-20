import { makeApp } from './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { addMaterial, createCase, getCase, legalWorkspaceNamespace } from '../server/org/legal_cases';
import { createOrg, addMember } from '../server/org/db';
import { setOrganizationResourcePolicy } from '../server/org/resource_acl';
let cleanup=()=>{};
const owner='external-archive-fixture-owner';
const sourceKeys=['QICHACHA_APP_KEY','QICHACHA_API_KEY','QICHACHA_SECRET_KEY','QICHACHA_BASE_URL','TIANYANCHA_API_KEY','TIANYANCHA_BASE_URL','QIXINBAO_API_KEY','QIXINBAO_BASE_URL','PKULAW_API_KEY','PKULAW_TOKEN','PKULAW_BASE_URL','FARUI_API_KEY','FARUI_BASE_URL'];
const registry=new ToolRegistry();
beforeAll(async()=>{const app=await makeApp();cleanup=app.cleanup;registerLegalTools(registry);});
afterAll(()=>cleanup());
beforeEach(()=>{for(const key of sourceKeys)vi.stubEnv(key,'');vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('No external network in fixture');}));});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
function fixture(orgId=legalWorkspaceNamespace(owner)){
 const item=createCase(orgId,owner,{title:'Synthetic external source case',notes:'USER FACTS MUST STAY'});
 addMaterial(orgId,owner,item.id,{title:'User original',content:'USER ORIGINAL TAIL',type:'evidence',source:'manual'});
 return getCase(orgId,item.id,owner)!;
}
function run(name:string,item:ReturnType<typeof fixture>,extra:Record<string,unknown>={},actor=owner,domain='personal'){
 return executeToolCall({registry,name,arguments:{caseId:item.id,name:'Synthetic '+item.id,query:'Synthetic query '+item.id,...extra},context:{userId:actor,orgId:domain==='work'?item.orgId:undefined,domain,authenticated:true} as any});
}
describe('registered external query archival uses actual source availability',()=>{
 it.each(['legal_company_database_lookup','legal_search_external_authorities','legal_trace_assets','legal_equity_penetration'])('%s preserves a partial workflow history without adding a missing-source material',async name=>{
  const before=fixture();const result=await run(name,before);const after=getCase(before.orgId,before.id,owner)!;
  expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false,changedCaseIds:[]});
  expect(result.terminalVerification?.status).toBe('failed');expect(after.materials).toEqual(before.materials);expect(after.notes).toBe(before.notes);
  expect(after.workflowRuns?.at(-1)).toMatchObject({tool:name,ok:false,status:'partial',materialIds:[]});
  expect(fetch).not.toHaveBeenCalled();expect(result.result).toContain('未归档');
 });
 it.each(['legal_company_database_lookup','legal_search_external_authorities'])('%s archives exactly once when a real mocked API source exists',async name=>{
  const before=fixture();
  if(name==='legal_company_database_lookup'){
   vi.stubEnv('TIANYANCHA_API_KEY','fixture');vi.stubEnv('TIANYANCHA_BASE_URL','https://company.invalid/api');
   vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({error_code:0,result:{name:'Actual synthetic company',creditCode:'SYNTHETIC-ID'}}),{status:200}));
  }else{
   vi.stubEnv('PKULAW_API_KEY','fixture');vi.stubEnv('PKULAW_BASE_URL','https://law.invalid/api');
   vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({items:[{title:'Actual synthetic judgment',summary:'Source excerpt only, not verified law.',court:'最高人民法院',url:'https://source.invalid/fixture'}]}),{status:200}));
  }
  const result=await run(name,before,{sourceIds:[name==='legal_company_database_lookup'?'tianyancha':'pkulaw']});const after=getCase(before.orgId,before.id,owner)!;
  expect(result.receipt).toMatchObject({ok:true,status:'observed',persisted:true,changedCaseIds:[before.id]});
  expect(after.materials).toHaveLength(before.materials.length+1);expect(after.materials.filter(material=>material.source==='tool')).toHaveLength(1);expect(after.notes).toBe(before.notes);expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('retains observed enterprise data but does not archive the incomplete enforcement report',async()=>{
  const before=fixture();vi.stubEnv('QICHACHA_APP_KEY','fixture');vi.stubEnv('QICHACHA_SECRET_KEY','fixture');vi.stubEnv('QICHACHA_BASE_URL','https://qcc.invalid');
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({Status:'200',Result:{Name:'Observed synthetic company'}}),{status:200}));
  const result=await run('legal_trace_assets',before);expect(result.result).toContain('Observed synthetic company');expect(result.result).toContain('执行来源未取得');
  expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(getCase(before.orgId,before.id,owner)!.materials).toEqual(before.materials);
 });
 it('does not write or query for an unauthorized organization actor',async()=>{
  const org=createOrg('External source ACL fixture','external-acl-'+Date.now(),owner);addMember(org.id,owner,'owner');addMember(org.id,'external-viewer','viewer');const before=fixture(org.id);setOrganizationResourcePolicy({orgId:org.id,actorUserId:owner,resourceType:'legal_case',resourceId:before.id,ownerUserId:owner,classification:'organization'});expect(getCase(org.id,before.id,'external-viewer','write')).toBeNull();
  const result=await run('legal_company_database_lookup',before,{},'external-viewer','work');expect(result.terminalVerification?.status).toBe('failed');
  expect(getCase(org.id,before.id,owner)!.materials).toEqual(before.materials);expect(fetch).not.toHaveBeenCalled();
 });
});

describe('configured legal gateway must return readable source rows',()=>{
 it.each([{}, {items:[{}]}, {error:{code:'NO_DATA',message:'Opaque gateway failure'}}])('does not invent observed sources from HTTP200 %j',async payload=>{
  const before=fixture();vi.stubEnv('PKULAW_API_KEY','fixture');vi.stubEnv('PKULAW_BASE_URL','https://law.invalid/empty');
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(payload),{status:200}));
  const result=await run('legal_search_external_authorities',before,{query:'empty-'+JSON.stringify(payload)+'-'+before.id,sourceIds:['pkulaw']});
  expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});expect(result.result).toContain('未取得可核验来源');
  expect(result.result).not.toContain('北大法宝 result');expect(getCase(before.orgId,before.id,owner)!.materials).toEqual(before.materials);expect(fetch).toHaveBeenCalledTimes(1);
 });
 it.each([{title:'Title-only actual candidate'},{summary:'Summary-only actual candidate'}])('retains supplied readable candidate %j without certifying its applicability',async candidate=>{
  const before=fixture();vi.stubEnv('PKULAW_API_KEY','fixture');vi.stubEnv('PKULAW_BASE_URL','https://law.invalid/readable');
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({items:[candidate]}),{status:200}));
  const result=await run('legal_search_external_authorities',before,{sourceIds:['pkulaw']});
  expect(result.receipt).toMatchObject({ok:true,status:'observed',persisted:true});expect(result.result).toContain(Object.values(candidate)[0]);expect(result.result).toContain('律师复核');
  expect(getCase(before.orgId,before.id,owner)!.materials).toHaveLength(before.materials.length+1);expect(fetch).toHaveBeenCalledTimes(1);
 });
});
