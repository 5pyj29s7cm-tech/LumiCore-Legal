import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAutonomousToolPolicy } from '../server/autonomy/task_executor';
import { autonomousTurnPlanningData } from '../server/autonomy/executor/tool_policy';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

let registry: ToolRegistry;

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
  registry = new ToolRegistry();
  registerAllTools(registry);
});

describe('autonomous capability planning entrance', () => {
  it('routes scheduled work through the same durable capability protocol', () => {
    const pipeline = buildLumiExecutionPipeline(autonomousTurnPlanningData({
      id: 'autotask-scheduled-1',
      userId: 'autonomous-plan-user',
      title: 'Inspect installed applications',
      description: '检查本机已经安装的桌面应用并生成只读清单。',
      source: 'scheduler',
    }, 30, registry));

    expect(pipeline.turnIntent.channel).toBe('scheduler');
    expect(pipeline.turnIntent.boundary).toBe('task_center');
    expect(pipeline.taskId).toBe('autotask-scheduled-1');
    expect(pipeline.executionPlan).toBeUndefined();
    expect(pipeline.modelToolProjection.toolNames.length).toBeGreaterThan(0);
  });

  it('fails an actual selected autonomous external call closed before its adapter can execute', async () => {
    const pipeline = buildLumiExecutionPipeline(autonomousTurnPlanningData({
      id: 'autotask-external-1',
      userId: 'autonomous-plan-user',
      title: 'Send a message',
      description: 'send to Alice: deployment is complete',
      source: 'user_request',
    }, 30, registry));

    expect(pipeline.turnIntent.channel).toBe('autonomy');
    expect(pipeline.executionPlan).toBeUndefined();
    const tool = registry.get('wechat_send_message')!;
    const original = tool.handler;
    const handler = vi.fn(async () => 'must not execute');
    tool.handler = handler;
    try {
      await expect(registry.execute('wechat_send_message', { contact: 'Alice', message: 'deployment is complete' }, {
        userId: 'autonomous-plan-user', authenticated: true, localExecution: true, autonomous: true,
        toolPolicy: pipeline.authorizationPolicy, actionIntent: 'send to Alice: deployment is complete',
      })).rejects.toThrow('Autonomous external commit blocked');
      expect(handler).not.toHaveBeenCalled();
    } finally { tool.handler = original; }
  });

  it('keeps a recovery attempt inside the capabilities persisted by its prior plan', () => {
    const policy = buildAutonomousToolPolicy({
      title: 'Resume a read task',
      description: 'Read the same target after a provider timeout',
      executionPlan: {
        decisionAuthority: 'semantic_planner',
        nodes: [
          { toolName: 'url_fetch' },
          { toolName: 'web_search' },
          { toolName: undefined },
        ],
      } as any,
      recovery: {
        planRevisions: [{ revision: 1, strategy: 'retry_same_plan' }],
      } as any,
    }, 30);
    expect(policy.allowedTools).toEqual(['url_fetch', 'web_search']);
    expect(policy.allowedTools).not.toContain('*');
  });
});
