import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { createWorkTakeoverTask } from '../server/work_takeover/tasks';
import { buildWorkTakeoverContinuityContext } from '../server/work_takeover/continuity';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { ToolRegistry } from '../server/tools/registry';
import { hasExplicitToolIntent } from '../server/cognition/tool_intent';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';

const originalRequest = '下面是虚构程序验收素材，不是真实委托案件。只在当前隔离个人聊天里处理，不要创建或归档案件，不要向法院提交任何材料。请现在直接提炼争议焦点，不要介绍办理方法，也不要起草诉状。2026年9月1日虚构甲公司与虚构乙公司订立买卖合同，9月5日交货。原告甲公司主张被告乙公司仍欠货款9万元；被告称其中7万元已经付款，目前只有付款截图，原始银行流水和收款记录尚未核实。被告同时主张货物存在质量问题，但没有检验报告，质量争议尚未检验。请分项给出付款抵扣及欠款金额、货物质量与付款抗辩这两个方面的争议焦点、双方主张、待证事实和需要补核实的证据；对7万元付款和质量缺陷都保留未核实状态，不作确定认定。只返回面向律师复核的争点工作稿。';
const explicitRequest = "以下只是虚构程序验收素材，不是真实委托案件。请现在实际调用一次当前已有的争议焦点提炼函数 legal_extract_dispute_focus，等待它返回后只给我争点工作稿；不要由你直接代替这个函数自行分析，不要调用其他法律检索功能，不要创建或归档案件，不要向法院提交材料。虚构甲乙公司于2026年9月1日订立买卖合同，9月5日交货。原告甲公司主张仍欠货款9万元，被告乙公司称其中7万元已付款，但只有截图，原始银行流水和收款记录待核实；被告另称货物质量有问题，但尚无检验报告、未检验。请通过这个已有函数提炼付款抵扣与欠款金额、质量问题与付款抗辩两个方面，列双方主张、待证事实和待补证据，付款与质量缺陷都保留未核实状态。最后只显示律师复核工作稿，不复述函数名、参数或调用过程。";
const userId = 'legal-new-work-continuity';
beforeAll(async () => {
  await initDatabase();
  createWorkTakeoverTask({ userId, category: 'general_work', title: 'Old unrelated customer work', source: 'manual', status: 'in_progress', nextActions: ['Prepare old delivery'] });
});

describe('new legal work preserves its own intent', () => {
  it.each([originalRequest, explicitRequest, '请提炼付款和质量争议焦点，证据与事实保留未核实状态，只返回律师工作稿。'])('does not let legal evidence/status nouns bind new work to an older task', text => {
    expect(hasExplicitToolIntent(text)).toBe(true);
    const continuity = buildWorkTakeoverContinuityContext(userId, text, { surface: 'chat', domain: 'personal' });
    expect(continuity.latestTask).not.toBeNull();
    expect(continuity).toMatchObject({ intent: null, strength: 'none', shouldResumeTask: false, routeText: text });
  });
  it.each([originalRequest, explicitRequest])('carries the accepted intent through the actual shared execution pipeline', text => {
    const pipeline = buildLumiExecutionPipeline({ userText: text,
      dispatch: { userId, text, source: 'chat', channel: 'chat', domain: 'personal', operationMode: 'assistant', targetIsLumi: true },
      registry: new ToolRegistry(), personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 },
    });
    expect(pipeline.normalizedIntent).toEqual(normalizeActionIntent(text));
    expect(pipeline.normalizedIntent.kind).not.toBe('status_query');
    expect(pipeline.turnIntent.flow.routeText).toBe(text);
    expect(pipeline.turnIntent.flow.workTakeover.shouldResumeTask).toBe(false);
    expect(pipeline.turnIntent.flow.structuredMediaRequest).toBeUndefined();
  });
  it.each(['做完了吗？', '这个任务的结果怎么样？', '完成这个工作了吗？'])('preserves real task-status continuation: %s', text => {
    expect(buildWorkTakeoverContinuityContext(userId, text, { surface: 'work' })).toMatchObject({ intent: 'status', shouldResumeTask: true });
  });
  it.each(['当前任务进度怎么样了？', '壁纸状态怎么样？'])('preserves canonical explicit status questions: %s', text => {
    expect(normalizeActionIntent(text).kind).toBe('status_query');
  });
  it('preserves an explicit instruction to continue the existing work', () => {
    expect(buildWorkTakeoverContinuityContext(userId, '现在帮我完成这项工作。', { surface: 'work' })).toMatchObject({ intent: 'advance', shouldResumeTask: true });
  });
});
