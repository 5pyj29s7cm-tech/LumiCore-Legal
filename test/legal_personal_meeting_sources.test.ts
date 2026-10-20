// @vitest-environment jsdom
import {beforeEach,describe,expect,it} from 'vitest';
import {createEmptyLegalCase,writeLegalCaseFiles,getLegalCaseById,getActiveLegalCaseId,mergePersonalLegalCaseRuntimeSnapshot} from '../src/lib/legalCaseStore';
import {isLegalSourceMaterial} from '../shared/legal_workflow_receipts';
beforeEach(()=>localStorage.clear());
describe('single server archive snapshot returns to the personal workspace',()=>{
 it('keeps all imported speech separate from generated analysis without changing the active other case',()=>{
  const first={...createEmptyLegalCase(),title:'Archive destination A',notes:'Original facts not verified'};
  const second={...createEmptyLegalCase(),title:'Currently viewed B'};writeLegalCaseFiles([first,second],second.id);
  const transcript=Array.from({length:320},(_,i)=>'Original turn '+i).join('\n');
  const snapshot={...first,updatedAt:'2099-01-01T00:00:00.000Z',materials:[{id:'raw',type:'consultation',title:'Original conversation',createdAt:new Date().toISOString(),content:transcript,source:'import'},{id:'summary',type:'note',title:'Generated report',createdAt:new Date().toISOString(),content:'Generated analysis only',source:'tool'}]};
  mergePersonalLegalCaseRuntimeSnapshot(snapshot);
  expect(getActiveLegalCaseId()).toBe(second.id);expect(getLegalCaseById(second.id)?.materials).toHaveLength(0);
  const saved=getLegalCaseById(first.id)!;expect(saved.notes).toBe(first.notes);expect(saved.materials.filter(isLegalSourceMaterial)).toHaveLength(1);
  expect(saved.materials.find(m=>m.id==='raw')?.content).toContain('Original turn 0');expect(saved.materials.find(m=>m.id==='raw')?.content).toContain('Original turn 319');expect(saved.materials.find(m=>m.id==='raw')?.content).not.toContain('Generated analysis only');expect(saved.materials.find(m=>m.id==='summary')?.content).not.toContain('Original turn');
 });
 it('does not replace newer local case facts with an older server reply',()=>{
  const current={...createEmptyLegalCase(),id:'A',title:'New local title',notes:'Local edited facts',updatedAt:'2099-01-01T00:00:00.000Z'};writeLegalCaseFiles([current],current.id);
  mergePersonalLegalCaseRuntimeSnapshot({...current,title:'Old runtime title',notes:'Old runtime facts',updatedAt:'2000-01-01T00:00:00.000Z',materials:[{id:'report',type:'note',title:'New server report',createdAt:'2000-01-01T00:00:00.000Z',source:'tool',content:'Report content'}]});
  const saved=getLegalCaseById('A')!;expect(saved.title).toBe('New local title');expect(saved.notes).toBe('Local edited facts');expect(saved.materials.find(m=>m.id==='report')?.content).toBe('Report content');
 });
});
