import './helpers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerComputerUseTool } from '../server/tools/definitions/computer_use_tool';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { claimsLegalDocumentCompletion } from '../server/cognition/result_policy_evidence';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
const selectedDesktop = vi.hoisted(() => ({ loop: vi.fn() }));
vi.mock('../server/agents/computer_use', () => ({ computerUseLoop: selectedDesktop.loop }));
let network: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('PAYMENT_BOUNDARY_NO_NETWORK'));
  await initDatabase();
});
afterAll(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });
describe('case facts are not financial execution or document delivery',()=>{
  it.each(['请新建案件并归档：合同总价80万元、已付款20万元，原件未核实。','根据原告起诉状分析：乙方已经付款20万元。','Please archive the case: the buyer has paid 20000.','请分析付款期限和支付条款，给我风险建议。'])('does not authorize a payment for %s',text=>{expect(normalizeActionIntent(text).kind).not.toBe('payment');});
  it.each(['请付款给测试收款人20元','Please pay test recipient 20 dollars','转账给测试账户20元'])('refuses final external payment in the selected desktop task despite generic approval: %s', async text => {
    const registry = new ToolRegistry();
    registerComputerUseTool(registry);
    selectedDesktop.loop.mockReset().mockRejectedValue(new Error('OFFLINE_PAYMENT_LOOP_SENTINEL'));
    const desktop = vi.fn();
    await expect(registry.execute('computer_use', { task: text }, {
      userId: 'legal-payment-boundary-isolated', domain: 'personal', source: 'offline',
      authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local' as const,
      userConfirmed: true, currentTurnExecutionRequested: true, actionIntent: '仅检查当前页面',
      desktopRelay: desktop, llmGetters: { getDeepSeek: () => null, getGemini: () => null },
    })).rejects.toThrow('final external commit');
    expect(selectedDesktop.loop).not.toHaveBeenCalled();
    expect(desktop).not.toHaveBeenCalled();
  });
  it('does not interpret archived contract evidence as a generated legal document',()=>{const text='合同纠纷材料已入案。\n这一步不等同于正式法律意见或对外提交。';expect(claimsLegalDocumentCompletion(text)).toBe(false);const result=finalizeLumiResponse({taskText:'请新建案件并归档：买卖合同纠纷，原件未核实',responseText:text,source:'chat',toolRecords:[{name:'legal_message_intake_to_case',arguments:{},result:'消息已入案',receipt:{ok:true,status:'archived'},terminalVerification:{status:'verified',reason:'Original message archived'},executionEnvelope:{version:1,status:'verified_success'}} as any]});expect(result.blocked).toBe(false);});
  it('still rejects an unverified formally usable pleading without leaking internal tool instructions',()=>{const result=finalizeLumiResponse({taskText:'生成起诉状',responseText:'起诉状已经生成完成，可以直接使用。',source:'chat',toolRecords:[{name:'legal_generate_litigation_packet',arguments:{},result:'# 起诉状草稿\n没有完成法源核验'}]});expect(result.blocked).toBe(true);expect(result.text).not.toMatch(/legal_(?:generate|finalize|case)_/);});
});
