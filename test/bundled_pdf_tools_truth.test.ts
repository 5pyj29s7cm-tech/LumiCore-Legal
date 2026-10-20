import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
import { ToolRegistry } from '../server/tools/registry';
import { registerPdfTools } from '../server/tools/definitions/pdf_tools';
import { createHash } from 'node:crypto';
import { getGeneratedOutputDir } from '../server/config/data_path';

function contentText(result: any): string {
  return result.content.filter((entry: any) => entry.type === 'text').map((entry: any) => entry.text).join('\n');
}

describe('bundled PDF tools report only their real capabilities', () => {
  let directory = '';
  let client: Client | undefined;
  let firstPdf = '';
  let secondPdf = '';
  let longPdf = '';
  const head = 'PDF-FULL-BODY-HEAD-731829';
  const tail = 'PDF-FULL-BODY-TAIL-986427';
  const exportedFiles: string[] = [];

  async function writePdf(fileName: string, pages: number, fullBody = false): Promise<string> {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.setTitle('Lumi PDF protocol fixture');
    document.setAuthor('Synthetic test author');
    for (let index = 0; index < pages; index += 1) {
      const page = document.addPage([612, 792]);
      page.drawText(index === 0 ? head : 'Fixture page ' + (index + 1), { x: 30, y: 760, size: 8, font });
      if (fullBody) {
        for (let row = 0; row < 35; row += 1) {
          page.drawText('Evidence page ' + (index + 1) + ' row ' + (row + 1) + ': material source remains subject to verification.', {
            x: 30, y: 735 - row * 16, size: 8, font,
          });
        }
      }
      if (index === pages - 1) page.drawText(tail, { x: 30, y: 100, size: 8, font });
    }
    const target = path.join(directory, fileName);
    fs.writeFileSync(target, await document.save());
    return target;
  }

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-pdf-capability-protocol-'));
    firstPdf = await writePdf('first.pdf', 1);
    secondPdf = await writePdf('second.pdf', 2);
    longPdf = await writePdf('long-body.pdf', 12, true);
    client = new Client({ name: 'pdf-capability-protocol-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(process.cwd(), 'server', 'skills', 'bundled', 'pdftools', 'index.ts'),
      ],
      cwd: process.cwd(),
      stderr: 'pipe',
    }));
  }, 20000);

  afterAll(async () => {
    await client?.close();
    for (const exported of exportedFiles) {
      if (path.dirname(path.resolve(exported)) === path.resolve(getGeneratedOutputDir())) fs.rmSync(exported, { force: true });
    }
    if (directory && path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir())
      && path.basename(directory).startsWith('lumi-pdf-capability-protocol-')) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('publishes only merge and metadata actions after actual MCP initialization', async () => {
    const tools = (await client!.listTools()).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('pdf_tools');
    expect((tools[0].inputSchema as any).properties.action.enum).toEqual(['merge', 'info']);
    expect(client!.getServerVersion()?.version).toBe('1.0.1');
  });

  it('rejects the old fake extraction action instead of returning metadata as text', async () => {
    const result = await client!.callTool({ name: 'pdf_tools', arguments: { action: 'extract_text', files: [firstPdf] } });
    expect(result.isError).toBe(true);
    expect(contentText(result)).toMatch(/Invalid arguments|Input validation error/);
    expect(contentText(result)).not.toContain(head);
    expect(contentText(result)).not.toContain('Synthetic test author');
  });

  it('continues to inspect metadata without pretending it extracted the body', async () => {
    const result = await client!.callTool({ name: 'pdf_tools', arguments: { action: 'info', files: [firstPdf, secondPdf] } });
    expect(result.isError).not.toBe(true);
    const rows = JSON.parse(contentText(result));
    expect(rows.map((row: any) => row.pages)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ title: 'Lumi PDF protocol fixture', author: 'Synthetic test author' });
    expect(rows[0].sizeBytes).toBeGreaterThan(0);
    expect(contentText(result)).not.toContain(head);
    expect(contentText(result)).not.toContain(tail);
  });

  it('continues to merge real pages into the requested local PDF artifact', async () => {
    const output = path.join(directory, 'merged.pdf');
    const result = await client!.callTool({ name: 'pdf_tools', arguments: { action: 'merge', files: [firstPdf, secondPdf], output } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(contentText(result))).toMatchObject({ action: 'merge', inputFiles: 2, totalPages: 3, output });
    const merged = await PDFDocument.load(fs.readFileSync(output));
    expect(merged.getPageCount()).toBe(3);
    expect(fs.statSync(output).size).toBeGreaterThan(0);
  });

  it('keeps complete body extraction in the existing native tool beyond the preview limit', async () => {
    const registry = new ToolRegistry();
    registerPdfTools(registry);
    const result = JSON.parse(await registry.execute('pdf_to_text', { filePath: longPdf }, {
      allowLocalFileWrites: true,
      localWriteIntentReason: 'The test explicitly requests a plaintext export artifact.',
    }));
    exportedFiles.push(result.path);
    expect(result).toMatchObject({ ok: true, status: 'converted' });
    expect(path.dirname(result.path)).toBe(getGeneratedOutputDir());
    expect(result.path).not.toBe(longPdf);
    const text = fs.readFileSync(result.path, 'utf8');
    expect(text.length).toBeGreaterThan(10000);
    expect(text).toContain(head);
    expect(text).toContain(tail);
    expect(text.indexOf(tail)).toBeGreaterThan(10000);
    expect(result.characters).toBe(text.length);
  });

  it('preserves PDF originals with absent or misleading filename extensions', async () => {
    const registry = new ToolRegistry();
    registerPdfTools(registry);
    for (const name of ['pdf-without-extension', 'pdf-content.bin']) {
      const input = path.join(directory, name);
      const original = fs.readFileSync(longPdf);
      fs.writeFileSync(input, original);
      const hashBefore = createHash('sha256').update(original).digest('hex');
      const result = JSON.parse(await registry.execute('pdf_to_text', { filePath: input }, {
        allowLocalFileWrites: true,
        localWriteIntentReason: 'Export a unique plaintext artifact while retaining the supplied PDF evidence.',
      }));
      exportedFiles.push(result.path);
      expect(result.path).not.toBe(input);
      expect(path.dirname(result.path)).toBe(getGeneratedOutputDir());
      expect(createHash('sha256').update(fs.readFileSync(input)).digest('hex')).toBe(hashBefore);
      const text = fs.readFileSync(result.path, 'utf8');
      expect(text).toContain(head);
      expect(text).toContain(tail);
      expect(text.indexOf(tail)).toBeGreaterThan(10000);
    }
  });

  it('preserves an existing sibling TXT instead of replacing user material', async () => {
    const sibling = path.join(directory, 'long-body.txt');
    const priorText = 'Existing user-owned notes must remain byte-for-byte unchanged.';
    fs.writeFileSync(sibling, priorText);
    const registry = new ToolRegistry();
    registerPdfTools(registry);
    const result = JSON.parse(await registry.execute('pdf_to_text', { filePath: longPdf }, {
      allowLocalFileWrites: true,
      localWriteIntentReason: 'Export PDF text independently from existing sibling notes.',
    }));
    exportedFiles.push(result.path);
    expect(result.path).not.toBe(sibling);
    expect(fs.readFileSync(sibling, 'utf8')).toBe(priorText);
    expect(fs.readFileSync(result.path, 'utf8')).toContain(tail);
  });

  it('retains separate text artifacts for repeated conversions of the same PDF', async () => {
    const registry = new ToolRegistry();
    registerPdfTools(registry);
    const results = await Promise.all([1, 2].map(() => registry.execute('pdf_to_text', { filePath: longPdf }, {
      allowLocalFileWrites: true,
      localWriteIntentReason: 'Each explicitly requested conversion keeps its own plaintext artifact.',
    }).then(text => JSON.parse(text))));
    exportedFiles.push(...results.map(result => result.path));
    expect(results[0].path).not.toBe(results[1].path);
    for (const result of results) {
      expect(fs.readFileSync(result.path, 'utf8')).toContain(head);
      expect(fs.readFileSync(result.path, 'utf8')).toContain(tail);
    }
  });
});
