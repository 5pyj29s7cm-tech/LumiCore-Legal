import { readImplementationSource } from './implementation_source';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function source(file: string) {
  return readImplementationSource(path.join(process.cwd(), file), 'utf8');
}

describe('organization workspace information architecture', () => {
  it('keeps legal case creation and deletion separate from the case workflow', () => {
    const legalHub = source('src/components/org/LegalHub.tsx');
    const routes = source('server/org/routes.ts');

    expect(legalHub).toContain('LegalCaseCreateDialog');
    expect(legalHub).toContain('LegalCaseDeleteDialog');
    expect(legalHub).toContain('setActiveLegalCaseId(id)');
    expect(legalHub).not.toContain('text-white/25 opacity-0');
    expect(legalHub).not.toContain('Case Action Board');
    expect(legalHub).not.toContain('案件行动面板');
    expect(routes).toContain("router.delete('/org/legal/cases/:caseId'");
    expect(routes).toContain("requireOrgRole('owner', 'admin')");
  });

  it('keeps the legal edition focused on a visible case workspace without other industry modules', () => {
    const orgHub = source('src/components/org/OrgHub.tsx');
    expect(orgHub).toContain('legalNavItems');
    expect(orgHub).toContain("id: 'workspace'");
    expect(orgHub).toContain('workspaceCopy.caseWorkspace');
    expect(orgHub).not.toContain("id: 'spatial-design'");
    expect(orgHub).not.toContain("id: 'brand-design'");
    expect(orgHub).not.toContain('<DesignHub');
    expect(orgHub).not.toContain('orgModulesOpen');
  });

  it('hides duplicate dashboard destinations from organization navigation', () => {
    const orgHub = source('src/components/org/OrgHub.tsx');

    for (const id of ['kb', 'members']) {
      expect(orgHub).toContain(`id: '${id}'`);
    }
    expect(orgHub).toContain("visibleItems.filter(item => item.id === 'dashboard')");
    expect(orgHub).not.toContain('showInNav');
    expect(orgHub).not.toContain('item.roles.includes');
    expect(orgHub).not.toContain("id: 'templates'");
    expect(orgHub).not.toContain("id: 'chat'");
  });

  it('combines organization settings with branch connection without duplicating the branch navigation item', () => {
    const orgHub = source('src/components/org/OrgHub.tsx');
    const settingsWorkspace = source('src/components/org/OrganizationSettingsWorkspace.tsx');
    const branchPanel = source('src/components/OrgBranchPanel.tsx');

    expect(orgHub).toContain("case 'settings': return <OrganizationSettingsWorkspace />");
    expect(orgHub).toContain('initialTab="branch"');
    expect(orgHub).toContain("id: 'branch'");
    expect(settingsWorkspace).toContain('<OrgSettings />');
    expect(settingsWorkspace).toContain('<OrgBranchPanel />');
    expect(settingsWorkspace).toContain("type OrganizationSettingsTab = 'general' | 'branch'");
    expect(branchPanel).toContain("uiMessage('org-branch-panel.branch-connection.9cecc72547')");
    expect(branchPanel).not.toContain("ui('分支连接', 'Branch Connection')");
  });

  it('uses the same Lumi model configuration across personal and organization domains', () => {
    const orgSettings = source('src/components/org/OrgSettings.tsx');
    const appContext = source('src/contexts/AppContext.tsx');
    const selfModel = source('server/client/self_model.ts');
    const systemRoutes = source('server/routes/system_routes.ts');

    expect(orgSettings).not.toContain('/api/preferences/org-llm');
    expect(orgSettings).not.toContain('LLM_PROVIDER_OPTIONS');
    expect(appContext).not.toContain("'/api/preferences/org-llm'");
    expect(systemRoutes).not.toContain('/preferences/org-llm');
    expect(selfModel).toContain('organizations do not have an independent model policy');
    expect(selfModel).toContain('model_configuration_update');
  });

  it('reports exact organization views and preserves routed destinations until the workspace mounts', () => {
    const orgHub = source('src/components/org/OrgHub.tsx');
    const desktop = source('src/components/DesktopUI.tsx');
    const navigation = source('src/lib/orgWorkspaceNavigation.ts');
    const contract = source('shared/org_workspace.ts');

    expect(orgHub).toContain('takePendingOrganizationWorkspaceRoute');
    expect(orgHub).toContain("'lumi:org-view-changed'");
    expect(orgHub).toContain('canAccessOrganizationWorkspaceView');
    expect(desktop).toContain('queueOrganizationWorkspaceRoute');
    expect(desktop).toContain('organizationWorkspaceView');
    expect(desktop).toContain('availableOrganizationWorkspaceViews');
    expect(contract).toContain("'spatial-design'");
    expect(contract).toContain("'brand-design'");
    expect(navigation).toContain('sessionStorage');
  });

  it('reports post-ingestion health to the same current-workspace Lumi', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const editor = source('src/components/org/KnowledgeBaseEditor.tsx');
    const selfModel = source('server/client/self_model.ts');

    expect(desktop).toContain("'/api/org/kb/stats'");
    expect(desktop).toContain('indexedFiles');
    expect(desktop).toContain('partialFiles');
    expect(desktop).toContain('pendingFiles');
    expect(desktop).toContain("'lumi:knowledge-updated'");
    expect(editor).toContain("'organization-knowledge-editor'");
    expect(selfModel).toContain('A saved upload is not automatically fully usable');
    expect(selfModel).toContain('orgMissingIndex');
  });

  it('gives legal tools a shared current-case and execution-state context', () => {
    const legalHub = source('src/components/org/LegalHub.tsx');
    const contextBar = source('src/components/org/LegalCaseContextBar.tsx');
    const toolClient = source('src/lib/legalToolClient.ts');

    expect(legalHub).toContain('<LegalCaseContextBar');
    expect(contextBar).toContain("export type LegalToolState = 'input' | 'running' | 'result'");
    expect(contextBar).toContain("copy.linked");
    expect(contextBar).toContain("uiMessage('legal-case-context-bar.closed.f9c16bb807')");
    expect(contextBar).not.toContain("ui('当前案件', 'Current case')");
    expect(toolClient).toContain("'lumi:org-legal-cases-changed'");
  });
});
