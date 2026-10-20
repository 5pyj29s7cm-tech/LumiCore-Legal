import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { getStoredDesktopExecutionPreference, saveStoredDesktopExecutionPreference } from '../server/cognition/operation_mode_store';
import * as modeStore from '../server/cognition/operation_mode_store';
import { evaluateActionConstitution, canAutoApproveAction } from '../server/tools/action_constitution';
import { stateByUser, updateClientState } from '../server/client/self/state';
import { createTurnConfirmation } from '../server/tools/turn_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import { buildTransportNeutralConfirmationScope, clearAllPendingConfirmationsForTests, formatPendingConfirmationRequest, getPendingConfirmation, recordPendingConfirmationDurably, buildPendingConfirmationPersistenceRecord, hydratePendingConfirmationFromPersistence } from '../server/tools/pending_confirmation';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { ToolRegistry } from '../server/tools/registry';
import { capabilityContract } from '../server/tools/capability_contracts';
import { executeConfirmedToolStep } from '../server/tools/confirmed_step';

const userId = 'desktop-mode-confirmation-owner';
const context = { userId, domain: 'personal', actionIntent: '打开记事本并输入测试' };
const args = { task: '打开记事本并输入测试' };
const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId: 'mode-chat', taskId: 'mode-task' });
function snapshot(enabled: boolean, extra = {}) {
  updateClientState(userId, { workDomain: 'personal', surfaces: { wallpaperMode: enabled }, ...extra } as any);
}
beforeAll(async () => { await initDatabase(); await ensurePendingConfirmationPersistenceInitialized(); });
beforeEach(async () => { stateByUser.clear(); clearAllPendingConfirmationsForTests(); await saveStoredDesktopExecutionPreference(userId, 'internal'); });

