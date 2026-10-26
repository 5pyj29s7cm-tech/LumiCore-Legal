import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { readBidRequirementInput } from '../server/regions/packs/cn/legal_tools/documents';
import { decodeToolResult } from '../server/tools/result_envelope';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import { sdkCompletion } from './legal_bid_fixture';
import * as cases from '../server/org/legal_cases';
let app:Awaited<ReturnType<typeof makeApp>>, folder:string;
const registry=new ToolRegistry(),userId='bid-input-closure-owner';
const originals=['R01：仅依原件范围起草，资质和承诺待责任人确认。 FULL-SOURCE-TAIL-A','条目,未税,税额,含税\n虚构服务,240000,14400,254400\n原始说明,数量与税率待确认,不得认定核准, FULL-SOURCE-TAIL-B'];
let filePaths:string[],projectName:string,create:ReturnType<typeof vi.fn>;
const proposal='根据对应原件拟议响应，仅用于内部工作稿；资格、承诺及计算仍待责任人复核，不冒充事实已确认或正式投标。';
const validResponse=(params:any)=>sdkCompletion(params,{choices:[{message:{role:'assistant',content:proposal},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
const context=()=>({userId,domain:'personal',source:'legal-direct-tool',authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',llmGetters:{getRelay:()=>({chat:{completions:{create}}})}} as any);
const run=async(extra:Record<string,any>={})=>decodeToolResult(await registry.execute('legal_generate_bid',{projectName,filePaths,persistCase:false,...extra},context()));
beforeAll(async()=>{app=await makeApp();registerLegalTools(registry);folder=fs.mkdtempSync(path.join(os.tmpdir(),'lumi-bid-input-closure-'));filePaths=[path.join(folder,'requirements.txt'),path.join(folder,'quote.csv')];originals.forEach((text,index)=>fs.writeFileSync(filePaths[index],text));});
afterAll(()=>{fs.rmSync(folder,{recursive:true,force:true});app.cleanup();});
beforeEach(()=>{resetCircuit();vi.stubEnv('LUMI_PRIVACY','standard');projectName='Source-closure-'+crypto.randomUUID();upsertUserPreferredLLM(userId,{provider:'relay',model:'aliyun/deepseek-v4-flash',selectionMode:'pinned',allowCloudFallback:false,fallbackCandidates:[]});create=vi.fn(async params=>validResponse(params));});
afterEach(()=>{vi.unstubAllEnvs();resetCircuit();});
describe('registered bid source failures do not launch known-incomplete work',()=>{
  it('removes explicit realpath duplicates before counting the folder limit',async()=>{
    const input=await readBidRequirementInput({filePaths:[filePaths[0],path.relative(process.cwd(),filePaths[0]),filePaths[1]],folderPath:folder,maxFiles:1});
    expect(input.materials).toHaveLength(2);expect(input.skipped).toEqual([]);for(const original of originals)expect(input.requirements.split(original)).toHaveLength(2);
    const result=await run({folderPath:folder,maxFiles:1});expect(result.receipt).toMatchObject({ok:true,status:'generated'});expect(create).toHaveBeenCalledOnce();
  });
  it.each(['missing','unsupported','folder-limit'])('preserves readable originals but launches no new model calls after %s source failure',async failure=>{
    const orgId=cases.legalWorkspaceNamespace(userId),item=cases.createCase(orgId,userId,{title:'虚构缺源工作稿'});
    const bad=path.join(folder,'not-readable-'+crypto.randomUUID()+(failure==='unsupported'?'.unsupported':'.txt'));if(failure==='unsupported')fs.writeFileSync(bad,'Unsupported source must not be silently ignored.');
    try{const extra=failure==='folder-limit'?{filePaths:[],folderPath:folder,maxFiles:1}:{filePaths:[filePaths[0],bad]};const result=await run({...extra,caseId:item.id,persistCase:true});
      expect(result.receipt).toMatchObject({ok:false,status:'partial'});expect(create).not.toHaveBeenCalled();expect(result.content).toContain('## 未读取材料');expect(result.content).toContain('来源未完整读取');expect(result.content).not.toContain(proposal);
      expect(cases.getCase(orgId,item.id,userId)!.materials.filter(material=>material.source==='tool')).toHaveLength(0);
    }finally{if(fs.existsSync(bad))fs.unlinkSync(bad);}
  });
  it('starts a new generation only after a later request has a fully readable source set',async()=>{
    expect((await run()).receipt).toMatchObject({ok:true,status:'generated'});expect(create).toHaveBeenCalledOnce();create.mockClear();
    const blocked=await run({filePaths:[...filePaths,path.join(folder,'missing-later-source.txt')]});
    expect(blocked.receipt).toMatchObject({ok:false,status:'partial'});expect(create).not.toHaveBeenCalled();expect(blocked.content).not.toContain(proposal);
    const retried=await run();expect(retried.receipt).toMatchObject({ok:true,status:'generated'});expect(create).toHaveBeenCalledOnce();
  });
  it('keeps a real provider failure partial, then retries only on a later user request',async()=>{
    const privateError='PRIVATE_PROVIDER_SERVER_ERROR_NOT_A_DRAFT';create.mockRejectedValue(Object.assign(new Error(privateError),{status:500}));
    const failed=await run({});expect(failed.receipt).toMatchObject({ok:false,status:'partial'});expect(create).toHaveBeenCalledOnce();expect(failed.content).not.toContain(privateError);expect(failed.content).not.toContain(proposal);for(const original of originals)expect(failed.content).toContain(original);
    create.mockClear();create.mockImplementation(async params=>validResponse(params));const resumed=await run();expect(resumed.receipt).toMatchObject({ok:true,status:'generated'});expect(create).toHaveBeenCalledOnce();
  });
});
