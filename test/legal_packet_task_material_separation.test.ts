import './helpers';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import * as cases from '../server/org/legal_cases';
import { startIsolatedConversation, addMessageIdempotent } from '../server/conversation/manager';
import { bindConversationActionTurnTask } from '../server/conversation/action_turn_ledger';
import { buildCaseContext, resolveLegalCaseArguments } from '../server/regions/packs/cn/legal_tools/context';
import { buildEvidenceReviewRows } from '../server/regions/packs/cn/legal_tools/case_workflow';
import { buildLitigationPacketDrafts } from '../server/regions/packs/cn/legal_tools/litigation_drafts';
const actual=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/legal_packet_task_material_actual.json',import.meta.url)),'utf8'));
beforeAll(initDatabase);
function setup(saved=true,nativeText=actual.nativeText){
 const userId='task-material-'+randomUUID(),orgId=cases.legalWorkspaceNamespace(userId);
 const c=cases.upsertCaseSnapshot(orgId,userId,{...actual.case,materials:saved?actual.case.materials:[]});
 const before=JSON.stringify(c.materials),conversation=startIsolatedConversation(userId,'lumi','personal',''),requestId=randomUUID(),taskId=randomUUID();
 addMessageIdempotent({userId,agentId:'lumi',conversationId:conversation.id,requestId,domain:'personal',orgId:'',source:'chat',channel:'chat',role:'user',content:nativeText,deferActionPreparation:true});
 expect(bindConversationActionTurnTask({userId,conversationId:conversation.id,requestId,taskId}).bound).toBe(true);
 const context={userId,conversationId:conversation.id,requestId,taskId,domain:'personal',orgId:'',source:'chat'};
 return {c,context,orgId,before};
}
describe('saved packet originals and exact current task have distinct parameter roles',()=>{
 it('replays the actual native request with four unchanged originals and keeps the complete task in requirements',()=>{
  const f=setup(),resolved=resolveLegalCaseArguments('legal_generate_litigation_packet',{caseId:f.c.id,caseName:f.c.title},f.context);
  const originals=f.c.materials.map((m:any)=>'[材料 '+m.id+'：'+m.title+']\n'+m.content).join('\n\n');
  expect(resolved.materials).toBe(originals);expect(resolved.requirements).toBe(actual.nativeText);
  const report=buildCaseContext(resolved);expect(report).toContain('- 本轮办理要求: '+actual.nativeText);
  expect(report).not.toContain('- 案件材料（未指定当事人角色）: '+actual.nativeText);
  const rows=buildEvidenceReviewRows(resolved,f.c).filter(r=>!!r.materialId);expect(rows).toHaveLength(4);expect(rows.flatMap(r=>r.sources)).toHaveLength(15);
  const ten=buildLitigationPacketDrafts(resolved,'原告',rows).find(d=>d.baseName==='10_civil-complaint')!.markdown;
  expect(ten).not.toContain('使用现有 legal_generate_litigation_packet');for(const m of f.c.materials)for(const line of m.content.split('\n').filter(Boolean))expect(ten).toContain(line);
  expect(JSON.stringify(cases.getCase(f.orgId,f.c.id,f.context.userId)!.materials)).toBe(f.before);
 });
 it('preserves effective case context across the three actual argument variants, without normalizing new identities',()=>{
  const f=setup();const base={caseId:f.c.id,caseName:f.c.title};
  const variants=[base,{...base,writeFiles:true,includeDocx:true,persistCase:true,forceRegenerate:false},{...base,role:'原告'}];
  const contexts=variants.map(a=>buildCaseContext(resolveLegalCaseArguments('legal_generate_litigation_packet',a,f.context)));
  expect(contexts[1]).toBe(contexts[0]);expect(contexts[2]).toBe(contexts[0]);
  expect(resolveLegalCaseArguments('legal_generate_litigation_packet',{...base,role:'被告'},f.context).packetFieldConflicts).toHaveLength(1);
 });
 it('retains an exact verified current attachment as material beside four originals, never as task instructions',()=>{
  const imagePath='D:/fixtures/current-packet.png',nativeText='请根据附件 '+imagePath+' 和已存四份原件生成本案工作稿，附件原件和归属待核验。\n'+actual.nativeText;
  const f=setup(true,nativeText),analysis='本轮新增附件原文：我方称另有付款截图，截图真实性及合同关联待核实。';
  const record={name:'ocr_image_file',arguments:{imagePath},result:JSON.stringify({analysis}),requestId:f.context.requestId,taskId:f.context.taskId,terminalVerification:{status:'verified'},
   envelope:{status:'verified_success',requestId:f.context.requestId,taskId:f.context.taskId,verification:{status:'verified',basis:'terminal_verification'}}};
  const resolved=resolveLegalCaseArguments('legal_generate_litigation_packet',{caseId:f.c.id,requirements:'MODEL REWRITE MUST NOT BE AUTHORITY'}, {...f.context,getCurrentToolRecords:()=>[record]});
  expect(resolved.requirements).toBe(nativeText);expect(resolved.requirements).not.toContain(analysis);expect(resolved.requirements).not.toContain('MODEL REWRITE');
  expect(resolved.materials).toContain('[附件实际读取/OCR文字，需核对原件]\n'+analysis);for(const m of f.c.materials)expect(resolved.materials).toContain(m.content);
  expect(resolved.materials).not.toContain(nativeText);expect(buildEvidenceReviewRows(resolved,f.c).filter(r=>!!r.materialId)).toHaveLength(4);
  const stale=resolveLegalCaseArguments('legal_generate_litigation_packet',{caseId:f.c.id}, {...f.context,getCurrentToolRecords:()=>[{...record,taskId:'another-task'}]});expect(stale.materials).not.toContain(analysis);
 });
 it('keeps the existing no-saved-original fallback rather than deleting literal input',()=>{
  const f=setup(false),resolved=resolveLegalCaseArguments('legal_generate_litigation_packet',{caseId:f.c.id},f.context);
  expect(resolved.materials).toBe(actual.nativeText);expect(resolved.requirements).toBeUndefined();
 });
 it('leaves other legal chat source resolution and authenticated direct arguments unchanged',()=>{
  const f=setup(),base={caseId:f.c.id};const other=resolveLegalCaseArguments('legal_extract_dispute_focus',base,f.context);
  expect(other.materials).toContain(actual.nativeText);expect(other.requirements).toBeUndefined();
  const direct=resolveLegalCaseArguments('legal_generate_litigation_packet',{...base,materials:'DIRECT MATERIAL',requirements:'DIRECT REQUIREMENT'}, {...f.context,source:'legal-direct-tool'});
  expect(direct.materials).toContain('DIRECT MATERIAL');expect(direct.requirements).toBe('DIRECT REQUIREMENT');
 });
});
