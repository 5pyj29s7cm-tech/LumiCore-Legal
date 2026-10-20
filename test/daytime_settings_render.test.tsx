// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import {render,cleanup,act,fireEvent} from '@testing-library/react';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {DEFAULT_GENERATION_PREFERENCES,DEFAULT_RETRIEVAL_MODEL_PREFERENCES} from '../src/components/settings/model_preferences';
import {setLocale} from '../src/i18n/runtime';
import {zhCatalog} from '../src/i18n/locales/catalog_zh';
import {SettingsView,buildSidebarGroups} from '../src/components/settings/navigation';
const state=vi.hoisted(()=>({calls:[] as string[],app:{user:{uid:'theme-fixture-user',role:'admin',name:'配色验收'},workDomain:'personal',orgConnection:null,appearanceMode:'light',resolvedAppearanceMode:'light',aiConfig:{provider:'relay',model:'aliyun/deepseek-v4-flash',thinking:false},visionConfig:{provider:'relay',model:''},logout:vi.fn(),setAppearanceMode:vi.fn(),switchDomain:vi.fn(),updateAIConfig:vi.fn(),reloadModelPreferences:vi.fn(),updateVisionConfig:vi.fn()}}));
vi.mock('../src/contexts/AppContext',()=>({useApp:()=>state.app}));
vi.mock('../src/services/socketService',()=>({socketService:{getSocket:()=>null}}));
vi.mock('../src/hooks/usePlatform',()=>({usePlatform:()=>({platform:'win32',isElectron:false})}));
function fixtureResponse(path:string){
 if(path==='/api/settings/keys')return {};
 if(path==='/api/preferences/generation')return structuredClone(DEFAULT_GENERATION_PREFERENCES);
 if(path==='/api/preferences/retrieval-model')return structuredClone(DEFAULT_RETRIEVAL_MODEL_PREFERENCES);
 if(path==='/api/preferences/world')return {provider:'inherit_vision',model:'',models:{}};
 if(path==='/api/mcp')return {servers:[{name:'legal-casework',transport:'stdio',command:'builtin',args:[],enabled:true}]};
 if(path==='/api/voice/active-provider')return {pref:{stt:'auto',tts:'auto',sttModel:'',ttsModel:''},active:{stt:null,tts:null,streamingStt:null}};
 if(path.includes('/llm/providers'))return {providers:{relay:{available:true,configured:true,enabled:true,status:'ready'}}};
 if(path.includes('/mcp/health'))return {servers:{'legal-casework':{status:'connected',toolCount:4}}};
 if(path.includes('/hardware'))return {devices:[],available:[],status:'ready'};
 if(path.includes('/models'))return {models:[],data:[],providers:{},ok:true};
 if(path.includes('/connections')||path.includes('/sources'))return {sources:[],connections:[],applications:[],items:[]};
 return {ok:true,enabled:false,models:[],services:[],providers:{},settings:{},preferences:{},items:[],sources:[],connections:[],data:[]};
}
vi.mock('../src/services/apiClient',()=>({apiUrl:(p:string)=>p,apiJson:async(p:string,init:any={})=>{state.calls.push(p);if(init.method&&init.method!=='GET')throw Error('UI fixture never submits changes');return fixtureResponse(p)},apiFetch:async(p:string,init:any={})=>{state.calls.push(p);if(init.method&&init.method!=='GET')throw Error('UI fixture never submits changes');return new Response(JSON.stringify(fixtureResponse(p)),{status:200,headers:{'Content-Type':'application/json'}})}}));
beforeAll(()=>{setLocale('zh');vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Network disabled in actual-component theme fixture')}));window.matchMedia=vi.fn().mockImplementation(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn(),addListener:vi.fn(),removeListener:vi.fn()}));});
afterEach(()=>cleanup());
const sections=[...buildSidebarGroups(zhCatalog).flatMap(g=>g.items.map(i=>i.id)),'applications'];
it.each(sections)('renders actual SettingsView section %s without external calls',async(section)=>{
 state.calls=[];const view=render(<div className="lumi-light-shell"><div className="os-window" style={{position:'relative',width:'1420px',height:'880px'}}><header className="os-window-header">设置</header><div className="os-window-content"><SettingsView t={zhCatalog} lang="zh" setLang={vi.fn()} activeSection={section} onSectionChange={vi.fn()}/></div></div></div>);
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,90))});
 expect(view.container.textContent!.length).toBeGreaterThan(50);
 const out='C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/legal-cooperative-20261014/closure-next/daytime-full-audit/settings-dom';fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/'+section+'.html',view.container.innerHTML);fs.writeFileSync(out+'/'+section+'.json',JSON.stringify({section,component:'actual SettingsView and actual section components',mocked:'AppContext/platform/API responses; network disabled, no model call, no user mutation',apiCalls:state.calls},null,2));
});

it.each([[1,'local'],[2,'services']] as const)('renders actual provider tab %s with readable controls',async(tabIndex,id)=>{
 const view=render(<div className="lumi-light-shell"><div className="os-window" style={{position:'relative',width:'1420px',height:'880px'}}><header className="os-window-header">设置</header><div className="os-window-content"><SettingsView t={zhCatalog} lang="zh" setLang={vi.fn()} activeSection="ai-providers" onSectionChange={vi.fn()}/></div></div></div>);
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,90))});fireEvent.click(view.getAllByRole('tab')[tabIndex]);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,90))});
 expect(view.getAllByRole('tab')[tabIndex].getAttribute('aria-selected')).toBe('true');
 const out='C:/Users/Administrator/Documents/Codex/2026-10-03/new-chat/work/legal-cooperative-20261014/closure-next/daytime-full-audit/settings-dom';fs.writeFileSync(out+'/ai-providers-'+id+'.html',view.container.innerHTML);fs.writeFileSync(out+'/ai-providers-'+id+'.json',JSON.stringify({section:'ai-providers',subview:id,component:'actual provider tab body',mocked:'AppContext/API; all network and mutations disabled'}));
});
