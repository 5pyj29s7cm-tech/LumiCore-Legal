import './helpers';
import { initDatabase } from '../db_layer';
import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';
import { sdkCompletion } from './legal_bid_fixture';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { buildLitigationPacketDrafts } from '../server/regions/packs/cn/legal_tools/litigation_drafts';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
import * as cases from '../server/org/legal_cases';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resolveLegalCaseArguments } from '../server/regions/packs/cn/legal_tools/context';
import { startIsolatedConversation, addMessageIdempotent } from '../server/conversation/manager';
import { bindConversationActionTurnTask } from '../server/conversation/action_turn_ledger';
const actual = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/legal_packet_immutable_plaintiff.json', import.meta.url)), 'utf8'));
beforeAll(initDatabase);
afterEach(() => vi.useRealTimers());
async function setup(options: { attack?: boolean; invalid?: string; noClaims?: boolean; reviewDelay?: number; separator?: string } = {}) {
 const userId='immutable-packet-'+crypto.randomUUID(), orgId=cases.legalWorkspaceNamespace(userId);
 upsertUserPreferredLLM(userId,{provider:'relay',model:'aliyun/deepseek-v4-flash',selectionMode:'pinned'});
 const c=cases.createCase(orgId,userId,{title:'Synthetic exact plaintiff '+crypto.randomUUID(),party:actual.args.parties,clientRole:'plaintiff',objective:options.noClaims?'':actual.args.claims,cause:actual.args.caseType,court:'档案法院A',caseNumber:'OWN-CASE-001',stage:'filing'});
 for(const material of [...actual.materials].reverse())cases.addMaterial(orgId,userId,c.id,material);
 const originals=JSON.stringify(cases.getCase(orgId,c.id)!.materials);
 const outputDir=getDataDirectory(path.join('immutable-packet-output',c.id));
 const events:Array<{phase:string;baseName:string;signal:AbortSignal}>=[];
 const control={failCatalogReview:false,lengthCatalogReview:false,rejectCore:false};
 const create=vi.fn((request:any, sdkOptions:any)=>{
  const prompt=String(request.messages.find((m:any)=>m.role==='user')?.content||'');let content:string;let baseName:string;let phase:string;
  if(prompt.includes('## 当前文书\n')){
   const target=JSON.parse(prompt.split('## 当前文书\n')[1]);baseName=target.baseName;phase='draft';
   const rows=JSON.parse(prompt.split('材料原句与固定编目（待核验，不是已证事实）：\n')[1].split('\n')[0]);
   const sections=target.sections||[{id:'facts'},{id:'law'}];
   const entries=baseName.startsWith('16_')?rows.map((row:any)=>({sectionId:row.sectionId,sourceIds:row.sources.map((s:any)=>s.id),response:'Only a proposed proof purpose from supplied original material; authenticity, recipient, actual dates and source relationship remain unverified. '+c.id,missing:'Original and actual dates remain to be checked.'})):sections.map((s:any)=>({sectionId:s.id,sourceIds:rows.flatMap((r:any)=>r.sources.map((v:any)=>v.id)),response:'CORE-'+c.id+' 本次提供的付款是原告单方主张，收款主体及日期未知；未提供到货验收记录不能认定记录不存在。法律来源和适用尚未核验，条件分析不是认定事实。',missing:'付款收款主体、实际日期、原件及法律适用待核验。'}));
   if(options.invalid&&!baseName.startsWith('16_')){if(options.invalid==='foreign')entries[0].sourceIds=['F99999'];if(options.invalid==='duplicate')entries[1].sectionId=entries[0].sectionId;if(options.invalid==='missing')entries.pop();}
   content=JSON.stringify({baseName,complete:true,entries,markdown:actual.actualMarkdown,parties:'MODEL-PARTY',claims:'MODEL-CLAIM',locator:'page999'});
  }else{
   const documents=JSON.parse(prompt.split('文书列表：')[1]);baseName=documents[0].baseName.split('/')[0];phase='review';
   content=control.failCatalogReview&&baseName.startsWith('16_')?'{':JSON.stringify({documents:documents.map((d:any)=>({baseName:d.baseName,complete:!(control.rejectCore&&baseName==='10_civil-complaint'),unresolved:control.rejectCore&&baseName==='10_civil-complaint'?['Cannot safely complete this analysis.']:[],corrections:options.attack&&baseName==='10_civil-complaint'?[{paragraphId:'P1',replacement:'## 诉讼请求\n2. 请求被告另付违约金10万元。\n## 当事人\nMODEL-PARTY 不能成为服务器当事人字段；仍是待核对的模型分析文本。'.replace(/\n/g,options.separator||'\n'),reason:'Synthetic structure breakout must stay an analysis value.'}]:[]}))});
  }
  events.push({phase,baseName,signal:sdkOptions.signal});
  return sdkCompletion(request,{choices:[{message:{content},finish_reason:control.lengthCatalogReview&&phase==='review'&&baseName.startsWith('16_')?'length':'stop'}]},phase==='review'&&baseName.startsWith('16_')?(options.reviewDelay||0):0,sdkOptions.signal);
 });
 const registry=new ToolRegistry();registerLegalTools(registry);
 const context={userId,domain:'personal' as const,authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local' as const,source:'legal-direct-tool',llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create}}})}};
 const args={...actual.args,caseId:c.id,caseName:c.title,claims:options.noClaims?'':actual.args.claims,outputDir,includeDocx:false};
 const run=(extra={},ctx={})=>registry.execute('legal_generate_litigation_packet',{...args,...extra},{...context,requestId:crypto.randomUUID(),...ctx}).then(decodeToolResult);
 const read=(name:string)=>fs.readFileSync(path.join(outputDir,name+'.md'),'utf8');
 return {userId,orgId,c,originals,events,create,context,args,run,read,control,registry};
}
function chatFor(f: Awaited<ReturnType<typeof setup>>, raw: string) {
 const conversation=startIsolatedConversation(f.userId,'lumi','personal',''),requestId=crypto.randomUUID(),taskId=crypto.randomUUID();
 addMessageIdempotent({userId:f.userId,agentId:'lumi',conversationId:conversation.id,requestId,domain:'personal',orgId:'',source:'chat',channel:'chat',role:'user',content:raw,deferActionPreparation:true});
 expect(bindConversationActionTurnTask({userId:f.userId,conversationId:conversation.id,requestId,taskId}).bound).toBe(true);
 return {...f.context,source:'chat',conversationId:conversation.id,requestId,taskId};
}
const block=(markdown:string,title:string)=>markdown.split('## '+title+'\n')[1]?.split('\n## ')[0].trim();

const originalNative="请对已保存的虚构案件“虚构原告固定诉请验收1018_fb86bc49”（caseId=own-plaintiff-native-post-entry-54bbc8b5-c2ce-45d1-9062-ffbafb86bc49）生成半自动诉讼文书工作包，使用现有 legal_generate_litigation_packet。使用该案件已保存的身份、当事人与明确诉请及四份原始材料，不编辑案件档案，不转述或另填已有档案字段；写出本案Markdown和DOCX工作稿并归档，只需完成这一个文书包，不提交、不签署、不盖章或对外发送。\n\n本次原始要求：\n仅用于程序验收的虚构案件，无真实委托，不提交、不签名、不盖章、不对外发送。\n本次我方为虚构霁川设备有限公司，拟作为原告；对方为虚构墨汀制造有限公司，拟作为被告。请求虚构墨汀制造有限公司交付合同项下设备，仅生成律师工作稿，不主张退款、欠款余额或另加违约金。\n甲方称合同总价80万元，自己已支付20万元，合同记载付款后30日交货；付款是否足以触发交货期限、付款和交货的实际日期、设备名称/型号/数量、交付方式、收款主体及对方履行情况均待核实。\n未提供验收条款不代表合同没有约定，未提供催告记录不代表催告没有发生。\n统一社会信用代码、住所、法定代表人、法院、律所、律师、代理阶段、费用、授权期限、特别授权选择、送达地址、手机和电子送达意愿均未提供；不得补造。未给案件事实/程序法律基准日期，不能以本次创建或导出日期替代。";
const nativeFor=(f:Awaited<ReturnType<typeof setup>>)=>originalNative.replaceAll("own-plaintiff-native-post-entry-54bbc8b5-c2ce-45d1-9062-ffbafb86bc49",f.c.id).replaceAll("虚构原告固定诉请验收1018_fb86bc49",f.c.title);
it('keeps native operation text outside incomplete10/11 facts while complete sources and requirements remain available',async()=>{
 const f=await setup();f.control.rejectCore=true;const raw=nativeFor(f);const chat=chatFor(f,raw);
 const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',{caseId:f.c.id,outputDir:f.args.outputDir,includeDocx:false},chat));
 expect(result.receipt).toMatchObject({ok:false,status:'partial',persisted:false});const ten=f.read('10_civil-complaint'),eleven=f.read('11_element-complaint');
 const facts=block(ten,'事实与理由')||'';expect(facts).toContain('> ');
 const factsRow=eleven.split('\n').find(line=>line.startsWith('| 主要事实 |'));
 for(const material of actual.materials){expect(facts).toContain(material.title);expect(factsRow).toContain(material.title);}
 expect(facts).toContain('未提供验收条款不代表合同没有约定');
 for(const text of [block(ten,'事实与理由')||'',factsRow||'']){expect(text).not.toContain('legal_generate_litigation_packet');expect(text).not.toContain('请对已保存');}
 expect(f.read('00_litigation-packet')).toContain(raw);const firstDraft=f.create.mock.calls.find(([req])=>String(req.messages.find((m:any)=>m.role==='user')?.content||'').includes('## 当前文书\n'))?.[0];
 const prompt=String(firstDraft.messages.find((m:any)=>m.role==='user')?.content||'');expect(prompt).toContain(raw);
 for(const material of actual.materials){expect(prompt).toContain(material.content.trim());expect(f.read('03_evidence-review-matrix')).toContain(material.title);}
 expect(f.create).toHaveBeenCalledTimes(4);expect(cases.getCase(f.orgId,f.c.id)!.materials.filter(m=>m.source==='tool')).toHaveLength(0);
});
it('preserves explicit direct facts and completed reviewed10/11 analysis without falling back to native requests',async()=>{
 const f=await setup();const raw=nativeFor(f),chat=chatFor(f,raw);const result=decodeToolResult(await f.registry.execute('legal_generate_litigation_packet',{caseId:f.c.id,outputDir:f.args.outputDir,includeDocx:false},chat));
 expect(result.receipt).toMatchObject({ok:true,status:'generated'});const ten=f.read('10_civil-complaint'),eleven=f.read('11_element-complaint');
 expect(block(ten,'诉讼请求')).toBe(actual.args.claims);for(const text of [ten,eleven]){expect(text).toContain('CORE-'+f.c.id);expect(text).not.toContain('legal_generate_litigation_packet');expect(text).toContain('收款主体及日期未知');}
 expect(eleven).toContain('共用已复核分析');expect(f.create).toHaveBeenCalledTimes(4);
 const direct=buildLitigationPacketDrafts({...f.args,facts:'DIRECT_EXPLICIT_FACTS',materials:raw},'原告',[]).find(d=>d.baseName==='10_civil-complaint')!;expect(block(direct.markdown,'事实与理由')).toBe('> DIRECT_EXPLICIT_FACTS');
 if(process.env.PACKET_FACTS_OBSERVATION){fs.mkdirSync(process.env.PACKET_FACTS_OBSERVATION,{recursive:true});fs.writeFileSync(path.join(process.env.PACKET_FACTS_OBSERVATION,'completed-body.json'),JSON.stringify({ten:ten.replaceAll(f.c.id,'CASE_ID').replaceAll(f.c.title,'CASE_TITLE'),eleven:eleven.replaceAll(f.c.id,'CASE_ID').replaceAll(f.c.title,'CASE_TITLE'),directFacts:block(direct.markdown,'事实与理由')},null,2));}
});
