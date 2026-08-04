import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCallOrThrow } from '../server/tools/execution_engine';
import { makeApp } from './helpers';

let registerLegalTools: (registry: ToolRegistry) => void;
let cleanup = () => {};

beforeAll(async () => {
  const app = await makeApp();
  cleanup = app.cleanup;
  ({ registerLegalTools } = await import('../server/tools/definitions/legal_tools'));
});

afterAll(() => cleanup());

describe('direct legal tool execution', () => {
  it('returns verified receipts for the asset-trace workflow read tools', async () => {
    const registry = new ToolRegistry();
    registerLegalTools(registry);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 404, headers: { 'content-type': 'text/plain' } }),
    );

    try {
      const calls = [
        { name: 'legal_external_source_status', arguments: {} },
        { name: 'legal_trace_assets', arguments: { name: 'Receipt Test Subject', persistCase: false } },
        { name: 'legal_equity_penetration', arguments: { name: 'Receipt Test Company', persistCase: false } },
        { name: 'legal_company_database_lookup', arguments: { name: 'Receipt Test Company', persistCase: false } },
        { name: 'legal_search_tender_projects', arguments: { keyword: 'Receipt Test Company', persistCase: false } },
        { name: 'legal_search_case', arguments: { query: 'Receipt Test Subject' } },
        { name: 'legal_search_statute', arguments: { query: 'enforcement' } },
        {
          name: 'legal_external_research_plan',
          arguments: {
            caseName: 'Receipt Test',
            facts: 'Asset investigation receipt test.',
            issues: ['asset clues'],
            companyNames: ['Receipt Test Company'],
            persistCase: false,
          },
        },
      ];

      for (const call of calls) {
        const output = await executeToolCallOrThrow({ registry, ...call });
        expect(output.length, call.name).toBeGreaterThan(20);
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('exposes every tool used by the asset-trace client through the direct route allowlist', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(
      new URL('../server/routes/chat_routes.ts', import.meta.url),
      'utf8',
    ));
    for (const toolName of [
      'legal_external_source_status',
      'legal_trace_assets',
      'legal_equity_penetration',
      'legal_company_database_lookup',
      'legal_search_tender_projects',
      'legal_search_case',
      'legal_search_statute',
      'legal_external_research_plan',
      'legal_case_strategy',
    ]) {
      expect(source).toContain(`'${toolName}'`);
    }
  });
});
