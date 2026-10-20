import { isLegalSourceMaterial } from '../../../shared/legal_workflow_receipts';
import { legalReviewQualityCopy } from '../../i18n/regions/cn/legalReviewQuality';
import React, { useRef, useState } from 'react';
import { FileText, Loader2, Shield, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '../../lib/useT';
import type { LegalCaseFile, LegalCaseMaterial } from '../../lib/legalCaseStore';
import { apiJson } from '../../services/apiClient';
import { useLegalDocument, useLegalDocumentScope } from '../../hooks/useLegalDocument';
import { runLegalTool } from '../../lib/legalToolClient';
import { LegalTwoPaneTool } from './legal_hub/two_pane_tool';
import { uiMessage } from '../../i18n/uiMessages';
import { chinaLegalCopy } from '../../i18n/regions/cn/legal';
import { useFileDrop } from '../../hooks/useFileDrop';
import { fileImportCopy } from '../../i18n/locales/fileImport';
import type { KnowledgeFileSource } from '../../lib/knowledgeFileImport';

export function LegalContractReview(props: { caseFile?: LegalCaseFile | null; onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void }) {
  return <LegalContractDocument key={useLegalDocumentScope(props.caseFile?.id)} {...props} />;
}

function LegalContractDocument({ caseFile }: { caseFile?: LegalCaseFile | null }) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const qualityCopy = legalReviewQualityCopy[isZh ? 'zh' : 'en'];
  const { text: contract, setText: setContract, result, successfulResult, restoredResult, busy, upload, scopedFileUrl, read, generate } = useLegalDocument(
    (caseFile?.materials || []).find(material => material.type === 'contract' && material.content && isLegalSourceMaterial(material))?.content || '',
    { error: uiMessage('legal-contract-review.error.1d47687da7'), uploadFailed: qualityCopy.failed },
    { caseFile, toolName: 'legal_review_contract' },
  );
  const loading = busy === 'generate', uploading = busy === 'upload';
  const fileRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [pendingFiles, setPendingFiles] = useState<Array<{ id: string; name: string; error?: string }>>([]);
  const [uploadFailures, setUploadFailures] = useState<string[]>([]);

  const readFullFiles = async (files: Array<{ id: string; name: string }>, signal: AbortSignal) => {
    const pending: Array<{ id: string; name: string; error?: string }> = [], sections: string[] = [];
    for (const file of files) {
      signal.throwIfAborted();
      try {
        const data = await apiJson<Record<string, any>>(scopedFileUrl('/api/files/text/' + encodeURIComponent(file.id)), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ password: password || undefined }),
        });
        signal.throwIfAborted();
        if (data.truncated !== false || !data.text?.trim()) throw new Error(qualityCopy.failed);
        sections.push('# ' + file.name + '\n' + data.text);
      } catch (error: any) {
        signal.throwIfAborted();
        pending.push({ ...file, error: error?.message || qualityCopy.failed });
      }
    }
    signal.throwIfAborted();
    setPendingFiles(pending);
    setPassword('');
    if (pending.length) toast.error(qualityCopy.pending);
    return sections.join('\n\n');
  };
  const handleFileUpload = (source: React.ChangeEvent<HTMLInputElement> | KnowledgeFileSource) => {
    const files = Array.isArray(source) ? source : Array.from(source.currentTarget.files || []);
    const selectedNames = new Set(files.map(file => file.name));
    return upload(source, async (data, signal) => {
      setUploadFailures(previous => [...previous.filter(name => !selectedNames.has(name)), ...data.failed.map((file: any) => String(file.fileName))]);
      return readFullFiles([...pendingFiles, ...(data.files || [])], signal);
    });
  };
  const drop = useFileDrop(handleFileUpload, Boolean(busy));
  const retryRead = () => read(signal => readFullFiles(pendingFiles, signal));
  const review = () => {
    if (!contract.trim() || pendingFiles.length || uploadFailures.length) return;
    return generate(signal => runLegalTool('legal_review_contract', {
      contract,
      caseId: caseFile?.id,
      caseName: caseFile ? (caseFile.title || caseFile.party || caseFile.caseNumber || undefined) : undefined,
      caseType: caseFile?.cause || chinaLegalCopy('zh').contractReviewCaseType,
      court: caseFile?.court,
      persistCase: Boolean(caseFile),
    }, signal));
  };

  return (
    <LegalTwoPaneTool
      icon={<Shield size={22} />} accent="blue" caseFile={caseFile} running={loading}
      title={t.legalContractReviewTitle || uiMessage('legal-contract-review.contract-review.d4cc309459')}
      desc={t.legalContractReviewDesc || uiMessage('legal-contract-review.review-clause-risks-legal-basis.84a59ad01a')}
      result={result} successfulResult={successfulResult} restoredResult={restoredResult}
      emptyText={uiMessage('legal-contract-review.review-results-will-appear-here.df0e833747')}
      left={(
          <div {...drop.props} className={`flex h-full min-h-0 flex-col rounded-lg ${drop.dragging ? 'ring-2 ring-blue-400' : ''}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="inline-flex items-center gap-2 text-sm font-medium text-white">
                <FileText size={16} className="text-blue-300" />
                {uiMessage('legal-contract-review.contract-text.c30d0eba56')}
              </h3>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading || loading}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
              >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {uiMessage('legal-contract-review.upload.b6fb916ac9')}
              </button>
              <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.txt,.md" onChange={handleFileUpload} className="hidden" />
            </div>
            <p className="mb-3 text-xs text-white/50">{fileImportCopy[isZh ? 'zh' : 'en'].drop} · PDF / DOCX / TXT / MD</p>
            <label className="mb-3 flex flex-col gap-1 text-xs text-white/60">
              {qualityCopy.password}
              <input type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} disabled={uploading || loading} className="rounded border border-white/10 bg-black/20 px-3 py-2" />
            </label>
            {pendingFiles.length > 0 && <div className="mb-3 text-sm text-amber-200" role="status">
              <p>{qualityCopy.pending}</p>
              {pendingFiles.map(file => <p key={file.id}>{file.name}: {file.error}</p>)}
              <button onClick={retryRead} disabled={uploading || loading} className="mt-2 underline disabled:opacity-50">{qualityCopy.retry}</button>
            </div>}
            {uploadFailures.length > 0 && <p role="status" className="mb-3 text-sm text-amber-200">{qualityCopy.partial} {uploadFailures.join(', ')}</p>}
            <textarea
              value={contract}
              onChange={event => setContract(event.target.value)}
              placeholder={t.legalContractReviewPlaceholder || uiMessage('legal-contract-review.paste-contract-text-or-upload.3dbd66ea5b')}
              className="min-h-[420px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 font-mono text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-blue-400/35"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-white/40">{qualityCopy.coverage}</p>
              <button
                onClick={review}
                disabled={loading || uploading || pendingFiles.length > 0 || uploadFailures.length > 0 || !contract.trim()}
                className="inline-flex items-center gap-2 rounded-lg border border-blue-400/20 bg-blue-500/15 px-4 py-2.5 text-sm font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Shield size={16} />}
                {t.legalContractReviewReview || uiMessage('legal-contract-review.review.e3dfc24f76')}
              </button>
            </div>
          </div>
      )}
    />
  );
}
