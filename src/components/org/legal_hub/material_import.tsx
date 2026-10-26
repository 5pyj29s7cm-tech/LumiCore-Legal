import { useRef, useState } from 'react';
import { Upload, Loader2 } from "lucide-react";
import { useT } from "../../../lib/useT";
import { useLegalDocument, useLegalDocumentScope } from "../../../hooks/useLegalDocument";
import { useFileDrop } from '../../../hooks/useFileDrop';
import { fileImportCopy, materialImportCopy } from '../../../i18n/locales/fileImport';
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseToolArgs } from './case_values';
import { LegalTwoPaneTool } from './two_pane_tool';

type Props = {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
};

export function LegalImportView(props: Props) {
  return <LegalImportDocument key={useLegalDocumentScope(props.caseFile?.id, props.orgId)} {...props} />;
}

function LegalImportDocument({
  caseFile,
  orgId,
}: Props) {
  const t = useT();
  const language = t.langCode === 'en' ? 'en' : 'zh';
  const copy = fileImportCopy[language];
  const materialCopy = materialImportCopy[language];
  const [materialType, setMaterialType] = useState('case_material');
  const historical = caseFile?.workflowRuns?.find(run => run.tool === 'legal_import_materials_to_kb' || run.tool === 'legal_import_judgment');
  const { text: content, setText: setContent, result, successfulResult, restoredResult, busy, upload, generate } = useLegalDocument('', { error: 'Error' }, { caseFile, toolName: historical?.tool || 'legal_import_materials_to_kb' });
  const loading = Boolean(busy);
  const fileRef = useRef<HTMLInputElement>(null);
  const drop = useFileDrop(source => upload(source), loading);

  const importMaterials = () => {
    if (!content.trim()) return;
    const title = content.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(/^#{1,6}\s+/, '') || materialCopy.defaultTitle;
    return generate(signal => runLegalTool('legal_import_materials_to_kb', {
      ...legalCaseToolArgs(caseFile, orgId),
      title,
      materialType,
      content,
    }, signal));
  };

  return (
    <LegalTwoPaneTool
      icon={<Upload size={22} />}
      accent="blue"
      title={materialCopy.title}
      desc={materialCopy.description}
      caseFile={caseFile}
      running={loading}
      left={(
        <div {...drop.props} className={`flex min-h-0 flex-col rounded-lg ${drop.dragging ? 'ring-2 ring-blue-400' : ''}`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-white/50">{copy.drop} · PDF / DOCX / TXT / MD</span>
            <button onClick={() => fileRef.current?.click()} disabled={loading} className="rounded-lg border border-white/10 px-3 py-2 text-sm text-white/70 disabled:opacity-50">{copy.upload}</button>
            <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.txt,.md" onChange={upload} className="hidden" />
          </div>
          <label className="mb-3 flex flex-col gap-2 text-sm font-medium text-white">
            {materialCopy.materialType}
            <select aria-label={materialCopy.materialType} value={materialType} onChange={event => setMaterialType(event.target.value)} disabled={loading} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white outline-none focus:border-blue-400/35 disabled:opacity-50">
              {Object.entries(materialCopy.types).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="mb-2 text-sm font-medium text-white">{materialCopy.content}</label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={materialCopy.placeholder}
            className="min-h-[420px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 font-mono text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-blue-400/35"
          />
          <button
            onClick={importMaterials}
            disabled={loading || !content.trim()}
            className="mt-3 inline-flex items-center justify-center gap-2 self-end rounded-lg border border-blue-400/20 bg-blue-500/15 px-4 py-2.5 text-sm font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            {loading ? uiMessage('legal-hub.importing.ec01cb1a24') : materialCopy.import}
          </button>
        </div>
      )}
      result={result}
      successfulResult={successfulResult}
      restoredResult={restoredResult}
      emptyText={uiMessage('legal-hub.import-result-and-archive-status.ef57344682')}
    />
  );
}
