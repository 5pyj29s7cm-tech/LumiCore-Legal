import { reasoningChecks } from './legal_reasoning_fixture';
import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { createOrg, addMember } from '../server/org/db';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { decodeToolResult } from '../server/tools/result_envelope';
import { makeLLMCall } from '../server/llm/providers';
import { createCase, addMaterial, getCase } from '../server/org/legal_cases';
import { verifyCitation } from '../server/legal/kb';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import { inspectLegalReasoningLinks, formatLegalReasoningLinks } from '../server/regions/packs/cn/legal_reasoning_links';

vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn(),
}));
const registry = new ToolRegistry();
const context = { userId: 'reasoning-owner', domain: 'work', orgId: 'reasoning-org', authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local', llmGetters: {} } as any;
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); context.orgId = createOrg('Reasoning regressions fixture', 'reasoning-regressions', context.userId).id; addMember(context.orgId, context.userId, 'owner'); installCivilCodeFixture(); registerLegalTools(registry); });
afterAll(() => app.cleanup());
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

function fixture() {
  const item = createCase(context.orgId, context.userId, { title: '虚构旧版归档材料案', cause: '买卖合同纠纷' });
  const material = addMaterial(context.orgId, context.userId, item.id, {
    type: 'evidence', source: 'tool', title: '证据材料与证明目的',
    content: '已签收货物，尚欠二万元；违约金约定和损失尚需核实。',
  })!;
  addMaterial(context.orgId, context.userId, item.id, {
    type: 'note', source: 'tool', title: '上次生成的意见书', content: '不得作为原始证明的生成稿标记。',
  });
  const link = {
    issue: '违约金的核实', ruleCitation: '《民法典》第585条', ruleQuote: verifyCitation('《民法典》第585条').sourceText!,
    fact: material.content, evidence: [{ materialId: material.id, quote: material.content, locator: '材料正文第1句' }],
    application: '需结合完整约定和实际损失核实违约金，欠款记录不证明违约金的具体金额。',
    conclusion: '现有材料不足以确认违约金数额，须补充约定全文及损失凭证。', limitations: '尚未核对原件及对方提出的反证。',
  };
  return { item, material, link };
}
const run = async (caseId: string, overrides = {}) => decodeToolResult(await registry.execute('legal_case_reasoning_matrix', {
  caseId, legalAuthorities: '《民法典》第585条', writeFiles: false, ...overrides,
}, context));
const entryFor = (link: ReturnType<typeof fixture>['link']) => ({ issue: link.issue, ruleId: 'R1', checks: reasoningChecks(link.ruleQuote, { sourceIds: ['F1'], application: link.application, conclusion: link.conclusion, limitations: link.limitations }) });
const generated = (link: ReturnType<typeof fixture>['link']) => ({ text: JSON.stringify({ entries: [entryFor(link)] }), toolCalls: null });
const reviewed = (link: ReturnType<typeof fixture>['link']) => ({ text: JSON.stringify({ reviews: [{ index: 1, checks: reasoningChecks(link.ruleQuote, { sourceIds: ['F1'], status: 'conditional', application: link.application, conclusion: link.conclusion, missingPremises: ['需补充完整约定及损失凭据'] }) }], uncoveredIssues: [] }), toolCalls: null });

