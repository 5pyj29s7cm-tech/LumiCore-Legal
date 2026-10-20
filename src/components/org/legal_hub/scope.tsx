import { desktopWorkflowCopy } from '../../../i18n/locales/desktopWorkflows';
import { chinaLegalCopy } from '../../../i18n/regions/cn/legal';
import { LegalResearchWorkspace } from './external_research';
import { LegalUsageModeProvider } from '../LegalCaseContextBar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Scale, FileText, Search, Crosshair, Shield, Brain, CheckCircle, Upload, ClipboardList, FolderOpen, ArrowRight, Archive } from "lucide-react";
import { toast } from "sonner";
import { LegalBidWorkbench } from "../LegalBidWorkbench";
import { LegalCaseSearch } from "../LegalCaseSearch";
import { LegalAssetTrace } from "../LegalAssetTrace";
import { LegalContractReview } from "../LegalContractReview";
import { useT } from "../../../lib/useT";
import { useApp } from "../../../contexts/AppContext";
import { useLegalDocument } from "../../../hooks/useLegalDocument";
import { apiJson } from "../../../services/apiClient";
import { refreshPersonalLegalCasesFromRuntime, isLegalCaseAccount, syncPersonalLegalCaseToRuntime, mergePersonalLegalCaseRuntimeSnapshot, deletePersonalLegalCaseFromRuntime, addLegalCaseMaterial, clearLegalConsultationCaseId, createEmptyLegalCase, getActiveLegalCaseId, getLegalConsultationCaseId, LEGAL_CASES_CHANGED_EVENT, readLegalCaseFiles, setActiveLegalCaseId, updateLegalCase, writeLegalCaseFiles, type LegalCaseFile, type LegalCaseMaterial } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import type { LegalView, NavItem, LegalCaseCreateInput } from './contracts';
import { resolveLegalCaseActiveId, legalCaseTitle } from './case_values';
import { LegalCaseWorkspace } from './workspace';
import { LegalPacketView } from './packet';
import { LegalExternalResearchView } from './external_research';
import { LegalStrategyView } from './strategy';
import { LegalVerifyView } from './verification';
import { LegalImportView } from './material_import';
import { LegalKnowledgeSyncView } from './knowledge_sync';
import { LegalCaseCreateDialog, LegalCaseDeleteDialog } from './case_dialogs';

