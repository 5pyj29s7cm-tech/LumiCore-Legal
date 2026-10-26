import { describe, expect, it, vi } from 'vitest';
vi.mock('../db_layer', () => ({}));
import { normalizeActionIntent, hasAffirmativeArtifactMutationAction } from '../server/cognition/normalized_action_intent';
import { actionInstructionClauses, affirmativeActionInstructionClauses } from '../server/cognition/action_instruction_clauses';
import { requestsExactReadOnlyArtifactInspection } from '../server/cognition/action_desktop_evidence';

const connectors = ['and', 'and then', 'then', 'afterwards'];
describe('coordinated artifact predicates bind their own operands', () => {
  it.each(connectors)('keeps a relative source separate from the created target with %s', connector => {
    const text = 'Read source.pdf ' + connector + ' create a new report.docx.';
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'create', target: 'report.docx', sideEffectClass: 'local_write', payload: text });
    expect(hasAffirmativeArtifactMutationAction(text)).toBe(true);
    expect(requestsExactReadOnlyArtifactInspection(text)).toBe(false);
  });
  it.each(connectors)('keeps an absolute source separate from the created target with %s', connector => {
    const text = 'Read C:/input/source.pdf ' + connector + ' create C:/output/report.docx.';
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'create', target: 'C:/output/report.docx', sideEffectClass: 'local_write', payload: text });
    expect(requestsExactReadOnlyArtifactInspection(text)).toBe(false);
  });
  it.each(connectors)('binds a later edit to its file with %s', connector => {
    const text = 'Read C:/input/source.pdf ' + connector + ' revise C:/output/report.docx.';
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'mutate', target: 'C:/output/report.docx', sideEffectClass: 'local_write', payload: text });
    expect(requestsExactReadOnlyArtifactInspection(text)).toBe(false);
  });
  it('does not mistake the PNG input for a read-only whole request', () => {
    const text = 'Read image.png and create a new report.docx.';
    expect(requestsExactReadOnlyArtifactInspection(text)).toBe(false);
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'create', target: 'report.docx', payload: text });
  });
  it.each([
    'Read C:/input/source.pdf and do not create C:/output/report.docx.',
    'Read C:/input/source.pdf and then do not write C:/output/report.docx.',
    'Do not create C:/output/report.docx and overwrite C:/output/other.docx. Read C:/input/source.pdf.',
    'Never create C:/output/report.docx and then revise C:/output/other.docx. Read C:/input/source.pdf.',
  ])('preserves coordinated prohibitions: %s', text => {
    expect(hasAffirmativeArtifactMutationAction(text)).toBe(false);
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'read', target: 'C:/input/source.pdf', sideEffectClass: 'none' });
    expect(requestsExactReadOnlyArtifactInspection(text)).toBe(true);
  });
  it.each([
    'Read C:/input/source.pdf and explain "create C:/output/report.docx and overwrite C:/input/source.pdf".',
    'Read C:/input/source.pdf and explain “then create C:/output/report.docx”.',
    'The source says "Read source.pdf and create report.docx". Explain this quotation only.',
  ])('keeps quoted instruction payloads inert: %s', text => {
    expect(hasAffirmativeArtifactMutationAction(text)).toBe(false);
    expect(normalizeActionIntent(text).sideEffectClass).not.toBe('local_write');
  });
  it.each([
    'C:/Research and Development/source.pdf',
    'C:/Research then Development/source.pdf',
    'C:/Research and then Development/source.pdf',
  ])('keeps unquoted location words inside the path: %s', source => {
    const text = 'Read ' + source + ' and create C:/output/report.docx.';
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'create', target: 'C:/output/report.docx' });
    const clauses = affirmativeActionInstructionClauses(text);
    expect(clauses[0].probe).toContain(source);
    expect(clauses[1].probe).toContain('create C:/output/report.docx');
  });
  it.each([
    'C:/Research and Development/source.pdf',
    'C:/Research then Development/source.pdf',
    'C:/Research and then Development/source.pdf',
  ])('keeps quoted paths and exact original span offsets: %s', source => {
    const text = 'Read "' + source + '" and create "C:/output/report and notes.docx" with content "then delete the original".';
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'create', target: 'C:/output/report and notes.docx', payload: text });
    const clauses = actionInstructionClauses(text);
    expect(clauses.map(clause => clause.text).join('')).toBe(text);
    for (const clause of clauses) expect(text.slice(clause.start, clause.start + clause.text.length)).toBe(clause.text);
    expect(affirmativeActionInstructionClauses(text).map(clause => clause.probe).join(' ')).not.toContain('delete the original');
  });
  it.each([
    'Read "C:/input/source.pdf" and "C:/input/other.pdf".',
    'Read C:/input/source.pdf and C:/input/other.pdf.',
    'Read source.pdf and other.pdf.',
  ])('keeps coordinated file operands under their original read predicate: %s', text => {
    expect(affirmativeActionInstructionClauses(text)).toHaveLength(1);
    expect(affirmativeActionInstructionClauses(text)[0].probe).toContain('other.pdf');
    expect(requestsExactReadOnlyArtifactInspection(text)).toBe(true);
    expect(hasAffirmativeArtifactMutationAction(text)).toBe(false);
  });

  it('does not borrow a quoted path as an output operand of a pathless later creation', () => {
    const text = 'Read "C:/input/source.pdf" and create a report.';
    expect(normalizeActionIntent(text)).not.toMatchObject({ operation: 'create', target: 'C:/input/source.pdf' });
    expect(hasAffirmativeArtifactMutationAction(text)).toBe(true);
    expect(requestsExactReadOnlyArtifactInspection(text)).toBe(false);
  });
});

describe('Chinese coordination uses the same literal and source-span projection', () => {
  it.each(['并', '并且', '然后', '接着'])('binds an independent created output after %s', connector => {
    const text = '请读取“C:/input/source.pdf”' + connector + '创建“C:/output/report.docx”。';
    expect(normalizeActionIntent(text)).toMatchObject({ operation: 'create', target: 'C:/output/report.docx', sideEffectClass: 'local_write', payload: text });
    const parts = actionInstructionClauses(text);
    expect(parts.map(part => part.text).join('')).toBe(text);
    for (const part of parts) expect(text.slice(part.start, part.start + part.text.length)).toBe(part.text);
  });
  it.each([
    '请读取“C:/input/然后并创建.docx”，不要生成文件。',
    '请读取“C:/input/source.pdf”并说明“然后创建C:/output/report.docx”这段文字。',
    '不要创建“C:/output/report.docx”并覆盖“C:/input/source.pdf”。',
  ])('retains literal and negative boundaries: %s', text => {
    expect(hasAffirmativeArtifactMutationAction(text)).toBe(false);
    expect(normalizeActionIntent(text).sideEffectClass).toBe('none');
  });
});
