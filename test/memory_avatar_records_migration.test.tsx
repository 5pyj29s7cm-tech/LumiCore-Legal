// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ user: { uid: 'owner-a' }, api: vi.fn(), create: vi.fn(), login: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: mocks.user, login: mocks.login }) }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: mocks.api }));
vi.mock('../src/services/memoryAvatarService', () => ({ memoryAvatarService: { create: mocks.create } }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
import { MemoryAvatarLab } from '../src/components/MemoryAvatarLab';

class Reader {
  static LOADING = 1;
  static instances: Reader[] = [];
  readyState = 1;
  result = '';
  onload: null | ((event: any) => unknown) = null;
  onerror: null | (() => unknown) = null;
  onloadend: null | (() => unknown) = null;
  constructor() { Reader.instances.push(this); }
  readAsText() {}
  readAsDataURL() {}
  abort() { this.readyState = 2; this.onloadend?.(); }
  complete(value: string) { this.result = value; this.readyState = 2; const result = this.onload?.({ target: { result: value } }); this.onloadend?.(); return result; }
  fail() { this.readyState = 2; this.onerror?.(); this.onloadend?.(); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const response = (data: unknown) => ({ ok: true, json: async () => data });
const distilled = {
  inferredName: 'Synthetic companion', relationshipType: 'close_friend', personalityConfig: { expressionStyle: { tone: 'warm' } },
  seedMemories: Array.from({ length: 12 }, (_, i) => ({ type: 'story', content: `Synthetic memory ${i + 1}`, keywords: ['fixture'], confidence: .7, evidenceGrade: 'verbatim' })),
  evidenceMap: [{ memoryIndex: 0, grade: 'verbatim', source: 'Target line' }], narrative: 'A synthetic biography', summary: { messageCount: 12, memoryCount: 12 },
};
beforeEach(() => {
  mocks.user = { uid: 'owner-a' };
  Object.values(mocks).forEach(value => { if (typeof value === 'function') value.mockReset(); });
  Reader.instances = []; vi.stubGlobal('FileReader', Reader);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function capture(name: string, container: HTMLElement) {
  const directory = process.env.LUMI_MEMORY_CREATE_PREVIEW_DIR;
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name + '.html'), container.innerHTML);
}
function openRecords(directName = '') {
  const entered = vi.fn(); const props = { t: {}, lang: 'en' as const, onEnterSanctuary: entered };
  const view = render(<MemoryAvatarLab {...props} />);
  if (directName) fireEvent.change(screen.getByLabelText('Name'), { target: { value: directName } });
  capture('direct', view.container);
  const surface = view.container.firstElementChild;
  fireEvent.click(screen.getByRole('button', { name: 'Create from records' }));
  capture('records', view.container);
  return { ...view, props, entered, surface };
}
async function preview() {
  const view = openRecords();
  fireEvent.change(screen.getByLabelText('Record text preview'), { target: { value: 'Target: A synthetic story.' } });
  mocks.api.mockResolvedValueOnce(response(distilled));
  fireEvent.click(screen.getByRole('button', { name: 'Extract person and memories' }));
  await screen.findByText('A synthetic biography');
  capture('preview', view.container);
  return view;
}

it('keeps records inside the actual new creation surface and returns to the intact name form', () => {
  const view = openRecords('Unsubmitted name draft');
  expect(view.container.firstElementChild).toBe(view.surface);
  expect(view.surface?.getAttribute('data-memory-avatar-create')).toBe('');
  expect(screen.getByRole('heading', { name: 'Create from records' })).toBeTruthy();
  expect(screen.queryByText('Memory Avatar Lab')).toBeNull();
  expect(screen.getByLabelText('Record text preview')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Start from a name' }));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsubmitted name draft');
  expect(screen.queryByLabelText('Record text preview')).toBeNull();
});

it('imports real text control content, allows correction, and submits the displayed source and relationship', async () => {
  const view = openRecords();
  fireEvent.change(screen.getByLabelText('Import record file'), { target: { files: [new File(['fixture'], 'synthetic.txt')] } });
  await act(async () => Reader.instances.at(-1)!.complete('Target: Original synthetic record.'));
  expect((screen.getByLabelText('Record text preview') as HTMLTextAreaElement).value).toContain('Original synthetic record');
  fireEvent.change(screen.getByLabelText('Record text preview'), { target: { value: 'Target: Corrected synthetic record.' } });
  fireEvent.change(screen.getByLabelText('Relationship'), { target: { value: 'family' } });
  mocks.api.mockResolvedValueOnce(response(distilled));
  fireEvent.click(screen.getByRole('button', { name: 'Extract person and memories' }));
  await screen.findByText('Synthetic memory 12');
  expect(JSON.parse(mocks.api.mock.calls[0][1].body)).toMatchObject({ chatLog: 'Target: Corrected synthetic record.', format: 'plain', relationshipType: 'family' });
  expect(view.entered).not.toHaveBeenCalled();
});

it('releases a failed extraction for retry and keeps the source visible', async () => {
  openRecords();
  fireEvent.change(screen.getByLabelText('Record text preview'), { target: { value: 'Target: Keep this record.' } });
  mocks.api.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Synthetic extraction failure' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Extract person and memories' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Extract person and memories' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByLabelText('Record text preview') as HTMLTextAreaElement).value).toContain('Keep this record');
  mocks.api.mockResolvedValueOnce(response(distilled));
  fireEvent.click(screen.getByRole('button', { name: 'Extract person and memories' }));
  await screen.findByText('A synthetic biography');
});

it('saves all extracted fields only after preview, reuses failed save identity, and enters only on ACK', async () => {
  const view = await preview();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewed companion' } });
  mocks.api.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Synthetic save not confirmed' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Create and enter' }));
  await screen.findByRole('alert');
  expect(view.entered).not.toHaveBeenCalled();
  const first = JSON.parse(mocks.api.mock.calls.at(-1)![1].body);
  const gate = deferred<ReturnType<typeof response>>(); mocks.api.mockReturnValueOnce(gate.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Create and enter' }));
  expect(view.entered).not.toHaveBeenCalled();
  await act(async () => gate.resolve(response({ id: 'synthetic-avatar', name: first.name })));
  const retried = JSON.parse(mocks.api.mock.calls.at(-1)![1].body);
  expect(retried).toMatchObject({ name: 'Reviewed companion', seedMemories: distilled.seedMemories, evidenceMap: distilled.evidenceMap, clientRequestId: first.clientRequestId });
  expect(view.entered).toHaveBeenCalledTimes(1);
});

it.each(['owner', 'direct'] as const)('aborts and ignores late extraction after %s transition', async transition => {
  const view = openRecords();
  fireEvent.change(screen.getByLabelText('Record text preview'), { target: { value: 'Target: Owner A private fixture.' } });
  const gate = deferred<ReturnType<typeof response>>(); mocks.api.mockReturnValueOnce(gate.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Extract person and memories' }));
  const signal = mocks.api.mock.calls[0][1].signal as AbortSignal;
  if (transition === 'owner') { mocks.user = { uid: 'owner-b' }; view.rerender(<MemoryAvatarLab {...view.props} />); }
  else fireEvent.click(screen.getByRole('button', { name: 'Start from a name' }));
  expect(signal.aborted).toBe(true);
  await act(async () => gate.resolve(response(distilled)));
  expect(screen.queryByText('A synthetic biography')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Create from records' }));
  expect((screen.getByLabelText('Record text preview') as HTMLTextAreaElement).value).toBe('');
  expect(view.entered).not.toHaveBeenCalled();
});

it('unlocks the actual audio control after an OS read failure without uploading', async () => {
  openRecords();
  fireEvent.change(screen.getByLabelText('Import voice recording (optional)'), { target: { files: [new File(['fixture'], 'synthetic.wav')] } });
  await act(async () => Reader.instances.at(-1)!.fail());
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Import voice recording (optional)') as HTMLInputElement).disabled).toBe(false);
  expect(mocks.api).not.toHaveBeenCalled();
});

it('keeps the imported source when returning from preview, and renders the same workflow in Chinese', async () => {
  const view = await preview();
  fireEvent.click(screen.getByRole('button', { name: 'Back to source text' }));
  expect((screen.getByLabelText('Record text preview') as HTMLTextAreaElement).value).toBe('Target: A synthetic story.');
  view.rerender(<MemoryAvatarLab {...view.props} lang="zh" />);
  expect(screen.getByRole('heading', { name: '从已有资料创建' })).toBeTruthy();
  expect((screen.getByLabelText('资料原文预览') as HTMLTextAreaElement).value).toBe('Target: A synthetic story.');
  capture('records-zh', view.container);
  mocks.api.mockResolvedValueOnce(response(distilled));
  fireEvent.click(screen.getByRole('button', { name: '提取人物与记忆' }));
  await screen.findByRole('button', { name: '创建并进入领地' });
  expect(screen.getByText('Synthetic memory 12')).toBeTruthy();
  capture('preview-zh', view.container);
});

it.each(['light', 'dark'])('uses the shared theme surface and readable semantic controls in %s mode', mode => {
  document.documentElement.dataset.mode = mode;
  const view = openRecords();
  expect(view.surface?.className).toContain('bg-background');
  expect(screen.getByLabelText('Record text preview').className).toContain('text-foreground');
  expect(view.container.querySelector('.bg-zinc-950\\/90')).toBeNull();
  delete document.documentElement.dataset.mode;
});