export function LegalHubScope({ initialView = 'workspace', workspaceResetKey = 0 }: { initialView?: LegalView; workspaceResetKey?: number }) {
  const { user, workDomain, orgConnection } = useApp();
  const [view, setView] = useState<LegalView>(initialView);
  useEffect(() => setView(initialView), [initialView, workspaceResetKey]);
  const [caseFilter, setCaseFilter] = useState('');
  const [cases, setCases] = useState<LegalCaseFile[]>(() => workDomain === 'work' ? [] : readLegalCaseFiles());
  const [activeCaseId, setActiveCaseIdState] = useState(() => getActiveLegalCaseId());
  const [orgCasesLoading, setOrgCasesLoading] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LegalCaseFile | null>(null);
  const mutation = useLegalDocument('', { error: uiMessage('legal-hub.failed-to-save-case.90f7d722b2') });
  const lifetime = useRef<AbortController | null>(null);
  const reading = useRef<AbortController | null>(null);
  const writing = useRef<Promise<void> | null>(null);
  const pendingEdit = useRef<{ id: string; patch: Partial<LegalCaseFile>; result: Promise<boolean> } | null>(null);
  const confirmedCases = useRef(cases);
  const t = useT();
  const useOrgCases = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
  const canDeleteCases = !useOrgCases || ['owner', 'admin'].includes(String(orgConnection?.orgRole || '').toLowerCase());
  const isCurrent = () => isLegalCaseAccount(user?.uid) && !lifetime.current?.signal.aborted;

  const refreshCases = useCallback(async (readRuntime = true) => {
    if (!lifetime.current || !isCurrent()) return;
    if (!useOrgCases && (workDomain === 'work' || !readRuntime)) {
      const loaded = workDomain === 'work' ? [] : readLegalCaseFiles();
      setCases(loaded);
      setActiveCaseIdState(prev => resolveLegalCaseActiveId(loaded, prev || getActiveLegalCaseId()));
      return;
    }
    reading.current?.abort();
    const request = new AbortController();
    reading.current = request;
    setOrgCasesLoading(true);
    try {
      if (writing.current) await writing.current;
      if (request.signal.aborted || !isCurrent()) return;
      const loaded = useOrgCases
        ? (await apiJson('/api/org/legal/cases', { signal: request.signal })).cases
        : await refreshPersonalLegalCasesFromRuntime(request.signal);
      if (request.signal.aborted || !isCurrent()) return;
      const snapshot = Array.isArray(loaded) ? loaded : [];
      confirmedCases.current = snapshot;
      setCases(snapshot);
      setActiveCaseIdState(prev => resolveLegalCaseActiveId(snapshot, prev || getActiveLegalCaseId()));
    } catch (err: any) {
      if (!request.signal.aborted && isCurrent()) toast.error(err?.message || uiMessage('token-dashboard.failed-to-load.1131733383'));
    } finally {
      if (!request.signal.aborted && isCurrent()) setOrgCasesLoading(false);
    }
  }, [useOrgCases, workDomain, user?.uid]);

  useEffect(() => {
    const owner = new AbortController();
    lifetime.current = owner;
    const eventName = useOrgCases ? 'lumi:org-legal-cases-changed' : LEGAL_CASES_CHANGED_EVENT;
    const refreshCache = () => { void refreshCases(useOrgCases); };
    const refreshRuntime = () => { void refreshCases(); };
    const syncStorage = (event: StorageEvent) => {
      if (!useOrgCases && (!event.key || event.key.startsWith('lumi_legal_'))) refreshCache();
    };
    refreshRuntime();
    window.addEventListener(eventName, refreshCache);
    window.addEventListener('storage', syncStorage);
    window.addEventListener('focus', refreshRuntime);
    return () => {
      owner.abort();
      reading.current?.abort();
      window.removeEventListener(eventName, refreshCache);
      window.removeEventListener('storage', syncStorage);
      window.removeEventListener('focus', refreshRuntime);
    };
  }, [refreshCases, useOrgCases]);

  const scopedRequest = async <T,>(url: string, body: unknown, method = 'POST', requestSignal?: AbortSignal) => {
    const owner = lifetime.current?.signal;
    if (!owner || !isCurrent()) throw new DOMException('View closed', 'AbortError');
    const signal = AbortSignal.any([owner, AbortSignal.timeout(15_000), ...(requestSignal ? [requestSignal] : [])]);
    const data = await apiJson<T>(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal,
    });
    signal.throwIfAborted();
    if (!isCurrent()) throw new DOMException('View closed', 'AbortError');
    return data;
  };
  const reportFailure = (error: any, fallback: string) => {
    if (isCurrent()) toast.error(error?.message || fallback);
  };
  const writeOrgCase = <T,>(path: string, method: string, body: unknown, apply: (current: LegalCaseFile[], data: T) => LegalCaseFile[], base = '/api/org/legal/cases', requestSignal?: AbortSignal) => {
    pendingEdit.current = null;
    const signal = lifetime.current?.signal;
    reading.current?.abort();
    setOrgCasesLoading(false);
    const execute = async () => {
      if (pendingEdit.current?.patch === body) pendingEdit.current = null;
      if (!signal || signal.aborted) throw new DOMException('View closed', 'AbortError');
      const data = await scopedRequest<T>(`${base}${path}`, body, method, requestSignal);
      signal.throwIfAborted();
      const receipt = data as { id?: string; success?: boolean };
      if (method === 'DELETE' ? receipt?.success !== true : !receipt?.id) throw new Error(uiMessage('legal-hub.failed-to-save-case.90f7d722b2'));
      confirmedCases.current = apply(confirmedCases.current, data);
      return data;
    };
    const result = writing.current ? writing.current.then(execute) : execute();
    const settled = result.then(() => {}, () => {}).then(() => {
      if (writing.current !== settled) return;
      writing.current = null;
      if (!signal?.aborted) setCases(confirmedCases.current);
    });
    writing.current = settled;
    return result;
  };

  const navItems: NavItem[] = useMemo(() => [
    { id: 'workspace', label: chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace.caseOverview, icon: <FolderOpen size={16} /> },
    { id: 'import', label: t.legalImportJudgment, icon: <Upload size={16} /> },
    { id: 'external-research', label: uiMessage('legal-hub.research.fd18b45d25'), icon: <Search size={16} /> },
    { id: 'case-search', label: t.legalCaseSearch, icon: <Search size={16} /> },
    { id: 'asset-trace', label: t.legalAssetTrace, icon: <Crosshair size={16} /> },
    { id: 'contract-review', label: t.legalContractReview, icon: <Shield size={16} /> },
    { id: 'strategy', label: chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace.strategyAnalysis, icon: <Brain size={16} /> },
    { id: 'packet', label: uiMessage('legal-hub.packet.1758eaea66'), icon: <ClipboardList size={16} /> },
    { id: 'verify', label: chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace.documentCheck, icon: <CheckCircle size={16} /> },
    { id: 'knowledge-sync', label: uiMessage('legal-hub.sync-to-kb.f5314698c5'), icon: <Archive size={16} /> },
    { id: 'bid', label: t.legalBidWorkbench, icon: <FileText size={16} /> },
  ], [t]);

  const workflowNavItems = useMemo(() => navItems.filter(item => item.id !== 'bid'), [navItems]);

  const activeCase = useMemo(() => {
    return cases.find(item => item.id === activeCaseId) || cases[0] || null;
  }, [activeCaseId, cases]);
  useEffect(() => {
    if (useOrgCases || workDomain === 'work' || !activeCase || !isCurrent()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void syncPersonalLegalCaseToRuntime(activeCase, controller.signal).catch(error => {
      if (!controller.signal.aborted && isCurrent()) toast.error(error?.message || uiMessage('legal-hub.failed-to-save-case.90f7d722b2'));
    }); }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [activeCase, useOrgCases, workDomain, user?.uid]);
  const workflowStepIndex = workflowNavItems.findIndex(item => item.id === view);
  const isWorkflowView = initialView === 'workspace' && workflowStepIndex >= 0;
  const toolCase = isWorkflowView ? activeCase : null;
  const currentStep = navItems.find(item => item.id === view);
  const legalOrgId = useOrgCases ? orgConnection?.orgId : undefined;

  const createCase = (input: LegalCaseCreateInput) => mutation.save(async () => {
    if (!isCurrent()) return false;
    const nextCase = {
      ...createEmptyLegalCase(),
      ...input,
      title: input.title.trim() || input.party.trim() || input.caseNumber.trim() || uiMessage('legal-hub.untitled-case.796e2578d9'),
    };
    if (useOrgCases) {
      const data = await writeOrgCase<LegalCaseFile>('', 'POST', nextCase, (current, created) => [created, ...current]);
      setActiveCaseIdState(data.id);
      setActiveLegalCaseId(data.id);
    } else {
      writeLegalCaseFiles([nextCase, ...readLegalCaseFiles()], nextCase.id);
    }
    setCreateDialogOpen(false);
    setView('workspace');
    return true;
  }, uiMessage('legal-hub.case-file-created.24082b4003'));

  const deleteCase = () => mutation.save(async () => {
    if (!isCurrent() || !deleteTarget) return false;
    if (useOrgCases) {
      await writeOrgCase(`/${encodeURIComponent(deleteTarget.id)}`, 'DELETE', undefined, current => current.filter(item => item.id !== deleteTarget.id));
      const nextActiveId = resolveLegalCaseActiveId(confirmedCases.current, getActiveLegalCaseId());
      setActiveCaseIdState(nextActiveId);
      setActiveLegalCaseId(nextActiveId);
    } else {
      await deletePersonalLegalCaseFromRuntime(deleteTarget.id, lifetime.current?.signal);
      if (!isCurrent()) return false;
      const next = readLegalCaseFiles().filter(item => item.id !== deleteTarget.id);
      writeLegalCaseFiles(next, resolveLegalCaseActiveId(next, getActiveLegalCaseId()));
    }
    if (getLegalConsultationCaseId() === deleteTarget.id) clearLegalConsultationCaseId();
    setDeleteTarget(null);
    setView('workspace');
    return true;
  }, uiMessage('legal-hub.case-deleted.6afeed7983'));

  const updateCase = (id: string, patch: Partial<LegalCaseFile>) => {
    if (!isCurrent()) return false;
    if (!useOrgCases) return Boolean(updateLegalCase(id, patch));
    setCases(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (pendingEdit.current?.id === id) {
      Object.assign(pendingEdit.current.patch, patch);
      return pendingEdit.current.result;
    }
    const queued = Boolean(writing.current);
    const result = writeOrgCase<LegalCaseFile>(`/${encodeURIComponent(id)}`, 'PUT', patch, (current, saved) => current.map(item => item.id === id ? saved : item))
      .then(() => true).catch(error => { reportFailure(error, uiMessage('legal-hub.failed-to-save-case.90f7d722b2')); return false; });
    if (queued) pendingEdit.current = { id, patch, result };
    return result;
  };

  const removeMaterial = async (caseId: string, materialId: string, expectedRevision: string, signal: AbortSignal) => {
    const path = '/' + encodeURIComponent(caseId) + '/materials/' + encodeURIComponent(materialId);
    type Receipt = { success: boolean; caseId: string; materialId: string; case: LegalCaseFile };
    const validate = (data: Receipt) => {
      if (data?.success !== true || data.caseId !== caseId || data.materialId !== materialId || data.case?.id !== caseId
        || !data.case.removedMaterialIds?.includes(materialId) || data.case.materials.some(item => item.id === materialId)) throw new Error('Invalid material removal receipt');
      return data.case;
    };
    if (useOrgCases) await writeOrgCase<Receipt>(path, 'DELETE', { expectedRevision },
      (current, data) => current.map(item => item.id === caseId ? validate(data) : item), '/api/legal/cases', signal);
    else {
      const data = await scopedRequest<Receipt>('/api/legal/cases' + path, { expectedRevision }, 'DELETE', signal);
      mergePersonalLegalCaseRuntimeSnapshot(validate(data));
    }
    return true;
  };

  const addMaterial = (type: LegalCaseMaterial['type'], title: string, content?: string, source: LegalCaseMaterial['source'] = 'manual') => {
    if (!isCurrent()) return false;
    if (!activeCase) {
      toast.info(uiMessage('legal-hub.create-a-case-file-first.a26c342dec'));
      return false;
    }
    if (!useOrgCases) return Boolean(addLegalCaseMaterial(activeCase.id, { type, title, content, source }));
    return writeOrgCase<LegalCaseMaterial>(`/${encodeURIComponent(activeCase.id)}/materials`, 'POST', { type, title, content, source }, (current, material) => current.map(item => item.id === activeCase.id ? {
      ...item, materials: [material, ...(item.materials || [])],
    } : item)).then(() => true).catch(error => { reportFailure(error, uiMessage('legal-hub.failed-to-archive-material.4ed52ef083')); return false; });
  };

  const createReminder = async (content: string, dueAt?: string) => {
    try {
      await scopedRequest('/api/reminders', { content, dueAt: dueAt ? `${dueAt}T09:00:00` : null });
      toast.success(uiMessage('legal-hub.reminder-added.5dba21bd39'));
    } catch (err: any) {
      reportFailure(err, uiMessage('legal-hub.failed-to-create-reminder.880d5a66e2'));
    }
  };

  const createCasePlan = async () => {
    if (!activeCase) {
      toast.info(uiMessage('legal-hub.create-a-case-file-first.a26c342dec'));
      return;
    }
    const title = `${uiMessage('legal-hub.case-plan.66f8396b22')}: ${activeCase.title || activeCase.party || activeCase.caseNumber || activeCase.id}`;
    try {
      await scopedRequest('/api/plans', {
        title,
        description: activeCase.notes || activeCase.cause || '',
        tags: ['legal', activeCase.stage, activeCase.cause].filter(Boolean),
        source: 'user',
        priority: activeCase.stage === 'trial' || activeCase.stage === 'judgment' ? 'high' : 'medium',
        steps: [
          { title: uiMessage('legal-hub.organize-party-statements-and-evidence.dd4cfb3b29'), description: activeCase.notes || '' },
          { title: uiMessage('legal-hub.search-similar-cases-and-identify.bc6a84e94c'), description: activeCase.cause || '' },
          { title: uiMessage('legal-hub.draft-documents-for-lawyer-review.8ad498dd83'), description: activeCase.caseNumber || '' },
        ],
      });
      toast.success(uiMessage('legal-hub.case-plan-created.2289f19321'));
      window.dispatchEvent(new CustomEvent('lumi:client-action', { detail: { action: 'open_plans' } }));
    } catch (err: any) {
      reportFailure(err, uiMessage('legal-hub.failed-to-create-case-plan.c0b35de7a9'));
    }
  };

  const startConsultation = () => {
    if (!isCurrent()) return;
    if (!activeCase) {
      toast.info(uiMessage('legal-hub.create-a-case-file-first.a26c342dec'));
      return;
    }
    window.dispatchEvent(new CustomEvent('lumi:request-meeting-mode', {
      detail: {
        action: 'start_meeting_mode',
        confirmed: true,
        legalCaseId: activeCase.id,
        legalCaseTitle: activeCase.title || activeCase.party || activeCase.caseNumber || uiMessage('legal-hub.untitled-case.796e2578d9'),
        respond: () => { if (!lifetime.current?.signal.aborted) toast.success(desktopWorkflowCopy().meetingWorkspace.readyHint); },
        reject: (message: string) => {
          if (lifetime.current?.signal.aborted) return;
          clearLegalConsultationCaseId();
          toast.error(message || uiMessage('legal-hub.failed-to-start-consultation-capture.99681efb6d'));
        },
      },
    }));
  };

  const openMeetingNotes = () => {
    window.dispatchEvent(new CustomEvent('lumi:client-action', {
      detail: { action: 'open_meeting_notes', respond: () => {} },
    }));
  };

  const toolAddMaterial = toolCase ? addMaterial : undefined;
  const renderView = () => {
    switch (view) {
      case 'research': return <LegalResearchWorkspace orgId={legalOrgId} />;
      case 'workspace':
        return (
          <LegalCaseWorkspace
            key={activeCase?.id}
            caseFilter={caseFilter}
            setCaseFilter={setCaseFilter}
            cases={cases}
            activeCase={activeCase}
            onCreateCase={() => setCreateDialogOpen(true)}
            onDeleteCase={setDeleteTarget}
            onSelectCase={(id) => {
              if (!isCurrent()) return;
              setActiveCaseIdState(id);
              setActiveLegalCaseId(id);
            }}
            onUpdateCase={updateCase}
            onSetView={setView}
            onStartConsultation={startConsultation}
            onOpenMeetingNotes={openMeetingNotes}
            onCreateReminder={createReminder}
            onCreatePlan={createCasePlan}
            onAddMaterial={addMaterial}
            onRemoveMaterial={!useOrgCases || ['owner', 'admin', 'member'].includes(String(orgConnection?.orgRole || '')) ? removeMaterial : undefined}
            onRefreshCases={refreshCases}
            orgBacked={useOrgCases}
            canDeleteCases={canDeleteCases}
            orgId={legalOrgId}
            refreshing={orgCasesLoading}
          />
      );
      case 'packet': return <LegalPacketView key={activeCase?.id} caseFile={toolCase} orgId={legalOrgId} />;
      case 'external-research': return <LegalExternalResearchView key={activeCase?.id} caseFile={toolCase} orgId={legalOrgId} />;
      case 'bid': return <LegalBidWorkbench caseFile={toolCase} orgId={legalOrgId} />;
      case 'case-search': return <LegalCaseSearch caseFile={toolCase} onAddMaterial={toolAddMaterial} />;
      case 'asset-trace': return <LegalAssetTrace caseFile={toolCase} orgId={legalOrgId} onAddMaterial={toolAddMaterial} onUpdateCase={toolCase ? patch => { void updateCase(toolCase.id, patch); } : undefined} />;
      case 'contract-review': return <LegalContractReview caseFile={toolCase} />;
      case 'strategy': return <LegalStrategyView key={activeCase?.id} caseFile={toolCase} orgId={legalOrgId} />;
      case 'verify': return <LegalVerifyView key={activeCase?.id} caseFile={toolCase} orgId={legalOrgId} onAddMaterial={toolAddMaterial} />;
      case 'import': return <LegalImportView key={activeCase?.id} caseFile={toolCase} orgId={legalOrgId} onAddMaterial={toolAddMaterial} />;
      case 'knowledge-sync': return <LegalKnowledgeSyncView key={activeCase?.id} caseFile={toolCase} />;
      default: return <LegalCaseSearch />;
    }
  };

  return (
    <>
      <div data-organization-wallpaper-module="legal" className="lumi-org-module-shell lumi-legal-workbench flex h-full">
      <div data-wallpaper-tool="organization-module-workspace" className="lumi-org-module-workspace lumi-legal-workspace flex min-w-0 flex-1 flex-col bg-black/10">
        <div data-wallpaper-tool="organization-module-context" className="lumi-legal-context border-b border-white/[0.08] bg-black/25 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-amber-200/70">
                <span>
                  {isWorkflowView
                    ? chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace.caseFlow
                    : uiMessage('legal-hub.legal-special-tool.53e70e4ac3')}
                </span>
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-2 text-sm text-white/70">
                <span className="truncate font-semibold text-white/85">
                  {isWorkflowView ? legalCaseTitle(activeCase) : chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace.standalone}
                </span>
                <span className="text-white/25">&rarr;</span>
                <span className="truncate">{currentStep?.label}</span>
                {isWorkflowView && (
                  <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/40">
                    {(activeCase?.materials || []).length} {uiMessage('legal-hub.materials.e065db1968')}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('lumi:client-action', { detail: { action: 'open_chat' } }))}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-500/10 px-3 text-xs font-bold text-cyan-100 transition hover:bg-cyan-500/18"
            >
              <span>{uiMessage('legal-hub.ask-lumi-in-work-workspace.6fe76d2092')}</span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
        {isWorkflowView && (
          <div className="min-w-0 max-w-full border-b border-white/[0.08] bg-black/20 px-4 py-2.5">
            <nav aria-label={chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace.caseFlow} className="custom-scrollbar flex min-w-0 max-w-full items-center gap-2 overflow-x-auto overscroll-x-contain pb-0.5">
              <span className="mr-1 shrink-0 text-[10px] font-black uppercase tracking-[0.14em] text-white/30">
                {chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace.caseFlow}
              </span>
              {workflowNavItems.map(item => {
                const active = view === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-label={item.label}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setView(item.id)}
                    className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition ${active ? 'border-amber-400/25 bg-amber-500/12 text-amber-100' : 'border-white/[0.08] bg-white/[0.035] text-white/45 hover:bg-white/[0.07] hover:text-white/75'}`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <p className="mt-1.5 text-xs leading-5 text-white/45">{chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace.navigationHint}</p>
          </div>
        )}
        <div className="lumi-org-module-scroll lumi-legal-content custom-scrollbar min-h-0 flex-1 overflow-y-auto">
          <LegalUsageModeProvider mode={isWorkflowView ? 'case' : 'standalone'}>{renderView()}</LegalUsageModeProvider>
        </div>
      </div>
      </div>
      {createDialogOpen && (
        <LegalCaseCreateDialog
          busy={Boolean(mutation.busy)}
          onClose={() => !mutation.busy && setCreateDialogOpen(false)}
          onSubmit={createCase}
        />
      )}
      {deleteTarget && (
        <LegalCaseDeleteDialog
          caseFile={deleteTarget}
          busy={Boolean(mutation.busy)}
          onClose={() => !mutation.busy && setDeleteTarget(null)}
          onConfirm={deleteCase}
        />
      )}
    </>
  );
}

