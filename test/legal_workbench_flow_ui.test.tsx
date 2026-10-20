// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LegalStrategyView} from '../src/components/org/legal_hub/strategy';
import {LegalVerifyView} from '../src/components/org/legal_hub/verification';
import {LegalCaseWorkspace} from '../src/components/org/legal_hub/workspace';
const fx=vi.hoisted(()=>({tool:vi.fn(),api:vi.fn(),domain:'personal',org:'',user:'flow-owner'}));
vi.mock('../src/contexts/AppContext',()=>({useApp:()=>({user:{uid:fx.user},workDomain:fx.domain,orgConnection:{orgId:fx.org,connected:true,orgRole:'owner'}})}));
vi.mock('../src/lib/legalToolClient',()=>({runLegalTool:fx.tool}));
vi.mock('../src/services/apiClient',()=>({apiJson:fx.api}));
vi.mock('../src/lib/legalCaseStore',async original=>({...await original<typeof import('../src/lib/legalCaseStore')>(),syncPersonalLegalCaseToRuntime:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../src/lib/useT',()=>({useT:()=>({langCode:'en',legalCaseStrategyAnalyze:'analyze',legalCaseStrategyTitle:'Strategy',legalCaseStrategyDesc:'Description',legalVerifyCitationVerify:'verify',legalVerifyCitationTitle:'Citation',legalVerifyCitationDesc:'Description'})}));
vi.mock('../src/i18n/uiMessages',()=>({uiMessage:(key:string)=>key.split('.')[1],formatUiMessage:(key:string)=>key.split('.')[1]}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn(),info:vi.fn()}}));
beforeEach(()=>{fx.tool.mockReset().mockResolvedValue('REAL_CURRENT_RESULT');fx.api.mockReset().mockRejectedValue(new Error('No unselected material reads'));fx.domain='personal';fx.org='';fx.user='flow-owner';});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const chooseTool=(tool:string)=>{const summary=screen.getByText('Advanced options');if(!summary.closest('details')?.open)fireEvent.click(summary);fireEvent.change(screen.getByRole('combobox',{name:'Work content'}),{target:{value:tool}});};
const run=(tool:string,displayText:string)=>({tool,displayText,status:'partial',ok:false,checkedAt:'2026-10-15T05:00:00Z',basis:'old',materialIds:[],artifacts:[]});
const file=(runs:any[]=[])=>({id:'flow-case',title:'Virtual flow',party:'Virtual A/B',cause:'contract',court:'',caseNumber:'',judge:'',stage:'consultation',factDate:'2026-09-01',hearingDate:'',judgmentDate:'',appealDeadline:'',enforcementDeadline:'',notes:'ORIGINAL_FACTS\n【材料归档】OLD_GENERATED_TITLE',materials:[{id:'latest-result',source:'tool',type:'note',title:'Latest generated report',content:'LATEST_GENERATED_BODY',createdAt:'2026-10-15'},{id:'draft',source:'manual',type:'pleading',title:'模拟起诉状',content:'DRAFT_ORIGINAL_BODY',createdAt:'2026-10-14'}],workflowRuns:runs,createdAt:'',updatedAt:''} as any);
const props=(c=file())=>({activeCase:c,cases:[c],caseFilter:'',setCaseFilter:vi.fn(),onCreateCase:vi.fn(),onDeleteCase:vi.fn(),onSelectCase:vi.fn(),onUpdateCase:vi.fn(()=>true),onSetView:vi.fn(),onStartConsultation:vi.fn(),onOpenMeetingNotes:vi.fn(),onCreateReminder:vi.fn(),onCreatePlan:vi.fn(),onAddMaterial:vi.fn(()=>true),onRemoveMaterial:vi.fn().mockResolvedValue(true),onRefreshCases:vi.fn(),orgBacked:false,canDeleteCases:false,refreshing:false});
it('keeps the overview factual and does not auto-open the newest generated body or write old records',()=>{
 const p=props(),mount=render(<LegalCaseWorkspace {...p}/>);
 expect(mount.container.querySelector('pre')).toBeNull();expect(screen.queryByRole('button',{name:'从案件移除'})).toBeNull();
 expect((screen.getByPlaceholderText('record-statements-issues-evidence-gaps') as HTMLTextAreaElement).value).toBe('ORIGINAL_FACTS');
 expect(p.onUpdateCase).not.toHaveBeenCalled();expect(fx.api).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:/Latest generated report/}));expect(mount.container.querySelector('pre')?.textContent).toBe('LATEST_GENERATED_BODY');
 expect(screen.getByRole('button',{name:'从案件移除'})).toBeTruthy();
});
it('keeps the unique case-plan action but removes direct generation and repeated tool shortcuts from the overview',()=>{
 const p=props();render(<LegalCaseWorkspace {...p}/>);fireEvent.click(screen.getByRole('button',{name:'case-plan'}));expect(p.onCreatePlan).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole('button',{name:'engagement-letter'})).toBeNull();expect(screen.queryByRole('button',{name:'reasoning-matrix'})).toBeNull();expect(screen.queryByRole('button',{name:'Document review'})).toBeNull();expect(fx.tool).not.toHaveBeenCalled();
});
it('defaults to strategy even when a newer specialist matrix exists, preserving both histories without a request',()=>{
 render(<LegalStrategyView caseFile={file([run('legal_case_reasoning_matrix','MATRIX_HISTORY'),run('legal_case_strategy','STRATEGY_HISTORY')])}/>);
 expect(screen.getByText('STRATEGY_HISTORY')).toBeTruthy();expect(screen.queryByText('MATRIX_HISTORY')).toBeNull();
 chooseTool('legal_case_strategy');
 expect(screen.getByText('STRATEGY_HISTORY')).toBeTruthy();expect(screen.queryByText('MATRIX_HISTORY')).toBeNull();
 chooseTool('legal_case_reasoning_matrix');expect(screen.getByText('MATRIX_HISTORY')).toBeTruthy();expect(fx.tool).not.toHaveBeenCalled();
});
it('aborts the outgoing strategy form and never displays its late response as a matrix result',async()=>{
 let finish!:(s:string)=>void;fx.tool.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));render(<LegalStrategyView caseFile={file()}/>);
 fireEvent.click(screen.getByRole('button',{name:'analyze'}));await waitFor(()=>expect(fx.tool).toHaveBeenCalledTimes(1));const oldSignal=fx.tool.mock.calls[0][2] as AbortSignal;
 chooseTool('legal_case_reasoning_matrix');expect(oldSignal.aborted).toBe(true);
 await act(async()=>finish('LATE_STRATEGY_ONLY'));expect(screen.queryByText('LATE_STRATEGY_ONLY')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'reasoning-matrix'}));await screen.findByText('REAL_CURRENT_RESULT');expect(fx.tool.mock.calls[1][0]).toBe('legal_case_reasoning_matrix');expect(fx.tool.mock.calls[1][1]).toMatchObject({caseId:'flow-case',writeFiles:true});
});
it('isolates the matrix editor and output on a case change',async()=>{
 const mount=render(<LegalStrategyView caseFile={file()}/>);chooseTool('legal_case_reasoning_matrix');fireEvent.click(screen.getByRole('button',{name:'reasoning-matrix'}));await screen.findByText('REAL_CURRENT_RESULT');
 mount.rerender(<LegalStrategyView caseFile={{...file(),id:'another-case',notes:'OTHER_FACTS',materials:[]}}/>);expect(screen.queryByText('REAL_CURRENT_RESULT')).toBeNull();expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('OTHER_FACTS');
});
it('keeps citation and formal-delivery histories separate, and does not use the citation result as a draft',()=>{
 render(<LegalVerifyView caseFile={file([run('legal_finalize_delivery_package','FORMAL_HISTORY'),run('legal_verify_citation','CITATION_HISTORY')])}/>);
 expect(screen.getByText('FORMAL_HISTORY')).toBeTruthy();expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('DRAFT_ORIGINAL_BODY');
 chooseTool('legal_verify_citation');expect(screen.getByText('CITATION_HISTORY')).toBeTruthy();expect(screen.queryByText('FORMAL_HISTORY')).toBeNull();expect(fx.tool).not.toHaveBeenCalled();
});
it('formal delivery uses the explicitly selected material and server-owned archive only',async()=>{
 const writer=vi.fn();render(<LegalVerifyView caseFile={file()} onAddMaterial={writer}/>);chooseTool('legal_finalize_delivery_package');
 fireEvent.change(screen.getByRole('combobox',{name:'Document source'}),{target:{value:'draft'}});fireEvent.click(screen.getByRole('button',{name:'Document review'}));await screen.findByText('REAL_CURRENT_RESULT');
 expect(fx.tool).toHaveBeenCalledWith('legal_finalize_delivery_package',expect.objectContaining({caseId:'flow-case',content:'DRAFT_ORIGINAL_BODY',documentType:'起诉状',includeDocx:true,includePdf:false}),expect.any(AbortSignal));
 expect(screen.queryByRole('button',{name:'archive-to-case'})).toBeNull();expect(writer).not.toHaveBeenCalled();
});
it('preserves the explicit citation archive path while keeping formal history out of its input',async()=>{
 const writer=vi.fn(()=>true);render(<LegalVerifyView caseFile={file()} onAddMaterial={writer}/>);chooseTool('legal_verify_citation');fireEvent.click(screen.getByRole('button',{name:'verify'}));await screen.findByText('REAL_CURRENT_RESULT');
 fireEvent.click(screen.getByRole('button',{name:'archive-to-case'}));await waitFor(()=>expect(writer).toHaveBeenCalledTimes(1));expect(writer.mock.calls[0]).toEqual(['note',expect.any(String),'REAL_CURRENT_RESULT','tool']);
});
it('keeps the notice original once without overwriting the fact summary or manually re-archiving the server result',async()=>{
 const p=props();render(<LegalCaseWorkspace {...p}/>);const message='开庭时间：2026年10月30日 https://example.invalid/virtual.pdf';
 fireEvent.change(screen.getByPlaceholderText('paste-sms-or-court-notice'),{target:{value:message}});fireEvent.click(screen.getByRole('button',{name:'process-link'}));await waitFor(()=>expect(fx.tool).toHaveBeenCalledTimes(1));await screen.findByText('REAL_CURRENT_RESULT');
 expect(p.onUpdateCase).toHaveBeenCalledWith('flow-case',{hearingDate:'2026-10-30'});expect(p.onAddMaterial).toHaveBeenCalledTimes(1);expect(p.onAddMaterial).toHaveBeenCalledWith('note','hearing-notice-sms',message,'notice');expect(fx.tool.mock.calls[0][0]).toBe('legal_process_notice_link');
});

