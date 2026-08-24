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

function workflowTask(id: string, status: string, entryId: string, caseIdentity: string) {
  return {
    id,
    status,
    metadata: {
      industryWorkflow: {
        entryId,
        context: { caseIdentity },
      },
    },
  };
}

function startedWorkflow(id: string, entryId: string) {
  return {
    task: { id, status: 'in_progress' },
    conversationId: `conversation-${id}`,
    conversationTaskId: `action-${id}`,
    requestId: `request-${id}`,
    handoffPrompt: 'continue',
    contract: {
      productLine: 'legal',
      entryId,
      title: entryId,
      requiredArtifactLabels: [],
      expectedContentTerms: [],
      requiresFileArtifact: false,
    },
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
      localPath: 'D:\\LumiOS\\legal_delivery\\verified-delivery.docx',
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
      localPath: 'D:\\LumiOS\\legal_delivery\\verified-delivery.docx',
    });
    expect(readLegalCaseFiles()[0].materials[0].localPath)
      .toBe('D:\\LumiOS\\legal_delivery\\verified-delivery.docx');
  });

  it('reuses only a matching active entry and case task and sends the native proof', async () => {
    sessionStorage.setItem('lumi_legal_industry_task', JSON.stringify({
      taskId: 'task-active',
      entryId: 'contract-review',
      caseIdentity: 'id:case-1',
      createdAt: Date.now(),
    }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/industry/workflows/task-active')) {
        return jsonResponse({ task: workflowTask('task-active', 'in_progress', 'contract-review', 'id:case-1') });
      }
      if (url.includes('/api/legal/tool/legal_review_contract')) {
        const headers = new Headers(init?.headers);
        expect(headers.get('x-lumi-desktop-session')).toBe('desktop-proof-for-client-test');
        expect(JSON.parse(String(init?.body))).toMatchObject({ industryWorkflowTaskId: 'task-active' });
        return jsonResponse({ text: 'reviewed', receipt: { ok: true, status: 'reviewed' }, caseUpdates: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(runLegalToolExecution('legal_review_contract', {
      contract: 'contract body',
      caseId: 'case-1',
      persistCase: true,
    })).resolves.toMatchObject({ text: 'reviewed' });
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input) === '/api/industry/workflows' && init?.method === 'POST'
    ))).toBe(false);
  });

  it.each([
    ['terminal task', 'contract-review', 'id:case-1', 'delivered'],
    ['different entry', 'asset-trace', 'id:case-1', 'in_progress'],
    ['different case', 'contract-review', 'id:case-2', 'in_progress'],
  ])('starts a new task for a %s', async (_label, entryId, caseIdentity, status) => {
    sessionStorage.setItem('lumi_legal_industry_task', JSON.stringify({
      taskId: 'task-stale',
      entryId,
      caseIdentity,
      createdAt: Date.now(),
    }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/industry/workflows/task-stale')) {
        return jsonResponse({ task: workflowTask('task-stale', status, entryId, caseIdentity) });
      }
      if (url === '/api/industry/workflows' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          entryId: 'contract-review',
          context: { caseIdentity: 'id:case-1' },
        });
        return jsonResponse(startedWorkflow('task-new', 'contract-review'), 201);
      }
      if (url.includes('/api/legal/tool/legal_review_contract')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ industryWorkflowTaskId: 'task-new' });
        return jsonResponse({ text: 'reviewed', receipt: { ok: true, status: 'reviewed' }, caseUpdates: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await runLegalToolExecution('legal_review_contract', {
      contract: 'contract body',
      caseId: 'case-1',
      persistCase: true,
    });
    const stored = JSON.parse(sessionStorage.getItem('lumi_legal_industry_task') || '{}');
    expect(stored).toMatchObject({
      taskId: 'task-new',
      entryId: 'contract-review',
      caseIdentity: 'id:case-1',
    });
    expect(fetchMock.mock.calls.filter(([input, init]) => (
      String(input) === '/api/industry/workflows' && init?.method === 'POST'
    ))).toHaveLength(1);
  });
});
