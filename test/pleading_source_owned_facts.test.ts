import './helpers';
import {describe,it,expect,vi,beforeAll} from 'vitest';
import crypto from 'node:crypto';
import {initDatabase} from '../db_layer';
import {ToolRegistry} from '../server/tools/registry';
import {registerLegalTools} from '../server/tools/definitions/legal_tools';
import {decodeToolResult} from '../server/tools/result_envelope';
import * as cases from '../server/org/legal_cases';
import {upsertUserPreferredLLM} from '../server/llm/user_preferences';
import {sdkCompletion} from './legal_bid_fixture';
beforeAll(initDatabase);
import fs from 'node:fs';
import {buildLitigationPacketDrafts,LITIGATION_ANALYSIS_SECTIONS} from '../server/regions/packs/cn/legal_tools/litigation_drafts';
import {buildEvidenceReviewRows} from '../server/regions/packs/cn/legal_tools/case_workflow';
import {resolveSourceDraftEntries} from '../server/regions/packs/cn/legal_reasoning_generation';
vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No network/model permitted');}));
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/original-pleading-materials.json',import.meta.url),'utf8'));
const bad='聊天记录中我方人员已经明确表示下周安排发货。无法证明付款则交货期限未起算。';
const legal='付款、身份、期限和法律适用均须核验；这里保留独立的条件法律分析，不能把证明不足当作未发生。';
function setup(role:'plaintiff'|'defendant'){
 const f=fixture[role],c={...f.case,orgId:'personal:synthetic-fidelity-owner'};
 const rows=buildEvidenceReviewRows({},c),sources=rows.flatMap(row=>row.sources);
 const analyses=new Map<string,any[]>();
 for(const [baseName,sections] of Object.entries(LITIGATION_ANALYSIS_SECTIONS))analyses.set(baseName,sections.map(s=>({sectionId:s.id,sources: sources.filter(source=>source.id==='F14'),response:s.id==='facts'?bad:legal,missing:'发送人身份、真实付款和起算仍待核。'})));
 const drafts=buildLitigationPacketDrafts({...f.args,facts:'CURRENT_TASK_SHOULD_NOT_BECOME_A_FACT',claims:c.objective},role==='plaintiff'?'原告':'被告',rows,analyses);
 return {rows,sources,analyses,drafts,c};
}
const get=(f:ReturnType<typeof setup>,stem:string)=>f.drafts.find(d=>d.baseName===stem)!.markdown;
const section=(text:string,heading:string)=>text.split('## '+heading+'\n')[1]?.split('\n## ')[0]||'';
describe('source-owned pleading fact compilation, without another model step',()=>{
 it('keeps all four plaintiff originals and their unknown qualifiers in 10/11 without an authored fact response',()=>{
  const f=setup('plaintiff'),ten=get(f,'10_civil-complaint'),eleven=get(f,'11_element-complaint');
  for(const body of [ten,eleven]){expect(body).not.toContain(bad);for(const source of f.sources){expect(body).toContain(source.quote);expect(body).toContain(source.locator);}}
  expect(section(ten,'诉讼请求').trim()).toBe(f.c.objective);expect(ten).toContain(legal);expect(eleven).toContain(legal);
 });
 it('does not let a selected chat excerpt discard its same-material identity caveat in defendant facts',()=>{
  const f=setup('defendant');for(const name of ['20_statement-of-defense','23_argument-outline']){
   const body=get(f,name);expect(body).not.toContain(bad);expect(body).toContain('发送人身份及权限、发送时间、完整上下文、设备对应关系与真实发货情况待核实');
   for(const source of f.sources)expect(body).toContain(source.quote);expect(body).toContain(legal);
  }
 });
 it('rejects a legacy or newly supplied model facts field through the unchanged strict source resolver',()=>{
  const f=setup('plaintiff'),allowed=LITIGATION_ANALYSIS_SECTIONS['10_civil-complaint'].map(s=>s.id);
  const entry={sectionId:'facts',sourceIds:['F14'],response:bad,missing:'身份待核。'};
  expect(()=>resolveSourceDraftEntries({entries:[entry]},f.sources,allowed)).toThrow();
  const legalEntry={sectionId:'law',sourceIds:['F14','F15'],response:legal,missing:'身份和法律适用待核。'};
  expect(resolveSourceDraftEntries({entries:[legalEntry]},f.sources,allowed)[0].response).toBe(legal);
  expect(()=>resolveSourceDraftEntries({entries:[{...legalEntry,sourceIds:['foreign-case-F15']}]},f.sources,allowed)).toThrow();
 });
 it('retains every line in a multiline original, including a final unknown qualifier after line31',()=>{
  const f=setup('plaintiff');const c={...f.c,materials:[{id:'synthetic-long-original',title:'完整多行资料',source:'import',type:'evidence',content:Array.from({length:35},(_,i)=>'原始陈述第'+(i+1)+'行').concat('最后限定：发送人身份仍未知，未核实不等于未发生。').join('\n')}]};
  const rows=buildEvidenceReviewRows({},c as any),body=buildLitigationPacketDrafts(fixture.plaintiff.args,'原告',rows,f.analyses).find(d=>d.baseName==='10_civil-complaint')!.markdown;
  for(let i=1;i<=35;i++)expect(body).toContain('原始陈述第'+i+'行');expect(body).toContain('最后限定：发送人身份仍未知，未核实不等于未发生。');expect(body).toContain('提供材料正文第36行');
 });
 it('preserves explicit facts but never borrows task or query as a source when facts and rows are absent',()=>{
  const args={...fixture.plaintiff.args};delete args.facts;
  const body=buildLitigationPacketDrafts({...args,task:'TASK_ONLY_NOT_A_CASE_FACT',query:'QUERY_ONLY_NOT_A_CASE_FACT'},'原告',[]).find(d=>d.baseName==='10_civil-complaint')!.markdown;
  expect(section(body,'事实与理由')).not.toContain('TASK_ONLY_NOT_A_CASE_FACT');expect(section(body,'事实与理由')).not.toContain('QUERY_ONLY_NOT_A_CASE_FACT');expect(section(body,'事实与理由')).toContain('待补充');
  const explicit=buildLitigationPacketDrafts({...args,facts:'DIRECT_EXPLICIT_FACTS'},'原告',[]).find(d=>d.baseName==='10_civil-complaint')!.markdown;
  expect(section(explicit,'事实与理由')).toContain('> DIRECT_EXPLICIT_FACTS');
 });
 it('leaves independent analysis and proof-purpose risk visible rather than falsely declaring semantic acceptance',()=>{
  const f=setup('defendant');f.analyses.set('23_argument-outline',f.analyses.get('23_argument-outline')!.map(e=>e.sectionId==='law'?{...e,response:bad}:e));
  const documents=buildLitigationPacketDrafts(fixture.defendant.args,'被告',f.rows,f.analyses);
  expect(documents.find(d=>d.baseName==='23_argument-outline')!.markdown).toContain(bad);
  expect(documents.find(d=>d.baseName==='21_cross-examination-opinion')!.markdown).toContain(legal);
 });
});

