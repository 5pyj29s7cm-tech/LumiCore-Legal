import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as llmAdapter from '../server/llm/providers';
import { ToolLifecyclePersistenceError } from '../server/llm/adapter';
import { getToolRuntimeMetrics, resetToolRuntimeMetricsForTests } from '../server/runtime/tool_metrics';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry, resetExternalCommitRuntimeCacheForTests } from '../server/tools/registry';
import { encodeToolResult } from '../server/tools/result_envelope';
import { configureExternalCommitJournal } from '../server/tools/external_commit_journal';
import { getAdapterResilienceSnapshot, resetAdapterResilienceForTests } from '../server/tools/adapter_resilience';
import type { ToolCapabilityMetadata, ToolDefinition } from '../server/tools/types';

const capture = JSON.parse(fs.readFileSync(new URL('./fixtures/tool_bid_partial_capture.json', import.meta.url), 'utf8'));
const capturedPartial = encodeToolResult(capture.text, capture.receipt);
const verification = {
  strategy: 'terminal_receipt' as const, required: true,
  requiredFields: ['ok', 'status'], requiredValues: { ok: true },
  successStatuses: ['generated', 'completed'], successSignals: ['terminal receipt'], limitations: [],
};
function register(registry: ToolRegistry, name: string, handler: ToolDefinition['handler'], metadata: ToolCapabilityMetadata = {}) {
  registry.register({
    name, description: 'Offline terminal-metrics fixture.', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: {} },
    capability: {
      lane: 'client', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'offline fixture', reversible: true }],
      verification, ...metadata,
    }, handler,
  });
}
function outcomes(name: string) { return getToolRuntimeMetrics().tools[name].outcomes; }
const context = { userId: 'metrics-offline-owner', userConfirmed: true };
let llm: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  llm = vi.spyOn(llmAdapter, 'makeLLMCall').mockRejectedValue(new Error('No model calls in metrics replay.'));
  fetchMock = vi.fn(async () => { throw new Error('No network in metrics replay.'); });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  expect(llm).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  resetToolRuntimeMetricsForTests(); resetAdapterResilienceForTests();
  resetExternalCommitRuntimeCacheForTests(); configureExternalCommitJournal(null);
});

