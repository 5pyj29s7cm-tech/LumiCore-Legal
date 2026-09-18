import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeDiagnosticValue } from '../server/client/diagnostic_sanitizer';
import { parseDocument } from '../server/legal/parser';
import { extractPdfTextContent } from '../server/utils/pdf_text';
import { ToolRegistry } from '../server/tools/registry';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { registerPdfTools } from '../server/tools/definitions/pdf_tools';

import { ENCRYPTED_PDF_BASE64 } from './fixtures/encrypted_pdf';

describe('password-protected PDF support', () => {
  let tempDir = '';
  let pdfPath = '';

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-password-pdf-'));
    pdfPath = path.join(tempDir, 'protected.pdf');
    fs.writeFileSync(pdfPath, Buffer.from(ENCRYPTED_PDF_BASE64, 'base64'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('distinguishes a missing password from an incorrect password without exposing either value', async () => {
    await expect(extractPdfTextContent(pdfPath)).rejects.toMatchObject({
      code: 'PDF_PASSWORD_REQUIRED',
    });

    try {
      await extractPdfTextContent(pdfPath, 'wrong-password-value');
      throw new Error('Expected incorrect password error');
    } catch (error: any) {
      expect(error.code).toBe('PDF_PASSWORD_INCORRECT');
      expect(error.message).not.toContain('wrong-password-value');
    }
  });

  it('reads encrypted content through the native PDF and generic document tools', async () => {
    const registry = new ToolRegistry();
    registerPdfTools(registry);
    registerDocumentTools(registry);

    const pdfResult = await registry.execute('read_pdf', { filePath: pdfPath, password: 'open-sesame' });
    const documentResult = await registry.execute('extract_document_text', { filePath: pdfPath, password: 'open-sesame' });
    const textExportResult = await registry.execute('pdf_to_text', {
      filePath: pdfPath,
      password: 'open-sesame',
    }, {
      allowLocalFileWrites: true,
      localWriteIntentReason: 'The test explicitly requests a plaintext export artifact.',
    });
    const diffResult = await registry.execute('diff_documents', {
      filePath1: pdfPath,
      filePath2: pdfPath,
      password1: 'open-sesame',
      password2: 'open-sesame',
      outputFormat: 'summary',
    });
    const parsed = await parseDocument(pdfPath, { password: 'open-sesame' });

    expect(pdfResult).toContain('Pages: 1');
    expect(pdfResult).toContain('Lumi encrypted PDF test');
    expect(documentResult).toContain('Lumi encrypted PDF test');
    expect(textExportResult).toContain('protected.txt');
    expect(fs.readFileSync(path.join(tempDir, 'protected.txt'), 'utf8')).toContain('Lumi encrypted PDF test');
    expect(diffResult).toContain('Change ratio: ~0%');
    expect(parsed?.text).toContain('Lumi encrypted PDF test');
  });

  it('declares password as optional and redacts it from tool records', () => {
    const registry = new ToolRegistry();
    registerPdfTools(registry);
    registerDocumentTools(registry);
    const declarations = registry.getToolDeclarations();

    for (const toolName of ['read_pdf', 'pdf_to_text', 'extract_document_text', 'ingest_document_to_rag']) {
      const declaration = declarations.find(item => item.function.name === toolName);
      expect(declaration?.function.parameters.properties.password.type).toBe('string');
      expect(declaration?.function.parameters.required || []).not.toContain('password');
    }
    const diffDeclaration = declarations.find(item => item.function.name === 'diff_documents');
    expect(diffDeclaration?.function.parameters.properties.password1.type).toBe('string');
    expect(diffDeclaration?.function.parameters.properties.password2.type).toBe('string');

    expect(sanitizeDiagnosticValue({ filePath: pdfPath, password: 'open-sesame' })).toEqual({
      filePath: pdfPath,
      password: '[redacted]',
    });

    const executionEngineSource = fs.readFileSync(path.join(process.cwd(), 'server/tools/execution_engine.ts'), 'utf8');
    expect(executionEngineSource).toContain('SECRET_ARGUMENT_RE');
    expect(executionEngineSource).toContain('arguments: receiptArguments');
    expect(executionEngineSource).toContain('onToolStart?.({');
  });
});
