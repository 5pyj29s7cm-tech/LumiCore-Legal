import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { makeApp } from './helpers';
import { makeLLMCall, makeLLMCallStreaming } from '../server/llm/providers';
import { providerGetterArguments } from '../server/llm/provider_getters';
import { resetCircuit } from '../server/cloud/circuit_breaker';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async()=>{app=await makeApp();});afterAll(()=>app.cleanup());
beforeEach(()=>{vi.stubEnv('LUMI_PRIVACY','standard');resetCircuit();});afterEach(()=>{vi.unstubAllEnvs();resetCircuit();});
const text = '{"source":"fallback","complete":true}';
const config = { provider:'relay' as const, model:'virtual-aggregate-primary', userId:'virtual-aggregate-stream-owner', selectionMode:'ordered_fallback' as const, fallbackCandidates:[{provider:'openai' as const,model:'virtual-aggregate-fallback'}],allowCloudFallback:true,maxTokens:128,relayStreaming:true };
const messages = [{role:'user' as const,content:'Only a synthetic aggregate-transport test; no user material.'}];
function fixture(parent?:AbortController){
 const primary=vi.fn(async(params:any)=>{expect(params.stream).toBe(true);return(async function*(){yield{choices:[{delta:{content:'{"source":"broken-prefix"'}}]};if(parent)parent.abort(new Error('Synthetic parent cancellation'));yield{error:{code:'synthetic_stream_error',message:'Synthetic primary stream failed'}};})();});
 const fallback=vi.fn(async(params:any)=>{expect(params.stream).toBe(true);return(async function*(){yield{choices:[{delta:{content:text},finish_reason:'stop'}]};})();});
 const getters=providerGetterArguments({getDeepSeek:()=>null,getGemini:()=>null,getOpenAI:()=>({chat:{completions:{create:fallback}}}),getRelay:()=>({chat:{completions:{create:primary}}})});return{primary,fallback,getters};
}
describe('buffered legal transport delegates candidate fallback once to existing dispatch',()=>{
 it('buffers a failed primary JSON prefix, then returns only the complete configured fallback with one call per candidate',async()=>{const f=fixture();const result=await makeLLMCall(messages,[],config,...f.getters);expect(result.text).toBe(text);expect(result.text).not.toContain('broken-prefix');expect(f.primary).toHaveBeenCalledOnce();expect(f.fallback).toHaveBeenCalledOnce();expect(result.routing?.attempts).toHaveLength(2);expect(result.routing?.attempts[0]).toMatchObject({status:'failed',visibleOutputCommitted:false});expect(result.routing?.selectedProvider).toBe('openai');for(const call of [...f.primary.mock.calls,...f.fallback.mock.calls])expect(call[0].stream).toBe(true);});
 it('preserves public streaming visibility and does not replay after a user-visible prefix',async()=>{const f=fixture(),chunks:string[]=[];await expect(makeLLMCallStreaming(messages,[],config,chunk=>chunks.push(chunk),...f.getters)).rejects.toThrow('Synthetic primary stream failed');expect(chunks.join('')).toContain('broken-prefix');expect(f.primary).toHaveBeenCalledOnce();expect(f.fallback).not.toHaveBeenCalled();});
 it('propagates parent cancellation and never routes to another candidate',async()=>{const parent=new AbortController(),f=fixture(parent);await expect(makeLLMCall(messages,[],{...config,signal:parent.signal},...f.getters)).rejects.toThrow();expect(parent.signal.aborted).toBe(true);expect(f.primary).toHaveBeenCalledOnce();expect(f.fallback).not.toHaveBeenCalled();});
 it('fails closed for local_only before any cloud SDK request',async()=>{const f=fixture();await expect(makeLLMCall(messages,[],{...config,dataRoutingPolicy:'local_only'},...f.getters)).rejects.toThrow(/local.only|privacy/i);expect(f.primary).not.toHaveBeenCalled();expect(f.fallback).not.toHaveBeenCalled();});
 it('leaves the ordinary buffered API unchanged when aggregate streaming was not requested',async()=>{const primary=vi.fn(async(params:any)=>{expect(params.stream).not.toBe(true);return{choices:[{message:{content:'ordinary buffered result'},finish_reason:'stop'}]};});const result=await makeLLMCall(messages,[],{...config,relayStreaming:false,fallbackCandidates:[]},...providerGetterArguments({getDeepSeek:()=>null,getGemini:()=>null,getRelay:()=>({chat:{completions:{create:primary}}})}));expect(result.text).toBe('ordinary buffered result');expect(primary).toHaveBeenCalledOnce();});
});
