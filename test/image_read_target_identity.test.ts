import './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionRecord } from '../server/tools/types';
import { documentReadMatchesRequestedTarget, hasVerifiedExactReadOnlyArtifactEvidence, isSuccessfulExactDocumentRead, requestsExactReadOnlyArtifactInspection } from '../server/cognition/action_desktop_evidence';

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OFFLINE_TARGET_IDENTITY_ONLY')); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

function imageRead(file: string): ToolExecutionRecord {
  return {
    name: 'ocr_image_file', arguments: { imagePath: file },
    result: JSON.stringify({ path: file, analysis: 'Synthetic original image text.\n\nNo additional fact is established.' }),
    terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Synthetic image source read completed.' },
  } as ToolExecutionRecord;
}
function documentRead(file: string, tool = 'read_file'): ToolExecutionRecord {
  return {
    name: tool, arguments: { filePath: file }, result: 'Synthetic original document text.\n\nThe source remains unchanged.',
    terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Synthetic document source read completed.' },
  } as ToolExecutionRecord;
}

describe('exact image read source identity uses the supported OCR formats', () => {
  it.each(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'PNG', 'JPEG'])('retains an absolute %s source path without a writable-document resolver', extension => {
    const file = 'C:/synthetic-image-sources/a/receipt.' + extension;
    const other = 'C:/synthetic-image-sources/b/receipt.' + extension;
    const task = '读取 ' + file + '，只读，不生成文件。';
    const record = imageRead(file);
    const original = JSON.stringify(record);
    expect(isSuccessfulExactDocumentRead(record)).toBe(true);
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(record, task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(imageRead(other), task)).toBe(false);
    expect(hasVerifiedExactReadOnlyArtifactEvidence([record], task)).toBe(true);
    expect(JSON.stringify(record)).toBe(original);
  });

  it.each([
    ['D:\\Evidence Folder\\入库凭据.BMP', 'Read "D:\\Evidence Folder\\入库凭据.BMP"; do not modify files.'],
    ['\\\\host\\share\\Evidence Folder\\image.tiff', 'Read "\\\\host\\share\\Evidence Folder\\image.tiff"; do not save anything.'],
    ['/tmp/synthetic case/原始影像.jpeg', '请读取“/tmp/synthetic case/原始影像.jpeg”，不修改原件。'],
  ])('preserves the supplied full path identity: %s', (file, task) => {
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(imageRead(file), task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(imageRead(file.replace(/[^/\\]+$/, 'other.png')), task)).toBe(false);
  });

  it.each(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'])('correlates a directed relative %s source and its confirmed parent path', extension => {
    const file = 'D:/synthetic-relative-images/scan.' + extension;
    const task = 'Read "scan.' + extension + '"; do not create or modify any file.';
    const record = imageRead(file);
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(record, task)).toBe(true);
    const accepted = { target: { status: 'confirmed', path: file } } as any;
    expect(documentReadMatchesRequestedTarget(record, task, accepted)).toBe(true);
    expect(documentReadMatchesRequestedTarget(imageRead('D:/other-images/scan.' + extension), task, accepted)).toBe(false);
    expect(documentReadMatchesRequestedTarget(record, task, { target: { status: 'rejected', path: file } } as any)).toBe(false);
  });

  it('keeps an image and document operand list separate from prohibited sources and quoted document prose', () => {
    const image = imageRead('C:/source-list/receipt.webp');
    const document = documentRead('C:/source-list/notes.pdf', 'read_pdf');
    const forbidden = imageRead('C:/source-list/private.webp');
    const task = 'Read "C:/source-list/receipt.webp" and "C:/source-list/notes.pdf"; do not read "C:/source-list/private.webp". The source says "Read C:/source-list/unrelated.png".';
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(image, task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(document, task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(forbidden, task)).toBe(false);
    expect(documentReadMatchesRequestedTarget(imageRead('C:/source-list/unrelated.png'), task)).toBe(false);
    expect(hasVerifiedExactReadOnlyArtifactEvidence([image, document], task)).toBe(true);
    expect(hasVerifiedExactReadOnlyArtifactEvidence([image], task)).toBe(false);
  });

  it('retains explicit and current-attachment precedence without treating a same basename in another directory as the source', () => {
    const file = 'C:/uploads/scanned-evidence.gif';
    const other = 'C:/other/scanned-evidence.gif';
    const record = imageRead(file);
    expect(documentReadMatchesRequestedTarget(record, '读取这张图', undefined, [file])).toBe(true);
    expect(documentReadMatchesRequestedTarget(record, '读取这张图', undefined, [other])).toBe(false);
    expect(documentReadMatchesRequestedTarget(record, 'Read "' + other + '" attachment', undefined, [file])).toBe(false);
    expect(documentReadMatchesRequestedTarget(record, 'Read "C:/uploads/SCANNED-EVIDENCE.GIF"')).toBe(true);
  });

  it('does not promote unsuccessful OCR, a non-image input or a document reader carrying image arguments', () => {
    const record = imageRead('C:/fixture/image.png');
    expect(documentReadMatchesRequestedTarget({ ...record, error: 'Perception unavailable' }, 'Read image.png')).toBe(false);
    expect(isSuccessfulExactDocumentRead({ ...record, result: JSON.stringify({ path: 'C:/fixture/image.png', analysis: '' }) })).toBe(false);
    expect(isSuccessfulExactDocumentRead({ ...record, terminalVerification: { status: 'failed', strategy: 'terminal_receipt', reason: 'Synthetic image read failed.' } })).toBe(false);
    expect(isSuccessfulExactDocumentRead({ ...record, arguments: { imagePath: 'C:/fixture/notes.docx' } })).toBe(false);
    expect(isSuccessfulExactDocumentRead({ ...record, name: 'read_pdf' })).toBe(false);
  });
});

describe('existing document readers keep their format and exact-path contracts', () => {
  it.each([
    ['report.docx', 'read_docx'], ['report.pdf', 'read_pdf'], ['report.xlsx', 'read_xlsx'],
    ['report.txt', 'read_file'], ['report.rtf', 'read_file'], ['report.md', 'read_file'],
  ])('still matches a real document and rejects a sibling with the same name: %s', (name, tool) => {
    const file = 'C:/synthetic-documents/' + name;
    const task = '请读取“' + file + '”，只读，不生成文件。';
    const record = documentRead(file, tool);
    expect(isSuccessfulExactDocumentRead(record)).toBe(true);
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(record, task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(documentRead('D:/other-documents/' + name, tool), task)).toBe(false);
    expect(documentReadMatchesRequestedTarget(record, 'Read "' + name + '"')).toBe(true);
  });

  it.each([
    '请列出两种图片格式，不读取文件，也不生成文件。',
    'The source says "Read image.webp". Explain that sentence only.',
  ])('does not reinterpret analysis, quotations or output creation as a read-only request: %s', task => {
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);
  });
});