it('aborts a formal request when the selected source changes and never attaches its late success to another material',async()=>{
 let finish!:(s:string)=>void;fx.tool.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));render(<LegalVerifyView caseFile={file()}/>);
 chooseTool('legal_finalize_delivery_package');fireEvent.click(screen.getByRole('button',{name:'Document review'}));await waitFor(()=>expect(fx.tool).toHaveBeenCalledTimes(1));const signal=fx.tool.mock.calls[0][2] as AbortSignal;
 fireEvent.change(screen.getByRole('combobox',{name:'Document source'}),{target:{value:'latest-result'}});expect(signal.aborted).toBe(true);await act(async()=>finish('OLD_DRAFT_DELIVERY'));
 expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('LATEST_GENERATED_BODY');expect(screen.queryByText('OLD_DRAFT_DELIVERY')).toBeNull();expect(screen.queryByText('result-ready')).toBeNull();
});
it('clears the current formal success when selecting a different draft, without a new request or archive',async()=>{
 const writer=vi.fn();render(<LegalVerifyView caseFile={file()} onAddMaterial={writer}/>);chooseTool('legal_finalize_delivery_package');fireEvent.click(screen.getByRole('button',{name:'Document review'}));await screen.findByText('REAL_CURRENT_RESULT');
 fireEvent.change(screen.getByRole('combobox',{name:'Document source'}),{target:{value:'latest-result'}});expect(screen.queryByText('REAL_CURRENT_RESULT')).toBeNull();expect(screen.queryByText('result-ready')).toBeNull();expect(fx.tool).toHaveBeenCalledTimes(1);expect(writer).not.toHaveBeenCalled();
});

it('does not silently select another formal draft when the chosen material is removed',()=>{
 const c={...file(),materials:[{id:'a',title:'Draft A',type:'pleading',content:'DRAFT_A',source:'manual'},{id:'b',title:'Draft B',type:'pleading',content:'DRAFT_B',source:'manual'}]};const mount=render(<LegalVerifyView caseFile={c}/>);
 chooseTool('legal_finalize_delivery_package');expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('DRAFT_A');
 mount.rerender(<LegalVerifyView caseFile={{...c,materials:[c.materials[1]]}}/>);expect((screen.getByRole('combobox',{name:'Document source'}) as HTMLSelectElement).value).toBe('');expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
});

it('keeps specialist modes collapsed and performs only the requested default document review',async()=>{
 render(<LegalVerifyView caseFile={file()}/>);const advanced=screen.getByText('Advanced options').closest('details');expect(advanced?.open).toBe(false);expect(screen.getByRole('combobox',{name:'Work content'}).closest('details')).toBe(advanced);expect(fx.tool).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Document review'}));await screen.findByText('REAL_CURRENT_RESULT');expect(fx.tool).toHaveBeenCalledTimes(1);expect(fx.tool.mock.calls[0][0]).toBe('legal_finalize_delivery_package');
});
