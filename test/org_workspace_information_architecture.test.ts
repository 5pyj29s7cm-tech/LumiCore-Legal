import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

describe('organization workspace information architecture', () => {
  it('keeps legal case creation and deletion separate from the case workflow', () => {
    const legalHub = source('src/components/org/LegalHub.tsx');
    const routes = source('server/org/routes.ts');

    expect(legalHub).toContain('LegalCaseCreateDialog');
    expect(legalHub).toContain('LegalCaseDeleteDialog');
    expect(legalHub).toContain("method: 'DELETE'");
    expect(legalHub).toContain('setActiveLegalCaseId(id)');
    expect(legalHub).not.toContain('text-white/25 opacity-0');
    expect(legalHub).not.toContain('Case Action Board');
    expect(legalHub).not.toContain('案件行动面板');
    expect(routes).toContain("router.delete('/org/legal/cases/:caseId'");
    expect(routes).toContain("requireOrgRole('owner', 'admin')");
  });

  it('keeps the legal client organization workspace legal-only', () => {
    const orgHub = source('src/components/org/OrgHub.tsx');
    const legalHub = source('src/components/org/LegalHub.tsx');
    const legalCopy = source('src/i18n/regions/cn/legal.ts');
    const marketplace = source('src/components/org/TemplateMarketplace.tsx');
    const creator = source('src/components/org/TemplateCreator.tsx');
    const reviewQueue = source('src/components/org/TemplateReviewQueue.tsx');

    for (const id of [
      'workspace',
      'research',
      'contract-review',
      'asset-trace',
      'verify',
      'bid',
    ]) {
      expect(orgHub).toContain(`id: '${id}'`);
    }
    expect(orgHub).not.toContain('spatial-design');
    expect(orgHub).not.toContain('brand-design');
    expect(orgHub).not.toContain('DesignHub');
    expect(orgHub).not.toContain('orgModulesOpen');
    expect(orgHub).not.toContain("uiMessage('org-hub.organization-modules");
    expect(orgHub).not.toContain('t.orgExitWorkSpace');
    expect(orgHub).toContain('legalNavItems.map');
    expect(orgHub).toContain('workspaceCopy.standaloneLegalTools');
    for (const entry of ['caseWorkspace', 'documentGeneration', 'lawAndCases', 'assetClues', 'deliveryVerification', 'bidProduction']) {
      expect(orgHub).toContain(`workspaceCopy.${entry}`);
    }
    expect(orgHub).toContain("{ id: 'packet'");
    for (const label of ['案件工作台', '文书生成', '合同审查', '法条与类案', '财产线索', '交付核验', '标书制作']) {
      expect(legalCopy).toContain(label);
    }
    expect(orgHub).toContain('workspaceResetKey={legalWorkspaceResetKey}');
    expect(legalHub).not.toContain('flex w-56 shrink-0 flex-col');
    expect(legalHub).not.toContain('<LegalDataSourcesSettings />');
    expect(legalHub).toContain('onSetView={openCaseTool}');
    expect(legalHub).toContain('setWorkflowView(nextView)');
    expect(legalHub).toContain('workflowNavItems.map');
    expect(legalHub).toContain("const activeView = isWorkflowView ? workflowView : view");
    expect(legalHub).toContain('overflow-x-auto overscroll-x-contain');
    expect(legalHub).not.toContain('onClick={() => openCaseTool(nextStep.id)}');
    expect(legalHub).not.toContain('const setView = onViewChange');
    expect(legalHub).toContain('LegalResearchWorkspace');
    expect(legalHub).toContain("type LegalResearchTab = 'case-search' | 'external-research' | 'import'");
    for (const id of ['strategy', 'packet', 'knowledge-sync']) {
      expect(legalHub).toContain(`case '${id}'`);
    }
    expect(marketplace).toContain('category=legal');
    expect(creator).toContain("category: 'legal'");
    expect(reviewQueue).toContain('category=legal');
  });

  it('combines template review with the marketplace and hides duplicate dashboard destinations from navigation', () => {
    const orgHub = source('src/components/org/OrgHub.tsx');
    const templateWorkspace = source('src/components/org/AgentTemplateWorkspace.tsx');

    for (const id of ['kb', 'chat', 'templates', 'members']) {
      expect(orgHub).toContain(`id: '${id}'`);
    }
    expect(orgHub.match(/showInNav: false/g)?.length).toBeGreaterThanOrEqual(5);
    expect(orgHub).toContain("case 'templates': return <AgentTemplateWorkspace />");
    expect(orgHub).toContain('initialTab="review"');
    expect(templateWorkspace).toContain('<TemplateMarketplace />');
    expect(templateWorkspace).toContain('<TemplateReviewQueue />');
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
    expect(settingsWorkspace).toContain("type OrganizationSettingsTab = 'general' | 'legal-data-sources' | 'branch'");
    expect(settingsWorkspace).toContain('<LegalDataSourcesSettings />');
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
    expect(contract).toContain("'legal'");
    expect(contract).not.toContain("'spatial-design'");
    expect(contract).not.toContain("'brand-design'");
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
    const orgHub = source('src/components/org/OrgHub.tsx');
    const contextBar = source('src/components/org/LegalCaseContextBar.tsx');
    const assetTrace = source('src/components/org/LegalAssetTrace.tsx');
    const bidWorkbench = source('src/components/org/LegalBidWorkbench.tsx');
    const toolClient = source('src/lib/legalToolClient.ts');

    expect(legalHub).toContain('<LegalCaseContextBar');
    expect(legalHub).toContain('const toolCase = isWorkflowView ? activeCase : null');
    expect(legalHub).toContain('const toolAddMaterial = toolCase ? addMaterial : undefined');
    expect(legalHub).toContain("<LegalUsageModeProvider mode={isWorkflowView ? 'case' : 'standalone'}>");
    expect(legalHub).toContain("persistCase: false");
    expect(assetTrace).toContain("persistCase: false");
    expect(bidWorkbench).toContain("persistCase: false");
    expect(orgHub).not.toContain('LegalUsageMode');
    expect(orgHub).not.toContain('startIndustryWorkflow');
    expect(orgHub).toContain("sessionStorage.setItem('lumi_legal_industry_task'");
    expect(toolClient).toContain('ensureLegalIndustryTask');
    expect(toolClient).toContain("source: 'legal_tool_execution'");
    expect(contextBar).toContain("export type LegalToolState = 'input' | 'running' | 'result'");
    expect(contextBar).toContain("export type LegalUsageMode = 'standalone' | 'case'");
    expect(contextBar).toContain('copy.standaloneResultNotice');
    expect(contextBar).toContain('copy.usage');
    expect(contextBar).not.toContain('onModeChange');
    expect(contextBar).not.toContain('onSelectCase');
    expect(contextBar).toContain("uiMessage('legal-case-context-bar.closed.f9c16bb807')");
    expect(contextBar).not.toContain("ui('当前案件', 'Current case')");
    expect(toolClient).toContain("'lumi:org-legal-cases-changed'");
  });
});
