import { beforeEach, describe, expect, it, vi } from 'vitest';
import texts from './fixtures/model-selected-tool-scope/captured-task-texts.json';
const mocks = vi.hoisted(() => ({ makeLLMCall: vi.fn() }));
vi.mock('../server/llm/providers', async () => {
 const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
 return { ...actual, makeLLMCall: mocks.makeLLMCall };
});
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';
const roles = Array.from({length:11},(_,i)=>'role-'+i);
const getters = [()=>null,()=>null,()=>null,()=>null,()=>null] as const;
function probe(required=true) {
 const registry=new ToolRegistry();
 const handler=vi.fn(async (args: Record<string,unknown>)=>JSON.stringify({ok:true,role:args.role??null}));
 registry.register({name:'fixture_enum_probe',description:'Observe one explicitly selected fixture role.',parameters:{type:'object',properties:{role:{type:'string',enum:roles},detail:{type:'string'}},required:required?['role']:[]},permission:'public',securityLevel:'safe',evidence:{capability:'fixture.enum.observe',operation:'observe',assurance:'observed',subjectArgument:'role'},handler});
 return {registry,handler};
}
async function run(registry:ToolRegistry, text:string, iterations=1,context?:any) {
 return runWithTools([{role:'user',content:text}],registry,{provider:'deepseek',model:'enum-authority-fixture'},undefined,iterations,...getters,undefined,context);
}
const call=(id:string,role:string)=>({id,name:'fixture_enum_probe',arguments:{role,detail:'model-selected detail'}});
function noBudget(result: Awaited<ReturnType<typeof run>>) { expect(result.toolCalls.some(r=>r.name==='lumi_tool_invocation_budget')).toBe(false); }
beforeEach(()=>{vi.clearAllMocks();mocks.makeLLMCall.mockReset();mocks.makeLLMCall.mockResolvedValue({text:'Fixture observation complete.',toolCalls:[]});});
describe('model-selected enum scope through the real adapter and registry',()=>{
 it('does not multiply a model-selected call under the exact captured meme text',async()=>{
  const {registry,handler}=probe(); const selected=call('explicit-one',roles[3]);
  mocks.makeLLMCall.mockResolvedValueOnce({text:'Observe only this selected role.',toolCalls:[selected]});
  const result=await run(registry,texts.meme);expect(handler).toHaveBeenCalledTimes(1);expect(handler.mock.calls[0][0]).toEqual(selected.arguments);
  expect(result.toolCalls.filter(r=>r.name===selected.name).map(r=>({id:r.id,arguments:r.arguments}))).toEqual([{id:selected.id,arguments:selected.arguments}]);noBudget(result);
 });
 it('does not turn four explicitly chosen calls into fourteen under the captured full-story text',async()=>{
  const {registry,handler}=probe();const simple=vi.fn(async(args:Record<string,unknown>)=>JSON.stringify({ok:true,...args}));
  for(let i=0;i<3;i++)registry.register({name:'fixture_read_'+i,description:'Read one synthetic fixture.',parameters:{type:'object',properties:{index:{type:'number'}},required:['index']},permission:'public',securityLevel:'safe',handler:simple});
  const selected=[call('selected-role',roles[5]),...Array.from({length:3},(_,i)=>({id:'read-'+i,name:'fixture_read_'+i,arguments:{index:i}}))];
  mocks.makeLLMCall.mockResolvedValueOnce({text:'Four selected fixture observations.',toolCalls:selected});
  const result=await run(registry,texts.full);expect(handler).toHaveBeenCalledTimes(1);expect(simple).toHaveBeenCalledTimes(3);expect(result.toolCalls.map(r=>({id:r.id,name:r.name,arguments:r.arguments}))).toEqual(selected);noBudget(result);
 });
 it('retains an explicitly chosen optional subject instead of deleting it for a broad goal',async()=>{
  const {registry,handler}=probe(false);const selected=call('optional-subject',roles[4]);
  mocks.makeLLMCall.mockResolvedValueOnce({text:'Only this role was selected.',toolCalls:[selected]});
  const result=await run(registry,'检查全部能力，但本次模型选择仅查 role-4。');expect(handler).toHaveBeenCalledTimes(1);expect(handler.mock.calls[0][0]).toEqual(selected.arguments);expect(result.toolCalls[0].arguments).toEqual(selected.arguments);noBudget(result);
 });
 it('preserves a singular selection and assigns only a missing call ID',async()=>{
  const {registry,handler}=probe();mocks.makeLLMCall.mockResolvedValueOnce({text:'One role.',toolCalls:[{name:'fixture_enum_probe',arguments:{role:roles[2]}}]});
  const result=await run(registry,'Observe role-2 only.');expect(handler).toHaveBeenCalledTimes(1);expect(result.toolCalls[0].id).toBeTruthy();expect(result.toolCalls[0].arguments).toEqual({role:roles[2]});noBudget(result);
 });
 it('executes an explicit bounded 8+3 model sequence without inventing extra calls',async()=>{
  const {registry,handler}=probe();const first=roles.slice(0,8).map((r,i)=>call('batch-a-'+i,r));const second=roles.slice(8).map((r,i)=>call('batch-b-'+i,r));
  mocks.makeLLMCall.mockResolvedValueOnce({text:'First bounded eight.',toolCalls:first}).mockResolvedValueOnce({text:'Remaining three.',toolCalls:second});
  const result=await run(registry,'Observe every fixture role in explicit bounded batches.',2);expect(handler).toHaveBeenCalledTimes(11);expect(handler.mock.calls.map(args=>(args[0] as any).role)).toEqual(roles);expect(result.toolCalls.map(r=>r.id)).toEqual([...first,...second].map(c=>c.id));expect(mocks.makeLLMCall).toHaveBeenCalledTimes(2);noBudget(result);
 });
 it('leaves tool-exposure enforcement in charge of an unexposed model call',async()=>{
  const {registry,handler}=probe();mocks.makeLLMCall.mockResolvedValueOnce({text:'Invalid undeclared call.',toolCalls:[{id:'unknown',name:'not_declared',arguments:{role:roles[0]}}]});
  const result=await run(registry,'Observe every fixture role.');expect(handler).not.toHaveBeenCalled();expect(result.toolCalls).toHaveLength(0);
 });
 it('stops the remaining explicit batch when the caller cancels after the first adapter',async()=>{
  const {registry,handler}=probe();let cancelled=false;handler.mockImplementation(async args=>{cancelled=true;return JSON.stringify({ok:true,...args});});
  mocks.makeLLMCall.mockResolvedValueOnce({text:'Two explicitly chosen calls.',toolCalls:[call('cancel-first',roles[0]),call('cancel-second',roles[1])]});
  const result=await run(registry,'Observe every fixture role.',1,{isCancelled:()=>cancelled});expect(handler).toHaveBeenCalledTimes(1);expect(result.toolCalls.filter(r=>r.adapterStarted).map(r=>r.id)).toEqual(['cancel-first']);
 });
});
