import { useState } from 'react';
import { chinaLegalCopy, inferChinaLegalDocumentType } from '../../../i18n/regions/cn/legal';
import { CHINA_LEGAL_WORKSPACE_COPY } from '../../../i18n/regions/cn/legalWorkspace';
import { CheckCircle, Loader2 } from "lucide-react";
import { useT } from "../../../lib/useT";
import { useLegalDocument, useLegalDocumentScope } from "../../../hooks/useLegalDocument";
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile, LegalCaseMaterial } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseToolArgs, legalCaseTitle } from './case_values';
import { LegalTwoPaneTool } from './two_pane_tool';

type VerifyTool = 'legal_verify_citation' | 'legal_finalize_delivery_package';
type VerifyProps = { caseFile?: LegalCaseFile | null; orgId?: string; onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => boolean | Promise<boolean> };
export function LegalVerifyView({ caseFile, orgId, onAddMaterial }: VerifyProps) {
  const scope = useLegalDocumentScope(caseFile?.id, orgId);
  const [tool, setTool] = useState<VerifyTool>('legal_finalize_delivery_package');
  const t = useT();
  const copy = chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace;
  const initialMaterial = caseFile?.materials.find(material => material.content && (material.type === 'pleading' || material.type === 'contract'));
  const [selectedId, setSelectedId] = useState(initialMaterial?.id || '');
  const materialId = selectedId && !caseFile?.materials.some(material => material.id === selectedId) ? '' : selectedId;
  const sourceId = tool === 'legal_finalize_delivery_package' ? materialId : initialMaterial?.id || '';
  return <div className="flex h-full min-h-0 flex-col">
    <details className="border-b border-white/10 px-6 py-3 text-xs text-white/65">
      <summary className="cursor-pointer">{copy.advancedOptions}</summary>
      <label className="mt-3 flex flex-wrap items-center gap-3">
      <span>{copy.toolMode}</span>
      <select aria-label={copy.toolMode} value={tool} onChange={event => setTool(event.target.value as VerifyTool)} className="lumi-field h-9 min-w-48 rounded-lg">
        <option value="legal_verify_citation">{copy.citationOnly}</option>
        <option value="legal_finalize_delivery_package">{copy.documentCheck}</option>
      </select>
      </label>
    </details>
          {tool === 'legal_finalize_delivery_package' && <label className="mb-3 space-y-1.5 text-xs text-white/65">
            <span>{copy.documentSource}</span>
            <select aria-label={copy.documentSource} value={materialId} onChange={event => { const id = event.target.value; setSelectedId(id); }} className="lumi-field h-9 w-full rounded-lg">
              <option value="">{copy.customText}</option>
              {(caseFile?.materials || []).filter(material => material.content).map(material => <option key={material.id} value={material.id}>{material.title}</option>)}
            </select>
          </label>}
    <div className="min-h-0 flex-1"><LegalVerifyForm key={scope + tool + (tool === 'legal_finalize_delivery_package' ? sourceId : '')} caseFile={caseFile} orgId={orgId} onAddMaterial={onAddMaterial} tool={tool} materialId={sourceId} /></div>
  </div>;
}
function LegalVerifyForm({ caseFile, orgId, onAddMaterial, tool, materialId }: VerifyProps & { tool: VerifyTool; materialId: string }) {
  const t = useT();
  const copy = chinaLegalCopy(t.langCode === 'en' ? 'en' : 'zh').workspace;
  const selectedMaterial = caseFile?.materials.find(material => material.id === materialId);
  const formal = tool === 'legal_finalize_delivery_package';
  const { text, setText, result, successfulResult, restoredResult, busy, save, generate } = useLegalDocument(selectedMaterial?.content || '', { error: 'Error' }, { caseFile, toolName: tool });
  const loading = Boolean(busy);

  const verify = () => {
    if (!text.trim()) return;
    return generate(signal => runLegalTool(tool, { ...legalCaseToolArgs(caseFile, orgId), ...(formal ? { content: text, documentType: inferChinaLegalDocumentType(selectedMaterial?.title || '', selectedMaterial?.type), includeDocx: true, includePdf: false } : { text }) }, signal));
  };

  return (
    <LegalTwoPaneTool
      icon={<CheckCircle size={22} />}
      accent="emerald"
      title={formal ? copy.documentCheck : t.legalVerifyCitationTitle}
      desc={formal ? copy.documentCheckDesc : t.legalVerifyCitationDesc}
      caseFile={caseFile}
      running={loading}
      left={(
        <div className="flex min-h-0 flex-col">

          <label className="mb-2 text-sm font-medium text-white">{uiMessage('legal-hub.text-to-verify.e83f5c99d9')}</label>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={t.legalVerifyCitationPlaceholder}
            className="min-h-[340px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-emerald-400/35"
          />
          <button
            onClick={verify}
            disabled={loading || !text.trim()}
            className="mt-3 inline-flex items-center justify-center gap-2 self-end rounded-lg border border-emerald-400/20 bg-emerald-500/15 px-4 py-2.5 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
            {loading ? uiMessage('legal-hub.verifying.1c01a1f8ae') : formal ? copy.documentCheck : t.legalVerifyCitationVerify}
          </button>
        </div>
      )}
      result={result}
      successfulResult={successfulResult}
      restoredResult={restoredResult}
      emptyText={uiMessage('legal-hub.citation-verification-results-will-appear.7fa754234b')}
      archiveLabel={uiMessage('legal-hub.archive-to-case.6dc41a223d')}
      onArchive={!formal && successfulResult && onAddMaterial ? () => save(() => onAddMaterial('note', CHINA_LEGAL_WORKSPACE_COPY.verificationTitle(legalCaseTitle(caseFile)), successfulResult, 'tool')) : undefined}
    />
  );
}
