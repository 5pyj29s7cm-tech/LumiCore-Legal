// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createAssetTraceWorkflow } from '../src/lib/legalAssetTraceWorkflow';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegalAssetTrace } from '../src/components/org/LegalAssetTrace';
import { chinaLegalCopy } from '../src/i18n/regions/cn/legal';
import { setLocale } from '../src/i18n/runtime';
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ workDomain: 'personal', orgConnection: null, user: { uid: 'asset-query-owner' } }) }));
const storageKey='lumi_legal_asset_trace_workflow_v1';
const company='Synthetic Registration Company';
const text='## Enterprise registration\nCompany: '+company+'\nRegistration: SYNTHETIC-REGISTRATION-TAIL\nEnforcement source not yet verified.';
beforeEach(()=>{ localStorage.clear(); sessionStorage.clear(); setLocale('en'); vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected external request')); });
afterEach(()=>{ cleanup(); vi.restoreAllMocks(); });
async function start(receipt:Record<string,unknown>,verification?:Record<string,unknown>){
 vi.mocked(fetch).mockImplementation(async()=>new Response(JSON.stringify({text,receipt,verification}),{status:200,headers:{'Content-Type':'application/json'}}));
 const copy=chinaLegalCopy('en').assetTraceWorkflow; render(<LegalAssetTrace/>);
 fireEvent.change(screen.getByPlaceholderText(copy.subjectPlaceholder),{target:{value:company}});
 fireEvent.click(screen.getByRole('button',{name:copy.start}));
 await waitFor(()=>{const value=JSON.parse(localStorage.getItem(storageKey)||'null');expect(value?.steps.find((step:any)=>step.id==='quick-scan')?.output).toBe(text);});
 return JSON.parse(localStorage.getItem(storageKey)!);
}
describe('asset trace starts with the actual source query and keeps incomplete evidence visible',()=>{
 it('queries the entered company directly instead of treating connection metadata as the investigation',async()=>{
  const saved=await start({ok:true,status:'observed'},{status:'verified'});
  expect(fetch).toHaveBeenCalledTimes(1);const [url,init]=vi.mocked(fetch).mock.calls[0];
  expect(String(url)).toContain('/api/legal/tool/legal_trace_assets');
  expect(JSON.parse(String(init?.body)).args).toMatchObject({name:company,persistCase:false});
  expect(saved.steps.find((step:any)=>step.id==='source-preflight')).toBeUndefined();
  expect(saved.steps.find((step:any)=>step.id==='quick-scan')).toMatchObject({status:'completed',output:text});
 });
 it.each([{ok:false,status:'partial'},{ok:true,status:'observed'}])('keeps returned registration while refusing an unverified whole result: %j',async receipt=>{
  const saved=await start(receipt,{status:'blocked'});
  expect(saved.steps.find((step:any)=>step.id==='quick-scan')).toMatchObject({status:'needs_action',output:text});
  expect(saved.status).toBe('needs_action');
 });
});

const registration = {
 '企业名称': company, '法定代表人': 'Synthetic Director', '注册资本': '800万元', '登记状态': '在业',
 '成立日期': '2016-05-06', '统一社会信用代码': 'SYNTHETIC-CREDIT-ONLY', '实缴资本': 0,
 '企业类型': 'Synthetic enterprise type', '登记机关': 'Synthetic Registration Authority',
};
function sourceBlock(tool: string, data: unknown) {
 return '## 官方来源原始结果\n- 来源: Synthetic authorized fixture\n- 工具: '+tool+'\n- 查询时间: 2026-10-25T01:02:03.000Z\n- SHA256: SYNTHETIC-ORIGINAL-DIGEST\n\n'+JSON.stringify(data);
}
function openSaved(output: string, subjectName = company) {
 const workflow = createAssetTraceWorkflow({subjectName,subjectType:'enterprise',runMode:'quick'});
 workflow.steps[0] = {...workflow.steps[0],status:'completed',output}; workflow.status = 'completed';
 const original = JSON.stringify(workflow); localStorage.setItem(storageKey,original);
 render(<LegalAssetTrace/>); return original;
}
describe('saved asset reports project their own sources into readable views without querying again',()=>{
 it('renders normal GFM, translates only old application status fields, and leaves saved/original bytes intact',async()=>{
  setLocale('zh'); const copy=chinaLegalCopy('zh').assetTraceWorkflow;
  const output='# Synthetic investigation report\n\n## 数据可用性\n- 数据状态: observed\n- 已取得来源记录: 2\n\n## Results\n**Readable emphasis**\n\n| Field | Value |\n|---|---|\n| Synthetic | preserved |\n\n'+sourceBlock('get_company_registration_info',registration);
  const original=openSaved(output);
  expect(await screen.findByRole('heading',{name:'Synthetic investigation report'})).toBeTruthy();
  expect(screen.getByText('Readable emphasis').tagName).toBe('STRONG'); expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.getByText('数据状态: 已取得来源')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:copy.company}));
  for(const value of [company,'Synthetic Director','800万元','在业','2016-05-06','SYNTHETIC-CREDIT-ONLY','0','Synthetic enterprise type','Synthetic Registration Authority'])expect(screen.getByText(value)).toBeTruthy();
  expect(screen.getByText(copy.companyFields.paidInCapital)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:copy.raw}));
  expect(document.querySelector('pre')?.textContent).toContain(output);
  expect(document.querySelector('pre')?.textContent).toContain('- 数据状态: observed');
  expect(localStorage.getItem(storageKey)).toBe(original); expect(fetch).not.toHaveBeenCalled();
 });
 it('uses exact company-section fields for sources without JSON and never mistakes the data status for company status',async()=>{
  const copy=chinaLegalCopy('en').assetTraceWorkflow;
  openSaved('## 企业基本信息\n- 名称: '+company+'\n- 注册资本: 12万元\n- 统一社会信用代码: SYNTHETIC-SECTION-CREDIT\n\n## 数据可用性\n- 数据状态: observed');
  fireEvent.click((await screen.findAllByRole('button',{name:copy.company})).at(-1)!);
  expect(screen.getByText(company)).toBeTruthy(); expect(screen.getByText('12万元')).toBeTruthy(); expect(screen.getByText('SYNTHETIC-SECTION-CREDIT')).toBeTruthy();
  expect(screen.queryByText(copy.companyFields.status)).toBeNull(); expect(screen.queryByText('observed')).toBeNull(); expect(fetch).not.toHaveBeenCalled();
 });
 it('does not borrow another subject or an enforcement payload as company registration',async()=>{
  const copy=chinaLegalCopy('en').assetTraceWorkflow;
  openSaved(sourceBlock('get_company_registration_info',{...registration,'企业名称':'Another Synthetic Company',Shareholders:[{Name:'Other Company Holder',Ratio:'80%'}]})+'\n\n'+sourceBlock('get_judgment_debtor_info',{'主体名称':'Another Synthetic Company','被执行信息':[{'案号':'OTHER-SUBJECT-CASE','执行法院':'Other Subject Court','执行标的':300}]})+'\n\n## Other notes\n- 名称: '+company+'\n- 状态: unrelated narrative');
  fireEvent.click((await screen.findAllByRole('button',{name:copy.company})).at(-1)!); expect(screen.getByText(copy.noOutput)).toBeTruthy();
  expect(screen.queryByText('Another Synthetic Company')).toBeNull(); expect(screen.queryByText('Synthetic Director')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:copy.equity})); expect(screen.getByText(copy.noStructuredEquity)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:copy.enforcement})); expect(screen.getByText(copy.noStructuredEnforcement)).toBeTruthy(); expect(fetch).not.toHaveBeenCalled();
 });
 it('renders supplied structured shareholders and later enforcement records from this subject own registered sources',async()=>{
  const copy=chinaLegalCopy('en').assetTraceWorkflow;
  const companySource={...registration,Shareholders:[{Name:'Synthetic Known Holder',Ratio:'25%'},{Name:'Synthetic Zero Holder',Ratio:0},{Name:'Synthetic Unknown Holder'}]};
  const enforcementSource={'主体名称':company,'被执行信息':[{'案号':'SYNTHETIC-EXECUTION-01','执行法院':'Synthetic Execution Court','执行标的':9000}]};
  const output=sourceBlock('get_company_registration_info',companySource)+'\n\n'+sourceBlock('get_judgment_debtor_info',enforcementSource);
  const original=openSaved(output);
  fireEvent.click((await screen.findAllByRole('button',{name:copy.company})).at(-1)!); expect(screen.getByText('Synthetic Director')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:copy.equity}));
  expect(screen.getByText('Synthetic Known Holder')).toBeTruthy(); expect(screen.getByText('25%')).toBeTruthy();
  expect(screen.getByText('Synthetic Zero Holder')).toBeTruthy(); expect(screen.getByText('0%')).toBeTruthy();
  const unknown=screen.getByText('Synthetic Unknown Holder').closest('div.rounded-lg')!; expect(unknown.textContent).not.toContain('%'); expect(unknown.querySelector('[style]')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:copy.enforcement}));
  for(const value of ['SYNTHETIC-EXECUTION-01','Synthetic Execution Court','9000'])expect(screen.getByText(value)).toBeTruthy();
  expect(screen.queryByText('2026-10-25')).toBeNull(); expect(screen.queryByText(copy.noStructuredEnforcement)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:copy.raw})); expect(document.querySelector('pre')?.textContent).toContain(output);
  expect(localStorage.getItem(storageKey)).toBe(original); expect(fetch).not.toHaveBeenCalled();
 });
 it('keeps free-text case numbers and percentages in originals instead of presenting invented structured records',async()=>{
  const copy=chinaLegalCopy('en').assetTraceWorkflow;
  openSaved('## Unstructured source note\n- Narrative percentage: 25%\n[CASE-ONLY-IN-TEXT] Fictional Court | 日期: 2026-01-01 | 标的: unverified');
  fireEvent.click(await screen.findByRole('button',{name:copy.enforcement})); expect(screen.getByText(copy.noStructuredEnforcement)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:copy.equity})); expect(screen.getByText(copy.noStructuredEquity)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:copy.raw})); expect(document.querySelector('pre')?.textContent).toContain('CASE-ONLY-IN-TEXT'); expect(fetch).not.toHaveBeenCalled();
 });
 it('shows the report tab through the same safe Markdown renderer',async()=>{
  const copy=chinaLegalCopy('en').assetTraceWorkflow;
  openSaved('# Safe stored report\n\n<script>untrusted_script_marker()</script>\n\n[Unsafe destination](javascript:alert(1))');
  fireEvent.click(await screen.findByRole('button',{name:copy.report}));
  expect(screen.getByRole('heading',{name:'Safe stored report'})).toBeTruthy(); expect(document.querySelector('script')).toBeNull();
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull(); expect(fetch).not.toHaveBeenCalled();
 });
});

