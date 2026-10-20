import { useState } from 'react';
import { chinaLegalCopy } from '../../../i18n/regions/cn/legal';
import { Brain, Loader2 } from "lucide-react";
import { useT } from "../../../lib/useT";
import { useLegalDocument, useLegalDocumentScope } from "../../../hooks/useLegalDocument";
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseDraftContext, legalCaseToolArgs } from './case_values';
import { LegalTwoPaneTool } from './two_pane_tool';

type StrategyTool = 'legal_case_strategy' | 'legal_case_reasoning_matrix';
type StrategyProps = { caseFile?: LegalCaseFile | null; orgId?: string };
export function LegalStrategyView({ caseFile, orgId }: StrategyProps) {
  const scope = useLegalDocumentScope(caseFile?.id, orgId);
  const [tool, setTool] = useState<StrategyTool>('legal_case_strategy');
  const copy = chinaLegalCopy(useT().langCode === 'en' ? 'en' : 'zh').workspace;
  return <div className="flex h-full min-h-0 flex-col">
    <details className="border-b border-white/10 px-6 py-3 text-xs text-white/65">
      <summary className="cursor-pointer">{copy.advancedOptions}</summary>
      <label className="mt-3 flex flex-wrap items-center gap-3">
      <span>{copy.toolMode}</span>
      <select aria-label={copy.toolMode} value={tool} onChange={event => setTool(event.target.value as StrategyTool)} className="lumi-field h-9 min-w-48 rounded-lg">
        <option value="legal_case_strategy">{copy.strategyAnalysis}</option>
        <option value="legal_case_reasoning_matrix">{uiMessage('legal-hub.reasoning-matrix.7e54736217')}</option>
      </select>
      </label>
    </details>
    <div className="min-h-0 flex-1"><LegalStrategyForm key={scope + tool} caseFile={caseFile} orgId={orgId} tool={tool} /></div>
  </div>;
}
function LegalStrategyForm({ caseFile, orgId, tool }: StrategyProps & { tool: StrategyTool }) {
  const t = useT();
  const copy = chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace;
  const { text: facts, setText: setFacts, result, successfulResult, restoredResult, busy, generate } = useLegalDocument(legalCaseDraftContext(caseFile), { error: 'Error' }, { caseFile, toolName: tool });
  const loading = Boolean(busy);

  const analyze = () => {
    if (!facts.trim()) return;
    return generate(signal => runLegalTool(tool, { ...legalCaseToolArgs(caseFile, orgId), facts, ...(tool === 'legal_case_reasoning_matrix' ? { materials: facts, writeFiles: true } : {}) }, signal));
  };

  return (
    <LegalTwoPaneTool
      icon={<Brain size={22} />}
      accent="amber"
      title={tool === 'legal_case_reasoning_matrix' ? uiMessage('legal-hub.reasoning-matrix.7e54736217') : copy.strategyAnalysis}
      desc={t.legalCaseStrategyDesc}
      caseFile={caseFile}
      running={loading}
      left={(
        <div className="flex min-h-0 flex-col">
          <label className="mb-2 text-sm font-medium text-white">{uiMessage('legal-hub.case-facts.a83dee9a30')}</label>
          <textarea
            value={facts}
            onChange={e => setFacts(e.target.value)}
            placeholder={t.legalCaseStrategyPlaceholder}
            className="min-h-[360px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35"
          />
          <button
            onClick={analyze}
            disabled={loading || !facts.trim()}
            className="mt-3 inline-flex items-center justify-center gap-2 self-end rounded-lg border border-amber-400/20 bg-amber-500/15 px-4 py-2.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Brain size={16} />}
            {loading ? uiMessage('legal-hub.analyzing.3b98929aff') : tool === 'legal_case_reasoning_matrix' ? uiMessage('legal-hub.reasoning-matrix.7e54736217') : t.legalCaseStrategyAnalyze}
          </button>
        </div>
      )}
      result={result}
      successfulResult={successfulResult}
      restoredResult={restoredResult}
      emptyText={uiMessage('legal-hub.strategy-analysis-will-appear-here.61c7ee7a79')}
    />
  );
}
