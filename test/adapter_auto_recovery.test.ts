import { describe, expect, it } from 'vitest';
import { selectSafeMcpRecoveryCandidates } from '../server/tools/definitions/adapter_auto_recovery_tools';
import { buildSelfRepairToolPolicy } from '../server/cognition/execution_decision';

describe('safe adapter auto recovery', () => {
  it('recovers only enabled failed runtimes and never enables setup-only or crash-loop servers', () => {
    const selected = selectSafeMcpRecoveryCandidates(
      {
        healthy: { enabled: true },
        failed: { enabled: true },
        disabled: { enabled: false },
        looping: { enabled: true },
        external: { enabled: true, source: 'external' },
      },
      {
        healthy: { status: 'connected', consecutiveCrashes: 0 },
        failed: { status: 'failed', consecutiveCrashes: 2 },
        disabled: { status: 'failed', consecutiveCrashes: 1 },
        looping: { status: 'crashed', consecutiveCrashes: 5 },
        external: { status: 'failed', consecutiveCrashes: 1 },
      },
    );
    expect(selected).toEqual(['failed']);
    expect(selectSafeMcpRecoveryCandidates({ failed: { enabled: true } }, { failed: { status: 'failed' } }, 'failed')).toEqual(['failed']);
  });

  it('exposes safe runtime recovery to explicit adapter repair turns', () => {
    const policy = buildSelfRepairToolPolicy('修复 MCP 连接故障');
    expect(policy.allowedTools).toContain('adapter_auto_recover');
  });
});
