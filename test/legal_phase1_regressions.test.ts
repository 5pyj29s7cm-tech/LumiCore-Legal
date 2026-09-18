import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerLegalTools } from '../server/regions/packs/cn/legal_tools';
import { makeLLMCall } from '../server/llm/providers';
import { verifyCitation, verifyMultipleCitations } from '../server/legal/kb';
import { resetStatuteAuthorityRefreshStateForTest } from '../server/legal/statute_authority_store';
import { installCivilCodeFixture } from './fixtures/legal_authority_fixture';
import { ENCRYPTED_PDF_BASE64 } from './fixtures/encrypted_pdf';
import { createCase, getCase } from '../server/org/legal_cases';
import { listKbArticles } from '../server/org/db';
import { getDataDirectory } from '../server/config/data_path';
import { parseDocument } from '../server/legal/parser';
import { splitContractForReview } from '../server/regions/packs/cn/legal_work_product_quality';

vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: vi.fn(async () => ({ text: '片段审查已完成：条款权利义务仍需律师核对。', toolCalls: [] })),
}));
vi.mock('../server/llm/embedding_provider', async original => ({
  ...await original<typeof import('../server/llm/embedding_provider')>(),
  generateConfiguredEmbedding: vi.fn(async () => ({ vector: [1, 0], provider: 'synthetic', model: 'offline-fixture' })),
}));

let app: Awaited<ReturnType<typeof makeApp>>;
const registry = new ToolRegistry();
const context = { userId: 'quality-owner', authenticated: true, authRole: 'admin', domain: 'work', orgId: 'quality-org', localExecution: true, executionBoundary: 'trusted_local' } as any;
const run = (name: string, args: Record<string, any>, extra = {}) => executeToolCall({ registry, name, arguments: { orgId: 'quality-org', userId: 'quality-owner', persistCase: false, ...args }, context: { ...context, ...extra } });
beforeAll(async () => {
  app = await makeApp();
  app.apiRouter.use('/', (await import('../routes/files')).default);
  registerLegalTools(registry);
});
afterAll(() => app.cleanup());
afterEach(() => { vi.clearAllMocks(); resetStatuteAuthorityRefreshStateForTest(); });