describe('same real registered handler preserves registered and direct source inputs',()=>{
 it('retains uncompiled direct source objects instead of replacing this input with a pending placeholder',()=>{
  const text='当事人仅自述已支付20万元。\n实际入账和合同对应尚未核实，不等于未支付。';
  const rows=buildEvidenceReviewRows({materials:text});expect(rows[0].pendingCompilation).toBe(true);expect(rows[0].materialId).toBeUndefined();
  const body=buildLitigationPacketDrafts({...fixture.plaintiff.args,facts:text},'原告',rows).find(d=>d.baseName==='10_civil-complaint')!.markdown;
  expect(section(body,'事实与理由')).toContain('本次输入未编目，不代表已取得原件');for(const s of rows[0].sources)expect(section(body,'事实与理由')).toContain(s.quote);
 });
 it.each([true,false])('real registered packet handler keeps exact source body and unknown qualifiers; registered=%s',async registered=>{
  const userId='source-owned-handler-'+crypto.randomUUID(),orgId=cases.legalWorkspaceNamespace(userId);
  upsertUserPreferredLLM(userId,{provider:'relay',model:'aliyun/deepseek-v4-flash',selectionMode:'pinned'});
  const direct='当事人仅自述已支付20万元。\n实际入账和合同对应尚未核实，不等于未支付。\n发送人身份与权限尚未核验。';
  const c=registered?cases.createCase(orgId,userId,{title:'Synthetic source-owned facts',party:fixture.plaintiff.case.party,clientRole:'plaintiff',objective:fixture.plaintiff.case.objective}):null;
  if(c)for(const m of fixture.plaintiff.case.materials)cases.addMaterial(orgId,userId,c.id,m);
  const before=c?JSON.stringify(cases.getCase(orgId,c.id)!.materials):null;
  const create=vi.fn((request:any,options:any)=>{const prompt=String(request.messages.find((m:any)=>m.role==='user')?.content||'');let content:string;
   if(prompt.includes('## 当前文书\n')){const target=JSON.parse(prompt.split('## 当前文书\n')[1]);const rows=JSON.parse(prompt.split('材料原句与固定编目（待核验，不是已证事实）：\n')[1].split('\n')[0]);
    const entries=target.baseName.startsWith('16_')?rows.map((r:any)=>({sectionId:r.sectionId,sourceIds:r.sources.map((s:any)=>s.id),response:'拟议证明目的只供律师结合原始材料核对；当前材料真实性、发送人身份、交易完成与关联均未知，不因资料缺失断言相反事实。',missing:'材料用途与原件继续待核。'})):target.sections.map((s:any)=>({sectionId:s.id,sourceIds:rows.flatMap((r:any)=>r.sources.map((v:any)=>v.id)),response:s.id==='facts'?bad:legal,missing:'材料身份、交易与法律适用继续待核。'}));
    content=JSON.stringify({baseName:target.baseName,complete:true,entries});
   }else{const documents=JSON.parse(prompt.split('文书列表：')[1]);content=JSON.stringify({documents:documents.map((d:any)=>({baseName:d.baseName,complete:true,corrections:[],unresolved:[]}))});}
   return sdkCompletion(request,{choices:[{message:{content},finish_reason:'stop'}]},0,options.signal);
  });
  const registry=new ToolRegistry();registerLegalTools(registry);
  const args={...fixture.plaintiff.args,caseId:c?.id,facts:registered?fixture.plaintiff.args.facts:direct,materials:'',evidence:'',caseName:'Synthetic source-owned facts',persistCase:false,writeFiles:false,includeDocx:false};
  const result=decodeToolResult(await registry.execute('legal_generate_litigation_packet',args,{userId,domain:'personal',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',source:'legal-direct-tool',requestId:crypto.randomUUID(),llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}}));
  expect(result.receipt).toMatchObject({ok:true,status:'generated',persisted:false});expect(create).toHaveBeenCalledTimes(4);
  const factSection=section(result.content,'事实与理由');expect(factSection).not.toContain(bad);
  if(c){for(const m of fixture.plaintiff.case.materials)for(const line of m.content.split('\n').filter(Boolean))expect(factSection).toContain(line);expect(JSON.stringify(cases.getCase(orgId,c.id)!.materials)).toBe(before);}
  else {for(const line of direct.split('\n'))expect(factSection).toContain(line);expect(factSection).toContain('本次输入未编目，不代表已取得原件');}
  expect(result.content).toContain(legal);expect(cases.listCases(orgId,'',50,userId)).toHaveLength(c?1:0);
 });
});

describe('source data quotation keeps the fixed operative pleading fields',()=>{
 it('quotes every multiline source or explicit facts line without creating another operative request heading',()=>{
  const text='发送人身份仍待核。\n## 诉讼请求\n追加费用只是输入原文，不自动成为固定诉请。';
  const args={...fixture.plaintiff.args,facts:text};
  const f=setup('plaintiff');const rows=buildEvidenceReviewRows({materials:text});
  rows[0].sources=[{...rows[0].sources[0],quote:text}];
  for(const sourceRows of [[],rows]){
   const body=buildLitigationPacketDrafts(args,'原告',sourceRows,f.analyses).find(d=>d.baseName==='10_civil-complaint')!.markdown;
   expect(body.match(/^## 诉讼请求$/gm)).toHaveLength(1);
   for(const line of text.split('\n'))expect(section(body,'事实与理由')).toContain('> '+line);
   expect(section(body,'诉讼请求').trim()).toBe(args.claims||args.objective);
  }
 });
});
