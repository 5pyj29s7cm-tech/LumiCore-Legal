import './helpers';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEvidenceReviewRows } from '../server/regions/packs/cn/legal_tools/case_workflow';
import { buildLitigationPacketDrafts } from '../server/regions/packs/cn/legal_tools/litigation_drafts';
const fixtures=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/legal_packet_evidence_slot_originals.json',import.meta.url)),'utf8'));
const block=(s:string,h:string)=>s.split('## '+h+'\n')[1]?.split('\n## ')[0].trim();
function compile(key:'plaintiff'|'defendant',explicit='') {
 const f=fixtures[key],sourceCase={...f.case,orgId:'personal:synthetic-slot-test',createdBy:'synthetic-slot-test',updatedBy:'synthetic-slot-test'};
 const before=JSON.stringify(sourceCase.materials),args={caseName:f.case.title,caseType:f.case.cause,parties:f.case.party,claims:f.case.objective,materials:f.nativeText,...(explicit?{evidence:explicit}:{})};
 // Same native packet filter: operation requirements remain context, never an extra evidence record.
 const rows=buildEvidenceReviewRows(args,sourceCase).filter(r=>!!r.materialId);
 const core=new Map([['10_civil-complaint',[{sectionId:'facts',sources:rows.flatMap(r=>r.sources),response:'Source-bound complete conditional facts, not established payment or delivery.',missing:'Originals and actual dates remain unverified.'},{sectionId:'law',sources:rows.flatMap(r=>r.sources),response:'Conditional legal analysis only; authoritative law and dates remain unverified.',missing:''}]]]);
 const initial=buildLitigationPacketDrafts(args,'原告',rows);
 const documents=buildLitigationPacketDrafts(args,'原告',rows,core);
 if(process.env.PACKET_SLOT_OBSERVATION){fs.mkdirSync(process.env.PACKET_SLOT_OBSERVATION,{recursive:true});fs.writeFileSync(process.env.PACKET_SLOT_OBSERVATION+'/'+key+(explicit?'-explicit':'')+'.json',JSON.stringify({initial,completed:documents},null,2));}
 return{f,args,sourceCase,before,rows,core,initial,documents,ten:documents.find(d=>d.baseName==='10_civil-complaint')!.markdown,eleven:documents.find(d=>d.baseName==='11_element-complaint')!.markdown};
}
it.each(['plaintiff','defendant'] as const)('lists only names and registered sources for the actual %s original-record fixture without inventing proof',key=>{
 const f=compile(key),section=block(f.ten,'证据和证据来源')!;
 const row=f.eleven.split('\n').find(l=>l.startsWith('| 现有证据 |'))!;
 expect(f.rows).toHaveLength(key==='plaintiff'?4:5);expect(section).not.toContain('证据材料待补充');expect(row).not.toContain('证据材料待补充');
 for(const r of f.rows){expect(section).toContain(r.name);expect(section).toContain(r.sourceLabel);expect(row).toContain(r.name);expect(row).toContain(r.sourceLabel);}
 expect(section.match(/原件与证明力待核/g)).toHaveLength(f.rows.length);expect(row.match(/原件与证明力待核/g)).toHaveLength(f.rows.length);
 for(const material of f.f.case.materials)expect(section).not.toContain(material.content.trim());
 for(const text of [section,row]){expect(text).not.toContain('本次中性材料输入');expect(text).not.toContain('legal_generate_litigation_packet');expect(text).not.toContain('请对已保存');}
 expect(JSON.stringify(f.sourceCase.materials)).toBe(f.before);expect(block(f.ten,'诉讼请求')).toBe(f.f.case.objective);
 // Five-record fixture is a renderer stress input, not a claimed defendant-to-plaintiff semantic conversion.
 const defense=buildLitigationPacketDrafts(f.args,'被告',f.rows);expect(block(defense.find(d=>d.baseName==='20_statement-of-defense')!.markdown,'我方证据')).toBe('［证据材料待补充］');
});
it('keeps legitimate empty evidence slots when no original rows or explicit evidence exist',()=>{
 const docs=buildLitigationPacketDrafts({caseName:'Synthetic no sources',materials:'Operation instructions only; do not turn this into evidence.'},'原告',[]);
 expect(block(docs.find(d=>d.baseName==='10_civil-complaint')!.markdown,'证据和证据来源')).toBe('［证据材料待补充］');
 expect(docs.find(d=>d.baseName==='11_element-complaint')!.markdown).toContain('| 现有证据 | ［证据材料待补充］ |');
});
it('preserves explicit evidence verbatim and does not append a second inferred list',()=>{
 const explicit='Original direct evidence instruction; authenticity and proof remain unverified.';const f=compile('plaintiff',explicit);
 expect(block(f.ten,'证据和证据来源')).toBe(explicit);const row=f.eleven.split('\n').find(l=>l.startsWith('| 现有证据 |'))!;expect(row).toContain(explicit);
 for(const r of f.rows)expect(row).not.toContain(r.name);expect(row).not.toContain('原件与证明力待核');
});
it('uses the existing cell escaping so registered names cannot create new headings or table cells',()=>{
 const f=compile('plaintiff');const rows=f.rows.map((row,index)=>index?row:{...row,name:'Original title|\r## not a heading\nNo new requested remedy',sourceLabel:'Registered|source\r# not a court finding'});
 const docs=buildLitigationPacketDrafts(f.args,'原告',rows,f.core),ten=docs.find(d=>d.baseName==='10_civil-complaint')!.markdown,eleven=docs.find(d=>d.baseName==='11_element-complaint')!.markdown;
 const section=block(ten,'证据和证据来源')!,row=eleven.split('\n').find(l=>l.startsWith('| 现有证据 |'))!;
 expect(section).toContain('Original title｜；## not a heading；No new requested remedy');expect(section).not.toMatch(/[\r\n]/);expect(row.split(' | ')).toHaveLength(3);expect(row).toContain('原件与证明力待核');
});

it('leaves the initial model target templates unchanged before a reviewed core is available',()=>{
 for(const key of ['plaintiff','defendant'] as const){const f=compile(key);const ten=f.initial.find(d=>d.baseName==='10_civil-complaint')!.markdown,eleven=f.initial.find(d=>d.baseName==='11_element-complaint')!.markdown;
  expect(block(ten,'证据和证据来源')).toBe('［证据材料待补充］');expect(eleven).toContain('| 现有证据 | ［证据材料待补充］ |');
 }
});
