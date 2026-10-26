import { describe, expect, it } from 'vitest';
import { explicitFile, outputDocumentInstruction, sourceDocumentInstruction } from '../server/conversation/targets/instruction_targets';
import { withoutLocationLiterals } from '../server/cognition/location_literals';

describe('output destinations share literal-aware instruction spans', () => {
  it.each([
    '删除“合并成结果.docx”',
    '请读取“另存为副本.txt”',
    'Read "D:/notes/merge into result.docx".',
    '说明“把文件另存为 result.docx”的含义。',
    'Merge "D:/notes/one.docx" and "D:/notes/two.docx".',
    'Merge "D:/notes/one.docx". Write a summary into "D:/notes/result.docx".',
    'Combine "D:/notes/one.docx"; move a copy to "D:/notes/result.docx".',
    'Merge "D:/notes/one.docx" into a new document.',
    '请不要另存为“D:/notes/result.docx”。',
    'Do not merge "D:/notes/one.docx" into "D:/notes/result.docx".',
  ])('does not obtain a destination from literal data or a missing output: %s', task => {
    expect(outputDocumentInstruction(task)).toBe('');
    expect(sourceDocumentInstruction(task)).toBe(task.trim());
  });

  it.each([
    ['读取“D:/notes/source.txt”，另存为“D:/notes/result.txt”。', 'D:/notes/source.txt', 'D:/notes/result.txt'],
    ['把“D:/notes/source.docx”合并成“D:/notes/result.docx”。', 'D:/notes/source.docx', 'D:/notes/result.docx'],
    ['Read "D:/notes/source.csv" and save as "D:/notes/result.csv".', 'D:/notes/source.csv', 'D:/notes/result.csv'],
    ['Merge "D:/notes/source.docx" and "D:/notes/second.docx" into "D:/notes/result.docx".', 'D:/notes/source.docx', 'D:/notes/result.docx'],
    ['Combine "D:/notes/source.pdf" with "D:/notes/second.pdf" to "D:/notes/result.pdf".', 'D:/notes/source.pdf', 'D:/notes/result.pdf'],
    ['Merge source.docx and second.docx into result.docx.', 'source.docx', 'result.docx'],
    ['把“source.docx”合并为“result.docx”。', 'source.docx', 'result.docx'],
  ])('retains original source operands and selects only the result: %s', (task, source, destination) => {
    const output = outputDocumentInstruction(task);
    expect(output).toContain(destination);
    expect(explicitFile(output)).toBe(destination);
    expect(explicitFile(task)).toBe(source);
    expect(explicitFile(sourceDocumentInstruction(task))).toBe(source);
    expect(sourceDocumentInstruction(task)).not.toContain(destination);
  });

  it('keeps long exact operands without using a verb-to-format distance window', () => {
    const directory = 'D:/' + 'long-directory/'.repeat(17);
    const source = directory + 'source.docx';
    const destination = directory + 'result.docx';
    const task = `Merge "${source}" into "${destination}".`;
    expect(explicitFile(task)).toBe(source);
    expect(explicitFile(outputDocumentInstruction(task))).toBe(destination);
  });

  it('does not treat a save marker in a literal filename as a source/output split', () => {
    const task = '请读取“合并成结果.docx”。';
    expect(explicitFile(task)).toBe('合并成结果.docx');
    expect(outputDocumentInstruction(task)).toBe('');
  });

  it.each([['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['`', '`']])(
    'keeps the predicate between %s absolute-path operands visible', (open, close) => {
      const task = `把${open}D:/notes/source.docx${close}合并成${open}D:/notes/result.docx${close}。`;
      const syntax = withoutLocationLiterals(task, false, true);
      expect(syntax.length).toBe(task.length);
      expect(syntax.indexOf('合并成')).toBe(task.indexOf('合并成'));
      expect(syntax).not.toContain('source.docx');
      expect(syntax).not.toContain('result.docx');
      expect(outputDocumentInstruction(task)).toContain('D:/notes/result.docx');
    },
  );
});
