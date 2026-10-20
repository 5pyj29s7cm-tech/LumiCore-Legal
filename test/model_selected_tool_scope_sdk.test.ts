import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import texts from './fixtures/model-selected-tool-scope/captured-task-texts.json';
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';
const roles=Array.from({length:11},(_,i)=>'role-'+i);
function registryProbe(required:boolean) {
 const registry=new ToolRegistry();const handler=vi.fn(async(args:Record<string,unknown>)=>JSON.stringify({ok:true,role:args.role??null}));
 registry.register({name:'sdk_enum_probe',description:'Read the explicitly selected synthetic role.',parameters:{type:'object',properties:{role:{type:'string',enum:roles},detail:{type:'string'}},required:required?['role']:[]},permission:'public',securityLevel:'safe',evidence:{capability:'fixture.sdk.enum',operation:'observe',assurance:'observed',subjectArgument:'role'},handler});return{registry,handler};
}
async function execute(registry:ToolRegistry,text:string,args:Record<string,unknown>,id:string) {
 const json=JSON.stringify(args);const split=Math.floor(json.length/2);
 const frames=[{choices:[{delta:{content:'Inspect the selected synthetic role.'}}]},
 {choices:[{delta:{tool_calls:[{index:0,id,type:'function',function:{name:'sdk_enum_probe',arguments:json.slice(0,split)}}]}}]},
 {choices:[{delta:{tool_calls:[{index:0,function:{arguments:json.slice(split)}}]}}]},
 {choices:[{delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:8,total_tokens:28}}];
 const transport=vi.fn(async()=>new Response(frames.map(f=>'data: '+JSON.stringify(f)+'\n\n').join('')+'data: [DONE]\n\n',{status:200,headers:{'Content-Type':'text/event-stream'}}));
 const sdk=new OpenAI({apiKey:'synthetic-not-a-real-key',maxRetries:0,fetch:transport});
 const result=await runWithTools([{role:'user',content:text}],registry,{provider:'deepseek',model:'synthetic-enum-sdk',selectionMode:'pinned'},undefined,1,()=>sdk,()=>null,()=>null,()=>null,()=>null,()=>{});
 return{result,transport};
}
describe('installed SDK SSE through actual provider, adapter and registry',()=>{
 it('executes one fragmented explicit enum call under captured meme text, with no fanout or extra SDK request',async()=>{
  const {registry,handler}=registryProbe(true);const args={role:roles[6],detail:'retain the full model-selected detail'};
  const {result,transport}=await execute(registry,texts.meme,args,'sdk-one');expect(transport).toHaveBeenCalledTimes(1);expect(handler).toHaveBeenCalledTimes(1);expect(handler.mock.calls[0][0]).toEqual(args);expect(result.toolCalls.map(r=>({id:r.id,arguments:r.arguments}))).toEqual([{id:'sdk-one',arguments:args}]);
 });
 it('preserves an optional enum value assembled by the SDK rather than deleting it for a broad request',async()=>{
  const {registry,handler}=registryProbe(false);const args={role:roles[7],detail:'explicit optional choice'};
  const {result,transport}=await execute(registry,'Read every required fixture; this selected call is role-7.',args,'sdk-optional');expect(transport).toHaveBeenCalledTimes(1);expect(handler).toHaveBeenCalledTimes(1);expect(handler.mock.calls[0][0]).toEqual(args);expect(result.toolCalls[0].arguments).toEqual(args);
 });
});
