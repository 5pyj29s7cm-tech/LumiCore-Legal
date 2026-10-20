// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mergePersonalLegalCaseRuntimeSnapshot,
  readLegalCaseFiles,
  writeLegalCaseFiles,
  type LegalCaseFile,
} from '../src/lib/legalCaseStore';
import { runLegalToolExecution } from '../src/lib/legalToolClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function caseFile(material: LegalCaseFile['materials'][number]): LegalCaseFile {
  return {
    id: 'case-client-continuity',
    title: 'Client continuity case',
    caseNumber: '',
    party: '',
    cause: 'contract review',
    court: '',
    judge: '',
    stage: 'consultation',
    hearingDate: '',
    judgmentDate: '',
    appealDeadline: '',
    enforcementDeadline: '',
    notes: '',
    materials: [material],
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('lumi_desktop_session_proof', 'desktop-proof-for-client-test');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('legal client continuity', () => {
  it('preserves an existing local path and file name when a same-id runtime material is incomplete', () => {
    writeLegalCaseFiles([caseFile({
      id: 'material-shared-id',
      type: 'pleading',
      title: 'Local verified artifact',
      content: 'older local content',
      fileName: 'verified-delivery.docx',
      localPath: 'D:\\LumiCore\\legal_delivery\\verified-delivery.docx',
      source: 'tool',
      createdAt: '2026-08-24T00:00:00.000Z',
    })], 'case-client-continuity');

    const merged = mergePersonalLegalCaseRuntimeSnapshot(caseFile({
      id: 'material-shared-id',
      type: 'pleading',
      title: 'Runtime artifact update',
      content: 'newer runtime content',
      source: 'tool',
      createdAt: '2026-08-24T00:01:00.000Z',
    }));

    expect(merged?.materials[0]).toMatchObject({
      id: 'material-shared-id',
      content: 'newer runtime content',
      fileName: 'verified-delivery.docx',
      localPath: 'D:\\LumiCore\\legal_delivery\\verified-delivery.docx',
    });
    expect(readLegalCaseFiles()[0].materials[0].localPath)
      .toBe('D:\\LumiCore\\legal_delivery\\verified-delivery.docx');
  });

  it('executes exactly once with native proof and returns verified artifacts without creating a second task', async () => {
    sessionStorage.setItem('lumi_legal_industry_task', JSON.stringify({ taskId: 'stale-task' }));
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get('x-lumi-desktop-session')).toBe('desktop-proof-for-client-test');
      expect(JSON.parse(String(init?.body))).toEqual({ args: { contract: 'source', persistCase: false } });
      return jsonResponse({ text: 'reviewed', receipt: { ok: true }, artifacts: ['verified.docx'], caseUpdates: [] });
    });
    await expect(runLegalToolExecution('legal_review_contract', { contract: 'source', persistCase: false })).resolves.toMatchObject({ text: 'reviewed', receipt: { ok: true }, artifacts: ['verified.docx'] });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(String(mock.mock.calls[0][0])).toContain('/api/legal/tool/legal_review_contract');
  });
  it('does not merge late case updates after cancellation', async () => {
    let release!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(resolve => { release = resolve; }));
    const request = new AbortController();
    const pending = runLegalToolExecution('legal_review_contract', { contract: 'source' }, request.signal);
    request.abort();
    release(jsonResponse({ text: 'stale', caseUpdates: [caseFile({ id: 'stale', type: 'note', title: 'stale', createdAt: '' })] }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(readLegalCaseFiles()).toEqual([]);
  });
});