describe('tool runtime metrics follow terminal receipts', () => {
  it('replays the actual captured bid partial without a model, preserving the failed canonical outcome', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => capturedPartial);
    register(registry, 'legal_generate_bid', handler, {
      lane: 'files', verification: { ...verification, strategy: 'artifact', requiredFields: ['ok', 'status', 'artifacts'] },
    });
    const record = await executeToolCall({ registry, name: 'legal_generate_bid', arguments: { persistCase: false }, context });
    expect(record.receipt).toEqual(capture.receipt);
    expect(record.result).toBe(capture.text);
    expect(record.terminalVerification?.status).toBe(capture.verification.status);
    expect(record.envelope?.status).toBe('failed');
    expect(outcomes('legal_generate_bid')).toMatchObject({ failed: 1, verified_success: 0 });
    expect(getToolRuntimeMetrics().totals.inFlight).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('uses the same existing terminal contract for direct registry calls', async () => {
    const registry = new ToolRegistry();
    register(registry, 'legal_generate_bid', async () => capturedPartial);
    await expect(registry.execute('legal_generate_bid', {}, context)).resolves.toBe(capturedPartial);
    expect(outcomes('legal_generate_bid')).toMatchObject({ failed: 1, verified_success: 0 });
  });

  it('does not confuse fulfilled business partial with adapter transport failure or retry', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => capturedPartial);
    const name = 'desktop_local_partial';
    register(registry, name, handler);
    for (let index = 0; index < 3; index += 1) await registry.execute(name, {}, context);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(outcomes(name)).toMatchObject({ failed: 3, verified_success: 0 });
    expect(getToolRuntimeMetrics().tools[name].retries).toBe(0);
    expect((getAdapterResilienceSnapshot().families as any).desktop).toMatchObject({ openCircuits: 0 });
  });

  it('keeps the partial outcome on completed local idempotency replay without rerunning the handler', async () => {
    const registry = new ToolRegistry(); const name = 'desktop_local_replay';
    const handler = vi.fn(async () => capturedPartial);
    register(registry, name, handler);
    const replayContext = { ...context, idempotencyKey: 'local-partial-completed' };
    await registry.execute(name, {}, replayContext); await registry.execute(name, {}, replayContext);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcomes(name)).toMatchObject({ failed: 2, verified_success: 0 });
  });

  it('keeps the partial outcome when a concurrent local call joins the pinned promise', async () => {
    const registry = new ToolRegistry(); const name = 'desktop_local_join';
    let release!: (value: string) => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const handler = vi.fn(() => new Promise<string>(resolve => { release = resolve; entered(); }));
    register(registry, name, handler);
    const replayContext = { ...context, idempotencyKey: 'local-partial-joined' };
    const first = registry.execute(name, {}, replayContext); await started;
    const second = registry.execute(name, {}, replayContext); await Promise.resolve();
    release(capturedPartial); await Promise.all([first, second]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcomes(name)).toMatchObject({ failed: 2, verified_success: 0 });
  });

  it.each([
    [{ ok: true, status: 'completed' }, 'verified_success'],
    [{ ok: false, status: 'failed', error: 'Fixture business failure.' }, 'failed'],
    [{ ok: true, status: 'completed', targetMatched: false }, 'target_mismatch'],
  ] as const)('uses the final envelope for %j', async (receipt, status) => {
    const registry = new ToolRegistry(); const name = 'local_terminal_fixture';
    register(registry, name, async () => encodeToolResult('Fixture result.', receipt));
    const record = await executeToolCall({ registry, name, context });
    expect(record.envelope?.status).toBe(status);
    expect(outcomes(name)[status]).toBe(1);
    expect(getToolRuntimeMetrics().totals.inFlight).toBe(0);
  });

  it('preserves confirmation waiting without entering the handler', async () => {
    const registry = new ToolRegistry(); const name = 'local_confirm_fixture';
    const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    register(registry, name, handler); registry.get(name)!.securityLevel = 'confirm';
    const record = await executeToolCall({ registry, name, context: { userId: context.userId } });
    expect(record.envelope?.status).toBe('waiting_confirmation');
    expect(outcomes(name)).toMatchObject({ waiting_confirmation: 1, verified_success: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('settles the metric after host corroboration, which runs exactly once', async () => {
    const registry = new ToolRegistry(); const name = 'host_proven_fixture';
    register(registry, name, async () => JSON.stringify({ ok: true, status: 'completed' }), { source: 'mcp' });
    let inFlightAtProof = -1;
    const corroborate = vi.fn(async () => {
      inFlightAtProof = getToolRuntimeMetrics().totals.inFlight;
      return { status: 'verified' as const, strategy: 'state_diff' as const, reason: 'Offline host proof.' };
    });
    registry.get(name)!.corroborateTerminalResult = corroborate;
    const record = await executeToolCall({ registry, name, context });
    expect(record.terminalVerification?.status).toBe('verified');
    expect(record.envelope?.status).toBe('verified_success');
    expect(corroborate).toHaveBeenCalledTimes(1);
    expect(inFlightAtProof).toBe(1);
    expect(outcomes(name)).toMatchObject({ verified_success: 1, failed: 0 });
  });

  it('does not resend an unknown external commit or count it as an adapter outage', async () => {
    const registry = new ToolRegistry(); const name = 'desktop_external_fixture';
    const handler = vi.fn(async () => JSON.stringify({ submitted: true, status: 'submitted_unverified' }));
    register(registry, name, handler, {
      operation: 'communicate', sideEffects: [{ type: 'external_communication', scope: 'offline target', reversible: false }],
    });
    const replayContext = { ...context, idempotencyKey: 'unknown-external-metrics' };
    const first = await executeToolCall({ registry, name, context: replayContext });
    const second = await executeToolCall({ registry, name, context: replayContext });
    expect(first.envelope?.status).toBe('unknown_outcome');
    expect(second.envelope?.status).toBe('unknown_outcome');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcomes(name)).toMatchObject({ unknown_outcome: 2, verified_success: 0 });
    expect((getAdapterResilienceSnapshot().families as any).desktop).toMatchObject({ openCircuits: 0 });
  });

  it('retains verified external-commit replay without repeating the mutation', async () => {
    const registry = new ToolRegistry(); const name = 'desktop_external_verified_fixture';
    const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed', verified: true }));
    register(registry, name, handler, {
      operation: 'communicate', sideEffects: [{ type: 'external_communication', scope: 'offline target', reversible: false }],
    });
    const replayContext = { ...context, idempotencyKey: 'verified-external-metrics' };
    await registry.execute(name, {}, replayContext); await registry.execute(name, {}, replayContext);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcomes(name)).toMatchObject({ verified_success: 2, unknown_outcome: 0 });
  });

  it('keeps nested direct-registry metrics separate from the outer canonical call', async () => {
    const registry = new ToolRegistry();
    register(registry, 'nested_inner', async () => capturedPartial);
    register(registry, 'nested_outer', async (_args, handlerContext) => {
      await registry.execute('nested_inner', {}, handlerContext);
      return JSON.stringify({ ok: true, status: 'completed' });
    });
    const record = await executeToolCall({ registry, name: 'nested_outer', context });
    expect(record.envelope?.status).toBe('verified_success');
    expect(outcomes('nested_inner')).toMatchObject({ failed: 1, verified_success: 0 });
    expect(outcomes('nested_outer')).toMatchObject({ failed: 0, verified_success: 1 });
    expect(getToolRuntimeMetrics().totals).toMatchObject({ calls: 2, inFlight: 0 });
  });

  it('preserves the existing canonical timeout status without leaking an in-flight metric', async () => {
    const registry = new ToolRegistry(); const name = 'local_timeout_fixture';
    const handler = vi.fn(async () => { throw new Error('Tool timed out after its execution budget.'); });
    register(registry, name, handler);
    const record = await executeToolCall({ registry, name, context });
    expect(record.envelope?.status).toBe('timeout');
    expect(outcomes(name)).toMatchObject({ timeout: 1, verified_success: 0, failed: 0 });
    expect(getToolRuntimeMetrics().totals.inFlight).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('releases the metric when durable lifecycle failure prevents publishing a canonical record', async () => {
    const registry = new ToolRegistry(); const name = 'local_lifecycle_fixture';
    const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    register(registry, name, handler);
    await expect(executeToolCall({ registry, name, context: {
      ...context, onAdapterStart: async () => { throw new ToolLifecyclePersistenceError(new Error('Offline lifecycle observer failure.')); },
    } })).rejects.toThrow('Offline lifecycle observer failure.');
    expect(handler).not.toHaveBeenCalled();
    expect(outcomes(name)).toMatchObject({ failed: 1, verified_success: 0 });
    expect(getToolRuntimeMetrics().totals.inFlight).toBe(0);
  });

});
