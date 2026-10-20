import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { writeDocxFromMarkdown } from '../server/regions/packs/cn/legal_tools/documents';
import { buildBidChapters, buildGroundedBidDraft } from '../server/regions/packs/cn/legal_work_product_quality';
import { buildMaterialSources } from '../server/regions/packs/cn/legal_reasoning_generation';
import fixture from './fixtures/legal_bid_six_materials_164.json';

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
  it('compiles all56 existing numbered-source states into one native57-row table', async () => {
    const sources = buildMaterialSources(fixture.materials);
    const chapters = buildBidChapters(sources);
    const response = chapters.find(chapter => chapter.id === 'response')!;
    expect(sources).toHaveLength(164);
    expect(response.sections).toHaveLength(56);
    const entries = response.sections.map(section => ({ sectionId: section.id,
      sources: [sources.find(source => source.id === section.id)!],
      response: '虚构对应响应正文，核对原件后再确认。', missing: '原始证明材料待补，不代表资格通过。' }));
    const markdown = buildGroundedBidDraft('虚构表格完整性验收', fixture.materials.map(material => material.content).join('\n'),
      sources, chapters, new Map([['response', entries]]));
    const table = markdown.slice(markdown.indexOf('| 原件编号 |'), markdown.indexOf('## 正式使用边界'));
    expect(table.split('\n').filter(line => /^\|.*\|$/.test(line))).toHaveLength(58);
    expect(table).not.toMatch(/\|\n\n\|/);
    const xml = await exportedXml(markdown);
    expect((xml.match(/<w:tbl>/g) || [])).toHaveLength(1);
    expect((xml.match(/<w:tr>/g) || [])).toHaveLength(57);
    expect((xml.match(/<w:tblHeader\b/g) || [])).toHaveLength(1);
    expect((xml.match(/已取得拟议响应；内容待核验，未核准/g) || [])).toHaveLength(56);
    for (const title of ['R01【范围】', 'R25【尾部稽核】', 'E01【价格 30 分】', 'E02【实施方案 25 分】', 'B12：']) expect(xml).toContain(title);
    expect(xml).toContain('真实平台');
  });

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
  it('uses the same native table for exact section locations and unchanged missing-material text without inferring assignees', async () => {
    const sources = buildMaterialSources([
      { id: 'original-a', title: '虚构文件甲', content: 'R13【偏差】须列商务偏差。\nF05【补料】材料及动作、责任人待核对。' },
      { id: 'original-b', title: '虚构文件乙', content: 'R13【偏差】另一原件的同编号要求，补料负责人未指派。' },
    ]);
    const chapters = buildBidChapters(sources);
    const exactMissing = '专项资质原件未提供；平台条件待确认；责任人不是虚构周样的既定任务。';
    const entries = sources.map((source, index) => ({ sectionId: source.id, sources: [source],
      response: '本项拟议正文保留，不重复搬入表格。', missing: index === 1 ? '' : exactMissing }));
    const markdown = buildGroundedBidDraft('虚构补料台账', '', sources, chapters, new Map([['response', entries]]));
    const table = markdown.slice(markdown.indexOf('| 原件编号 |'), markdown.indexOf('## 正式使用边界'));
    expect(table).toContain('待补事项及动作');
    expect(table).toContain(exactMissing);
    expect(table).toContain('模型未列其他缺项；不代表没有缺项');
    for (const position of [1, 2, 3]) expect(table).toContain('实际正文第' + position + '节');
    expect(table).toContain('待补动作：核对上述事项，补充原件或确认前提');
    expect(table).toContain('责任人待指定；时点待确认');
    expect(markdown).toContain('原文仅表示提供的资料，不代表证明已核验');
    const xml = await exportedXml(markdown);
    expect((xml.match(/<w:tbl>/g) || [])).toHaveLength(1);
    expect((xml.match(/<w:tr>/g) || [])).toHaveLength(4);
    expect((xml.match(/<w:tc>/g) || [])).toHaveLength(24);
    expect(xml).toContain(exactMissing);
    expect(xml).not.toContain('&lt;br&gt;待补动作');
    expect(xml).toContain('责任人待指定；时点待确认');
    expect((xml.match(/本项拟议正文保留，不重复搬入表格。/g) || [])).toHaveLength(3);
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
