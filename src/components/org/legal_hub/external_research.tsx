import React from 'react';
import { Upload } from 'lucide-react';
import { useT } from '../../../lib/useT';
import { chinaLegalCopy } from '../../../i18n/regions/cn/legal';
import { LegalCaseSearch } from '../LegalCaseSearch';
import { LegalImportView } from './material_import';
import { useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { useLegalDocument } from "../../../hooks/useLegalDocument";
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseDraftContext, legalCaseToolArgs } from './case_values';
import { LegalTwoPaneTool } from './two_pane_tool';

export function LegalExternalResearchView({
  caseFile,
  orgId,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
}) {
  const { text: facts, setText: setFacts, result, successfulResult, restoredResult, busy, generate: run } = useLegalDocument(legalCaseDraftContext(caseFile), { error: 'Error' }, { caseFile, toolName: 'legal_external_research_plan' });
  const [issues, setIssues] = useState(caseFile?.cause || '');
  const [companies, setCompanies] = useState(caseFile?.party || '');
  const loading = Boolean(busy);

  const generate = () => {
    if (!facts.trim() && !issues.trim() && !companies.trim()) return;
    return run(signal => runLegalTool('legal_external_research_plan', {
      ...legalCaseToolArgs(caseFile, orgId),
      facts,
      issues: issues.split(/[，,；;\n]/).map(item => item.trim()).filter(Boolean),
      companyNames: companies.split(/[，,；;\n]/).map(item => item.trim()).filter(Boolean),
    }, signal));
  };


  return (
    <LegalTwoPaneTool
      icon={<Search size={22} />}
      accent="cyan"
      title={uiMessage('legal-hub.semi-automated-external-research.a9fe50cd06')}
      desc={uiMessage('legal-hub.generate-search-terms-login-presets.497732dec9')}
      caseFile={caseFile}
      running={loading}
      left={(
        <>
          <input value={issues} onChange={event => setIssues(event.target.value)} placeholder={uiMessage('legal-hub.issues-comma-separated.f2f8ca4339')} className="lumi-field h-10 w-full rounded-lg" />
          <input value={companies} onChange={event => setCompanies(event.target.value)} placeholder={uiMessage('legal-hub.companies-debtors-comma-separated.052f39a297')} className="lumi-field mt-3 h-10 w-full rounded-lg" />
          <textarea value={facts} onChange={event => setFacts(event.target.value)} placeholder={uiMessage('legal-hub.facts-and-research-context.cd7839dce0')} className="mt-3 min-h-[340px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-cyan-400/35" />
          <button onClick={generate} disabled={loading || (!facts.trim() && !issues.trim() && !companies.trim())} className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/15 px-4 py-2.5 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:opacity-50">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            {loading ? uiMessage('legal-hub.generating.634308f29b') : uiMessage('legal-hub.generate-plan.6825d94075')}
          </button>
        </>
      )}
      result={result}
      successfulResult={successfulResult}
      restoredResult={restoredResult}
      emptyText={uiMessage('legal-hub.external-research-plan-will-appear.701d667eed')}
    />
  );
}

type LegalResearchTab = 'case-search' | 'external-research' | 'import';
export function LegalResearchWorkspace({ orgId }: { orgId?: string }) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const workspaceCopy = chinaLegalCopy(isZh ? 'zh' : 'en').workspace;
  const [tab, setTab] = useState<LegalResearchTab>('case-search');
  const tabs: Array<{ id: LegalResearchTab; label: string; icon: React.ReactNode }> = [
    { id: 'case-search', label: t.legalCaseSearch, icon: <Search size={14} /> },
    { id: 'external-research', label: uiMessage('legal-hub.research.fd18b45d25'), icon: <Search size={14} /> },
    { id: 'import', label: t.legalImportJudgment, icon: <Upload size={14} /> },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-white/[0.08] bg-black/16 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="mr-1 text-[10px] font-black uppercase tracking-[0.14em] text-white/30">
            {workspaceCopy.legalResearch}
          </span>
          {tabs.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition ${tab === item.id ? 'border-blue-400/25 bg-blue-500/12 text-blue-100' : 'border-white/[0.08] bg-white/[0.035] text-white/45 hover:bg-white/[0.07] hover:text-white/75'}`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'case-search' && <LegalCaseSearch />}
        {tab === 'external-research' && <LegalExternalResearchView caseFile={null} orgId={orgId} />}
        {tab === 'import' && <LegalImportView caseFile={null} orgId={orgId} />}
      </div>
    </div>
  );
}