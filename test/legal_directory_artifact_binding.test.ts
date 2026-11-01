import { expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { buildActionContract } from '../server/cognition/action_contract';
import { withoutLocationLiterals } from '../server/cognition/location_literals';

it.each([
  ['在 C:\\Users\\test-user\\Documents 创建 Lumi现场验收_晨星716.txt，写三行，重读核验，不外发，不开其他软件', 'C:\\Users\\test-user\\Documents\\Lumi现场验收_晨星716.txt'],
  ['请在 D:\\work\\files 新建 report.md。', 'D:\\work\\files\\report.md'],
  ['在 /tmp/lumi-test 创建 report.txt。', '/tmp/lumi-test/report.txt'],
  ['in /tmp/lumi-test create report.txt', '/tmp/lumi-test/report.txt'],
])('binds the exact directory and newly named artifact: %s', (text, target) => {
  expect(normalizeActionIntent(text)).toMatchObject({ kind: 'desktop_operation', operation: 'create', target, sideEffectClass: 'local_write' });
  expect(buildActionContract(text)).toMatchObject({ applies: true, kind: 'artifact_work' });
});

it.each([
  '不要在 D:\\work 创建 report.txt。',
  '解释“在 D:\\work 创建 report.txt”这句话。',
  '如果在 D:\\work 创建 report.txt会怎样？',
  '是否在 D:\\work 创建 report.txt？',
  '读取 D:\\work\\report.txt，不要创建任何文件。',
])('does not turn a location in non-creation instructions into a write: %s', text => {
  expect(normalizeActionIntent(text).operation).not.toBe('create');
});

it('keeps the Legal caller offset-preservation contract while masking both operands', () => {
  const text = '在 D:\\work 创建 report.txt，写入三行。';
  const masked = withoutLocationLiterals(text, false, true);
  expect(masked.length).toBe(text.length);
  expect(masked.indexOf('创建')).toBe(text.indexOf('创建'));
  expect(masked.indexOf('写入')).toBe(text.indexOf('写入'));
  expect(masked).not.toContain('D:\\work');
  expect(masked).not.toContain('report.txt');
});