describe('legal reasoning failure truth and original source continuity', () => {
  it('passes archived original material IDs to the model while excluding prior generated analysis', async () => {
    const { item, material, link } = fixture();
    vi.mocked(makeLLMCall).mockResolvedValueOnce(generated(link)).mockResolvedValueOnce(reviewed(link));
    const output = await run(item.id);
    expect(output.receipt).toMatchObject({ ok: true, reasoningLinked: true });
    const prompt = String(vi.mocked(makeLLMCall).mock.calls[0][0].find(message => message.role === 'user')!.content);
    const supplied = JSON.parse(prompt.slice(prompt.lastIndexOf('\n材料：') + 4));
    expect(supplied).toContainEqual(expect.objectContaining({ materialId: material.id, quote: material.content }));
    expect(prompt).not.toContain('不得作为原始证明的生成稿标记');
    expect(getCase(context.orgId, item.id, context.userId)?.workflowRuns?.at(-1)).toMatchObject({ ok: true, reasoningLinked: true });
  });

  it.each([
    [{ text: null, finishReason: 'length' as const, toolCalls: null }, '输出额度已耗尽'],
    [{ text: null, finishReason: 'stop' as const, toolCalls: null }, '未返回分析正文'],
    [{ text: '{"links":', toolCalls: null }, '格式不完整'],
    [{ text: '{"entries":[]}', toolCalls: null }, '模型未返回1–30项'],
  ])('keeps failed analysis partial without archiving it, and preserves its specific failure file', async (response, reason) => {
    const { item } = fixture();
    const originals = getCase(context.orgId, item.id, context.userId)!.materials;
    vi.mocked(makeLLMCall).mockResolvedValue(response);
    const output = await run(item.id, { writeFiles: true });
    expect(output.receipt).toMatchObject({ ok: false, status: 'partial', reasoningLinked: false });
    expect(output.content).toContain(reason);
    expect(output.content).not.toContain('底稿已生成');
    const archived = getCase(context.orgId, item.id, context.userId)!;
    expect(archived.workflowRuns?.at(-1)).toMatchObject({ ok: false, status: 'partial', reasoningLinked: false });
    expect(archived.materials).toEqual(originals);
    expect(archived.workflowRuns?.at(-1)?.materialIds).toEqual([]);
    const receipt = output.receipt;
    if (!receipt || typeof receipt !== 'object' || !('artifacts' in receipt) || !Array.isArray(receipt.artifacts)) throw Error('Missing actual matrix artifact receipt');
    const analysisPath = receipt.artifacts.find((file: unknown): file is string => typeof file === 'string' && file.endsWith('legal-reasoning-matrix.md'))!;
    const analysis = fs.readFileSync(analysisPath, 'utf8');
    expect(analysis).toContain(reason);
    expect(analysis).toContain('待逐项匹配法条');
    expect(analysis).not.toMatch(/\| 通过 \|/);
  });

  it('rejects truncated JSON even if the returned prefix happens to parse', async () => {
    const { item, link } = fixture();
    vi.mocked(makeLLMCall).mockResolvedValue({ text: JSON.stringify({ links: [link] }), finishReason: 'length', toolCalls: null });
    expect((await run(item.id)).receipt).toMatchObject({ ok: false, reasoningLinked: false });
  });

  it('shares a finite 180-second workflow while keeping each generation and applicability call capped at90 seconds', async () => {
    const { item, link } = fixture();
    vi.useFakeTimers();
    vi.mocked(makeLLMCall).mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(generated(link)), 70000)))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(reviewed(link)), 10000)));
    const pending = run(item.id);
    await vi.advanceTimersByTimeAsync(80001);
    expect((await pending).receipt).toMatchObject({ ok: true, reasoningLinked: true });
    const config = vi.mocked(makeLLMCall).mock.calls[0][2];
    expect(config.maxTokens).toBeGreaterThanOrEqual(8192);
    expect(config.attemptTimeouts?.absoluteMs).toBe(90000);
    expect(vi.mocked(makeLLMCall).mock.calls[1][2].attemptTimeouts?.absoluteMs).toBe(90000);
    
    expect(config.thinkingMode).toBeUndefined();
    expect(config.reasoningEffort).toBeUndefined();
    expect(vi.mocked(makeLLMCall).mock.calls[1][2].thinkingMode).toBeUndefined();
  });

  it('fails closed on malformed nested fields without crashing or archiving raw objects', async () => {
    const { item, link } = fixture();
    const invalid = [null, { ...link, limitations: {} }, { ...link, evidence: [null] }, { ...link, evidence: [{ materialId: link.evidence[0].materialId, quote: [], locator: {} }] }];
    vi.mocked(makeLLMCall).mockResolvedValue({ text: JSON.stringify({ links: invalid }), toolCalls: null });
    const output = await run(item.id);
    expect(output.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(output.content).toContain('模型未返回1–30项');
    const check = inspectLegalReasoningLinks(invalid, getCase(context.orgId, item.id, context.userId), context.orgId);
    expect(check.passed).toBe(false);
    expect(check.links).toEqual([]);
    expect(() => formatLegalReasoningLinks(invalid as any)).not.toThrow();
  });

  it('does not let a partially valid result become an approved archived basis on a later delivery', async () => {
    const { item, link } = fixture();
    vi.mocked(makeLLMCall).mockResolvedValue({ text: JSON.stringify({ entries: [entryFor(link), null] }), toolCalls: null });
    expect((await run(item.id)).receipt).toMatchObject({ ok: false, reasoningLinked: false });
    const archived = getCase(context.orgId, item.id, context.userId)!;
    expect(archived.materials.some(m => m.reasoningLinks?.length)).toBe(false);
    const delivery = decodeToolResult(await registry.execute('legal_finalize_delivery_package', {
      caseId: item.id, content: formatLegalReasoningLinks([link]), includeDocx: false,
    }, context));
    expect(delivery.receipt).toMatchObject({ ok: false, status: 'blocked' });
  });

  it('fills facts from originals and revises an unsupported inference in a separate review', async () => {
    const { item, link } = fixture();
    vi.mocked(makeLLMCall)
      .mockResolvedValueOnce({ text: JSON.stringify({ entries: [{ ...entryFor(link), fact: '合同没有约定付款日期，故签收当天全部货款到期。', checks: reasoningChecks(link.ruleQuote, { sourceIds: ['F1'], application: '合同没有约定付款日期，签收当天到期。', conclusion: link.conclusion, limitations: link.limitations }) }] }), toolCalls: null })
      .mockResolvedValueOnce(reviewed(link));
    expect((await run(item.id)).receipt).toMatchObject({ ok: true, reasoningLinked: true });
    expect(makeLLMCall).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(makeLLMCall).mock.calls[1][0].find(message => message.role === 'user')!.content)).toContain('未提供、未回应或未证明前提满足，不能推出其相反状态或前提不成立');
    const archived = getCase(context.orgId, item.id, context.userId)!;
    expect(archived.materials.find(m => m.reasoningLinks?.length)?.reasoningLinks?.[0].fact).toBe(link.fact);
    expect(archived.materials.find(m => m.reasoningLinks?.length)?.reasoningLinks?.[0].application).not.toContain('签收当天到期');
  });

  it('keeps unsupported or incomplete applicability reviews out of reusable reasoning', async () => {
    const { item, link } = fixture();
    vi.mocked(makeLLMCall).mockResolvedValueOnce(generated(link)).mockResolvedValueOnce({ text: '{"reviews":[]}', toolCalls: null });
    const output = await run(item.id);
    expect(output.receipt).toMatchObject({ ok: false, reasoningReviewed: false });
    expect(getCase(context.orgId, item.id, context.userId)?.materials.some(m => m.reasoningLinks?.length)).toBe(false);
  });

  it('reports an upstream timeout without disguising it as completed analysis', async () => {
    const { item, link } = fixture();
    vi.mocked(makeLLMCall).mockResolvedValueOnce(generated(link)).mockRejectedValueOnce(new Error('504 aliyun 请求超时。'));
    const output = await run(item.id);
    expect(output.receipt).toMatchObject({ ok: false, status: 'partial', reasoningReviewed: false });
    expect(output.content).toContain('官方模型线路返回超时');
    expect(makeLLMCall).toHaveBeenCalledTimes(2);
  });

  it('fills a review-identified omission once and reviews the repaired analysis again', async () => {
    const { item, link } = fixture();
    const response = JSON.parse(reviewed(link).text);
    response.uncoveredIssues = ['付款与本案合同的对应关系尚未展开'];
    vi.mocked(makeLLMCall).mockResolvedValueOnce(generated(link))
      .mockResolvedValueOnce({ text: JSON.stringify(response), toolCalls: null })
      .mockResolvedValueOnce(generated(link)).mockResolvedValueOnce(reviewed(link));
    expect((await run(item.id)).receipt).toMatchObject({ ok: true, reasoningReviewed: true });
    expect(makeLLMCall).toHaveBeenCalledTimes(4);
    expect(String(vi.mocked(makeLLMCall).mock.calls[2][0].find(message => message.role === 'user')!.content)).toContain('资料缺漏只作条件分析');
  });
});
