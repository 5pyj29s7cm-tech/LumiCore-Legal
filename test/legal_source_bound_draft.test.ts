import { reasoningFixtureReply } from './legal_reasoning_fixture';
import { sdkCompletionFixture } from './legal_contract_fixture';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeApp } from './helpers';
import { legalCaseSourceFingerprint } from '../shared/legal_workflow_receipts';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { decodeToolResult } from '../server/tools/result_envelope';
import { buildMaterialSources, resolveSourceDraftEntries } from '../server/regions/packs/cn/legal_reasoning_generation';
import { legalDocumentProgress } from '../server/regions/packs/cn/legal_document_progress';
import { getDataDirectory } from '../server/config/data_path';
import { createCase, addMaterial, getCase, listCases, legalWorkspaceNamespace } from '../server/org/legal_cases';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
const raw = '原告主张尚欠九万元，原件未核实。\n被告主张已付七万元，截图是否对应本案未查明。\n审阅者未取得完整合同，不代表合同没有约定。\n计划交付日2026-10-20，实际交付日未提供。SOURCE-END';
const source = buildMaterialSources([{ id: 'facts', title: '案件事实与审阅记录', content: raw }]);
const sections = ['analysis', 'requests', 'review'];
const valid = () => ({ entries: sections.map(sectionId => ({ sectionId, sourceIds: ['F1', 'F2', 'F3', 'F4'], response: '旧独立自由正文不得再作为法律论证。', missing: '' })) });
const application = '需核实原件与交易对应关系，不能由截图推定付款已经完成。';
const conclusion = '原件及付款关联核实之前，不据此确认已支付或欠款数额。';
let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry(), userId = 'source-bound-draft-owner', orgId = legalWorkspaceNamespace(userId);
let replies: unknown[] = [], finishReason = 'stop';
const create = vi.fn(async (params: any) => {
    const prompt = String(params.messages.find((m: any) => m.role === 'user').content);
    const generated = { entries: [{ issue: '付款陈述与原件核对', ruleId: 'R1', sourceIds: ['F1', 'F2', 'F3', 'F4'], application, conclusion, limitations: '尚需原件与交易对应关系，未推定合同无约定。' }] };
    const reviewed = { reviews: [{ index: 1, status: 'conditional', application, conclusion, reason: '原文包含的是待核实陈述，不能视为已认定事实。', missingPremises: ['原件及交易对应关系'] }], uncoveredIssues: [] };
    const reply = replies.length ? replies.shift() : prompt.includes('你是法律适用复核者') ? reviewed : generated;
    return sdkCompletionFixture(reasoningFixtureReply(prompt, reply), finishReason, params.stream);
});
const context = { userId, authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local', domain: 'personal', source: 'legal-direct-tool', llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => ({ chat: { completions: { create } } }) } } as any;
const run = async (extra: Record<string, any> = {}, overrides = {}) => decodeToolResult(await registry.execute('legal_generate_argument_or_opinion', { caseName: '来源绑定虚构案', role: '被告', facts: raw, factDate: '2026-09-01', persistCase: false, ...extra }, { ...context, ...overrides }));
function fixture() { const item = createCase(orgId, userId, { title: '当前原件论证虚构案', factDate: '2026-09-01' }); const material = addMaterial(orgId, userId, item.id, { type: 'evidence', source: 'manual', title: '未经核实的双方原始陈述', content: raw })!; addMaterial(orgId, userId, item.id, { type: 'note', source: 'tool', title: '旧意见稿', content: 'OLD-FREE-DRAFT-IGNORED' }); return { item, material, args: { caseId: item.id, legalAuthorities: '《民法典》第626条', objective: '先核对付款及交付原件，不承认尚未确认的欠款。' } }; }
beforeAll(async () => { app = await makeApp(); installCivilCodeFixture(); registerLegalTools(registry); upsertUserPreferredLLM(userId, { provider: 'relay', model: 'deepseek-v4-source-draft-fixture', selectionMode: 'pinned' }); });
afterAll(() => app.cleanup());
beforeEach(() => { replies = []; finishReason = 'stop'; create.mockClear(); });
describe('argument drafting consumes the existing legal reasoning and review chain', () => {
    it.each(['代理词', '法律意见书', '庭审提纲', '应对策略'])('keeps complete %s analysis with exact source facts and the existing applicability review', async (documentType) => {
        const { item, material, args } = fixture();
        const result = await run({ ...args, documentType, issues: ['仅核实付款陈述及原件关联'] });
        expect(result.receipt).toMatchObject({ ok: true, status: 'generated', persisted: false, reasoningLinked: true, reasoningReviewed: true });
        expect(result.content).toContain(item.title + ' ' + documentType + '草稿');
        expect(result.content).toContain('我方身份: 被告');
        expect(result.content).toContain('实体法律适用时间基准（仅案件级，不代表各事件日期）: 2026-09-01');
        for (const line of raw.split('\n'))
            expect(result.content).toContain(line);
        expect(result.content).toContain(material.id);
        expect(result.content).toContain(application);
        expect(result.content).toContain(conclusion);
        expect(result.content).toContain('未经律师核准');
        expect(result.content).toContain('仍不等于事实已经证明或律师已核准');
        expect(result.content).not.toContain('OLD-FREE-DRAFT-IGNORED');
        expect(create).toHaveBeenCalledTimes(2);
        for (const [params] of create.mock.calls) {
            expect(params).toMatchObject({ model: 'deepseek-v4-source-draft-fixture', max_tokens: 8192, response_format: { type: 'json_object' } });
            expect(params).not.toHaveProperty('thinking');
            expect(params).not.toHaveProperty('reasoning_effort');
        }
        const prompt = create.mock.calls[0][0].messages.find((m: any) => m.role === 'user').content;
        expect(prompt).not.toContain('sectionId');
        expect(prompt).toContain('ruleId'); expect(prompt).toContain('用户所列争点：["仅核实付款陈述及原件关联"]');
        expect(JSON.parse(prompt.split('\n材料：')[1])).toEqual(buildMaterialSources([{ id: material.id, title: material.title, content: raw }]));
    });
    it('does not create a fake source case or call the SDK when no archived source case exists', async () => { const before = listCases(orgId, '', 200, userId).length; const result = await run(); expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false }); expect(result.content).toContain('需要先将原始材料归档到明确案件'); expect(result.content).toContain('SOURCE-END'); expect(listCases(orgId, '', 200, userId)).toHaveLength(before); expect(create).not.toHaveBeenCalled(); });
    it('keeps missing archived originals or verified concrete law visibly partial with zero SDK calls', async () => {
        const empty = createCase(orgId, userId, { title: '空材料案件' });
        expect((await run({ caseId: empty.id, legalAuthorities: '《民法典》第626条' })).receipt).toMatchObject({ ok: false, status: 'partial' });
        const { args } = fixture();
        const result = await run({ ...args, legalAuthorities: '民法典法名候选，尚无具体核验法条' });
        expect(result.receipt).toMatchObject({ ok: false, status: 'partial' });
        expect(result.content).toContain('缺少已归档原始材料或已核验的具体法条');
        expect(create).not.toHaveBeenCalled();
    });
    it('does not blame a provider failure on already archived originals or verified rules', async () => {
        const { item, args } = fixture();
        let result!: Awaited<ReturnType<typeof run>>;
        await create.withImplementation(async () => { throw new Error('Controlled provider failure after readiness.'); }, async () => {
            result = await run(args);
        });
        expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false, reasoningReviewed: false });
        expect(result.content).toContain('模型调用失败，分析未完成。');
        expect(result.content).not.toContain('请先在案件工作台归档原件');
        expect(result.content).not.toContain('缺少已归档原始材料或已核验的具体法条');
        expect(result.content).toContain('SOURCE-END');
        expect(create).toHaveBeenCalled();
        expect(getCase(orgId, item.id, userId)!.materials.filter(material => material.source === 'tool')).toHaveLength(1);
    });
    it('never renders the retired free-response JSON even with valid source IDs and f8 false observations', async () => { const { args } = fixture(); const bad = '货物数量虽有记载；现有照片未显示拍摄时间；否则抗辩不能成立。'; replies = [{ entries: valid().entries.map(e => ({ ...e, response: bad, missing: bad })) }, { entries: valid().entries.map(e => ({ ...e, response: bad, missing: bad })) }]; const result = await run(args); expect(result.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(result.content).toContain('SOURCE-END'); expect(result.content).not.toContain(bad); expect(create).toHaveBeenCalledTimes(2); });
    it('renders existing review corrections rather than an unreviewed factual expansion', async () => { const { args } = fixture(); const bad = '现有照片未显示拍摄时间，货物数量已有记载。'; replies = [{ entries: [{ issue: '付款与原件核对', ruleId: 'R1', sourceIds: ['F1', 'F2', 'F3', 'F4'], application: bad, conclusion: bad, limitations: '原件及交易对应关系尚未核实。' }] }]; const result = await run(args); expect(result.receipt).toMatchObject({ ok: true, reasoningReviewed: true }); expect(result.content).not.toContain(bad); expect(result.content).toContain(application); expect(create).toHaveBeenCalledTimes(2); });
    it.each(['supported', 'conditional'])('renders corrected sources without obsolete prior-draft remarks after %s review', async status => {
        const { material, args } = fixture();
        const stale = '旧稿未引用F2，需补正；这只是上一步稿件的修订说明。';
        const missing = status === 'conditional' ? ['当前仍需核对银行原件与交易关联'] : [];
        replies = [
            { entries: [{ issue: '付款来源及前提核对', ruleId: 'R1', sourceIds: ['F1'], application, conclusion, limitations: '双方主张及原件真实性仍需律师核实。' }] },
            { reviews: [{ index: 1, status, sourceIds: ['F1', 'F2'], application, conclusion, reason: stale, missingPremises: missing }], uncoveredIssues: [] },
        ];
        const result = await run(args);
        expect(result.receipt).toMatchObject({ ok: true, reasoningReviewed: true });
        expect(create).toHaveBeenCalledTimes(2);
        expect(result.content).toContain(material.id);
        expect(result.content).toContain(raw.split('\n')[1]);
        expect(result.content).toContain('不证明证据真实或律师已经核准');
        expect(result.content).not.toContain(stale);
        if (missing.length) expect(result.content).toContain(missing[0]);
        expect(result.content).toContain('未经律师核准');
    });
    it('does not mistake caller-supplied traceable links for completed applicability review', async () => { const { item, material, args } = fixture(); const { verifyCitation } = await import('../server/legal/kb'); const link = { issue: '付款核对', ruleCitation: '《民法典》第626条', ruleQuote: verifyCitation('《民法典》第626条').sourceText!, fact: raw, evidence: [{ materialId: material.id, quote: raw, locator: '正文1至4行' }], application, conclusion, limitations: '原件及对应关系尚需核实。' }; const result = await run({ ...args, reasoningLinks: [link] }); expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reasoningLinked: true, reasoningReviewed: false }); expect(result.content).not.toContain(application); expect(create).not.toHaveBeenCalled(); expect(getCase(orgId, item.id, userId)!.materials.filter(m => m.source === 'tool')).toHaveLength(1); });
    it.each(['length', 'max_tokens', 'MAX_TOKENS'])('rejects %s truncation through the existing reasoning boundary', async (reason) => { const { args } = fixture(); finishReason = reason; const result = await run(args); expect(result.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(result.content).toContain('输出额度已耗尽'); expect(result.content).not.toContain(application); });
    it('keeps invalid review partial and never exposes its unreviewed draft', async () => { const { args } = fixture(); replies = [{ entries: [{ issue: '付款核对', ruleId: 'R1', sourceIds: ['F1'], application: 'UNREVIEWED-INFERENCE', conclusion: 'UNREVIEWED-CONCLUSION', limitations: '尚需原件' }] }, { reviews: [], uncoveredIssues: [] }]; const result = await run(args); expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reasoningReviewed: false }); expect(result.content).not.toContain('UNREVIEWED-INFERENCE'); });
    it('preserves cancellation and local-only policy before cloud SDK dispatch', async () => { const { args } = fixture(); const controller = new AbortController(); controller.abort(); await expect(run(args, { executionSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(create).not.toHaveBeenCalled(); const result = await run(args, { dataRoutingPolicy: 'local_only' }); expect(result.receipt).toMatchObject({ ok: false, status: 'partial' }); expect(create).not.toHaveBeenCalled(); });
    it('keeps both strategy searches as candidates and archives reviewed strategy as a note', async () => {
        const kb = await import('../server/legal/kb');
        const full = '法条检索候选说明，仍须本案适用复核。'.repeat(30) + 'CANDIDATE-TAIL';
        const statutes = vi.spyOn(kb, 'searchStatutes').mockResolvedValueOnce([{ articleId: 'strategy-rule', title: '《民法典》第626条', chunk: full, score: 1, isEffective: true }]);
        const similar = vi.spyOn(kb, 'searchSimilarCases').mockResolvedValueOnce([{ articleId: 'strategy-case', title: '虚构类案仅作为检索线索', chunk: '类案来源尚待核验。', score: 1, caseNumber: '虚构索引', court: '待核对' }]);
        try {
            const { item, args } = fixture();
            const result = decodeToolResult(await registry.execute('legal_case_strategy', { ...args, facts: raw, persistCase: true }, context));
            expect(statutes).toHaveBeenCalledTimes(1);
            expect(similar).toHaveBeenCalledTimes(1);
            expect(result.receipt).toMatchObject({ ok: true, reasoningReviewed: true });
            expect(result.content).toContain(full);
            expect(result.content).toContain('虚构类案仅作为检索线索');
            expect(result.content).toContain('未作本案适用或类案核准');
            expect(result.content).not.toContain('已验证有效');
            expect(getCase(orgId, item.id, userId)!.materials.find(material => material.title.endsWith('应对策略草稿'))).toMatchObject({ type: 'note', source: 'tool' });
            expect(create).toHaveBeenCalledTimes(2);
        }
        finally {
            statutes.mockRestore();
            similar.mockRestore();
        }
    });
    it('keeps title-only or unverified candidate law partial without inventing a source or calling the SDK', async () => {
        const kb = await import('../server/legal/kb');
        const statutes = vi.spyOn(kb, 'searchStatutes').mockResolvedValueOnce([{ articleId: 'strategy-title', title: '民法典', chunk: '没有具体条文、原文或核验来源的索引。', score: 1, isEffective: null }]);
        const similar = vi.spyOn(kb, 'searchSimilarCases').mockResolvedValueOnce([]);
        try {
            const { item } = fixture();
            const result = decodeToolResult(await registry.execute('legal_case_strategy', { caseId: item.id, facts: raw, factDate: '2026-09-01', persistCase: true }, context));
            expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reasoningReviewed: false });
            expect(result.content).toContain('缺少已归档原始材料或已核验的具体法条');
            expect(result.content).toContain('没有具体条文');
            expect(create).not.toHaveBeenCalled();
            expect(getCase(orgId, item.id, userId)!.materials.filter(material => material.source === 'tool')).toHaveLength(1);
        }
        finally {
            statutes.mockRestore();
            similar.mockRestore();
        }
    });
    it.each(['legal_case_strategy', 'legal_generate_argument_or_opinion'])('binds current editable input before %s generation and review without overwriting the case summary', async toolName => {
        const { item, args } = fixture();
        const current = '被告本次新增陈述：银行已撤回此前七万元转账，是否对应本案仍需核实。CURRENT-INPUT-FIRST\n审阅者补充：撤回与付款的时间顺序尚未查清，不可先作确定结论。CURRENT-INPUT-TAIL';
        const { updateCase } = await import('../server/org/legal_cases');
        updateCase(orgId, userId, item.id, { notes: '既有案件摘要原文不得被本次输入覆盖。' });
        const before = getCase(orgId, item.id, userId)!;
        const result = decodeToolResult(await registry.execute(toolName, { ...args, facts: current, persistCase: true }, context));
        expect(result.receipt).toMatchObject({ ok: true, reasoningReviewed: true });
        expect(create).toHaveBeenCalledTimes(2);
        for (const [params] of create.mock.calls) for (const paragraph of current.split('\n')) expect(params.messages.find((message: any) => message.role === 'user').content).toContain(paragraph);
        const after = getCase(orgId, item.id, userId)!;
        const summary = (notes: string) => notes.replace(/^【材料归档】.*$/gm, '').trim();
        expect(summary(after.notes)).toBe(summary(before.notes)); expect(after.notes).toContain('既有案件摘要原文不得被本次输入覆盖。');
        expect(after.factDate).toBe(before.factDate);
        expect(after.materials.filter(material => material.source === 'manual')).toHaveLength(before.materials.filter(material => material.source === 'manual').length + 1);
        expect(after.materials.filter(material => material.source === 'manual' && material.content === current)).toHaveLength(1);
        expect(after.materials.find(material => material.content === current)?.title).toContain('待核实');
    });
    it('returns partial with zero SDK calls for new unarchived input when persistence is disabled', async () => {
        const { item, args } = fixture();
        const before = JSON.stringify(getCase(orgId, item.id, userId));
        const current = '本次新增付款关联线索尚未归档，不得静默沿用旧资料。READONLY-CURRENT-TAIL';
        const result = await run({ ...args, facts: current, persistCase: false });
        expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reasoningReviewed: false });
        expect(result.content).toContain('本次输入尚未归档'); expect(result.content).toContain(current);
        expect(create).not.toHaveBeenCalled(); expect(JSON.stringify(getCase(orgId, item.id, userId))).toBe(before);
    });
    it('binds three current chat originals without recursively copying the archived corpus', async () => {
        const { item, args } = fixture();
        const { startIsolatedConversation, addMessageIdempotent } = await import('../server/conversation/manager');
        const { bindConversationActionTurnTask } = await import('../server/conversation/action_turn_ledger');
        const conversation = startIsolatedConversation(userId, 'lumi', 'personal', '');
        const originals: string[] = [];
        for (let round = 1; round <= 3; round++) {
            const requestId = 'source-input-request-' + crypto.randomUUID(), taskId = 'source-input-task-' + crypto.randomUUID();
            const current = '第' + round + '次当前用户原话：被告称七万元款项状态变化，真实性尚待核实。CHAT-CURRENT-TAIL-' + round;
            originals.push(current);
            addMessageIdempotent({ userId, agentId: 'lumi', conversationId: conversation.id, requestId, domain: 'personal', orgId: '', source: 'chat', channel: 'chat', role: 'user', content: current, deferActionPreparation: true });
            expect(bindConversationActionTurnTask({ userId, conversationId: conversation.id, requestId, taskId }).bound).toBe(true);
            const result = decodeToolResult(await registry.execute('legal_generate_argument_or_opinion', { ...args, facts: '虚构父模型改写：被告承认已经支付七万元。', persistCase: true }, { ...context, source: 'chat', conversationId: conversation.id, requestId, taskId }));
            expect(result.receipt).toMatchObject({ ok: true, reasoningReviewed: true });
            for (const [params] of create.mock.calls.slice(-2)) { const prompt = params.messages.find((message: any) => message.role === 'user').content; expect(prompt).toContain(current); expect(prompt).not.toContain('虚构父模型改写'); }
            const added = getCase(orgId, item.id, userId)!.materials.filter(material => material.source === 'manual' && material.title.includes('本次'));
            expect(added.map(material => material.content)).toEqual([...originals].reverse());
            expect(added.every(material => !material.content.includes('SOURCE-END') && !material.content.includes('[材料 '))).toBe(true);
        }
        expect(create).toHaveBeenCalledTimes(6);
    });
    it('does not treat a new affirmative sentence as archived merely because it is a substring of an older denial', async () => {
        const { item, args } = fixture();
        addMaterial(orgId, userId, item.id, { type: 'evidence', source: 'manual', title: '原始否认陈述', content: '被告陈述未支付两万元。' });
        const before = JSON.stringify(getCase(orgId, item.id, userId));
        const result = await run({ ...args, facts: '支付两万元。', persistCase: false });
        expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reasoningReviewed: false });
        expect(result.content).toContain('本次输入尚未归档'); expect(create).not.toHaveBeenCalled();
        expect(JSON.stringify(getCase(orgId, item.id, userId))).toBe(before);
    });
    it('keeps failed current-input storage partial before SDK dispatch and preserves existing material', async () => {
        const { item, args } = fixture();
        const cases = await import('../server/org/legal_cases');
        const before = getCase(orgId, item.id, userId)!;
        const sourceBasis = legalCaseSourceFingerprint(before);
        const store = vi.spyOn(cases, 'addMaterial').mockReturnValueOnce(null);
        try {
            const result = decodeToolResult(await registry.execute('legal_generate_argument_or_opinion', { ...args, facts: '本次新增付款线索待核验。STORAGE-FAIL-TAIL', persistCase: true }, context));
            expect(result.receipt).toMatchObject({ ok: false, status: 'partial', reasoningReviewed: false });
            expect(result.content).toContain('本次输入归档未完成'); expect(create).not.toHaveBeenCalled();
            const after = getCase(orgId, item.id, userId)!;
            expect(after.materials).toEqual(before.materials);
            expect(after.notes).toBe(before.notes);
            expect(after.factDate).toBe(before.factDate);
            expect(legalCaseSourceFingerprint(after)).toBe(sourceBasis);
            expect(after.workflowRuns).toHaveLength((before.workflowRuns || []).length + 1);
            expect(after.workflowRuns![0]).toMatchObject({ tool: 'legal_generate_argument_or_opinion', ok: false, status: 'partial', reasoningLinked: false, materialIds: [], displayText: result.content });
            expect(result.receipt).toMatchObject({ persisted: false, changedCaseIds: [] });
        } finally { store.mockRestore(); }
    });
    it('keeps the bid shared free-draft projection unchanged', () => { const result = resolveSourceDraftEntries(valid(), source, sections); expect(result[0].sources[0]).toBe(source[0]); expect(resolveSourceDraftEntries({ ...valid(), status: 'approved' }, source, sections)).toEqual(result); expect(Object.keys(result[0]).sort()).toEqual(['missing', 'response', 'sectionId', 'sources']); });
    it('keeps the old progress file untouched under the existing generation policy salt', () => { const scope = 'source-bound-policy-change-' + crypto.randomUUID(); const fingerprint = crypto.createHash('sha256').update('legal-document-review-v1\n' + scope).digest('hex'); const file = path.join(getDataDirectory('legal_document_progress'), fingerprint + '.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); const prior = JSON.stringify({ fingerprint, updatedAt: Date.now(), documents: { opinion: { markdown: '旧策略生成正文。'.repeat(10), reviewed: true } } }); fs.writeFileSync(file, prior); const progress = legalDocumentProgress(scope); expect(progress.get('opinion')).toBeUndefined(); expect(fs.readFileSync(file, 'utf8')).toBe(prior); });
});
