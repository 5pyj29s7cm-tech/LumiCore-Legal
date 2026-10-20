import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { runLegalLLM } from '../server/regions/packs/cn/legal_tools/context';
import { analyzeScreen } from '../server/llm/tool_loop/vision';
import { makeLLMCallDirect } from '../server/llm/providers';
import { saveLocalModelConfig } from '../server/llm/local_models';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { createRequire } from 'node:module';
import { ocrImageFile } from '../server/tools/definitions/ocr_tools';
import { upsertUserPreferredVision } from '../server/llm/vision_preferences';
import { isSuccessfulExactDocumentRead, documentReadMatchesRequestedTarget } from '../server/cognition/action_desktop_evidence';
import { resetCircuit } from '../server/cloud/circuit_breaker';
beforeAll(() => initDatabase());
afterEach(() => {vi.restoreAllMocks();vi.unstubAllEnvs();resetCircuit();});
const unavailable=()=>null;
const completion=(content:string)=>({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]});
describe('lawyer local model boundary reaches actual provider calls', () => {
  it('does not drop a trusted local_only policy from the legal subtask context', async () => {
    vi.stubEnv('LUMI_PRIVACY','standard');
    const userId='legal-local-only-owner';upsertUserPreferredLLM(userId,{provider:'openai',model:'synthetic-cloud-legal',selectionMode:'pinned',fallbackCandidates:[],allowCloudFallback:false});
    const cloud=vi.fn(async()=>completion('SYNTHETIC CLOUD RESULT MUST NOT RUN'));
    await expect(runLegalLLM('虚构刑事材料：事实和原件均待核实。',{userId,domain:'personal',dataRoutingPolicy:'local_only',llmGetters:{getDeepSeek:unavailable,getGemini:unavailable,getOpenAI:()=>({chat:{completions:{create:cloud}}})}})).rejects.toThrow(/Local-only/);
    expect(cloud).not.toHaveBeenCalled();
  });
  it('keeps a text-only local visual failure on its selected perception role rather than a cloud reasoning fallback', async () => {
    vi.stubEnv('LUMI_PRIVACY','standard');const userId='same-local-vision-and-brain',model='synthetic-text-only';
    upsertUserPreferredLLM(userId,{provider:'lmstudio',model,selectionMode:'pinned',fallbackCandidates:[{provider:'openai',model:'synthetic-cloud-fallback'}],allowCloudFallback:true});
    saveLocalModelConfig('lmstudio',{baseUrl:'http://127.0.0.1:1234',detected:true,models:[model],serviceReachable:true,inferenceHealthy:true,probedModel:model});
    const local=vi.fn(async()=>{throw new Error('400 Text-only model does not support image input');});const cloud=vi.fn(async()=>completion('CLOUD MUST NOT RECEIVE IMAGE'));
    await expect(analyzeScreen('U1lOVEhFVElDLUlNQUdFLURBVEE=','仅识别虚构证据图片中的文字',{provider:'lmstudio',model,userId},unavailable,unavailable,()=>({chat:{completions:{create:cloud}}}),unavailable,unavailable,unavailable,()=>({chat:{completions:{create:local}}}))).rejects.toThrow(/image input|local/i);
    expect(local).toHaveBeenCalledOnce();expect(cloud).not.toHaveBeenCalled();
    const messages=(local.mock.calls[0] as any[])[0].messages;
    expect(messages.some((message:any)=>Array.isArray(message.content)&&message.content.some((part:any)=>part.type==='image_url'&&part.image_url.url.includes('U1lOVEhFVElDLUlNQUdFLURBVEE=')))).toBe(true);
  });
  it('blocks remote endpoints labeled lmstudio even when only the current request is local_only', async () => {
    vi.stubEnv('LUMI_PRIVACY','standard');const model='synthetic-remote-local';saveLocalModelConfig('lmstudio',{baseUrl:'https://private-prompt.example.test',detected:true,models:[model],serviceReachable:true,inferenceHealthy:true,probedModel:model});
    const create=vi.fn(async()=>completion('REMOTE MUST NOT RUN'));const getter=vi.fn(()=>({chat:{completions:{create}}}));
    await expect(makeLLMCallDirect([{role:'user',content:'SYNTHETIC PRIVATE DATA'}],[],{provider:'lmstudio',model,dataRoutingPolicy:'local_only',noImplicitFailover:true},unavailable,unavailable,unavailable,unavailable,unavailable,unavailable,getter)).rejects.toThrow(/Privacy/);
    expect(getter).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
  });
  it('retains ordinary standard-mode remote configuration when no local_only policy was requested', async () => {
    vi.stubEnv('LUMI_PRIVACY','standard');const model='synthetic-standard-remote';saveLocalModelConfig('lmstudio',{baseUrl:'https://configured.example.test',detected:true,models:[model],serviceReachable:true,inferenceHealthy:true,probedModel:model});
    const create=vi.fn(async()=>completion('synthetic configured result'));
    const result=await makeLLMCallDirect([{role:'user',content:'PUBLIC SYNTHETIC DATA'}],[],{provider:'lmstudio',model,noImplicitFailover:true},unavailable,unavailable,unavailable,unavailable,unavailable,unavailable,()=>({chat:{completions:{create}}}));
    expect(result.text).toBe('synthetic configured result');expect(create).toHaveBeenCalledOnce();
  });
  it('overrides only the current SDK request fetch and refuses a local-to-remote redirect', async () => {
    vi.stubEnv('LUMI_PRIVACY','standard');let posted=0;
    const server=http.createServer((request,response)=>{if(request.method==='POST'){posted++;response.writeHead(302,{Location:'https://never-fetch.example.test/private'});response.end();}else{response.writeHead(404);response.end('{}');}});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=(server.address() as any).port,model='synthetic-loopback-model';
    saveLocalModelConfig('lmstudio',{baseUrl:'http://127.0.0.1:'+port,detected:true,models:[model],serviceReachable:true,inferenceHealthy:true,probedModel:model});
    const client=new OpenAI({apiKey:'synthetic-local',baseURL:'http://127.0.0.1:'+port+'/v1',maxRetries:0});const cloning=vi.spyOn(client,'withOptions');
    try{await expect(makeLLMCallDirect([{role:'user',content:'SYNTHETIC PRIVATE REDIRECT DATA'}],[],{provider:'lmstudio',model,dataRoutingPolicy:'local_only',noImplicitFailover:true},unavailable,unavailable,unavailable,unavailable,unavailable,unavailable,()=>client)).rejects.toThrow();expect(posted).toBe(1);expect(cloning).toHaveBeenCalledOnce();expect(cloning.mock.results[0].value).not.toBe(client);expect(client.baseURL).toBe('http://127.0.0.1:'+port+'/v1');}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('reports a missing perception provider without inventing OCR content or proof of a document read', async () => {
    const file=path.join(os.tmpdir(),'lumi-missing-perception-'+crypto.randomUUID()+'.png');fs.writeFileSync(file,'synthetic placeholder, never decoded when provider is absent');
    try{const result=JSON.parse(await ocrImageFile({imagePath:file},{userId:'no-vision-provider',llmGetters:{}}));expect(result.note).toContain('No configured visual-perception');expect(result.analysis).toBeUndefined();expect(isSuccessfulExactDocumentRead({name:'ocr_image_file',arguments:{imagePath:file},result:JSON.stringify(result)} as any)).toBe(false);}finally{fs.unlinkSync(file);}
  });
  it('transmits an actual image derivative to the selected local endpoint and preserves the original bytes', async () => {
    vi.stubEnv('LUMI_PRIVACY','standard');const userId='ocr-local-file-owner',model='synthetic-local-vision';upsertUserPreferredVision(userId,{provider:'lmstudio',model});saveLocalModelConfig('lmstudio',{baseUrl:'http://127.0.0.1:1234',detected:true,models:[model],serviceReachable:true,inferenceHealthy:true,probedModel:model});
    const require=createRequire(import.meta.url),sharp=require('sharp');const original=await sharp({create:{width:180,height:100,channels:3,background:{r:240,g:170,b:80}}}).png().toBuffer();const file=path.join(os.tmpdir(),'lumi-ocr-local-source-'+crypto.randomUUID()+'.png');fs.writeFileSync(file,original);
    const create=vi.fn(async()=>completion('仅测试图像传输，内容未识别、刑事事实和证据真实性均未核准。'));
    try{const result=JSON.parse(await ocrImageFile({imagePath:file,query:'读取虚构案件图片，不解释刑事定罪事实。'},{userId,dataRoutingPolicy:'local_only',llmGetters:{getDeepSeek:unavailable,getGemini:unavailable,getLmStudio:()=>({chat:{completions:{create}}})}}));expect(result.error).toBeUndefined();expect(result.provider).toBe('lmstudio');expect(isSuccessfulExactDocumentRead({name:'ocr_image_file',arguments:{imagePath:file},result:JSON.stringify(result),terminalVerification:{status:'verified'}} as any)).toBe(true);expect(isSuccessfulExactDocumentRead({name:'ocr_image_file',arguments:{imagePath:file},result:JSON.stringify({path:file,error:'local image input unsupported'}),terminalVerification:{status:'failed'}} as any)).toBe(false);expect(isSuccessfulExactDocumentRead({name:'ocr_image_file',arguments:{imagePath:file},result:JSON.stringify({path:file,analysis:{metadata:'not actual OCR text'}})} as any)).toBe(false);expect(create).toHaveBeenCalledOnce();const parts=(create.mock.calls[0] as any[])[0].messages.flatMap((message:any)=>Array.isArray(message.content)?message.content:[]),image=parts.find((part:any)=>part.type==='image_url');expect(image.image_url.url).toMatch(/^data:image\/png;base64,/);const derivative=Buffer.from(image.image_url.url.split(',')[1],'base64');expect(derivative.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))).toBe(true);expect(await sharp(derivative).metadata()).toMatchObject({width:180,height:100});expect(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(crypto.createHash('sha256').update(original).digest('hex'));}finally{fs.unlinkSync(file);}
  });

  it('correlates successful OCR only with the actual requested image or current attachment', () => {
    const file='C:/virtual-case-a/evidence.png',other='C:/virtual-case-b/evidence.png',payload=JSON.stringify({path:file,analysis:'虚构图像OCR文字，尚未核对原件或刑事事实。'});
    const record={name:'ocr_image_file',arguments:{imagePath:file},result:payload,terminalVerification:{status:'verified'}} as any;
    expect(isSuccessfulExactDocumentRead(record)).toBe(true);
    expect(documentReadMatchesRequestedTarget(record,'读取 C:/virtual-case-a/evidence.png')).toBe(true);
    expect(documentReadMatchesRequestedTarget(record,'读取 C:/virtual-case-b/evidence.png')).toBe(false);
    expect(documentReadMatchesRequestedTarget(record,'读取这张图',undefined,[file])).toBe(true);
    expect(documentReadMatchesRequestedTarget(record,'读取这张图',undefined,[other])).toBe(false);
    expect(documentReadMatchesRequestedTarget({...record,arguments:{path:file}},'读取 evidence.png')).toBe(true);
    expect(isSuccessfulExactDocumentRead({...record,name:'read_pdf'})).toBe(false);
    expect(isSuccessfulExactDocumentRead({...record,arguments:{imagePath:'C:/virtual/evidence.docx'}})).toBe(false);
    expect(documentReadMatchesRequestedTarget({...record,error:'local perception failed'},'读取 evidence.png')).toBe(false);
  });

  it.each([{text:'',finish:'stop'},{text:'被截断的图像内容',finish:'length'}])('does not turn an empty or truncated visual result into OCR evidence: $finish', async ({text,finish}) => {
    vi.stubEnv('LUMI_PRIVACY','standard');const create=vi.fn(async()=>({choices:[{message:{role:'assistant',content:text},finish_reason:finish}]}));
    await expect(analyzeScreen('U1lOVEhFVElD','读取虚构图像',{provider:'openai',model:'synthetic-vision',userId:'empty-visual-result'},unavailable,unavailable,()=>({chat:{completions:{create}}}))).rejects.toThrow(/complete usable text/);expect(create).toHaveBeenCalledOnce();
  });

});