describe('one existing confirmation includes the external desktop handoff', () => {
  it('does not auto-approve a low-risk computer action in internal mode', () => {
    snapshot(false);
    expect(evaluateActionConstitution('computer_use', args, 'safe', context).level).toBe('confirm');
    expect(canAutoApproveAction('computer_use', args, context)).toBe(false);
  });
  it('preserves risk policy with an external execution preference even while wallpaper is off', async () => {
    snapshot(false);
    await saveStoredDesktopExecutionPreference(userId, 'external');
    expect(evaluateActionConstitution('computer_use', args, 'safe', context).level).toBe('safe');
    expect(canAutoApproveAction('computer_use', args, context)).toBe(true);
    expect(evaluateActionConstitution('computer_use', { task: '提交法院立案' }, 'safe', { ...context, actionIntent: '提交法院立案' }).level).toBe('confirm');
  });
  it('shows the exact sensitive action confirmation in external mode without obsolete switch or wallpaper reasons', async () => {
    await saveStoredDesktopExecutionPreference(userId, 'external');
    const actionIntent = '支付给供应商500元', exactArgs = { task: actionIntent }, proposals: any[] = [];
    const confirm = createTurnConfirmation({ userId, source: 'test', requestId: 'external-sensitive-display', actionIntent,
      consumeScope: () => scope, proposalScope: () => scope, onPending: pending => proposals.push(pending) });
    expect(await confirm('computer_use', exactArgs)).toBe(false);
    expect(proposals).toHaveLength(1);
    const pending = proposals[0], message = formatPendingConfirmationRequest(pending);
    expect(pending.exactArgs).toEqual(exactArgs);
    expect(pending.safeArgs.externalDesktopHandoff).toBe(true);
    expect(pending.safeArgs.switchToExternalExecution).not.toBe(true);
    expect(message).toContain('请确认下面的操作，确认后我才会执行。');
    expect(message).toContain(actionIntent);
    expect(message).not.toContain('外部执行模式');
    expect(message).not.toContain('壁纸');
    expect(message.match(/请回复/g)).toHaveLength(1);
  });

  it.each(['missing', 'stale', 'other-domain', 'other-organization'])('does not infer external authorization from %s client state', kind => {
    if (kind !== 'missing') snapshot(true);
    if (kind === 'stale') stateByUser.get(userId)!.updatedAt = Date.now() - 31_000;
    if (kind === 'other-domain') stateByUser.get(userId)!.workDomain = 'work';
    const scoped = kind === 'other-organization' ? { ...context, domain: 'work', orgId: 'org-b' } : context;
    if (kind === 'other-organization') snapshot(true, { workDomain: 'work', org: { id: 'org-a' } });
    expect(evaluateActionConstitution('computer_use', args, 'safe', scoped).level).toBe('confirm');
    expect(canAutoApproveAction('computer_use', args, scoped)).toBe(false);
  });
  it('keeps observation and client UI navigation on their existing boundaries', () => {
    snapshot(false);
    expect(evaluateActionConstitution('desktop_active_window', {}, 'safe', context).level).toBe('safe');
    expect(evaluateActionConstitution('client_action', { action: 'open_settings' }, 'safe', context).level).toBe('safe');
    expect(canAutoApproveAction('desktop_active_window', {}, context)).toBe(true);
  });
  it('creates one immutable proposal with a mode explanation and consumes the exact grant once', async () => {
    snapshot(false);
    const created: any[] = [];
    const make = (pending?: any) => createTurnConfirmation({
      userId, source: 'test', requestId: 'mode-request', actionIntent: context.actionIntent,
      consumeScope: () => scope, proposalScope: () => scope, pending,
      onPending: value => created.push(value),
    });
    const first = make();
    expect(await first('computer_use', args)).toBe(false);
    expect(await first('computer_use', { task: '改为其他操作' })).toBe(false);
    expect(created).toHaveLength(1);
    const pending = getPendingConfirmation(userId, scope)!;
    expect(pending.exactArgs).toEqual(args);
    const message = formatPendingConfirmationRequest(pending);
    expect(message).toContain('外部执行模式');
    expect(message).toContain('后续桌面任务默认使用外部模式');
    expect(message.match(/请回复/g)).toHaveLength(1);
    const resumed = make(pending);
    expect(await resumed('computer_use', args)).toBe(true);
    expect(await resumed('computer_use', args)).toBe(false);
  });
  it('does not consume a proposal after scope changes or cancellation', async () => {
    snapshot(false);
    const created: any[] = [];
    await createTurnConfirmation({ userId, source: 'test', requestId: 'r', actionIntent: context.actionIntent, consumeScope: () => scope, proposalScope: () => scope, onPending: x => created.push(x) })('computer_use', args);
    const pending = created[0];
    const confirm = createTurnConfirmation({ userId, source: 'test', requestId: 'r2', actionIntent: context.actionIntent, pending, consumeScope: () => ({ ...scope, orgId: 'another' }), proposalScope: () => scope, isCancelled: () => true, onPending: () => {} });
    expect(await confirm('computer_use', args)).toBe(false);
    expect(getPendingConfirmation(userId, scope)?.id).toBe(pending.id);
  });
  it.each(['mutate', 'observe'] as const)('uses actual host capability metadata for a custom-named %s tool', async operation => {
    snapshot(false);
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'completed');
    registry.register({
      name: 'mode_fixture_alias', description: 'Offline fixture', parameters: { type: 'object', properties: {} },
      handler, permission: 'user', securityLevel: 'safe',
      capability: capabilityContract({ id: 'fixture.desktop.alias', family: 'fixture', lane: 'desktop', operation,
        risk: 'low', sideEffects: [{ type: 'desktop_control', scope: 'fixture only', reversible: true }],
        verification: { strategy: 'none', required: false, requiredFields: [], successSignals: [], limitations: [] },
      }),
    });
    const proposals: any[] = [];
    const confirm = createTurnConfirmation({ userId, source: 'test', requestId: 'metadata-r', actionIntent: context.actionIntent,
      consumeScope: () => scope, proposalScope: () => scope, onPending: x => proposals.push(x) });
    const toolContext = { ...context, authenticated: true, authRole: 'admin' as const, localExecution: true, executionBoundary: 'trusted_local' as const, requestConfirmation: confirm };
    const output = await registry.execute('mode_fixture_alias', { externalDesktopHandoff: false }, toolContext);
    if (operation === 'observe') {
      expect(output).toBe('completed');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(proposals).toHaveLength(0);
    } else {
      expect(output).toContain('requires user confirmation');
      expect(handler).not.toHaveBeenCalled();
      expect(proposals).toHaveLength(1);
      expect(formatPendingConfirmationRequest(proposals[0])).toContain('外部执行模式');
      snapshot(true);
      expect(formatPendingConfirmationRequest(proposals[0])).toContain('外部执行模式');
      expect(proposals[0].exactArgs).toEqual({ externalDesktopHandoff: false });
      await registry.execute('mode_fixture_alias', proposals[0].exactArgs, { ...toolContext, userConfirmed: true });
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the confirmed step owns one native handoff', () => {
  async function fixture(handoff = true, payload = { value: 'approved' }) {
    const calls: string[] = [];
    const registry = new ToolRegistry();
    const handler = vi.fn(async (_args: Record<string, any>, _context: any) => { calls.push('tool'); return JSON.stringify({ ok: true }); });
    registry.register({ name: 'mode_action_fixture', description: 'Offline fixture', parameters: { type: 'object', properties: {} }, handler, permission: 'public', securityLevel: 'safe' });
    const pending = await recordPendingConfirmationDurably(userId, 'mode_action_fixture', payload, 'test', { ...scope, externalDesktopHandoff: handoff, switchToExternalExecution: handoff });
    const relay = vi.fn(async (_name, input) => { calls.push(input.enabled ? 'external' : 'restore'); return JSON.stringify({ enabled: input.enabled }); });
    const executionContext = { userId, domain: 'personal', authenticated: true, localExecution: true, currentTurnExecutionRequested: true,
      desktopRelay: relay, toolPolicy: { allowedTools: ['mode_action_fixture'], requireConfirmation: [], forbiddenTools: [], maxIterations: 1 } };
    return { registry, pending, relay, calls, handler, executionContext };
  }
  it('enters once, runs exact approved arguments once, then restores once', async () => {
    const f = await fixture();
    const input = { userId, scope, registry: f.registry, pending: f.pending, context: f.executionContext };
    const result = await executeConfirmedToolStep(input);
    expect(result.error).toBeUndefined();
    expect(f.calls).toEqual(['external', 'tool', 'restore']);
    expect(getStoredDesktopExecutionPreference(userId)).toBe('external');
    expect(f.handler.mock.calls[0][0]).toEqual({ value: 'approved' });
    expect(f.handler.mock.calls[0][1].desktopPresentationManaged).toBe(true);
    await executeConfirmedToolStep(input);
    expect(f.calls).toEqual(['external', 'tool', 'restore']);
  });
  it('a current cancellation performs neither presentation nor tool actions', async () => {
    const f = await fixture();
    const result = await executeConfirmedToolStep({ userId, scope, registry: f.registry, pending: f.pending, context: { ...f.executionContext, isCancelled: () => true } });
    expect(result.error).toContain('cancelled');
    expect(f.calls).toEqual([]);
    expect(getStoredDesktopExecutionPreference(userId)).toBe('internal');
  });
  it('a wrong confirmation scope performs neither presentation nor tool actions', async () => {
    const f = await fixture();
    const result = await executeConfirmedToolStep({ userId, scope: { ...scope, channelId: 'another' }, registry: f.registry, pending: f.pending, context: f.executionContext });
    expect(result.error).toContain('one-time confirmation');
    expect(f.calls).toEqual([]);
    expect(getStoredDesktopExecutionPreference(userId)).toBe('internal');
  });
  it('does not run the action or native handoff when the preference cannot be saved', async () => {
    const f = await fixture();
    const save = vi.spyOn(modeStore, 'saveStoredDesktopExecutionPreference').mockRejectedValueOnce(new Error('private persistence error'));
    try {
      const result = await executeConfirmedToolStep({ userId, scope, registry: f.registry, pending: f.pending, context: f.executionContext });
      expect(result.error).toContain('preference could not be saved');
      expect(result.error).not.toContain('private persistence error');
      expect(f.calls).toEqual([]);
      expect(getStoredDesktopExecutionPreference(userId)).toBe('internal');
    } finally { save.mockRestore(); }
  });
  it('an already-external dangerous host desktop tool still has one exact confirmation and one native handoff', async () => {
    await saveStoredDesktopExecutionPreference(userId, 'external');
    const registry = new ToolRegistry();
    const calls: string[] = [];
    const handler = vi.fn(async (_args: Record<string, any>, _context: any) => { calls.push('tool'); return 'completed'; });
    registry.register({ name: 'custom_desktop_commit', description: 'Offline fixture', parameters: { type: 'object', properties: {} }, permission: 'user', securityLevel: 'confirm', handler,
      capability: capabilityContract({ id: 'fixture.desktop.commit', family: 'fixture', lane: 'desktop', operation: 'mutate', risk: 'high', sideEffects: [{ type: 'desktop_control', scope: 'fixture', reversible: true }], verification: { strategy: 'none', required: false, requiredFields: [], successSignals: [], limitations: [] } }),
    });
    const proposals: any[] = [];
    const toolContext = { ...context, authenticated: true, authRole: 'admin' as const, localExecution: true, executionBoundary: 'trusted_local' as const,
      desktopRelay: vi.fn(async (_name, input) => { calls.push(input.enabled ? 'external' : 'restore'); return '{}'; }),
      requestConfirmation: createTurnConfirmation({ userId, source: 'test', requestId: 'external-danger', actionIntent: context.actionIntent, consumeScope: () => scope, proposalScope: () => scope, onPending: p => proposals.push(p) }),
    };
    await registry.execute('custom_desktop_commit', { value: 'exact' }, toolContext);
    expect(handler).not.toHaveBeenCalled(); expect(proposals).toHaveLength(1);
    expect(proposals[0].safeArgs.externalDesktopHandoff).toBe(true);
    expect(proposals[0].safeArgs.switchToExternalExecution).toBeUndefined();
    expect(formatPendingConfirmationRequest(proposals[0])).not.toContain('后续桌面任务');
    const result = await executeConfirmedToolStep({ userId, scope, registry, pending: proposals[0], context: toolContext });
    expect(result.error).toBeUndefined(); expect(calls).toEqual(['external', 'tool', 'restore']);
    expect(handler.mock.calls[0][0]).toEqual({ value: 'exact' });
    expect(getStoredDesktopExecutionPreference(userId)).toBe('external');
  });
  it('a native handoff failure prevents the approved tool and does not retry it', async () => {
    const f = await fixture();
    f.relay.mockRejectedValueOnce(new Error('private-native-error'));
    const input = { userId, scope, registry: f.registry, pending: f.pending, context: f.executionContext };
    const result = await executeConfirmedToolStep(input);
    expect(result.error).toContain('handoff could not be established');
    expect(result.error).not.toContain('private-native-error');
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.relay).toHaveBeenCalledTimes(1);
    await executeConfirmedToolStep(input);
    expect(f.relay).toHaveBeenCalledTimes(1);
  });
  it('restores presentation even if the actual approved tool fails', async () => {
    const f = await fixture();
    f.handler.mockImplementationOnce(async () => { f.calls.push('tool'); throw new Error('fixture failed'); });
    const result = await executeConfirmedToolStep({ userId, scope, registry: f.registry, pending: f.pending, context: f.executionContext });
    expect(result.error).toContain('fixture failed');
    expect(f.calls).toEqual(['external', 'tool', 'restore']);
  });
  it('ignores model argument attempts to manufacture the display marker', async () => {
    const f = await fixture(false, { value: 'approved', externalDesktopHandoff: true, switchToExternalExecution: true } as any);
    expect(f.pending.safeArgs.externalDesktopHandoff).toBeUndefined();
    expect(f.pending.safeArgs.switchToExternalExecution).toBeUndefined();
    expect(formatPendingConfirmationRequest(f.pending)).not.toContain('壁纸模式');
    const result = await executeConfirmedToolStep({ userId, scope, registry: f.registry, pending: f.pending, context: f.executionContext });
    expect(result.error).toBeUndefined();
    expect(f.calls).toEqual(['tool']);
  });
  it('keeps the pinned mode explanation through encrypted-envelope hydration without changing exact args', async () => {
    const f = await fixture();
    const stored = buildPendingConfirmationPersistenceRecord(f.pending, 'vault:offline-envelope');
    expect(f.pending.exactArgs).toEqual({ value: 'approved' });
    const restored = hydratePendingConfirmationFromPersistence(stored, f.pending.exactArgs)!;
    expect(restored).toEqual(f.pending);
    expect(formatPendingConfirmationRequest(restored)).toContain('External execution');
    expect(hydratePendingConfirmationFromPersistence({ ...stored, safeArgs: { ...stored.safeArgs, value: 'tampered' } }, f.pending.exactArgs)).toBeNull();
  });
});

describe('existing wallpaper command aliases', () => {
  it.each([['进入壁纸模式', true]])('%s reuses the same client action', (text, enabled) => {
    const intent = normalizeActionIntent(text);
    expect(intent.clientAction).toBe('set_wallpaper_mode');
    expect(intent.clientActionArguments).toEqual({ enabled });
  });
  it.each(['进入外部模式', '切换到内部模式', '回到内部模式', '打开内部资料', '打开外部API文档', '外部接口现在正常吗'])('%s does not change presentation', text => {
    expect(normalizeActionIntent(text).clientAction).not.toBe('set_wallpaper_mode');
  });
});

import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { registerComputerUseTool } from '../server/tools/definitions/computer_use_tool';
const openModeMocks=vi.hoisted(()=>({loop:vi.fn(),sdk:vi.fn()}));
vi.mock('../server/agents/computer_use',()=>({computerUseLoop:openModeMocks.loop}));

function openModeFixture(task='直接用wps生成并打开',name='普通材料.docx'){
 const userId='mode-guard-'+crypto.randomUUID(),taskId='task-'+crypto.randomUUID(),requestId='request-'+crypto.randomUUID();
 const scope=buildTransportNeutralConfirmationScope({domain:'personal',conversationId:'offline-mode-chat',taskId});
 const registry=new ToolRegistry();registerDesktopTools(registry);registerComputerUseTool(registry);const proposals:any[]=[];
 const confirmation=()=>createTurnConfirmation({userId,source:'offline-mode-diagnosis',requestId,actionIntent:task,consumeScope:()=>scope,proposalScope:()=>scope,onPending:p=>proposals.push(p)});
 const relay=vi.fn(async(tool:string,args:any)=>{if(tool==='desktop_open')return 'Opened: '+args.target;if(tool==='desktop_set_wallpaper_mode')return JSON.stringify({enabled:args.enabled});if(tool==='desktop_active_window')return JSON.stringify({window_id:'12345',title:name+' - WPS Office',process_name:'wps.exe',pid:2468,executable_path:'C:/Synthetic/WPS/wps.exe',product_name:'WPS Office',x:0,y:0,width:900,height:600});throw new Error('Unexpected adapter '+tool);});
 const context:any={userId,taskId,requestId,conversationId:'offline-mode-chat',domain:'personal',authenticated:true,authRole:'user',localExecution:true,executionBoundary:'trusted_local',currentTurnExecutionRequested:true,actionIntent:task,desktopRelay:relay,requestConfirmation:confirmation(),llmGetters:{getDeepSeek:()=>null,getGemini:()=>null,getOpenAI:()=>({chat:{completions:{create:openModeMocks.sdk}}})}};
 const args={target:'C:/synthetic/'+name,application:'WPS Office'};return{userId,taskId,requestId,scope,registry,context,args,proposals,relay,confirmation};
}
describe('static desktop open does not reinterpret a document name as final signing authority',()=>{
 beforeEach(()=>{vi.clearAllMocks();openModeMocks.loop.mockRejectedValue(new Error('NO_COMPUTER_LOOP_ALLOWED'));openModeMocks.sdk.mockRejectedValue(new Error('NO_SDK_ALLOWED'));});
 it.each(['普通材料.docx','离婚诉讼委托书.docx','授权委托书.docx','合同签署日期说明.docx','付款计划说明.docx'])('external opens %s through the actual registered adapter without a new question',async name=>{
  const f=openModeFixture(undefined,name);await saveStoredDesktopExecutionPreference(f.userId,'external');
  const result=JSON.parse(await f.registry.execute('desktop_open',f.args,f.context));expect(result).toMatchObject({ok:true,status:'verified',targetMatched:true});expect(f.proposals).toHaveLength(0);expect(f.relay.mock.calls.map(c=>c[0])).toEqual(['desktop_open','desktop_active_window']);expect(getStoredDesktopExecutionPreference(f.userId)).toBe('external');expect(openModeMocks.loop).not.toHaveBeenCalled();expect(openModeMocks.sdk).not.toHaveBeenCalled();
 });
 it('internal asks once, consumes exact mode handoff once, then the next ordinary open uses saved external without asking',async()=>{
  const f=openModeFixture(undefined,'离婚诉讼委托书.docx');await saveStoredDesktopExecutionPreference(f.userId,'internal');
  expect(await f.registry.execute('desktop_open',f.args,f.context)).toContain('requires user confirmation');expect(f.proposals).toHaveLength(1);expect(f.relay).not.toHaveBeenCalled();expect(f.proposals[0].safeArgs.switchToExternalExecution).toBe(true);
  const accepted=await executeConfirmedToolStep({userId:f.userId,pending:f.proposals[0],scope:f.scope,registry:f.registry,context:f.context});expect(accepted.error).toBeUndefined();expect(getStoredDesktopExecutionPreference(f.userId)).toBe('external');
  const result=JSON.parse(await f.registry.execute('desktop_open',f.args,{...f.context,requestId:'next-'+crypto.randomUUID(),requestConfirmation:f.confirmation()}));expect(result.targetMatched).toBe(true);expect(f.proposals).toHaveLength(1);expect(f.relay.mock.calls.filter(c=>c[0]==='desktop_open')).toHaveLength(2);
 });
 it.each(['签署这份合同','支付给供应商500元','提交这份起诉状到法院'])('external never bypasses final commit confirmation/desktop refusal: %s',async task=>{
  const f=openModeFixture(task);await saveStoredDesktopExecutionPreference(f.userId,'external');
  expect(await f.registry.execute('computer_use',{task},f.context)).toContain('requires user confirmation');expect(f.proposals).toHaveLength(1);expect(f.relay).not.toHaveBeenCalled();expect(openModeMocks.loop).not.toHaveBeenCalled();expect(openModeMocks.sdk).not.toHaveBeenCalled();
  await expect(f.registry.execute('computer_use',{task},{...f.context,userConfirmed:true})).rejects.toThrow('Vision computer control cannot perform the final external commit.');expect(f.relay).not.toHaveBeenCalled();expect(openModeMocks.loop).not.toHaveBeenCalled();expect(openModeMocks.sdk).not.toHaveBeenCalled();
 });
});
