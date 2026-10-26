import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { writeDocxFromMarkdown } from '../server/regions/packs/cn/legal_tools/documents';

async function exportedParts(markdown: string, pageHeader = '') { 
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-table-export-'));
  try {
    const file = path.join(dir, 'response.docx');
    await writeDocxFromMarkdown(markdown, file, pageHeader);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    return { document: await zip.file('word/document.xml')!.async('string'),
      headers: await Promise.all(zip.file(/^word\/header\d+\.xml$/).map(file => file.async('string'))),
      footers: await Promise.all(zip.file(/^word\/footer\d+\.xml$/).map(file => file.async('string'))),
      relationships: await zip.file('word/_rels/document.xml.rels')!.async('string') }; 
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function exportedXml(markdown: string): Promise<string> { return (await exportedParts(markdown)).document; }

describe('actual legal work-table preservation in DOCX', () => {
  it('does not silently erase isolated table-shaped rows separated by blank paragraphs', async () => {
    const markdown = ['# 虚构旧格式', '| 编号 | 材料 |', '| --- | --- |', '| R01 | 首条原文 |', '| R25 | 末条原文TAIL |', '普通段落仍保留。'].join('\n\n');
    const xml = await exportedXml(markdown);
    expect(xml).toContain('编号'); expect(xml).toContain('R01'); expect(xml).toContain('首条原文');
    expect(xml).toContain('R25'); expect(xml).toContain('末条原文TAIL');
    expect(xml).toContain('普通段落仍保留。');
    expect((xml.match(/<w:tbl>/g) || [])).toHaveLength(0);
  });

  it('retains existing compact tables and keeps two separate tables and surrounding body distinct', async () => {
    const xml = await exportedXml('表前原文。\n\n| 编号 | 材料 |\n| --- | --- |\n| 1 | 第一表 |\n\n## 两表之间\n\n| 编号 | 材料 |\n| --- | --- |\n| 2 | 第二表 |\n\n表后尾段TAIL。');
    expect((xml.match(/<w:tbl>/g) || [])).toHaveLength(2);
    expect((xml.match(/<w:tr>/g) || [])).toHaveLength(4);
    expect((xml.match(/<w:tblHeader\b/g) || [])).toHaveLength(2);
    for (const text of ['表前原文。', '第一表', '两表之间', '第二表', '表后尾段TAIL。']) expect(xml).toContain(text);
  });
  it('writes a real default header and dynamic page field without replacing body text or marking data rows as headers', async () => {
    const parts = await exportedParts('# 虚构响应底稿\n\n正文及尾段TAIL不能被页眉替代。\n\n| 编号 | 原文 |\n| --- | --- |\n| R01 | 虚构首项 |\n| R56 | 虚构尾项 |', '虚构清泉项目  BID-TEST-2026-001');
    expect(parts.headers).toHaveLength(1); expect(parts.footers).toHaveLength(1);
    expect(parts.headers[0]).toContain('虚构清泉项目  BID-TEST-2026-001');
    expect(parts.document).toMatch(/<w:headerReference\b[^>]*w:type="default"/);
    expect(parts.document).toMatch(/<w:footerReference\b[^>]*w:type="default"/);
    expect(parts.relationships).toContain('/header'); expect(parts.relationships).toContain('/footer');
    expect(parts.footers[0]).toMatch(/<w:instrText\b[^>]*>\s*PAGE\s*<\/w:instrText>/);
    expect(parts.footers[0]).toContain('w:fldCharType="begin"'); expect(parts.footers[0]).toContain('w:fldCharType="end"');
    expect(parts.document).toContain('正文及尾段TAIL不能被页眉替代。');
    expect((parts.document.match(/<w:tblHeader\b/g) || [])).toHaveLength(1);
    expect((parts.document.match(/<w:tr>/g) || [])).toHaveLength(3);
    expect(parts.document.split('</w:tr>').slice(1).join('</w:tr>')).not.toContain('<w:tblHeader');
  });

  it('renders six heading levels and quotes without literal Markdown or blank paragraphs breaking heading continuity', async () => {
    const markdown = ['# 一级', '', '## 二级', '', '### 三级', '', '#### 四级', '', '##### 五级', '', '###### 六级', '', '> 原始引文保持内容。', '', '普通正文尾段。'].join('\n');
    const xml = await exportedXml(markdown);
    const paragraphs = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(match => match[0]);
    expect(paragraphs).toHaveLength(8);
    for (const [index, label] of ['一级', '二级', '三级', '四级', '五级', '六级'].entries()) {
      expect(paragraphs[index]).toContain(label);
      expect(paragraphs[index]).toContain('<w:keepNext/>');
      expect(paragraphs[index]).toContain('<w:color w:val="000000"/>');
      expect(paragraphs[index]).toContain(index === 0 ? 'w:val="Title"' : 'w:val="Heading' + index + '"');
    }
    expect(paragraphs[6]).toContain('原始引文保持内容。');
    expect(paragraphs[6]).toContain('<w:ind w:left="360"/>');
    expect(paragraphs[7]).toContain('普通正文尾段。');
    expect(xml).not.toContain('####'); expect(xml).not.toContain('&gt; 原始引文');
  });

  it('keeps each source locator with its following quote without locking ordinary bullets together', async () => {
    const xml = await exportedXml(['- 普通清单第一项', '', '- 普通清单第二项', '', '- F59 原件编号与实际正文位置', '', '> R21 原始引文须与来源相邻。', '', '- 另一个普通事项', '', '正文尾段TAIL。'].join('\n'));
    const paragraphs = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(match => match[0]);
    expect(paragraphs).toHaveLength(6);
    expect(paragraphs[2]).toContain('F59 原件编号与实际正文位置');
    expect(paragraphs[2]).toContain('<w:keepNext/>');
    for (const index of [0, 1, 3, 4, 5]) expect(paragraphs[index]).not.toContain('<w:keepNext/>');
    expect(paragraphs[3]).toContain('R21 原始引文须与来源相邻。');
    expect(paragraphs[3]).toContain('<w:ind w:left="360"/>');
    expect(paragraphs[5]).toContain('正文尾段TAIL。');
  });

});
