
// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrgHub } from '../src/components/org/OrgHub';
import { canAccessOrganizationWorkspaceView, listOrganizationWorkspaceViewsForRole } from '../shared/org_workspace';
import { queueOrganizationWorkspaceRoute } from '../src/lib/orgWorkspaceNavigation';
const fixture = vi.hoisted(() => ({ role: 'owner' }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({
  workDomain: 'work', switchDomain: vi.fn(), orgConnection: { orgId: 'synthetic-org', orgName: 'Synthetic legal organization', orgRole: fixture.role, connected: true },
}) }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en', orgDashboard: 'Dashboard', messaging: 'Messaging', orgAudit: 'Audit', orgSettings: 'Settings', orgWorkSpace: 'Organization', orgWorkDomain: 'Work', orgExitWorkSpace: 'Exit', orgRoleOwner: 'Owner', legalContractReview: 'Contract review', legalVerifyCitation: 'Citation verification' }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key.split('.')[1] }));
vi.mock('../src/components/org/LegalHub', () => ({ LegalHub: ({ initialView }: any) => <><h1>Legal cases and tools</h1><span data-testid="legal-outcome">{initialView}</span></> }));
vi.mock('../src/components/org/BranchDashboard', () => ({ BranchDashboard: () => <h1>Dashboard content</h1> }));
beforeEach(() => { fixture.role = 'owner'; sessionStorage.clear(); });
afterEach(cleanup);
it('restores the original seven legal entries, their destinations and industry boundaries', async () => {
  const events: any[] = [], listener = (event: Event) => events.push((event as CustomEvent).detail);
  window.addEventListener('lumi:org-view-changed', listener);
  try {
    render(<OrgHub />);
    await screen.findByRole('heading', { name: 'Dashboard content' });
    const nav = within(screen.getByRole('navigation'));
    expect(nav.getByRole('button', { name: 'Case workspace' })).toBeTruthy();
    for (const [label, outcome] of [['Case workspace', 'workspace'], ['Document drafting', 'packet'], ['Contract review', 'contract-review'], ['Statutes & precedents', 'research'], ['Asset leads', 'asset-trace'], ['Citation verification', 'verify'], ['Bid production', 'bid']]) {
      fireEvent.click(nav.getByRole('button', { name: label }));
      await screen.findByRole('heading', { name: 'Legal cases and tools' });
      expect(screen.getByTestId('legal-outcome').textContent).toBe(outcome);
    }
    expect(nav.queryByRole('button', { name: /spatial|brand|organization-modules/ })).toBeNull();
    fireEvent.click(nav.getByRole('button', { name: 'Dashboard' }));
    await screen.findByRole('heading', { name: 'Dashboard content' });
    act(() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'brand-design' } })));
    expect(screen.getByRole('heading', { name: 'Dashboard content' })).toBeTruthy();
    expect(screen.queryByText('Other industry content')).toBeNull();
    fireEvent.click(nav.getByRole('button', { name: 'Case workspace' }));
    await screen.findByRole('heading', { name: 'Legal cases and tools' });
    expect(events.at(-1).activeView).toBe('legal');
    expect(events.at(-1).availableViews).toContain('legal');
    expect(events.at(-1).availableViews).not.toContain('brand-design');
    expect(events.at(-1).availableViews).not.toContain('spatial-design');
    expect(events.at(-1).availableViews).not.toContain('chat');
  } finally { window.removeEventListener('lumi:org-view-changed', listener); }
});
it.each(['spatial-design', 'chat'])('does not restore a stale %s route after an upgrade', async route => {
  if (route === 'chat') {
    sessionStorage.setItem('lumi_pending_organization_workspace_route', JSON.stringify({view:'chat'}));
    expect(queueOrganizationWorkspaceRoute(route)).toBeNull();
  } else expect(queueOrganizationWorkspaceRoute(route)?.view).toBe(route);
  render(<OrgHub />);
  await screen.findByRole('heading', { name: 'Dashboard content' });
  expect(screen.getByRole('button', { name: 'Case workspace' })).toBeTruthy();
  expect(screen.queryByText('Other industry content')).toBeNull();
});
it.each(['owner', 'admin', 'member', 'viewer'])('keeps legal edition and role limits in the same access check for %s', role => {
  expect(canAccessOrganizationWorkspaceView(role, 'legal')).toBe(true);
  expect(canAccessOrganizationWorkspaceView(role, 'brand-design')).toBe(false);
  expect(canAccessOrganizationWorkspaceView(role, 'spatial-design')).toBe(false);
  const views = listOrganizationWorkspaceViewsForRole(role);
  expect(views).toContain('legal');
  expect(views).not.toContain('brand-design');
  expect(views).not.toContain('spatial-design');
  expect(canAccessOrganizationWorkspaceView(role, 'audit')).toBe(['owner', 'admin'].includes(role));
});
