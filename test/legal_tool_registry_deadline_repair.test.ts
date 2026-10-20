import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, getToolExecutionTimeoutMs } from '../server/tools/registry';
import { LEGAL_REASONING_MODEL_TIMEOUT_MS } from '../server/legal/budgets';
afterEach(()=>vi.useRealTimers());
describe('legal handler deadline must not be cut off by registry default',()=>{
  it.each(['legal_generate_bid','legal_draft_contract','legal_extract_dispute_focus','legal_import_materials_to_kb'])('%s retains document completion headroom', name=>{
    expect(getToolExecutionTimeoutMs(name)).toBeGreaterThan(LEGAL_REASONING_MODEL_TIMEOUT_MS+15_000);
  });
  it.each(['legal_generate_bid','legal_draft_contract'])('%s completes a real registry promise after 35 seconds rather than aborting at 30', async name=>{
    vi.useFakeTimers(); const registry=new ToolRegistry(); let aborted=false;
    registry.register({name,description:'Synthetic deadline fixture',parameters:{type:'object',properties:{}},securityLevel:'safe',permission:'public',handler:async (_args,context)=>await new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>resolve('Complete synthetic document body'),35_000);
      context?.executionSignal?.addEventListener('abort',()=>{aborted=true;clearTimeout(timer);reject(context.executionSignal!.reason)},{once:true});
    })});
    const pending=registry.execute(name,{persistCase:false},{userId:'deadline-test',domain:'personal',source:'test',userConfirmed:true});
    const observed=pending.then(value=>({value}),error=>({error})); await vi.advanceTimersByTimeAsync(30_100); expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);expect(await observed).toEqual({value:'Complete synthetic document body'});
  });
});