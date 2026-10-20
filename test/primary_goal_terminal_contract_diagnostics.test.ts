import knowledgeFixture from './fixtures/primary_goal_knowledge_terminal.json';
import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => vi.fn());
const playbackMock = vi.hoisted(() => vi.fn());
vi.mock('../server/agents/computer_use', () => ({ computerUseLoop: playbackMock }));
vi.mock('../server/llm/providers', async (original) => ({ ...await original<any>(), makeLLMCall: model, makeLLMCallStreaming: model }));
import { initDatabase, readDB } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { runLumiEntryTurn } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import { registerKnowledgeTools } from '../server/tools/definitions/knowledge_tools';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
beforeAll(() => initDatabase());
beforeEach(() => { model.mockReset(); playbackMock.mockReset(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OUTSIDE_FIXTURE_NETWORK_FORBIDDEN')); });
function fixture(iterations: number, tail = '') {
    const userId = 'outside-terminal-' + randomUUID();
    const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
    const requestId = randomUUID();
    const filePath = path.join(String(process.env.LUMI_DATA_DIR), 'source-' + requestId + '.txt');
    const original = 'ISOLATED_SOURCE_CONTENT\nSOURCE_TAIL_86751';
    fs.writeFileSync(filePath, original);
    const text = 'Read the file ' + filePath + ' and show its complete contents.' + tail;
    const registry = new ToolRegistry();
    registerFileOpsTools(registry);
    const read = registry.get('read_file')!;
    const handler = vi.fn(read.handler);
    read.handler = handler;
    const chunks: string[] = [];
    const identity = { userId, conversationId, requestId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
    const input: any = { entry: { source: 'isolated-terminal-boundary', channel: 'chat', historyLimit: 10, failureText: 'The request did not finish.', failureReason: 'isolated' }, identity, userText: text, authorization: captureRequestAuthorization(() => true, 'Revoked'), controller: new AbortController(), planning: { dispatch: { ...identity, text, source: 'isolated-terminal-boundary', channel: 'chat', operationMode: 'assistant', targetIsLumi: true }, registry, personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: iterations }, executionBoundary: 'trusted_local' }, assemble: () => ({ systemPrompt: 'Use the actual source.', model: { registry, config: { provider: 'deepseek', model: 'isolated-no-network', userId, requestId }, getters: {}, maxIterations: iterations, onStreamChunk: (chunk: string) => chunks.push(chunk), context: { authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local', actionIntent: text, routedTaskText: text } } }), deliver: r => r };
    return { input, identity, filePath, original, handler, chunks, readGoal: 'Read the file ' + filePath + ' and show its complete contents.' };
}
const exactPrepared = { text: knowledgeFixture.userText, files: knowledgeFixture.fileIds.map(fileId => ({ fileId })) };
const actualReceipt = knowledgeFixture.sourceTextReceipt;
const visibleAnswer = knowledgeFixture.visibleAnswer;
describe('same-primary terminal contract diagnostics with synthetic knowledge receipt', () => {
    it.each(['valid', 'paraphrased-goal', 'no-goals', 'foreign-record', 'bad-effects', 'bad-operation', 'bad-status', 'missing-evidence-ids', 'private-reference', 'response-incomplete'] as const)('checks current prompt schema and canonical evidence: %s', async (mode) => {
        const f = fixture(2);
        const text = exactPrepared.text;
        f.input.userText = text;
        f.input.planning.dispatch.text = text;
        registerKnowledgeTools(f.input.planning.registry);
        const entry = f.input.planning.registry.get('knowledge_file_stats')!;
        const handler = vi.fn(async () => JSON.stringify({ ...actualReceipt, userId: f.identity.userId }));
        entry.handler = handler;
        const base = f.input.assemble;
        f.input.assemble = () => { const x = base(); x.model.context.actionIntent = text; x.model.context.routedTaskText = text; return x; };
        const lines = text.split('\n').filter(Boolean);
        let finalPrompt: any;
        model.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'offline-stats-current', name: 'knowledge_file_stats', arguments: { fileIds: exactPrepared.files.map((x: any) => x.fileId) } }] }).mockImplementationOnce(async (messages: any[]) => { const auth = messages.find((m: any) => m.promptBlock?.id === 'current-execution-authorization'); expect(auth).toBeTruthy(); const example = JSON.parse(auth.content.match(/return JSON (\{.+?\}\]\})\./)![1]); expect(auth.promptBlock.fields.completionEvidence).toEqual([expect.objectContaining({ id: 'offline-stats-current', operation: 'observe', effects: [], status: 'verified_success' })]); finalPrompt = { currentRequest: text, authorization: auth.promptBlock.fields, authorizationContent: auth.content, example }; const goals = lines.map((line: string, i: number) => ({ text: line, operation: i === 0 ? 'observe' : 'respond', effects: [], status: 'completed', evidenceIds: ['offline-stats-current'] })); if (mode === 'paraphrased-goal')
            goals[1].text = '概括并回答全部十题'; if (mode === 'foreign-record')
            goals[1].evidenceIds = ['foreign-call']; if (mode === 'bad-effects')
            goals[1].effects = ['NOT_A_SIDE_EFFECT']; if (mode === 'bad-operation')
            goals[1].operation = 'observe|respond'; if (mode === 'bad-status')
            goals[1].status = 'verified_success'; if (mode === 'missing-evidence-ids')
            delete (goals[1] as any).evidenceIds; return { text: JSON.stringify({ answer: visibleAnswer + (mode === 'private-reference' ? ' offline-stats-current' : ''), ...(mode === 'no-goals' ? {} : { goals }) }), finishReason: mode === 'response-incomplete' ? 'length' : 'stop', toolCalls: [] }; });
        const r: any = await runLumiEntryTurn(f.input);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(model).toHaveBeenCalledTimes(2);
        expect(r.toolRecords.filter((x: any) => x.name === 'knowledge_file_stats' && x.envelope?.status === 'verified_success')).toHaveLength(1);
        expect(r.finalized.blocked).toBe(mode !== 'valid');
        if (mode !== 'private-reference')
            expect(r.finalized.text).toContain('Q10');
        const reasons: any = { 'paraphrased-goal': 'reply_goal_text_invalid', 'no-goals': 'reply_goals_missing', 'foreign-record': 'reply_goals_incomplete', 'bad-effects': 'reply_goal_effects_invalid', 'bad-operation': 'reply_goal_operation_invalid', 'bad-status': 'reply_goal_status_invalid', 'missing-evidence-ids': 'reply_goal_evidence_ids_invalid', 'private-reference': 'reply_private_reference', 'response-incomplete': 'reply_response_incomplete' };
        if (mode !== 'valid') {
            expect(r.modelResult.completionGuard.reason).toBe(reasons[mode]);
            expect(r.finalized.reason).toBe(reasons[mode]);
            expect(r.finalized.text).not.toContain(reasons[mode]);
            expect(r.finalized.text).not.toContain('offline-stats-current');
        }
        if (mode === 'valid') {
            expect(r.finalized.text).toBe(visibleAnswer);
            expect(readDB().conversationActionTasks.find((x: any) => x.id === r.taskId)?.status).toBe('completed');
        }
        else {
            expect(readDB().conversationActionTasks.find((x: any) => x.id === r.taskId)?.status).toBe('blocked');
        }
        expect(['respond', 'observe', 'test', 'create', 'mutate', 'communicate', 'unknown']).toContain(finalPrompt.example.goals[0].operation);
        expect(['completed', 'incomplete']).toContain(finalPrompt.example.goals[0].status);
    });
});
