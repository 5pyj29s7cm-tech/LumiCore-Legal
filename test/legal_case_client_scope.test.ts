import { setLegalCaseAccount } from '../src/lib/legalCaseStore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_LEGAL_CASE_STORAGE,
  LEGAL_CASES_STORAGE,
  clearLegalConsultationCaseId,
  createEmptyLegalCase,
  getActiveLegalCaseId,
  getLegalConsultationCaseId,
  readLegalCaseFiles,
  setActiveLegalCaseId,
  setLegalConsultationCaseId,
  writeLegalCaseFiles,
  mergePersonalLegalCaseRuntimeSnapshot,
  addLegalCaseMaterial,
} from '../src/lib/legalCaseStore';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

const originalWindow = (globalThis as any).window;
const originalLocalStorage = (globalThis as any).localStorage;
const originalCustomEvent = (globalThis as any).CustomEvent;
const storage = new MemoryStorage();

function usePersonalDomain() {
  storage.setItem('lumi_work_domain', 'personal');
  storage.removeItem('lumi_org_connection');
}

function useOrganization(orgId: string) {
  storage.setItem('lumi_work_domain', 'work');
  storage.setItem('lumi_org_connection', JSON.stringify({ orgId, connected: true }));
}

beforeEach(() => {
  storage.clear();
  (globalThis as any).localStorage = storage;
  (globalThis as any).window = { localStorage: storage, dispatchEvent: vi.fn() };
  setLegalCaseAccount('case-scope-owner');
  (globalThis as any).CustomEvent = class {
    constructor(public type: string, public init?: unknown) {}
  };
});

afterAll(() => {
  (globalThis as any).window = originalWindow;
  (globalThis as any).localStorage = originalLocalStorage;
  (globalThis as any).CustomEvent = originalCustomEvent;
});

describe('legal case client scope', () => {
  it('merges runtime case fields and artifacts without switching to a background case', () => {
    usePersonalDomain();
    const first = { ...createEmptyLegalCase(), id: 'first', title: 'First', updatedAt: '2026-01-01' };
    const active = { ...createEmptyLegalCase(), id: 'active', title: 'Active' };
    writeLegalCaseFiles([first, active], active.id);
    mergePersonalLegalCaseRuntimeSnapshot({ ...first, title: 'Updated first', clientRole: '被告', updatedAt: '2026-09-18', materials: [] });
    expect(readLegalCaseFiles().find(c => c.id === first.id)).toMatchObject({ title: 'Updated first', clientRole: '被告' });
    expect(getActiveLegalCaseId()).toBe('active');
    const material = addLegalCaseMaterial(first.id, { type: 'evidence', title: 'attachment', fileName: 'proof.pdf', localPath: 'D:/fixtures/proof.pdf' });
    expect(material).toMatchObject({ fileName: 'proof.pdf', localPath: 'D:/fixtures/proof.pdf' });
  });
  it('does not expose or overwrite the personal case database in work domain', () => {
    usePersonalDomain();
    const personalCase = { ...createEmptyLegalCase(), id: 'personal-case', title: 'Personal case' };
    writeLegalCaseFiles([personalCase], personalCase.id);
    expect(readLegalCaseFiles().map(item => item.id)).toEqual(['personal-case']);

    useOrganization('org-a');
    expect(readLegalCaseFiles()).toEqual([]);
    writeLegalCaseFiles([{ ...personalCase, id: 'must-not-write' }], 'must-not-write');

    usePersonalDomain();
    expect(readLegalCaseFiles().map(item => item.id)).toEqual(['personal-case']);
    expect(storage.getItem(`${LEGAL_CASES_STORAGE}:user:case-scope-owner`)).toContain('personal-case');
  });

  it('keeps active and consultation case choices separate per organization', () => {
    usePersonalDomain();
    setActiveLegalCaseId('personal-active');
    setLegalConsultationCaseId('personal-consultation');

    useOrganization('org-a');
    expect(getActiveLegalCaseId()).toBe('');
    expect(getLegalConsultationCaseId()).toBe('');
    setActiveLegalCaseId('org-a-active');
    setLegalConsultationCaseId('org-a-consultation');

    useOrganization('org-b');
    expect(getActiveLegalCaseId()).toBe('');
    expect(getLegalConsultationCaseId()).toBe('');
    setLegalConsultationCaseId('org-b-consultation');
    clearLegalConsultationCaseId();

    useOrganization('org-a');
    expect(getActiveLegalCaseId()).toBe('org-a-active');
    expect(getLegalConsultationCaseId()).toBe('org-a-consultation');

    usePersonalDomain();
    expect(getActiveLegalCaseId()).toBe('personal-active');
    expect(getLegalConsultationCaseId()).toBe('personal-consultation');
    expect(storage.getItem(`${ACTIVE_LEGAL_CASE_STORAGE}:user:case-scope-owner`)).toBe('personal-active');
  });

  it('clears a stale active case when the personal case list becomes empty', () => {
    usePersonalDomain();
    const caseFile = { ...createEmptyLegalCase(), id: 'case-to-delete', title: 'Delete me' };
    writeLegalCaseFiles([caseFile], caseFile.id);
    expect(getActiveLegalCaseId()).toBe(caseFile.id);

    writeLegalCaseFiles([], '');

    expect(readLegalCaseFiles()).toEqual([]);
    expect(getActiveLegalCaseId()).toBe('');
    expect(storage.getItem(ACTIVE_LEGAL_CASE_STORAGE)).toBeNull();
  });
});
