// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chinaLegalCopy } from '../src/i18n/regions/cn/legal';
import { LegalPacketView } from '../src/components/org/legal_hub/packet';
import { LegalStrategyView } from '../src/components/org/legal_hub/strategy';
import { LegalExternalResearchView } from '../src/components/org/legal_hub/external_research';
import { LegalVerifyView } from '../src/components/org/legal_hub/verification';
import { LegalImportView } from '../src/components/org/legal_hub/material_import';
import { LegalContractReview } from '../src/components/org/LegalContractReview';
import { LegalBidWorkbench } from '../src/components/org/LegalBidWorkbench';
import { LegalCaseSearch } from '../src/components/org/LegalCaseSearch';
const fixture=vi.hoisted(()=>({net:vi.fn(),domain:'personal',org:'org-history',user:'history-owner'}));
vi.mock('../src/contexts/AppContext',()=>({useApp:()=>({user:{uid:fixture.user},workDomain:fixture.domain,orgConnection:{orgId:fixture.org,connected:true,orgRole:'owner'}})}));
vi.mock('../src/services/apiClient',()=>({apiJson:fixture.net}));
vi.mock('../src/lib/useT',()=>({useT:()=>({langCode:'en',legalCaseStrategyAnalyze:'analyze',legalCaseStrategyTitle:'Strategy',legalCaseStrategyDesc:'Description',legalCaseSearchResults:'Search results'})}));
vi.mock('../src/i18n/uiMessages',()=>({uiMessage:(key:string)=>key.split('.')[1],formatUiMessage:(key:string)=>key.split('.')[1]}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn(),info:vi.fn()}}));
beforeEach(()=>{fixture.net.mockReset();fixture.net.mockRejectedValue(new Error('No API is permitted for history restoration'));fixture.domain='personal';fixture.org='org-history';fixture.user='history-owner';});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const run=(tool:string,displayText:string,status='partial')=>({tool,displayText,status,ok:status==='generated',checkedAt:'2026-10-15T05:00:00.000Z',basis:'old-source-basis',materialIds:[],artifacts:[]});
const file=(runs:any[],materials:any[]=[])=>({id:'virtual-history-case',title:'Virtual history case',clientRole:'defendant',party:'Virtual A/Virtual B',cause:'contract',court:'',caseNumber:'',judge:'',stage:'consultation',factDate:'2026-09-01',hearingDate:'',judgmentDate:'',appealDeadline:'',enforcementDeadline:'',notes:'Source facts only',materials,workflowRuns:runs,createdAt:'',updatedAt:''} as any);
const pages:[string,any][]=[['legal_generate_litigation_packet',LegalPacketView],['legal_case_strategy',LegalStrategyView],['legal_external_research_plan',LegalExternalResearchView],['legal_verify_citation',LegalVerifyView],['legal_import_materials_to_kb',LegalImportView],['legal_import_judgment',LegalImportView],['legal_review_contract',LegalContractReview],['legal_generate_bid',LegalBidWorkbench],['legal_search_case',LegalCaseSearch]];
it.each(pages)('reopens %s from existing exact-tool history without executing or enabling archive',async(tool,Component)=>{
  const original='HISTORY_ORIGINAL_'+tool, caseFile=file([run(tool,original)]), writer=vi.fn();
  const mount=()=>{
    const view=render(<Component caseFile={caseFile} onAddMaterial={writer}/>);
    if(tool==='legal_verify_citation'){
      const copy=chinaLegalCopy('en').workspace;
      fireEvent.click(screen.getByText(copy.advancedOptions,{selector:'summary'}));
      fireEvent.change(screen.getByRole('combobox',{name:copy.toolMode}),{target:{value:'legal_verify_citation'}});
    }
    return view;
  };
  let view=mount();expect(screen.getAllByText(new RegExp(original)).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button',{name:'archive-to-case'})).toBeNull();view.unmount();view=mount();
  expect(screen.getAllByText(new RegExp(original)).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button',{name:'archive-to-case'})).toBeNull();expect(screen.queryByText('result-ready')).toBeNull();
  expect(fixture.net).not.toHaveBeenCalled();expect(writer).not.toHaveBeenCalled();view.unmount();
});
it('shows the newest partial rather than resurrecting an older successful result',()=>{
  render(<LegalPacketView caseFile={file([run('legal_generate_litigation_packet','LATEST_PARTIAL'),run('legal_generate_litigation_packet','OLD_SUCCESS','generated')])}/>);
  expect(screen.getByText('LATEST_PARTIAL')).toBeTruthy();expect(screen.queryByText('OLD_SUCCESS')).toBeNull();expect(screen.queryByRole('button',{name:'archive-to-case'})).toBeNull();
});
it('restores a legacy result only by exact materialId and excludes original source material',()=>{
  const old:any=run('legal_generate_litigation_packet','');delete old.displayText;old.materialIds=['linked','source'];
  render(<LegalPacketView caseFile={file([old],[{id:'unrelated',source:'tool',type:'note',title:'same-looking title',content:'UNRELATED_RESULT'},{id:'linked',source:'tool',type:'pleading',title:'A different title',content:'EXACT_LINKED_BODY'},{id:'source',source:'manual',type:'evidence',title:'Source original',content:'RAW_SOURCE_NOT_RESULT'}])}/>);
  expect(screen.getByText('EXACT_LINKED_BODY')).toBeTruthy();expect(screen.queryByText('UNRELATED_RESULT')).toBeNull();
  expect(document.querySelector('article')!.textContent).not.toContain('RAW_SOURCE_NOT_RESULT');
});
it('does not overwrite a current attempt or editor on metadata refresh, and preserves its real failure',async()=>{
  let finish!:(value:any)=>void;fixture.net.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  const current=file([run('legal_generate_litigation_packet','OLD_HISTORY')]);const view=render(<LegalPacketView caseFile={current}/>);
  fireEvent.change(screen.getByPlaceholderText('facts-timeline-parties'),{target:{value:'Current edited facts'}});
  fireEvent.click(screen.getByRole('button',{name:'generate-packet'}));expect(screen.queryByText('OLD_HISTORY')).toBeNull();
  view.rerender(<LegalPacketView caseFile={{...current,title:'Metadata refreshed',workflowRuns:[run('legal_generate_litigation_packet','MIDFLIGHT_HISTORY')]}}/>);
  expect((screen.getByPlaceholderText('facts-timeline-parties') as HTMLTextAreaElement).value).toBe('Current edited facts');
  await act(async()=>finish({text:'CURRENT_PARTIAL',receipt:{ok:false,status:'partial'},verification:{status:'failed'},caseUpdates:[]}));
  await screen.findByText('Error: CURRENT_PARTIAL');expect(screen.queryByText('MIDFLIGHT_HISTORY')).toBeNull();expect(screen.queryByRole('button',{name:'archive-to-case'})).toBeNull();
  await waitFor(()=>expect((screen.getByRole('button',{name:'generate-packet'}) as HTMLButtonElement).disabled).toBe(false));
});
it('does not recover a different tool or case result',()=>{
  const view=render(<LegalPacketView key="first" caseFile={file([run('legal_case_strategy','OTHER_TOOL_RESULT')])}/>);
  expect(screen.queryByText('OTHER_TOOL_RESULT')).toBeNull();
  view.rerender(<LegalPacketView key="second" caseFile={{...file([]),id:'different-case'}}/>);expect(document.querySelector('article')).toBeNull();
});
