import './helpers';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import {beforeAll,beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {initDatabase} from '../db_layer';
import {runWithTools} from '../server/llm/adapter';
import {ToolRegistry} from '../server/tools/registry';
import {encodeToolResult} from '../server/tools/result_envelope';
import {guardModelTerminalResponse} from '../server/llm/tool_loop/projection';
const actual=JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/nda_terminal_request.json',import.meta.url)),'utf8'));
beforeAll(initDatabase);beforeEach(()=>{vi.stubEnv('LUMI_PRIVACY','standard');vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No actual network'));});afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllEnvs();});
const source='Synthetic original source text retained completely.';
function setup(opts:{execution?:boolean;format?:any;abort?:boolean;localOnly?:boolean;tool?:boolean}={}){
 const requestId=crypto.randomUUID(),taskId=crypto.randomUUID(),task='读取测试上下文并呈现原文。',controller=new AbortController(),registry=new ToolRegistry(),wire:any[]=[],handler=vi.fn(async()=>encodeToolResult(source,{ok:true,status:'verified'}));
 registry.register({name:'read_fixture',description:'Read offline synthetic fixture',parameters:{type:'object',properties:{}},permission:'public',securityLevel:'safe',capability:{id:'test.fixture.read',family:'test',lane:'system',operation:'observe',risk:'none',sideEffects:[{type:'local_read',scope:'synthetic fixture',reversible:true}],verification:{strategy:'terminal_receipt',required:true,requiredFields:['ok','status'],requiredValues:{ok:true},successStatuses:['verified'],successSignals:[],limitations:[]}},handler});
 const sdkFetch=vi.fn(async(_url:any,init:any)=>{const body=JSON.parse(String(init.body));wire.push(body);if(opts.abort){controller.abort(new Error('Synthetic cancel'));throw controller.signal.reason;}const tool=opts.tool&&wire.length===1;const content=opts.execution?JSON.stringify({answer:source,goals:[{text:task,operation:opts.tool?'observe':'respond',effects:opts.tool?['local_read']:[],status:'completed',evidenceIds:opts.tool?['read-wire']:[]}]}):source;const chunk={id:'sse-'+wire.length,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:tool?{tool_calls:[{index:0,id:'read-wire',type:'function',function:{name:'read_fixture',arguments:'{}'}}]}:{content},finish_reason:tool?'tool_calls':'stop'}]};return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n',{status:200,headers:{'Content-Type':'text/event-stream'}});});
 const sdk=new OpenAI({apiKey:'synthetic-not-a-key',baseURL:'https://synthetic.invalid/v1',fetch:sdkFetch,maxRetries:0});
 const config:any={provider:'relay',model:'aliyun/deepseek-v4-flash',selectionMode:'pinned',noImplicitFailover:true,userId:'wire-'+requestId,requestId,signal:controller.signal,attemptTimeouts:{requestMs:1000,firstByteMs:1000,semanticContentMs:1000,idleMs:1000,absoluteMs:2000},...(opts.format?{responseFormat:opts.format}:{}),...(opts.localOnly?{dataRoutingPolicy:'local_only'}:{})};
 const chunks:string[]=[];const context:any={userId:config.userId,requestId,taskId,domain:'personal',source:'offline-wire',authenticated:true,authRole:'admin',localExecution:true,executionBoundary:'trusted_local',currentTurnExecutionRequested:opts.execution===true,completionRequest:{currentText:task}};
 return{wire,handler,sdkFetch,chunks,run:()=>runWithTools([{role:'user',content:task}],registry,config,undefined,3,()=>null,()=>null,()=>null,()=>null,()=>null,s=>chunks.push(s),context,()=>null,()=>null,()=>null,()=>null,()=>null,()=>null,()=>sdk)};
}
describe('execution terminal JSON format on actual SDK wire',()=>{
 it('requests the existing json_object format on both tool-selection and final calls without suppressing real tool calls',async()=>{const f=setup({execution:true,tool:true});const r=await f.run();expect(f.wire).toHaveLength(2);for(const req of f.wire){expect(req.response_format).toEqual({type:'json_object'});expect(req.stream).toBe(true);expect(req.tools.some((t:any)=>t.function.name==='read_fixture')).toBe(true);}expect(f.handler).toHaveBeenCalledOnce();expect(r.text).toBe(source);expect(r.completionGuard).toMatchObject({blocked:false,primaryGoalResult:true});expect(f.chunks).toEqual([]);});
 it('leaves ordinary chat format and streaming behavior unchanged',async()=>{const f=setup({execution:false});const r=await f.run();expect(f.wire).toHaveLength(1);expect(f.wire[0]).not.toHaveProperty('response_format');expect(r.text).toBe(source);expect(f.chunks.join('')).toBe(source);expect(f.handler).not.toHaveBeenCalled();});
 it.each([false,true])('preserves an explicitly configured JSON schema for execution=%s',async execution=>{const format={type:'json_schema',json_schema:{name:'caller_schema',schema:{type:'object',properties:{answer:{type:'string'}}},strict:true}};const f=setup({execution,format});await f.run();expect(f.wire).toHaveLength(1);expect(f.wire[0].response_format).toEqual(format);});
 it('preserves an explicitly configured json_object on ordinary chat',async()=>{const f=setup({format:'json_object'});await f.run();expect(f.wire[0].response_format).toEqual({type:'json_object'});});
 it('does not replay the SDK call or execute a tool after parent cancellation',async()=>{const f=setup({execution:true,abort:true,tool:true});await f.run().catch(()=>null);expect(f.sdkFetch).toHaveBeenCalledOnce();expect(f.handler).not.toHaveBeenCalled();});
 it('does not send any SDK request across local_only policy',async()=>{const f=setup({execution:true,localOnly:true});await f.run().catch(()=>null);expect(f.sdkFetch).not.toHaveBeenCalled();expect(f.handler).not.toHaveBeenCalled();});
});
describe('existing protocol diagnosis boundaries, not assertions about the uncaptured actual answer',()=>{
 it.each(['not-json',JSON.stringify({answer:4,goals:[]}),JSON.stringify({answer:' ',goals:[]})])('conflates parse/type/empty inputs into the current missing-answer code: %s',response=>{const r=guardModelTerminalResponse({task:actual.text,response,structured:true,toolCalls:[],requestId:'synthetic-request',taskId:'synthetic-task'});expect(r).toMatchObject({blocked:true,reason:'reply_answer_missing'});});
 it('does not prove whole-request coverage merely from one model-chosen substring goal',()=>{const r=guardModelTerminalResponse({task:actual.text,response:JSON.stringify({answer:'仍需核对。',goals:[{text:'只完成这份合同工作稿。',operation:'respond',effects:[],status:'completed',evidenceIds:[]}]}),structured:true,toolCalls:[],requestId:'synthetic-request',taskId:'synthetic-task'});expect(r).toMatchObject({blocked:false,primaryGoalResult:true,text:'仍需核对。'});});
});
