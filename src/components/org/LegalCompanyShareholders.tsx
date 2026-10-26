import React, { useLayoutEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, ChevronUp, Loader2, Search } from 'lucide-react';
import { mapQichachaCompanyRegistration, mapQichachaShareholders, pickQichachaResult, type CompanyShareholderFields } from '../../../shared/legal_company_info';
import { chinaLegalCopy } from '../../i18n/regions/cn/legal';
import { runLegalToolExecution } from '../../lib/legalToolClient';
import { useT } from '../../lib/useT';

type SourceResult = {
  sourceName?: string;
  sourceEndpoint?: string;
  sourceTool?: string;
  queriedAt?: string;
  subject?: string;
  sourceText?: string;
};

type ShareholderResult = {
  subject: string;
  rows: CompanyShareholderFields[];
  source?: SourceResult;
  originalText: string;
  reportText: string;
  complete: boolean;
};

function sourceLink(value?: string): string | undefined {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

export function LegalCompanyShareholders({ subjectName, disabled = false }: { subjectName: string; disabled?: boolean }) {
  const t = useT();
  const copy = chinaLegalCopy(t.langCode !== 'en' ? 'zh' : 'en').assetTraceWorkflow.directShareholders;
  const subject = subjectName.trim();
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShareholderResult | null>(null);
  const [error, setError] = useState('');
  const [showOriginal, setShowOriginal] = useState(false);

  useLayoutEffect(() => {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setResult(null);
    setError('');
    setShowOriginal(false);
    return () => { request.current?.abort(); request.current = null; };
  }, [subject]);

  const query = async () => {
    if (!subject || disabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setResult(null);
    setError('');
    setShowOriginal(false);
    try {
      const execution = await runLegalToolExecution('legal_company_database_lookup', {
        name: subject,
        queryType: 'shareholders',
        sourceIds: ['qichacha'],
        persistCase: false,
        confirmedForKb: false,
      }, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      const sources: SourceResult[] = Array.isArray(execution.receipt.sourceResults) ? execution.receipt.sourceResults : [];
      const source = sources.find(item => item.sourceTool === 'get_shareholder_info');
      const originalText = typeof source?.sourceText === 'string' ? source.sourceText : '';
      let rows: CompanyShareholderFields[] = [];
      let sourceSubject = source?.subject || subject;
      try {
        const record = pickQichachaResult(JSON.parse(originalText));
        rows = mapQichachaShareholders(record);
        sourceSubject = mapQichachaCompanyRegistration(record)?.name || sourceSubject;
      }
      catch { /* The complete source remains available when it is not structured JSON. */ }
      setResult({
        subject: sourceSubject,
        rows,
        source,
        originalText,
        reportText: execution.text,
        complete: execution.verification?.status === 'verified' && execution.receipt.ok !== false,
      });
    } catch (failure) {
      if (!controller.signal.aborted && request.current === controller) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  };

  const link = sourceLink(result?.source?.sourceEndpoint);
  return (
    <section className="min-w-0 rounded-lg border border-white/10 bg-white/[0.04] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white/85"><Building2 size={16} className="shrink-0 text-cyan-300" />{copy.title}</h3>
          <p className="mt-1 text-xs leading-5 text-white/45">{copy.description}</p>
        </div>
        <button type="button" onClick={() => void query()} disabled={disabled || busy || !subject} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100 transition hover:bg-cyan-500/20 disabled:opacity-40">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
          {busy ? copy.querying : copy.query}
        </button>
      </div>
      {error && <p role="alert" className="mt-4 whitespace-pre-wrap break-words rounded-lg border border-red-400/20 bg-red-400/[0.06] p-3 text-sm leading-6 text-red-100/85">{error}</p>}
      {result && (
        <div className="mt-4 min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <p className="min-w-0 break-words text-white/75">{copy.subject}: {result.subject}</p>
            <span className={result.complete ? 'text-emerald-200/75' : 'text-amber-200/75'}>{result.complete ? copy.received : copy.incomplete}</span>
          </div>
          {result.rows.length > 0 ? (
            <div className="min-w-0 overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-left text-sm">
                <caption className="px-3 py-2 text-left text-xs text-white/50">{copy.count.replace('{count}', String(result.rows.length))}</caption>
                <thead className="border-y border-white/10 bg-black/20 text-xs text-white/50"><tr><th scope="col" className="px-3 py-2 font-medium">{copy.name}</th><th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{copy.ratio}</th><th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{copy.shares}</th></tr></thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {result.rows.map((row, index) => <tr key={row.name + '-' + index}><td className="min-w-40 px-3 py-3 text-white/80">{row.name}</td><td className="whitespace-nowrap px-3 py-3 font-mono text-cyan-100/85">{row.ratio ?? copy.notProvided}</td><td className="whitespace-nowrap px-3 py-3 font-mono text-white/70">{row.shares ?? copy.notProvided}</td></tr>)}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm leading-6 text-white/50">{copy.noDetails}</p>}
          {result.source && <dl className="flex min-w-0 flex-wrap gap-x-6 gap-y-2 text-xs leading-5 text-white/50">
            {result.source.sourceName && <div><dt className="inline text-white/35">{copy.source}: </dt><dd className="inline">{result.source.sourceName}</dd></div>}
            {result.source.queriedAt && <div><dt className="inline text-white/35">{copy.queriedAt}: </dt><dd className="inline"><time dateTime={result.source.queriedAt}>{result.source.queriedAt}</time></dd></div>}
            {result.source.sourceEndpoint && <div className="min-w-0 basis-full break-all">{link ? <a href={link} target="_blank" rel="noopener noreferrer" className="text-cyan-200/75 underline underline-offset-2">{result.source.sourceEndpoint}</a> : result.source.sourceEndpoint}</div>}
          </dl>}
          {!result.complete && result.reportText && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-amber-400/15 bg-black/15 p-3 text-xs leading-6 text-white/70">{result.reportText}</pre>}
          <button type="button" aria-expanded={showOriginal} onClick={() => setShowOriginal(value => !value)} className="inline-flex items-center gap-2 text-xs text-cyan-200/75 hover:text-cyan-100">{showOriginal ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{copy.original}</button>
          {showOriginal && <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/20 p-3 text-xs leading-6 text-white/70">{result.originalText || result.reportText}</pre>}
        </div>
      )}
    </section>
  );
}
