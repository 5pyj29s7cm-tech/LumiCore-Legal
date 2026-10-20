import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {hasVerifiedExactReadOnlyArtifactEvidence,documentReadMatchesRequestedTarget,isSuccessfulExactDocumentRead} from '../server/cognition/action_desktop_evidence';
import {buildActionContract,hasCoreActionEvidence} from '../server/cognition/action_contract';
import {finalizeLumiResponse} from '../server/cognition/result_finalizer';
import type {ToolExecutionRecord} from '../server/tools/types';
const captured=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'fixtures/knowledge_core_e240_capture.json'),'utf8'));
const task=captured.taskText as string;
const original=captured.records as ToolExecutionRecord[];
const records=()=>structuredClone(original);
const scope={userId:'admin-uid',domain:'personal',orgId:''};
const contract=buildActionContract(task);
afterEach(()=>vi.unstubAllGlobals());
function core(rs:ToolExecutionRecord[],text=task){return hasCoreActionEvidence(buildActionContract(text),rs,text,undefined,{requestId:captured.requestId,taskId:captured.taskId});}
function changed(fn:(payload:any,record:ToolExecutionRecord)=>void){const r=records()[0],p=JSON.parse(r.result);fn(p,r);r.result=JSON.stringify(p);return r;}
describe('canonical knowledge source receipts reach the shared completion boundary',()=>{
 it('accepts the exact two verified source-text receipts after source validation without another tool call',()=>{
  const network=vi.fn(()=>{throw Error('Offline receipt replay must not use network');});vi.stubGlobal('fetch',network);
  const rs=records();expect(contract.label).toBe('Exact read-only file inspection');
  expect(rs).toHaveLength(2);for(const r of rs){expect(isSuccessfulExactDocumentRead(r)).toBe(true);expect(documentReadMatchesRequestedTarget(r,task,undefined,[],scope)).toBe(true);}
  expect(hasVerifiedExactReadOnlyArtifactEvidence(rs,task)).toBe(true);expect(core(rs)).toBe(true);expect(network).not.toHaveBeenCalled();
 });
 it('lets a source-grounded synthetic answer pass the same contract instead of requesting recovery',()=>{
  // This is offline synthetic wording, never the unretained 2832-character live draft.
  const responseText='已读取这三份虚构资料。原告诉请金额为90000元，属于原告主张；被告自述付款70000元未取得银行原始流水核实。算术差额20000元不等于承认余债。合同签署日期、付款条件和管辖均未提供，不能据此认定没有约定。';
  const result=finalizeLumiResponse({taskText:task,responseText,toolRecords:records(),source:'offline-canonical-replay',requestId:captured.requestId,taskId:captured.taskId,flow:{routeText:task,acceptedActionContract:{taskText:task,contract}} as any});
  expect(result.blocked,JSON.stringify(result)).toBe(false);expect(result.text).toBe(responseText);
 });
 it.each(['','已读取文件。'])('keeps missing analysis blocked even when the original sources were read: %s',responseText=>{
  const result=finalizeLumiResponse({taskText:task,responseText,toolRecords:records(),source:'offline-canonical-replay',requestId:captured.requestId,taskId:captured.taskId,flow:{routeText:task,acceptedActionContract:{taskText:task,contract}} as any});
  expect(result.blocked).toBe(true);expect(result.text).not.toBe(responseText);expect(result.text).toMatch(/读取|read/i);
 });
 it('keeps a downstream failed shared-loop verdict blocked after full source retrieval',()=>{
  const result=finalizeLumiResponse({taskText:task,responseText:'仅取得原文，没有生成分析。',toolRecords:records(),source:'offline-canonical-replay',requestId:captured.requestId,taskId:captured.taskId,completionGuard:{text:'模型未返回分析结果。',blocked:true,reason:'model_failed_before_tool_execution'},flow:{routeText:task,acceptedActionContract:{taskText:task,contract}} as any});
  expect(result.blocked).toBe(true);expect(result.text).toContain('未返回分析');
 });
 it.each(['metadata','truncated','revision','textHash','unverified'] as const)('keeps %s receipts outside core evidence',kind=>{
  const r=changed((p,r)=>{if(kind==='metadata'){p.mode='inventory';p.files=p.files.map((f:any)=>({fileId:f.fileId,name:f.name}));}if(kind==='truncated')p.files[0].truncated=true;if(kind==='revision')p.files[0].sourceRevision='0'.repeat(64);if(kind==='textHash')p.files[0].textHash='0'.repeat(64);if(kind==='unverified')r.terminalVerification!.status='unverified';});
  expect(isSuccessfulExactDocumentRead(r)).toBe(false);expect(core([r])).toBe(false);
 });
 it.each(['owner','domain','orgId'] as const)('does not match a source receipt outside the supplied %s scope',kind=>{
  const r=changed(p=>{if(kind==='owner')p.userId='other-owner';if(kind==='domain')p.domain='work';if(kind==='orgId')p.orgId='other-org';});
  expect(documentReadMatchesRequestedTarget(r,task,undefined,[],scope)).toBe(false);
 });
 it('rejects an original fileId that was not explicitly named by the task',()=>{
  const r=records()[0];expect(documentReadMatchesRequestedTarget(r,task.replaceAll(r.arguments.fileIds[2],'not-this-source.txt'))).toBe(false);
  expect(core([r],task.replaceAll(r.arguments.fileIds[2],'not-this-source.txt'))).toBe(false);
 });
 it.each(['request','task'] as const)('rejects a receipt with a mismatched %s envelope',kind=>{
  const r=records()[0];if(kind==='request')r.requestId='other-request';else r.taskId='other-task';expect(isSuccessfulExactDocumentRead(r)).toBe(false);expect(core([r])).toBe(false);
 });
 it('does not promote an arbitrary tool with a copied payload into a source reader',()=>{
  const r=records()[0];r.name='not_a_document_reader';expect(isSuccessfulExactDocumentRead(r)).toBe(false);expect(hasVerifiedExactReadOnlyArtifactEvidence([r],task)).toBe(false);expect(core([r])).toBe(false);
 });
});
