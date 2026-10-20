// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
