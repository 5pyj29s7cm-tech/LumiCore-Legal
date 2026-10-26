import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { writeDocxFromMarkdown } from '../server/regions/packs/cn/legal_tools/documents';
import fixture from './fixtures/legal_bid_six_materials_164.json';

async function exportedXml(markdown: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-cell-render-'));
  try {
    const file = path.join(dir, 'response.docx');
    await writeDocxFromMarkdown(markdown, file);
    return await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml')!.async('string');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function cellText(xml: string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>/g)].map(match => match[1] === undefined ? '\n'
    : match[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => entity === 'amp' ? '&' : entity === 'lt' ? '<' : entity === 'gt' ? '>' : entity === 'quot' ? '"' : "'")).join('');
}

const markdownCell = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

describe('source-preserving legal Markdown cell rendering', () => {

  it('keeps literal source HTML, escaped entities, pipes and backslashes distinct from native cell line breaks', async () => {
    const materials = [
      { title: String.raw`虚构原件\\A|B<br>&lt;br&gt;.txt`, content: String.raw`R01【保真】原文含字面<br>、&lt;br&gt;、A|B及C:\\work\\case，不得改写。` },
      { title: '第二原件TAIL', content: '第二段原文未提供，不表示不存在。' },
    ];
    const xml = await exportedXml([
      '| 来源/位置 | 原文 |', '| --- | --- |',
      '| ' + materials.map(material => markdownCell(material.title)).join('<br>') + ' | ' + markdownCell(materials[0].content) + ' |',
    ].join('\n'));
    const rows = [...xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(match => match[0]);
    expect(rows).toHaveLength(2);
    const cells = [...rows[1].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
    expect(cells).toHaveLength(2);
    expect(cellText(cells[0])).toBe(materials.map(material => material.title).join('\n'));
    expect((cells[0].match(/<w:br\b/g) || [])).toHaveLength(1);
    expect(cellText(cells[1])).toBe(materials[0].content);
    expect(cells[1]).not.toContain('<w:br');
    expect(cells[1]).toContain('&lt;br&gt;');
    expect(cells[1]).toContain('&amp;lt;br&amp;gt;');
    expect(xml).not.toContain('<script');
  });

  it('retains long source lists as native cell line breaks and allows natural row pagination', async () => {
    const materials = Array.from({ length: 24 }, (_, index) => ({ title: '来源' + index + '虚构完整标题'.repeat(8) + (index === 23 ? 'LASTSOURCE24' : ''),
      content: index ? '普通原始说明，未提供其他事实。' : 'R01【长来源】必须保留完整原件定位。' }));
    const xml = await exportedXml([
      '| 来源/位置 | 原文 |', '| --- | --- |',
      '| ' + materials.map(material => markdownCell(material.title)).join('<br>') + ' | ' + markdownCell(materials[0].content) + ' |',
    ].join('\n'));
    const rows = [...xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(match => match[0]);
    expect(rows).toHaveLength(2);
    const cells = [...rows[1].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
    expect(cellText(cells[0])).toBe(materials.map(material => material.title).join('\n'));
    expect((cells[0].match(/<w:br\b/g) || [])).toHaveLength(23);
    expect(cells[0]).toContain('LASTSOURCE24');
    expect(rows[1]).not.toMatch(/<w:(?:cantSplit|trHeight|keepNext|keepLines)\b/);
    expect((xml.match(/<w:tblHeader\b/g) || [])).toHaveLength(1);
  });

  it('preserves ordinary quotation amounts and descriptions in a Markdown document', async () => {
    const quote = fixture.materials.find(material => material.title.includes('报价表.csv'))!;
    const lines = quote.content.split('\n').filter(line => line.startsWith('P04,') || line.startsWith('P-TOTAL,'));
    const xml = await exportedXml('# 模拟报价工作稿\n\n' + lines.join('\n\n') + '\n\n数量、名单和签章仍待责任人确认。');
    const text = cellText(xml);
    for (const line of lines) expect(text).toContain(line);
    for (const amount of ['254400.00', '240000.00', '14400.00', '3000.00', '6000.00']) expect(text).toContain(amount);
    expect(text).toContain('数量、名单和签章仍待责任人确认。');
  });

});