it.runIf(Boolean(process.env.LUMI_ASSET_TRACE_WORKFLOW_FIXTURE && process.env.LUMI_ASSET_TRACE_SOURCES_FIXTURE))('replays the selected saved workflow in the real component without querying or rewriting its source records',async()=>{
 setLocale('zh'); const copy=chinaLegalCopy('zh').assetTraceWorkflow;
 const workflowPath=process.env.LUMI_ASSET_TRACE_WORKFLOW_FIXTURE!, sourcesPath=process.env.LUMI_ASSET_TRACE_SOURCES_FIXTURE!;
 const stored=fs.readFileSync(workflowPath,'utf8'), sourceFile=fs.readFileSync(sourcesPath,'utf8');
 const workflow=JSON.parse(stored), sources=JSON.parse(sourceFile).sources;
 const registrationSource=sources.find((source:any)=>source.sourceTool==='get_company_registration_info');
 const observed=JSON.parse(registrationSource.text);
 localStorage.setItem(storageKey,stored); render(<LegalAssetTrace/>);
 expect(await screen.findByText('数据状态: 已取得来源')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:copy.company}));
 const fields=[['name','企业名称'],['legalPerson','法定代表人'],['capital','注册资本'],['status','登记状态'],['establishDate','成立日期'],['unifiedCode','统一社会信用代码'],['paidInCapital','实缴资本'],['enterpriseType','企业类型'],['registrationAuthority','登记机关']] as const;
 for(const [field,key] of fields){expect(observed[key]).toBeDefined();expect(screen.getByText(copy.companyFields[field]).parentElement?.textContent).toContain(String(observed[key]));}
 fireEvent.click(screen.getByRole('button',{name:copy.raw}));
 const raw=document.querySelector('pre')?.textContent || '';
 for(const source of sources){expect(raw).toContain(source.text);expect(raw).toContain(source.queriedAt);expect(raw).toContain(source.declaredSha256);}
 expect(raw).toContain(workflow.steps.find((step:any)=>step.id==='quick-scan').output);
 expect(localStorage.getItem(storageKey)).toBe(stored); expect(fs.readFileSync(workflowPath,'utf8')).toBe(stored); expect(fs.readFileSync(sourcesPath,'utf8')).toBe(sourceFile);
 expect(fetch).not.toHaveBeenCalled();
});
