// @vitest-environment jsdom
import React from 'react';
import { render, fireEvent, waitFor, screen, cleanup } from '@testing-library/react';
import { it, expect, afterEach, vi } from 'vitest';
import { loadSourceModule } from './source_expression';
const api = vi.fn();
const client:any = loadSourceModule('src/lib/legalToolClient.ts', {'../services/apiClient': { apiJson: api }, './legalCaseStore': { mergePersonalLegalCaseRuntimeSnapshot: vi.fn() }});
const hook:any = loadSourceModule('src/hooks/useLegalDocument.ts', {'react':React,'sonner':{toast:{success:vi.fn(),error:vi.fn()}},'../contexts/AppContext':{useApp:()=>({workDomain:'personal',orgConnection:null})},'../services/apiClient':{apiJson:api},'../i18n/uiMessages':{uiMessage:(k:string)=>k},'../lib/knowledgeFileImport':{},'../i18n/locales/fileImport':{fileImportCopy:{}},'../i18n/runtime':{getLocale:()=> 'zh'},'../../shared/legal_workflow_receipts':{isLegalSourceMaterial:(m:any)=>m.source!=='tool'}});
afterEach(()=>{cleanup();api.mockReset();});
const partial = {text:'民事起诉状未完成，保留结构模板',receipt:{ok:false,status:'partial'},verification:{status:'failed'},caseUpdates:[]};
it('refuses HTTP200 partial as confirmed text before caller archive',async()=>{api.mockResolvedValue(partial);await expect(client.runLegalTool('legal_generate_litigation_packet',{caseId:'virtual'})).rejects.toThrow(partial.text);});
it('keeps partial visible without a successfulResult archive action and releases button',async()=>{api.mockResolvedValue(partial);function View(){const d=hook.useLegalDocument('',{error:'Error'});return <><button disabled={!!d.busy} onClick={()=>d.generate((signal:any)=>client.runLegalTool('legal_generate_litigation_packet',{caseId:'virtual'},signal))}>Generate</button><output>{d.result}</output>{d.successfulResult&&<button>Archive</button>}</>;}render(<View/>);fireEvent.click(screen.getByRole('button',{name:'Generate'}));await screen.findByText(new RegExp(partial.text));await waitFor(()=>expect((screen.getByRole('button',{name:'Generate'}) as HTMLButtonElement).disabled).toBe(false));expect(screen.queryByRole('button',{name:'Archive'})).toBeNull();});
it('retains structured needs_source for assisted consumers',async()=>{api.mockResolvedValue({text:'请补充来源',receipt:{ok:false,status:'needs_source'},verification:{status:'failed'},caseUpdates:[]});await expect(client.runLegalToolExecution('legal_company_lookup',{})).resolves.toMatchObject({text:'请补充来源',receipt:{status:'needs_source'}});});
it('permits server verified success text',async()=>{api.mockResolvedValue({text:'完整正文',receipt:{ok:true,status:'generated'},verification:{status:'verified'},caseUpdates:[]});await expect(client.runLegalTool('legal_generate_litigation_packet',{})).resolves.toBe('完整正文');});

it('permits legacy citation handler without receipt when server verified it',async()=>{api.mockResolvedValue({text:'法条核验报告',verification:{status:'verified'},caseUpdates:[]});await expect(client.runLegalTool('legal_verify_citation',{})).resolves.toBe('法条核验报告');});
it('never lets explicit receipt failure override server verification',async()=>{api.mockResolvedValue({...partial,verification:{status:'verified'}});await expect(client.runLegalTool('legal_generate_litigation_packet',{})).rejects.toThrow(partial.text);});
