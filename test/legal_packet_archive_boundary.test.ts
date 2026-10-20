import { packetDraftFixture } from './legal_packet_fixture';
import { sdkCompletion } from './legal_bid_fixture';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { decodeToolResult } from '../server/tools/result_envelope';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{app=await makeApp();});
afterAll(()=>app.cleanup());
async function setup(mode: 'mixed'|'all'|'none') {
  const cases=await import('../server/org/legal_cases');
  const {registerLegalTools}=await import('../server/tools/definitions/legal_tools');
  const {upsertUserPreferredLLM}=await import('../server/llm/user_preferences');
  const userId='packet-boundary-'+mode+'-'+Math.random().toString(36).slice(2), orgId=cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId,{provider:'relay',model:'official-packet-isolated-test',selectionMode:'pinned'});
  const caseFile=cases.createCase(orgId,userId,{title:'虚构文书包边界验收',party:'虚构甲/虚构乙'});
  const create=vi.fn(async(params:any)=>{
    const prompt=String(params.messages.find((m:any)=>m.role==='user')?.content||'');
    let content='';
    if(prompt.includes('## 当前文书')){
      const target=JSON.parse(prompt.split('## 当前文书\n')[1]);
      if(mode!=='mixed'||target.baseName!=='10_civil-complaint') content=JSON.stringify(packetDraftFixture(prompt, {baseName:target.baseName,markdown:'# '+target.label+'（系统草稿）\n\n根据虚构材料作条件起草，双方主张与付款、交货日期均有待核验。本稿未核准，不直接提交，完整原件和主体资料仍须律师核实。'}));
    }else{
      const documents=JSON.parse(prompt.split('文书列表：')[1]);
      content=JSON.stringify({documents:documents.map((d:any)=>({baseName:d.baseName,complete:true,corrections:[],unresolved:[]}))});
    }
    return sdkCompletion(params, {choices:[{message:{content},finish_reason:'stop'}]});
  });
  const registry=new ToolRegistry();registerLegalTools(registry);
  const outputDir=fs.mkdtempSync(path.join(os.tmpdir(),'legal-packet-boundary-'));
  const args={caseId:caseFile.id,caseName:caseFile.title,role:'原告',parties:'虚构甲/虚构乙',claims:'请求按提供材料核对并履行原合同交付义务。',facts:'虚构事实。INTERNAL_INPUT_ONLY 不应作为无条件附录再次拼入文书。',evidence:'虚构合同复印件\n虚构付款回单',transcript:'UNRELATED_MEETING_TAIL 喂喂喂',outputDir,persistCase:true};
  const context:any={userId,domain:'personal',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',...(mode==='none'?{}:{llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}})};
  return {cases,orgId,userId,caseFile,create,registry,outputDir,args,context};
}
it('keeps a mixed packet out of the case, marks the exact failed row, and preserves the reviewed document and local originals',async()=>{
  const f=await setup('mixed');try{
    const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',f.args,f.context));
    expect(result.receipt).toMatchObject({ok:false,status:'partial',draftMode:'mixed'});
    expect(f.cases.getCase(f.orgId,f.caseFile.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
    const manifest=fs.readFileSync(path.join(f.outputDir,'99_manifest.md'),'utf8');
    expect(manifest.split('\n').find(l=>l.includes('10_civil-complaint.md'))).toContain('正文未完成');
    expect(manifest.split('\n').find(l=>l.includes('11_element-complaint.md'))).toContain('正文未完成');
    expect(fs.readFileSync(path.join(f.outputDir,'10_civil-complaint.md'),'utf8')).toContain('事实与理由');
    const reviewed=fs.readFileSync(path.join(f.outputDir,'16_evidence-catalog.md'),'utf8');
    expect(reviewed).toContain('双方主张与付款、交货日期均有待核验');
    expect(reviewed).not.toMatch(/本次案件材料摘要|INTERNAL_INPUT_ONLY|UNRELATED_MEETING_TAIL/);
    expect(f.create).toHaveBeenCalledTimes(3);
  }finally{fs.rmSync(f.outputDir,{recursive:true,force:true});}
});
it('archives exactly one complete model packet and never appends the entire input to reviewed individual documents',async()=>{
  const f=await setup('all');try{
    const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',f.args,f.context));
    expect(result.receipt).toMatchObject({ok:true,status:'generated',draftMode:'model'});
    expect(f.cases.getCase(f.orgId,f.caseFile.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(1);
    for(const name of ['10_civil-complaint.md','11_element-complaint.md'])expect(fs.readFileSync(path.join(f.outputDir,name),'utf8')).not.toMatch(/本次案件材料摘要|INTERNAL_INPUT_ONLY|UNRELATED_MEETING_TAIL/);
    expect(f.create).toHaveBeenCalledTimes(4);
  }finally{fs.rmSync(f.outputDir,{recursive:true,force:true});}
});
it('keeps no-model templates as partial without claiming or performing case archive',async()=>{
  const f=await setup('none');try{
    const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',f.args,f.context));
    expect(result.receipt).toMatchObject({ok:false,status:'partial',draftMode:'template'});
    expect(f.cases.getCase(f.orgId,f.caseFile.id)!.materials).toHaveLength(0);
    expect(f.create).not.toHaveBeenCalled();expect(fs.existsSync(path.join(f.outputDir,'10_civil-complaint.docx'))).toBe(true);
  }finally{fs.rmSync(f.outputDir,{recursive:true,force:true});}
});
it('keeps a complete-text packet out of the case when a requested DOCX fails',async()=>{
  const f=await setup('all');const docs=await import('../server/regions/packs/cn/legal_tools/documents');const write=vi.spyOn(docs,'writeDocxFromMarkdown').mockRejectedValueOnce(new Error('isolated DOCX failure'));try{
    const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',f.args,f.context));
    expect(result.receipt).toMatchObject({ok:false,status:'partial',draftMode:'model'});
    expect(f.cases.getCase(f.orgId,f.caseFile.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
    expect(result.content).toContain('isolated DOCX failure');
  }finally{write.mockRestore();fs.rmSync(f.outputDir,{recursive:true,force:true});}
});

it.each([
  ['all', true, 'generated', 'model', 4],
  ['mixed', false, 'partial', 'mixed', 3],
] as const)('returns companion forms and catalogs without writing files for a %s packet', async (mode, ok, status, draftMode, calls) => {
  const f = await setup(mode); try {
    const result = decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',
      { ...f.args, writeFiles: false, persistCase: false }, f.context));
    expect(result.receipt).toMatchObject({ ok, status, draftMode, persisted: false });
    expect(result.content).toContain('# 委托代理合同（系统草稿）');
    expect(result.content).toContain('# 授权委托书（系统草稿）');
    expect(result.content).toContain('# 律师事务所函（系统草稿）');
    expect(result.content).toContain('# 送达地址确认底稿（系统草稿）');
    expect(result.content).toContain('# 原告证据目录（系统草稿）');
    expect(result.content).toContain('Evidence Catalog And Three-Property Review');
    expect(result.content).toContain('［委托人名称及身份待确认］');
    expect(result.content).toContain('待律师确认证明目的');
    expect(result.content).toContain('未核验；核对原件');
    expect(result.content).toContain('双方主张与付款、交货日期均有待核验');
    const reviewedBody = result.content.split(ok ? '# 要素式诉状（系统草稿）' : '# 原告证据目录（系统草稿）')[1]?.split('## 状态与交付边界')[0];
    expect(reviewedBody?.trim().length).toBeGreaterThan(40);
    expect(reviewedBody).not.toMatch(/INTERNAL_INPUT_ONLY|UNRELATED_MEETING_TAIL/);
    if (!ok) {
      expect(result.content).toContain('## 尚未完成的文书');
      expect(result.content).toContain('民事起诉状：');
      expect(result.content).toContain('正文未完成，保留结构模板');
      expect(result.content).toContain('要素式诉状');expect(result.content).toContain('正文未完成');
      expect(result.content).toContain('## 事实与理由');
    }
    expect(f.create).toHaveBeenCalledTimes(calls);
    expect(fs.readdirSync(f.outputDir)).toEqual([]);
    expect(f.cases.getCase(f.orgId, f.caseFile.id)!.materials.filter(m => m.source === 'tool')).toHaveLength(0);
  } finally { fs.rmSync(f.outputDir, { recursive: true, force: true }); }
});
