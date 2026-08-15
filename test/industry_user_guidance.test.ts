import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_VARIANT } from '../shared/product_variant';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import {
  getIndustryGuidancePreference,
  isIndustryGuidanceRequest,
} from '../server/industry/user_guidance';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  return registry;
}

function pipelineFor(text: string, channel: 'chat' | 'voice' = 'chat') {
  const registry = createRegistry();
  return buildLumiExecutionPipeline({
    dispatch: {
      userId: 'industry_guidance_route_user',
      text,
      channel,
      source: channel,
      operationMode: 'chat',
      targetIsLumi: true,
    },
    registry,
    source: channel,
  });
}

const EDITION_GUIDE_QUESTION: Record<string, string> = {
  ecommerce: '\u5e97\u94fa\u6570\u636e\u600e\u4e48\u7528',
  design: 'CAD \u65b9\u6848\u600e\u4e48\u7528',
  legal: '\u5408\u540c\u5ba1\u67e5\u600e\u4e48\u7528',
  finance: '\u7a0e\u52a1\u7533\u62a5\u600e\u4e48\u7528',
};

describe('industry user guidance', () => {
  it('routes chat and voice learning questions to the same read-only guide', () => {
    const request = '\u6211\u662f\u7b2c\u4e00\u6b21\u4f7f\u7528\uff0c\u4f60\u6559\u6211\u600e\u4e48\u5f00\u59cb';
    expect(isIndustryGuidanceRequest(request)).toBe(true);
    const chat = pipelineFor(request, 'chat');
    const voice = pipelineFor(request, 'voice');

    for (const pipeline of [chat, voice]) {
      expect(pipeline.turnIntent.flow.industryGuidanceRequest).toBe(true);
      expect(pipeline.execution.allowToolUse).toBe(true);
      expect(pipeline.execution.toolRoute?.hardAllowlist).toBe(true);
      expect(pipeline.execution.toolPolicy.allowedTools).toContain('industry_user_guide');
      expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('industry_workflow_start');
      expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('industry_guidance_preference_set');
      expect(pipeline.execution.promptOverlay).toContain('Industry User Guidance');
      expect(pipeline.execution.promptOverlay).toContain('Explain only');
      expect(pipeline.capabilityPlan.taskLedgerRequired).toBe(false);
    }
    expect(chat.execution.toolPolicy.allowedTools).toEqual(voice.execution.toolPolicy.allowedTools);
  });

  it('does not turn a correction containing usage words into a new guide or task', () => {
    const pipeline = pipelineFor(
      '\u4f60\u641e\u9519\u4e86\uff0c\u6211\u53ea\u662f\u95ee\u8fd9\u4e2a\u9875\u9762\u600e\u4e48\u7528',
    );
    expect(pipeline.turnIntent.flow.industryGuidanceRequest).toBe(false);
    expect(pipeline.execution.toolPolicy.allowedTools || []).not.toContain('industry_user_guide');
    expect(pipeline.execution.toolPolicy.allowedTools || []).not.toContain('industry_workflow_start');
  });

  it('recognizes a real workspace usage question for this exact edition', () => {
    const pipeline = pipelineFor(EDITION_GUIDE_QUESTION[PRODUCT_VARIANT.productLine]);
    expect(pipeline.turnIntent.flow.industryGuidanceRequest).toBe(true);
    expect(pipeline.execution.toolPolicy.allowedTools).toContain('industry_user_guide');
    expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('industry_workflow_start');
  });

  it('returns the exact edition contract with no more than three steps and no execution claim', async () => {
    const registry = createRegistry();
    const result = JSON.parse(await registry.execute('industry_user_guide', {}, {
      userId: 'industry_guidance_read_user',
      domain: 'personal',
      actionIntent: '\u8fd9\u4e2a\u5b9a\u5236\u7248\u600e\u4e48\u7528',
      routedTaskText: '\u8fd9\u4e2a\u5b9a\u5236\u7248\u600e\u4e48\u7528',
      source: 'voice',
    }));

    expect(result).toMatchObject({
      ok: true,
      status: 'guided',
      edition: {
        variantId: PRODUCT_VARIANT.variantId,
        productLine: PRODUCT_VARIANT.productLine,
      },
      effectivePreference: { level: 'beginner', mode: 'explain' },
      responseContract: {
        maximumSteps: 3,
        explainOnly: true,
        neverTreatGuidanceAsCompletionEvidence: true,
        externalCommitRequiresExactConfirmation: true,
      },
    });
    expect(result.steps.length).toBeLessThanOrEqual(3);
    expect(result.availableWorkspaces.length).toBeGreaterThan(0);
  });

  it('persists explicit teaching preferences per user without granting execution permission', async () => {
    const registry = createRegistry();
    const userId = `industry_guidance_preference_${PRODUCT_VARIANT.productLine}`;
    const saved = JSON.parse(await registry.execute('industry_guidance_preference_set', {
      level: 'skilled',
      mode: 'guided',
    }, {
      userId,
      domain: 'personal',
      source: 'chat',
    }));
    expect(saved).toMatchObject({
      ok: true,
      status: 'saved',
      persisted: true,
      preference: { level: 'skilled', mode: 'guided' },
    });
    expect(getIndustryGuidancePreference({
      userId,
      domain: 'personal',
      orgId: '',
    })).toMatchObject({ level: 'skilled', mode: 'guided' });
    expect(getIndustryGuidancePreference({
      userId: `${userId}_other`,
      domain: 'personal',
      orgId: '',
    })).toMatchObject({ level: 'beginner', mode: 'explain' });

    const guided = JSON.parse(await registry.execute('industry_user_guide', {}, {
      userId,
      domain: 'personal',
      actionIntent: '\u4e0b\u4e00\u6b65\u5e94\u8be5\u600e\u4e48\u505a',
      source: 'chat',
    }));
    expect(guided.effectivePreference.mode).toBe('guided');
    expect(guided.responseContract.guidedExecutionLimit).toContain('one explicitly requested');
    expect(guided.responseContract.externalCommitRequiresExactConfirmation).toBe(true);
  });

  it('exposes preference mutation only for an explicit remember-default request', () => {
    const pipeline = pipelineFor(
      '\u4ee5\u540e\u6559\u6211\u65f6\u9ed8\u8ba4\u8fb9\u6559\u8fb9\u505a\uff0c\u8bb0\u4f4f\u8fd9\u4e2a\u8bbe\u7f6e',
    );
    expect(pipeline.turnIntent.flow.industryGuidanceRequest).toBe(true);
    expect(pipeline.execution.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
      'industry_user_guide',
      'industry_guidance_preference_set',
    ]));
    expect(pipeline.execution.toolPolicy.allowedTools).not.toContain('industry_workflow_start');
  });
});
