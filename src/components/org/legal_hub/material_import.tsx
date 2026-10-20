import { useRef } from 'react';
import { Upload, Loader2 } from "lucide-react";
import { useT } from "../../../lib/useT";
import { useLegalDocument, useLegalDocumentScope } from "../../../hooks/useLegalDocument";
import { useFileDrop } from '../../../hooks/useFileDrop';
import { fileImportCopy } from '../../../i18n/locales/fileImport';
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile, LegalCaseMaterial } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseToolArgs, inferLegalMaterialTitle } from './case_values';
import { LegalTwoPaneTool } from './two_pane_tool';

type Props = {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => boolean | Promise<boolean>;
};

export function LegalImportView(props: Props) {
  return <LegalImportDocument key={useLegalDocumentScope(props.caseFile?.id, props.orgId)} {...props} />;
}

function LegalImportDocument({
  caseFile,
  orgId,
  onAddMaterial,
}: Props) {
  const t = useT();
  const { text: content, setText: setContent, result, successfulResult, restoredResult, busy, upload, generate } = useLegalDocument('', { error: 'Error' }, { caseFile, toolName: 'legal_import_judgment' });
  const loading = Boolean(busy);
  const fileRef = useRef<HTMLInputElement>(null);
  const drop = useFileDrop(source => upload(source), loading);
  const copy = fileImportCopy[t.langCode === 'en' ? 'en' : 'zh'];

  const importJudgment = () => {
    if (!content.trim()) return;
    return generate(async signal => {
      const reply = await runLegalTool('legal_import_judgment', {
        ...legalCaseToolArgs(caseFile, orgId),
        content,
      }, signal);
      signal.throwIfAborted();
      if (caseFile && onAddMaterial) {
        const title = inferLegalMaterialTitle(content, uiMessage('legal-hub.judgment-document.3349b60486'));
        if (!await onAddMaterial('judgment', title, content, 'import')) throw new Error(uiMessage('legal-hub.failed-to-archive-material.4ed52ef083'));
        signal.throwIfAborted();
      }
      return reply;
    });
  };

  return (
    <LegalTwoPaneTool
      icon={<Upload size={22} />}
      accent="blue"
      title={t.legalImportJudgmentTitle}
      desc={t.legalImportJudgmentDesc}
      caseFile={caseFile}
      running={loading}
      left={(
        <div {...drop.props} className={`flex min-h-0 flex-col rounded-lg ${drop.dragging ? 'ring-2 ring-blue-400' : ''}`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-white/50">{copy.drop} · PDF / DOCX / TXT / MD</span>
            <button onClick={() => fileRef.current?.click()} disabled={loading} className="rounded-lg border border-white/10 px-3 py-2 text-sm text-white/70 disabled:opacity-50">{copy.upload}</button>
            <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.txt,.md" onChange={upload} className="hidden" />
          </div>
          <label className="mb-2 text-sm font-medium text-white">{uiMessage('legal-hub.judgment-document-content.a5f6676889')}</label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={uiMessage('legal-hub.paste-judgment-document-content-here.2534452d81')}
            className="min-h-[420px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 font-mono text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-blue-400/35"
          />
          <button
            onClick={importJudgment}
            disabled={loading || !content.trim()}
            className="mt-3 inline-flex items-center justify-center gap-2 self-end rounded-lg border border-blue-400/20 bg-blue-500/15 px-4 py-2.5 text-sm font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            {loading ? uiMessage('legal-hub.importing.ec01cb1a24') : t.legalImportJudgment}
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
