import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeToolResult } from '../server/tools/result_envelope';
import { getDataDirectory } from '../server/config/data_path';
let generate: typeof import('../server/regions/packs/cn/legal_tools/litigation_packet').generateLitigationPacketHandler;
let model: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  await (await import('../db_layer')).initDatabase();
  const context = await import('../server/regions/packs/cn/legal_tools/context');
  model = vi.spyOn(context, 'runLegalLLMWithin');
  generate = (await import('../server/regions/packs/cn/legal_tools/litigation_packet')).generateLitigationPacketHandler;
});
const ledgerSnapshot = () => { const file = path.join(getDataDirectory('org'), 'legal_cases.json'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; };
describe('packet UI role values select the actual packet branch without generation or persistence', () => {
  it.each([
    ['applicant', '原告', '# 民事起诉状（系统草稿）', '# 民事答辩状（系统草稿）', '# 质证意见（系统草稿）'],
    ['respondent', '被告', '# 民事答辩状（系统草稿）', '# 民事起诉状（系统草稿）', '# 要素式诉状（系统草稿）'],
    ['plaintiff', '原告', '# 民事起诉状（系统草稿）', '# 民事答辩状（系统草稿）', '# 质证意见（系统草稿）'],
    ['defendant', '被告', '# 民事答辩状（系统草稿）', '# 民事起诉状（系统草稿）', '# 要素式诉状（系统草稿）'],
  ])('%s selects only the %s work packet', async (role, label, included, excluded, excludedSecond) => {
    const before = ledgerSnapshot(); model.mockClear();
    const result = decodeToolResult(await generate({
      caseName: '虚构角色分支验收', role, caseType: '买卖合同纠纷',
      facts: '仅为离线角色路由测试；付款、交付及授权未核实。',
      evidence: '仅有虚构文字材料，不含图像或真实案件。',
      writeFiles: false, includeDocx: false, persistCase: false,
    }, { userId: 'packet-role-projection-owner', domain: 'personal' }));
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', draftMode: 'template' });
    expect(result.content).toContain(included);
    expect(result.content).not.toContain(excluded);
    expect(result.content).not.toContain(excludedSecond);
    expect(result.content).toContain('我方身份: ' + role);
    expect(model).not.toHaveBeenCalled();
    expect(ledgerSnapshot()).toBe(before);
  });
});