describe('legal phase one regressions', () => {
  it('verifies real paragraphs and rejects fabricated paragraphs, items, inserted articles, and quotations', () => {
    installCivilCodeFixture();
    const valid = verifyCitation('《民法典》第五百八十五条第二款');
    expect(valid).toMatchObject({ provisionVerified: true, verificationStatus: 'verified', quotationVerified: null });
    expect(valid.sourceText).toContain('适当减少');
    for (const bad of ['《民法典》第五百八十五条第999款第999项', '《民法典》第585条第二款第999项', '《民法典》第585条之一']) {
      expect(verifyCitation(bad)).toMatchObject({ provisionVerified: false, verificationStatus: 'not_found' });
    }
    expect(verifyMultipleCitations('《民法典》第585条规定：“违约金必须是合同总价的百分之五十”。')[0])
      .toMatchObject({ verificationStatus: 'text_mismatch', quotationVerified: false });
    expect(verifyMultipleCitations('《民法典》第585条第三款规定：“违约方支付违约金后，还应当履行债务。”')[0])
      .toMatchObject({ verificationStatus: 'verified', quotationVerified: true });
    expect(verifyMultipleCitations('《民法典》 第585条 第999款第（999）项')[0])
      .toMatchObject({ provisionVerified: false, verificationStatus: 'not_found' });
    expect(verifyMultipleCitations('《民法典》第585条、第999999条')[1]).toMatchObject({ exists: false });
    expect(verifyCitation('《民法典》第585条', undefined, { factDate: '2019-01-01' }))
      .toMatchObject({ isEffective: null, applicabilityStatus: 'historical_review_required' });
  });

  it('does not issue a positive generation receipt for an unsupported contract', async () => {
    const result = await run('legal_draft_contract', { type: '保密协议' });
    expect(result.receipt).toMatchObject({ ok: false, status: 'blocked', artifacts: [] });
    expect(result.terminalVerification?.status).not.toBe('verified');
  });

  it('blocks a formal delivery with an invented quotation or an inapplicable current-version date', async () => {
    installCivilCodeFixture();
    for (const args of [
      { content: '依据《民法典》第585条规定：“所有违约金必须自动翻倍”。' },
      { content: '依据《民法典》第585条提出主张。', factDate: '2019-01-01' },
    ]) {
      const result = await run('legal_finalize_delivery_package', { caseName: '法条核验阻断', ...args });
      expect(result.result).toContain('正式交付包未生成');
      expect(result.receipt).toMatchObject({ ok: false, status: 'blocked' });
      expect(result.terminalVerification?.status).not.toBe('verified');
    }
  });

  it('keeps unrelated project promises out of the actual DOCX bid draft', async () => {
    const result = await run('legal_generate_bid', { projectName: '办公家具采购', requirements: '采购桌椅100套。交货期60天。', useModel: false });
    expect(result.receipt).toMatchObject({ ok: true });
    const file = (result.receipt as any).artifacts.find((p: string) => p.endsWith('.docx'));
    const output = await parseDocument(file);
    expect(output?.text).toContain('交货期60天');
    expect(output?.text).toContain('采购桌椅100套');
    expect(output?.text).not.toMatch(/30天|30 天|AI法律|多模型|私有化部署/);
  });

  it('sends every character including the tail attachment to review, and reports provider failure as partial', async () => {
    const contract = '普通合同条款。'.repeat(2000) + '\n附件末尾：永久免除乙方全部责任。';
    const parts = splitContractForReview(contract);
    const llmGetters = { getOpenAI: () => null };
    const result = await run('legal_review_contract', { contract }, { llmGetters });
    expect(result.receipt).toMatchObject({ ok: true, status: 'reviewed' });
    const prompts = vi.mocked(makeLLMCall).mock.calls.map(call => String(call[0][0].content));
    expect(prompts).toHaveLength(parts.length);
    for (const part of parts) expect(prompts.some(prompt => prompt.includes(part.text))).toBe(true);
    expect(prompts.at(-1)).toContain('永久免除乙方全部责任');
    vi.mocked(makeLLMCall).mockRejectedValueOnce(new Error('Synthetic provider timeout'));
    const partial = await run('legal_review_contract', { contract }, { llmGetters });
    expect(partial.receipt).toMatchObject({ ok: false, status: 'partial' });
    expect(partial.result).toContain('未完成，需继续审查');
    expect(partial.terminalVerification?.status).not.toBe('verified');
  });

  it('retries encrypted material in its original case without duplicate articles or leaked passwords', async () => {
    const folder = getDataDirectory('quality-input');
    const filePath = path.join(folder, 'protected.pdf');
    fs.writeFileSync(filePath, Buffer.from(ENCRYPTED_PDF_BASE64, 'base64'));
    const caseFile = createCase('quality-org', 'quality-owner', { title: '加密材料重试' });
    const before = listKbArticles('quality-org').length;
    const missing = await run('legal_import_materials_to_kb', { filePath, caseId: caseFile.id });
    expect(missing.result).toContain('PDF_PASSWORD_REQUIRED');
    expect(missing.receipt).toMatchObject({ ok: false });
    const wrong = await run('legal_import_materials_to_kb', { filePath, caseId: caseFile.id, password: 'test-wrong-secret' });
    expect(wrong.result).toContain('PDF_PASSWORD_INCORRECT');
    expect(JSON.stringify(wrong.arguments)).not.toContain('test-wrong-secret');
    expect(listKbArticles('quality-org')).toHaveLength(before);
    const args = { filePath, caseId: caseFile.id, password: 'open-sesame' };
    const correct = await run('legal_import_materials_to_kb', args);
    expect(correct.receipt).toMatchObject({ ok: true, status: 'imported' });
    const again = await run('legal_import_materials_to_kb', args);
    expect(again.receipt).toMatchObject({ ok: true, status: 'imported' });
    expect(listKbArticles('quality-org')).toHaveLength(before + 1);
    expect(getCase('quality-org', caseFile.id, 'quality-owner')?.materials).toHaveLength(1);
    expect(JSON.stringify([correct, again, listKbArticles('quality-org'), getCase('quality-org', caseFile.id, 'quality-owner')])).not.toContain('open-sesame');
  });

  it('reads the complete uploaded source with authentication and unlocks the same PDF', async () => {
    const uid = 'quality-upload-owner';
    const headers = { Cookie: `token=${jwt.sign({ uid, username: uid, role: 'user' }, JWT_SECRET)}` };
    const full = 'Full contract provision.\n'.repeat(2600) + 'TAIL-ATTACHMENT-MUST-BE-REVIEWED';
    const form = new FormData();
    form.append('files', new Blob([full]), 'long-contract.txt');
    form.append('files', new Blob([Buffer.from(ENCRYPTED_PDF_BASE64, 'base64')], { type: 'application/pdf' }), 'protected.pdf');
    const upload = await fetch(`${app.url}/api/files/upload`, { method: 'POST', headers, body: form });
    expect(upload.status).toBe(200);
    const entries = (await upload.json()).files;
    const read = async (id: string, password?: string, auth = headers) => fetch(`${app.url}/api/files/text/${encodeURIComponent(id)}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const text = await (await read(entries[0].id)).json();
    expect(text.text).toBe(full);
    expect(text.truncated).toBe(false);
    expect((await read(entries[0].id, undefined, { Cookie: '' })).status).toBe(401);
    const other = { Cookie: `token=${jwt.sign({ uid: 'other', username: 'other', role: 'user' }, JWT_SECRET)}` };
    expect((await read(entries[0].id, undefined, other)).ok).toBe(false);
    expect((await (await read(entries[1].id)).json()).code).toBe('PDF_PASSWORD_REQUIRED');
    expect((await (await read(entries[1].id, 'bad')).json()).code).toBe('PDF_PASSWORD_INCORRECT');
    expect((await (await read(entries[1].id, 'open-sesame')).json()).text).toContain('Lumi encrypted PDF test');
  });
});
