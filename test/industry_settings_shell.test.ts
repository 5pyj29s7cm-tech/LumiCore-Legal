// @vitest-environment jsdom
import React, { Suspense, useEffect } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Settings } from '../src/components/desktop/surface_components';

const fixture = vi.hoisted(() => ({ uid: 'settings-user-a', mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: fixture.uid, role: 'user' }, workDomain: 'personal', orgConnection: null }) }));
vi.mock('../src/components/settings/navigation', () => ({ SettingsView: ({ t, lang, setLang, activeSection = 'general', onSectionChange }: any) => {
  useEffect(() => { fixture.mounted(); return fixture.unmounted; }, []);
  return React.createElement('section', {},
    React.createElement('h1', {}, t.settingsTitle),
    React.createElement('output', { 'aria-label': 'Settings section' }, activeSection),
    React.createElement('output', { 'aria-label': 'Settings language' }, lang),
    React.createElement('button', { onClick: () => onSectionChange?.('reasoning-model') }, 'Open reasoning'),
    React.createElement('button', { onClick: () => setLang('en') }, 'Use English'));
} }));
beforeEach(() => { fixture.uid = 'settings-user-a'; fixture.mounted.mockClear(); fixture.unmounted.mockClear(); });
afterEach(cleanup);
const show = (props: any) => React.createElement(Suspense, { fallback: 'Loading' }, React.createElement(Settings, props));

it('opens the existing settings directly and preserves a requested section and callbacks', async () => {
  const setLang = vi.fn(), onSectionChange = vi.fn();
  render(show({ t: { settingsTitle: 'Actual Lumi settings' }, lang: 'zh', setLang, activeSection: 'tools', onSectionChange }));
  await screen.findByRole('heading', { name: 'Actual Lumi settings' });
  expect(screen.getByLabelText('Settings section').textContent).toBe('tools');
  expect(screen.getByLabelText('Settings language').textContent).toBe('zh');
  fireEvent.click(screen.getByRole('button', { name: 'Open reasoning' }));
  expect(onSectionChange).toHaveBeenCalledWith('reasoning-model');
  fireEvent.click(screen.getByRole('button', { name: 'Use English' }));
  expect(setLang).toHaveBeenCalledWith('en');
});

it('keeps the existing account isolation and updates section routing without another overview', async () => {
  const props = { t: { settingsTitle: 'Actual Lumi settings' }, lang: 'zh', setLang: vi.fn() };
  const view = render(show(props));
  await screen.findByRole('heading', { name: 'Actual Lumi settings' });
  expect(screen.getByLabelText('Settings section').textContent).toBe('general');
  view.rerender(show({ ...props, activeSection: 'ai-providers' }));
  expect(screen.getByLabelText('Settings section').textContent).toBe('ai-providers');
  expect(fixture.mounted).toHaveBeenCalledTimes(1);
  fixture.uid = 'settings-user-b';
  view.rerender(show({ ...props, activeSection: 'security' }));
  expect(screen.getByLabelText('Settings section').textContent).toBe('security');
  expect(fixture.unmounted).toHaveBeenCalledTimes(1);
  expect(fixture.mounted).toHaveBeenCalledTimes(2);
});
