import { packetDraftFixture } from './legal_packet_fixture';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { getDataDirectory } from '../server/config/data_path';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { decodeToolResult } from '../server/tools/result_envelope';
import { LEGAL_REASONING_BASELINE } from '../server/regions/packs/cn/legal_tools/context';
import { buildFormalLegalMarkdown } from '../server/regions/packs/cn/legal_tools/documents';
import { analyzeFolderAndDraftArgumentHandler } from '../server/regions/packs/cn/legal_tools/folder_analysis';
import { contractStructuredReply } from './legal_contract_fixture';
import { sdkCompletion } from './legal_bid_fixture';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
const quote = '原文引注：该意见采用“大前提、小前提、涵摄”的三段论结构。';
const heading = '用户明确要求的法律分析底稿：大前提、小前提、涵摄结论。';
const payment = '甲方称已支付20万元，付款真实性及是否触发期限均待核实；不能把未核实改为否认。';
const body = '# 虚构分析工作稿\n\n' + quote + '\n\n' + heading + '\n\n' + payment;
function fixture(reply: (prompt: string) => string) {
  const userId = 'fidelity-' + crypto.randomUUID();
  upsertUserPreferredLLM(userId, { provider: 'relay', model: 'synthetic-source-fidelity', selectionMode: 'pinned' });
  const create = vi.fn((params: any, options: any) => {
    const prompt = String(params.messages.find((m: any) => m.role === 'user')?.content || '');
    return sdkCompletion(params, { choices: [{ message: { content: reply(prompt) }, finish_reason: 'stop' }] }, 0, options.signal);
  });
  const context = { userId, domain: 'personal' as const, authenticated: true, authRole: 'user', localExecution: true,
    executionBoundary: 'trusted_local' as const, llmGetters: { getDeepSeek: () => null, getGemini: () => null,
      getRelay: () => ({ chat: { completions: { create } } }) } };
  const registry = new ToolRegistry(); registerLegalTools(registry);
  return { create, context, registry };
}
function expectVerbatim(output: string) { expect(output).toContain(quote); expect(output).toContain(heading); expect(output).toContain(payment); }
describe('legal work product preserves source and explicitly requested terminology', () => {
  it.each([quote, heading, payment])('leaves original body wording unchanged through the formal compiler: %s', text => expect(buildFormalLegalMarkdown({caseName:'虚构原句案'}, text)).toContain(text));
  it('keeps ordinary-output methodology guidance in the prompt without treating it as an output replacement rule', () => {
    expect(LEGAL_REASONING_BASELINE).toContain('普通文书和聊天结果不要把');
    expect(LEGAL_REASONING_BASELINE).toContain('除非用户明确要求法律分析底稿');
    expect(LEGAL_REASONING_BASELINE).toContain('未提供、未回应不代表不存在或承认/否认');
    const formal = buildFormalLegalMarkdown({caseName:'虚构引文案',documentType:'法律意见书'}, body);
    expectVerbatim(formal); expect(formal).not.toContain(LEGAL_REASONING_BASELINE);
    expect(formal).toContain('不得未经律师确认直接提交、签发或发送');
  });
  it.each(['legal_draft_contract','legal_review_contract'])('preserves structured response text through registered %s', async name => {
    const f = fixture(prompt => contractStructuredReply(prompt, body));
    const output = await f.registry.execute(name, name === 'legal_draft_contract'
      ? {type:'无偿保密', details:body, persistCase:false} : {contract:body, persistCase:false}, f.context);
    expectVerbatim(output); expect(f.create).toHaveBeenCalledTimes(1);
    expect(output).not.toContain(LEGAL_REASONING_BASELINE);
  });
  it('preserves the complete bid Markdown body without terminology rewriting', async () => {
    const f = fixture(() => body);
    const result = decodeToolResult(await f.registry.execute('legal_generate_bid', {
      projectName:'虚构引文标书-' + crypto.randomUUID(), requirements:'A01：仅要求保留提供原句，未知条件待核对。', persistCase:false,
    }, f.context));
    expect(result.receipt).toMatchObject({ok:true,status:'generated'}); expectVerbatim(result.content);
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('preserves fact-review output in the registered packet final body and saved file', async () => {
    const f = fixture(prompt => {
      if (prompt.includes('## 当前文书\n')) {
        const target = JSON.parse(prompt.split('## 当前文书\n')[1]);
        return JSON.stringify(packetDraftFixture(prompt, {baseName:target.baseName,markdown:body}));
      }
      const documents = JSON.parse(prompt.split('文书列表：')[1]);
      return JSON.stringify({documents:documents.map((doc:any)=>({baseName:doc.baseName,complete:true,corrections:[],unresolved:[]}))});
    });
    const outputDir = getDataDirectory(path.join('fidelity-output', crypto.randomUUID()));
    const result = decodeToolResult(await f.registry.execute('legal_generate_litigation_packet', {
      caseName:'虚构原文引述案',role:'原告',parties:'虚构甲/虚构乙',claims:'仅请求按原合同交付，其他请求未经确认。',facts:payment,evidence:quote,includeDocx:false,outputDir,persistCase:false,
    }, f.context));
    expect(result.receipt).toMatchObject({ok:true,status:'generated'});
    for (const baseName of ['10_civil-complaint']) {
      const calls = f.create.mock.calls.map(([request]) => String(request.messages.find((m:any)=>m.role==='user')?.content || ''));
      expect(calls.filter(prompt=>prompt.includes('## 当前文书\n') && JSON.parse(prompt.split('## 当前文书\n')[1]).baseName===baseName)).toHaveLength(1);
      expect(calls.filter(prompt=>prompt.includes('文书列表：') && JSON.parse(prompt.split('文书列表：')[1])[0].baseName.startsWith(baseName+'/'))).toHaveLength(1);
    }
    expect(f.create).toHaveBeenCalledTimes(4);
    expect(f.create.mock.calls.map(([request])=>String(request.messages.find((m:any)=>m.role==='user')?.content||'')).filter(prompt=>prompt.includes('## 当前文书\n')&&JSON.parse(prompt.split('## 当前文书\n')[1]).baseName==='11_element-complaint')).toHaveLength(0);
    expectVerbatim(fs.readFileSync(path.join(outputDir,'10_civil-complaint.md'),'utf8'));
    expectVerbatim(fs.readFileSync(path.join(outputDir,'11_element-complaint.md'),'utf8'));
    const draftPrompt = String(f.create.mock.calls[0][0].messages.find((m:any)=>m.role==='user').content);
    expect(draftPrompt).toContain(LEGAL_REASONING_BASELINE);
    expect(fs.readFileSync(path.join(outputDir,'10_civil-complaint.md'),'utf8')).not.toContain(LEGAL_REASONING_BASELINE);
  });
  it('preserves the folder-analysis model text while keeping raw originals separate', async () => {
    const f = fixture(() => body);
    const folder = getDataDirectory(path.join('fidelity-folder',crypto.randomUUID())); fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(path.join(folder,'虚构材料.txt'),payment);
    const outputDir = path.join(folder, 'outputs');
    const result = decodeToolResult(await analyzeFolderAndDraftArgumentHandler({folderPath:folder,outputDir,persistCase:false},f.context));
    const savedAnalysis = fs.readFileSync(path.join(outputDir,'01_案情分析与争议焦点.md'),'utf8');
    expect(savedAnalysis).toBe(body); expect(f.create).toHaveBeenCalledTimes(1);
    const prompt = String(f.create.mock.calls[0][0].messages.find((m:any)=>m.role==='user').content);
    expect(prompt).toContain(LEGAL_REASONING_BASELINE); expect(prompt).toContain(payment);
    expect(result.content).not.toContain(LEGAL_REASONING_BASELINE);
  });
});
