import './helpers';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolExecutionRecord } from '../server/tools/types';
import { documentReadMatchesRequestedTarget, requestsExactReadOnlyArtifactInspection } from '../server/cognition/action_desktop_evidence';
import { resolveExplicitUserArtifactPath } from '../server/cognition/artifact_write_scope';

describe('image source folders retain the existing user-folder identity without widening writable formats', () => {
  it.each([
    ['Desktop', '桌面', 'Downloads', 'source.png'],
    ['Downloads', '下载文件夹', 'Desktop', 'source.webp'],
    ['Documents', '文档文件夹', 'Desktop', 'source.tiff'],
  ])('binds the explicit %s source and rejects the same filename in another folder', (folder, label, otherFolder, filename) => {
    const file = path.join(os.homedir(), folder, filename);
    const other = path.join(os.homedir(), otherFolder, filename);
    const task = '请读取' + label + '的“' + filename + '”，只读，不生成文件。';
    const record = (imagePath: string) => ({
      name: 'ocr_image_file', arguments: { imagePath },
      result: JSON.stringify({ path: imagePath, analysis: 'Synthetic image source original text.' }),
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Synthetic source-folder image read completed.' },
    } as ToolExecutionRecord);
    expect(requestsExactReadOnlyArtifactInspection(task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(record(file), task)).toBe(true);
    expect(documentReadMatchesRequestedTarget(record(other), task)).toBe(false);
    expect(resolveExplicitUserArtifactPath('"' + filename + '"', label)).toBe('');
    const document = path.join(os.homedir(), folder, 'source.docx');
    expect(resolveExplicitUserArtifactPath('"source.docx"', label)).toBe(document);
    const documentRecord = { name: 'read_docx', arguments: { filePath: document }, result: 'Synthetic document original text.' } as ToolExecutionRecord;
    expect(documentReadMatchesRequestedTarget(documentRecord, '请读取' + label + '的“source.docx”，不修改文件。')).toBe(true);
    expect(documentReadMatchesRequestedTarget({ ...documentRecord, arguments: { filePath: path.join(os.homedir(), otherFolder, 'source.docx') } }, '请读取' + label + '的“source.docx”，不修改文件。')).toBe(false);
  });
});
