import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import {
  hasRelevantEvidenceTool,
} from '../server/cognition/tool_planning';
import { registerModelConfigurationTools } from '../server/tools/definitions/model_configuration_tools';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const roles = ['alpha', 'beta', 'gamma'];
  registry.register({
    name: 'read_capability_state',
    description: 'Read or list all capability configuration. 读取或列出全部能力配置。',
    parameters: {
      type: 'object',
      properties: { role: { type: 'string', enum: roles } },
      required: [],
    },
    handler: async () => '{}',
    permission: 'user',
    securityLevel: 'safe',
    evidence: {
      capability: 'example.configuration',
      operation: 'observe',
      assurance: 'observed',
      subjectArgument: 'role',
    },
  });
  registry.register({
    name: 'test_capability_route',
    description: 'Test capability availability. 测试能力可用性。',
    parameters: {
      type: 'object',
      properties: { role: { type: 'string', enum: roles } },
      required: ['role'],
    },
    handler: async () => '{}',
    permission: 'user',
    securityLevel: 'safe',
    evidence: {
      capability: 'example.route',
      operation: 'test',
      assurance: 'verified',
      subjectArgument: 'role',
    },
  });
  return registry;
}

describe('generic tool planning', () => {
  beforeAll(async () => {
    await initDatabase();
  });
  it('discovers relevant evidence tools from their own descriptions', () => {
    const registry = createRegistry();
    expect(hasRelevantEvidenceTool(
      registry,
      '检查全部能力配置',
      ['read_capability_state'],
    )).toBe(true);
    expect(hasRelevantEvidenceTool(
      registry,
      '检查全部能力配置',
      ['unrelated_tool'],
    )).toBe(false);
  });

  it('routes a real all-model request through registry metadata, not a domain classifier', () => {
    const registry = new ToolRegistry();
    registerModelConfigurationTools(registry);
    const text = '检查一下各类模型配置';
    const dispatch = buildLumiTurnDispatch({
      userId: 'generic-model-discovery',
      text,
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: registry.getToolDeclarations(),
      toolRegistry: registry,
    });

    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolPolicy.allowedTools).toContain('model_configuration_get');
    expect(decision.promptOverlay).toContain('capability_discovery');
  });
});
