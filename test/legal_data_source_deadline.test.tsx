// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegalDataSourcesSettings } from '../src/components/org/LegalDataSourcesSettings';
import { legalDataSourceRecoveryCopy } from '../src/i18n/locales/legalDataSourceRecovery';

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), success: vi.fn(), error: vi.fn(), lang: 'en', account: { user: { uid: 'audit-owner', role: 'admin' } as { uid: string; role: string } | null } }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => fixture.account }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: fixture.lang }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key }));
vi.mock('../src/services/apiBridge', () => ({ getBackendOrigin: () => 'http://localhost:3000' }));
vi.mock('sonner', () => ({ toast: { success: fixture.success, error: fixture.error } }));

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }) as Response;
const input = () => document.getElementById('legal-source-QICHACHA_API_KEY') as HTMLInputElement;
const refresh = () => screen.getByRole('button', { name: 'legal-data-sources-settings.refresh.05348f5f9a' });
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const expire = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(15_001); }); };
const submit = () => fireEvent.keyDown(input(), { key: 'Enter' });
beforeEach(() => {
  vi.useFakeTimers(); fixture.fetch.mockReset(); fixture.success.mockReset(); fixture.error.mockReset();
  fixture.account.user = { uid: 'audit-owner', role: 'admin' }; fixture.lang = 'en'; vi.stubGlobal('fetch', fixture.fetch); localStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('legal key configuration deadlines and recovery', () => {
  it('ends a pending read and permits an explicit read retry without a write', async () => {
    const pending = deferred<Response>(); fixture.fetch.mockReturnValue(pending.promise);
    render(<LegalDataSourcesSettings />); await flush(); expect(input().disabled).toBe(true);
    await expire(); expect(screen.getByRole('alert').textContent).toContain(legalDataSourceRecoveryCopy.en.loadTimeout);
    expect((refresh() as HTMLButtonElement).disabled).toBe(false); expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    fixture.fetch.mockResolvedValue(response({ QICHACHA_API_KEY: false })); fireEvent.click(refresh()); await flush();
    expect(input().disabled).toBe(false); expect(screen.queryByRole('alert')).toBeNull();
    expect(fixture.fetch.mock.calls.every(([, init]) => !init.method)).toBe(true);
    await act(async () => pending.resolve(response({ QICHACHA_API_KEY: true })));
    expect(input().placeholder).toBeTruthy(); expect(fixture.success).not.toHaveBeenCalled();
  });

  it('keeps a timed-out write draft, requires read recovery, and never automatically resubmits', async () => {
    const pending = deferred<Response>(); let accepted = false;
    fixture.fetch.mockImplementation((_url, init) => init.method ? pending.promise : Promise.resolve(response({ QICHACHA_API_KEY: accepted })));
    render(<LegalDataSourcesSettings />); await flush(); fireEvent.change(input(), { target: { value: 'synthetic-key' } }); submit(); await flush();
    await expire(); expect(screen.getByRole('alert').textContent).toContain(legalDataSourceRecoveryCopy.en.saveTimeout);
    expect(input().value).toBe('synthetic-key'); expect(input().disabled).toBe(true); expect(fixture.success).not.toHaveBeenCalled();
    await expire(); expect(fixture.fetch.mock.calls.filter(([, init]) => init.method).length).toBe(1);
    fireEvent.click(refresh()); await flush(); expect(input().disabled).toBe(false); expect(input().value).toBe('synthetic-key');
    fixture.fetch.mockImplementation(async (_url, init) => { if (init.method) { accepted = true; return response({ success: true }); } return response({ QICHACHA_API_KEY: accepted }); });
    submit(); await flush(); expect(fixture.success).toHaveBeenCalledOnce(); expect(input().value).toBe('');
    expect(fixture.fetch.mock.calls.filter(([, init]) => init.method).length).toBe(2);
  });

  it('suppresses late write completion after timeout, including readback and key-change events', async () => {
    const pending = deferred<Response>(), published = vi.fn(); window.addEventListener('lumi:keys-changed', published);
    try {
      fixture.fetch.mockImplementation((_url, init) => init.method ? pending.promise : Promise.resolve(response({ QICHACHA_API_KEY: false })));
      render(<LegalDataSourcesSettings />); await flush(); fireEvent.change(input(), { target: { value: 'synthetic-key' } }); submit(); await flush(); await expire();
      const calls = fixture.fetch.mock.calls.length; await act(async () => pending.resolve(response({ success: true })));
      expect(fixture.fetch).toHaveBeenCalledTimes(calls); expect(fixture.success).not.toHaveBeenCalled(); expect(published).not.toHaveBeenCalled();
      expect(input().value).toBe('synthetic-key'); expect(screen.getByRole('alert').textContent).toContain(legalDataSourceRecoveryCopy.en.saveTimeout);
    } finally { window.removeEventListener('lumi:keys-changed', published); }
  });

  it('does not publish a timeout or late data from the account that was unmounted', async () => {
    const pending = deferred<Response>(); fixture.fetch.mockReturnValue(pending.promise);
    const view = render(<LegalDataSourcesSettings />); await flush(); const oldSignal = fixture.fetch.mock.calls[0][1].signal;
    fixture.fetch.mockResolvedValue(response({ QICHACHA_API_KEY: false })); fixture.account.user = { uid: 'next-owner', role: 'admin' };
    view.rerender(<LegalDataSourcesSettings />); await flush(); await expire();
    expect(oldSignal.aborted).toBe(true); expect(screen.queryByRole('alert')).toBeNull(); expect(input().disabled).toBe(false);
    await act(async () => pending.resolve(response({ QICHACHA_API_KEY: true })));
    expect(screen.queryByRole('alert')).toBeNull(); expect(fixture.error).not.toHaveBeenCalled(); expect(fixture.success).not.toHaveBeenCalled();
  });

  it('shows a rejected write inline, preserves its draft and permits a deliberate retry', async () => {
    let accepted = false;
    fixture.fetch.mockImplementation(async (_url, init) => init.method ? response(accepted ? { success: true } : { success: false, error: 'Synthetic rejected save' }, accepted ? 200 : 403) : response({ QICHACHA_API_KEY: accepted }));
    render(<LegalDataSourcesSettings />); await flush(); fireEvent.change(input(), { target: { value: 'synthetic-key' } }); submit(); await flush();
    expect(screen.getByRole('alert').textContent).toContain('Synthetic rejected save'); expect(input().disabled).toBe(false); expect(input().value).toBe('synthetic-key');
    accepted = true; submit(); await flush(); expect(fixture.success).toHaveBeenCalledOnce(); expect(screen.queryByRole('alert')).toBeNull(); expect(input().value).toBe('');
  });

  it('keeps an in-flight write owned when only display language changes', async () => {
    const pending = deferred<Response>(); let accepted = false;
    fixture.fetch.mockImplementation((_url, init) => init.method ? pending.promise : Promise.resolve(response({ QICHACHA_API_KEY: accepted })));
    const view = render(<LegalDataSourcesSettings />); await flush(); fireEvent.change(input(), { target: { value: 'synthetic-key' } }); submit(); await flush();
    const signal = fixture.fetch.mock.calls.find(([, init]) => init.method)![1].signal;
    fixture.lang = 'zh'; view.rerender(<LegalDataSourcesSettings />); await flush(); expect(signal.aborted).toBe(false);
    accepted = true; await act(async () => pending.resolve(response({ success: true })));
    expect(fixture.success).toHaveBeenCalledOnce(); expect(input().disabled).toBe(false); expect(input().value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull(); expect(fixture.fetch.mock.calls.filter(([, init]) => init.method).length).toBe(1);
  });
});
