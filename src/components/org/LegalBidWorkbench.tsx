import { useRef, useState } from 'react';
import { Download, FileText, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '../../lib/useT';
import { getLegalCaseLabel, type LegalCaseFile } from '../../lib/legalCaseStore';
import { runLegalToolExecution, successfulLegalToolText } from '../../lib/legalToolClient';
import { LegalDocumentHistoryNotice } from './legal_hub/two_pane_tool';
import { LegalCaseContextBar } from './LegalCaseContextBar';
import { uiMessage } from '../../i18n/uiMessages';
import { chinaLegalCopy } from '../../i18n/regions/cn/legal';
import { useLegalDocument, useLegalDocumentScope } from '../../hooks/useLegalDocument';
import { useFileDrop } from '../../hooks/useFileDrop';
import { fileImportCopy } from '../../i18n/locales/fileImport';

function legalCaseTitle(caseFile?: LegalCaseFile | null): string {
  return getLegalCaseLabel(caseFile || null) || chinaLegalCopy().unnamedCase;
}

function bidCaseArgs(caseFile?: LegalCaseFile | null, orgId?: string): Record<string, any> {
  if (!caseFile) return { ...(orgId ? { orgId } : {}), persistCase: false };
  return {
    caseId: caseFile.id,
    caseName: legalCaseTitle(caseFile),
    caseType: caseFile.cause || chinaLegalCopy().bidCaseType,
    parties: caseFile.party || undefined,
    orgId,
    persistCase: true,
  };
}

type Props = {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
};
export function LegalBidWorkbench(props: Props) {
  return <LegalBidDocument key={useLegalDocumentScope(props.caseFile?.id, props.orgId)} {...props} />;
}

function LegalBidDocument({ caseFile, orgId }: Props) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const [artifactPaths, setArtifactPaths] = useState<string[]>([]);
  const { text: requirements, setText: setRequirements, result, successfulResult, restoredResult, busy, upload: handleFileUpload, generate } = useLegalDocument('', {
    error: uiMessage('legal-bid-workbench.error.1d47687da7'),
    uploadFailed: uiMessage('legal-bid-workbench.file-upload-parsing-failed.2381d47571'),
    empty: uiMessage('legal-bid-workbench.no-bid-requirements-text-extracted.dd17d7b94e'),
    uploaded: uiMessage('legal-bid-workbench.file-parsed-into-bid-requirements.6edc294741'),
  }, { caseFile, toolName: 'legal_generate_bid' });
  const [projectName, setProjectName] = useState(() => caseFile?.title || caseFile?.cause || '');
  const loading = busy === 'generate', uploading = busy === 'upload';
  const fileRef = useRef<HTMLInputElement>(null);
  const drop = useFileDrop(source => handleFileUpload(source), Boolean(busy));

  const generateBid = () => {
    if (!requirements.trim()) return;
    return generate(async signal => {
      setArtifactPaths([]);
      const execution = await runLegalToolExecution('legal_generate_bid', {
        ...bidCaseArgs(caseFile, orgId), projectName, requirements,
      }, signal);
      signal.throwIfAborted();
      const text = successfulLegalToolText(execution);
      setArtifactPaths(execution.artifacts);
      return text;
    });
  };

  const openBidArtifact = async () => {
    const target = artifactPaths.find(filePath => /\.docx$/i.test(filePath)) || artifactPaths[0];
    if (!target) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const opened = await invoke<{ success: boolean; output: string }>('open_item', {
        target,
        application: null,
      });
      if (!opened.success) throw new Error(opened.output || 'Unable to open the bid artifact.');
      toast.success(uiMessage('legal-bid-workbench.opened-verified-docx.47da920fb1', isZh ? 'zh' : 'en'));
    } catch (error: any) {
      toast.error(error?.message || uiMessage('legal-bid-workbench.open-docx-failed.3f7b19a8c2', isZh ? 'zh' : 'en'));
    }
  };


  const exportBid = () => {
    if (!successfulResult) return;
    const blob = new Blob([successfulResult], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${projectName || 'bid-proposal'}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-violet-400/20 bg-violet-500/10 text-violet-300">
              <FileText size={22} />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-white">{t.legalBidGenTitle || uiMessage('legal-bid-workbench.bid-proposal-workbench.354a284512')}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">
                {t.legalBidGenDesc || uiMessage('legal-bid-workbench.parse-tender-requirements-and-generate.b2a47e1579')}
              </p>
            </div>
          </div>
        </section>

        <LegalCaseContextBar
          caseFile={caseFile}
          state={loading ? 'running' : successfulResult ? 'result' : 'input'}
          detail={uiMessage('legal-bid-workbench.requirements-generated-output-and-delivery.b9935641c5')}
        />

        <section className="grid min-h-[560px] gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div {...drop.props} className={`flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4 ${drop.dragging ? 'ring-2 ring-violet-400' : ''}`}>
            <div className="mb-3 grid gap-3 md:grid-cols-[1fr_auto]">
              <input
                type="text"
                value={projectName}
                onChange={event => setProjectName(event.target.value)}
                placeholder={uiMessage('legal-bid-workbench.project-name-optional.2f665e9364')}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/35 focus:border-violet-400/35"
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading || loading}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
              >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {t.legalBidGenUpload || uiMessage('legal-bid-workbench.upload.b6fb916ac9')}
              </button>
              <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.txt,.md,.csv" onChange={handleFileUpload} className="hidden" />
            </div>
            <textarea
              value={requirements}
              onChange={event => setRequirements(event.target.value)}
              placeholder={t.legalBidGenPlaceholder || uiMessage('legal-bid-workbench.paste-tender-document-scoring-rules.ad0cd16ad2')}
              className="min-h-[420px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-violet-400/35"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-white/40">{fileImportCopy[isZh ? 'zh' : 'en'].drop} · PDF / DOCX / TXT / MD / CSV</p>
              <button
                onClick={generateBid}
                disabled={Boolean(busy) || !requirements.trim()}
                className="inline-flex items-center gap-2 rounded-lg border border-violet-400/20 bg-violet-500/15 px-4 py-2.5 text-sm font-medium text-violet-100 transition hover:bg-violet-500/25 disabled:opacity-50"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
                {t.legalBidGenGenerate || uiMessage('legal-bid-workbench.generate.aeba8d9545')}
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-white">{uiMessage('legal-bid-workbench.output.8520bb37e3')}</h3>
              {successfulResult && artifactPaths.length > 0 && <button onClick={() => void openBidArtifact()} className="text-sm text-white/65">{uiMessage('legal-bid-workbench.open-docx.6c2f1e4b9a', isZh ? 'zh' : 'en')}</button>}
              {successfulResult && (
                <button
                  onClick={exportBid}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white"
                >
                  <Download size={14} />
                  {t.legalBidGenExport || uiMessage('legal-bid-workbench.export.fe47a613e3')}
                </button>
              )}
            </div>
            <LegalDocumentHistoryNotice run={restoredResult} />
            <div className="min-h-[420px] flex-1 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-4 custom-scrollbar">
              {result ? (
                <article className="whitespace-pre-wrap text-sm leading-7 text-white/78">{result}</article>
              ) : (
                <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                  <FileText size={32} className="text-white/20" />
                  <span>{uiMessage('legal-bid-workbench.generated-bid-proposal-will-appear.00d0e12b42')}</span>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
