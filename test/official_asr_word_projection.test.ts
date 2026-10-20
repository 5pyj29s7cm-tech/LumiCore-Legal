import { describe, expect, it } from 'vitest';
import actualSentence from './fixtures/official-asr-word-timestamps/actual-final-sentence.json';
import { parseOfficialSttMessage } from '../server/stt/providers/official';
const model = 'aliyun/qwen-audio-3.0-asr-flash-streaming';
const frame = (sentence: Record<string, unknown>, taskId = 'synthetic-word-task') => ({
 header: { event: 'result-generated', task_id: taskId }, payload: { output: { sentence } },
});
const words = [ { begin_time: 360, end_time: 600, text: '请坐', punctuation: '，' },
 { begin_time: 650, end_time: 2100, text: '今天想聊什么', punctuation: '？' } ];
const sentence = { text: '请坐，今天想聊什么？', sentence_end: true, begin_time: 360, end_time: 2100 };
describe('existing official ASR word timing projection', () => {
 it('preserves all48 real captured word intervals with the original sentence/final state unchanged', () => {
  const result = parseOfficialSttMessage(frame(actualSentence), model).result!;
  expect(result.text).toBe(actualSentence.text); expect(result.isFinal).toBe(true); expect(result.speechFinal).toBe(true);
  expect(result.speechStarted).toBe(false);
  expect(result.segments).toEqual(actualSentence.words.map(word => ({ text: word.text + word.punctuation, beginMs:word.begin_time, endMs:word.end_time })));
  expect(result.segments).toHaveLength(48);
 });
 it('retains documented word times and punctuation instead of only the sentence interval', () => {
  expect(parseOfficialSttMessage(frame({ ...sentence, words }), model, 'synthetic-word-task').result).toMatchObject({
   text: sentence.text, isFinal: true, taskId: 'synthetic-word-task',
   segments: [{ text: '请坐，', beginMs: 360, endMs: 600 }, { text: '今天想聊什么？', beginMs: 650, endMs: 2100 }],
  });
 });
 it.each([{ words: undefined }, { words: [] }])('keeps existing sentence fallback for absent/empty words', ({ words }) => {
  expect(parseOfficialSttMessage(frame({ ...sentence, words }), model).result?.segments)
   .toEqual([{ text: sentence.text, beginMs: 360, endMs: 2100 }]);
 });
 it.each([null, Number.NaN, -1, '600'])('never invents a word endpoint from malformed timing %s', end => {
  expect(parseOfficialSttMessage(frame({ ...sentence, words: [words[0], { ...words[1], end_time: end }] }), model).result?.segments)
   .toEqual([{ text: sentence.text, beginMs: 360, endMs: 2100 }]);
 });
 it('keeps words in provider order without deriving expected lyric lines', () => {
  const result = parseOfficialSttMessage(frame({ ...sentence, words: [words[1], words[0]] }), model).result!;
  expect(result.text).toBe(sentence.text);
  expect(result.segments?.map(segment => segment.text)).toEqual(['今天想聊什么？', '请坐，']);
 });
 it('preserves task correlation and does not interpret words from a different task', () => {
  const result = parseOfficialSttMessage(frame({ ...sentence, words }, 'other-task'), model, 'synthetic-word-task');
  expect(result.error?.message).toContain('different task'); expect(result.result).toBeUndefined();
 });
 it('preserves heartbeat and partial/final distinctions', () => {
  expect(parseOfficialSttMessage(frame({ heartbeat: true, words }), model).result).toBeUndefined();
  const partial = parseOfficialSttMessage(frame({ ...sentence, sentence_end: false, words }), model).result!;
  expect(partial.isFinal).toBe(false); expect(partial.speechFinal).toBe(false);
 });
});
