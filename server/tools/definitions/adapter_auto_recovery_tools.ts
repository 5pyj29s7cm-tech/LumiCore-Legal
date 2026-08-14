import { mcpManager } from '../../mcp/client';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { ToolRegistry } from '../registry';

export function selectSafeMcpRecoveryCandidates(
  config: Record<string, { enabled?: boolean; source?: string }>,
  health: Record<string, { status?: string; consecutiveCrashes?: number }>,
  requested = '',
): string[] {
  const names = requested ? [requested] : Object.keys(config).sort();
  return names.filter(name => {
    if (config[name]?.enabled !== true) return false;
    if (config[name]?.source === 'external') return false;
    const state = health[name];
    const status = String(state?.status || '').toLowerCase();
    const crashes = Number(state?.consecutiveCrashes || 0);
    if (crashes >= 5) return false;
    return ['crashed', 'failed'].includes(status);
  });
}

export function registerAdapterAutoRecoveryTools(registry: ToolRegistry): void {
  registry.register({
    name: 'adapter_auto_recover',
    description: 'Safely recover enabled local MCP/skill runtimes that are already configured but crashed or failed. It never enables disabled connectors, installs packages, changes credentials, bypasses login/security checks, or retries external commits.',
    parameters: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: 'Optional exact configured MCP/skill server name. Omit to recover up to three unhealthy enabled runtimes.' },
        dryRun: { type: 'boolean', description: 'Inspect and report the recovery plan without restarting anything.' },
      },
      required: [],
    },
    handler: async (args) => {
      const requested = String(args.serverName || '').trim();
      const config = mcpManager.getConfig();
      const healthBefore = mcpManager.getServerHealth();
      if (requested && !config[requested]) return JSON.stringify({ ok: false, status: 'not_configured', requested, recovered: [], blocked: ['server is not configured'] }, null, 2);
      if (requested && config[requested]?.enabled !== true) return JSON.stringify({ ok: false, status: 'setup_required', requested, recovered: [], blocked: ['disabled connectors are never enabled by auto recovery'] }, null, 2);
      const candidates = selectSafeMcpRecoveryCandidates(config, healthBefore, requested).slice(0, 3);
      if (args.dryRun === true || candidates.length === 0) return JSON.stringify({ ok: true, status: candidates.length ? 'planned' : 'healthy', dryRun: args.dryRun === true, candidates, recovered: [], healthBefore }, null, 2);
      const recovered: Array<Record<string, unknown>> = [];
      const blocked: Array<Record<string, unknown>> = [];
      for (const name of candidates) {
        try {
          const tools = await mcpManager.restartServer(name);
          const current = mcpManager.getServerHealth()[name];
          const verified = tools.length > 0 && ['connected', 'idle', 'available'].includes(String(current?.status || ''));
          if (!verified) throw new Error('runtime restarted without a verified connected tool inventory');
          recovered.push({ name, toolCount: tools.length, health: current?.status || 'connected' });
        } catch (error: any) {
          blocked.push({ name, reason: String(error?.message || error).slice(0, 500) });
        }
      }
      return JSON.stringify({ ok: blocked.length === 0, status: blocked.length === 0 ? 'recovered' : recovered.length ? 'partial' : 'blocked', recovered, blocked, healthAfter: mcpManager.getServerHealth() }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'adapter.runtime.safe-recovery', family: 'adapter-recovery', lane: 'system', operation: 'mutate', risk: 'low',
      sideEffects: [{ type: 'process_execution', scope: 'restart already-enabled local MCP/skill process', reversible: true }],
      verification: {
        strategy: 'state_diff', required: true, requiredFields: ['ok', 'status', 'recovered'],
        successStatuses: ['healthy', 'planned', 'recovered'], failureStatuses: ['not_configured', 'setup_required', 'partial', 'blocked'],
        successSignals: ['post-restart health and non-empty tool inventory'],
        limitations: ['Does not enable, install, authenticate, reconfigure, or replay any business mutation.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'adapter.runtime.safe-recovery', operation: 'mutate', subjectArgument: 'serverName', limitations: ['Only already-enabled failed local runtimes are eligible.'] }),
  });
}
