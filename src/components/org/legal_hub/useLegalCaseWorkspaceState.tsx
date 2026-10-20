import { legalCaseSourceFingerprint } from '../../../../shared/legal_workflow_receipts';
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLegalDocument, useLegalDocumentScope } from "../../../hooks/useLegalDocument";
import { runLegalTool } from "../../../lib/legalToolClient";
import { syncPersonalLegalCaseToRuntime, type LegalCaseFile, type LegalCaseMaterial } from "../../../lib/legalCaseStore";
import { useAppConfirm } from '../../../lib/appConfirm';
import { apiJson } from '../../../services/apiClient';
import { CHINA_LEGAL_WORKSPACE_COPY as reviewCopy } from '../../../i18n/regions/cn/legalWorkspace';
import { uiMessage } from "../../../i18n/uiMessages";
import { CHINA_LEGAL_TOOL_COPY } from "../../../i18n/regions/cn/legal";
import type { LegalView } from './contracts';
import { legalStageLabels, addDays, legalCaseToolArgs } from './case_values';

export function useLegalCaseWorkspaceState({
  caseFilter,
  setCaseFilter,
  cases,
  activeCase,
  onCreateCase,
  onDeleteCase,
  onSelectCase,
  onUpdateCase,
  onSetView,
  onStartConsultation,
  onOpenMeetingNotes,
  onCreateReminder,
  onCreatePlan,
  onAddMaterial,
  onRemoveMaterial,
  onRefreshCases,
  orgBacked,
  canDeleteCases,
  orgId,
  refreshing,
}: {
  caseFilter: string;
  setCaseFilter: (value: string) => void;
  cases: LegalCaseFile[];
  activeCase: LegalCaseFile | null;
  onCreateCase: () => void;
  onDeleteCase: (caseFile: LegalCaseFile) => void;
  onSelectCase: (id: string) => void;
  onUpdateCase: (id: string, patch: Partial<LegalCaseFile>) => boolean | Promise<boolean>;
  onSetView: (view: LegalView) => void;
  onStartConsultation: () => void;
  onOpenMeetingNotes: () => void;
  onCreateReminder: (content: string, dueAt?: string) => void;
  onCreatePlan: () => void;
  onAddMaterial: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => boolean | Promise<boolean>;
  onRemoveMaterial?: (caseId: string, materialId: string, expectedRevision: string, signal: AbortSignal) => Promise<boolean>;
  onRefreshCases: () => void;
  orgBacked: boolean;
  canDeleteCases: boolean;
  orgId?: string;
  refreshing: boolean;
}) {

  const notice = useLegalDocument('', { error: 'Error' });
  const { text: noticeText, setText: setNoticeText, result: noticeStatus, busy: noticeLoading } = notice;
  const [selectedMaterialId, setSelectedMaterialId] = useState('');
  const selectedMaterial = activeCase?.materials.find(item => item.id === selectedMaterialId);
  type MaterialReview = { revision: string; status: 'pending' | 'confirmed' | 'revoked' | 'stale'; reviewedAt?: string; scope: 'archived_text' | 'archived_text_and_file'; content: string };
  const [materialReview, setMaterialReview] = useState<MaterialReview | null>(null);
  const [reviewError, setReviewError] = useState('');
  const reviewScope = JSON.stringify([useLegalDocumentScope(activeCase?.id, orgId), selectedMaterial?.id, selectedMaterial?.title, selectedMaterial?.type, selectedMaterial?.content, selectedMaterial?.localPath, activeCase && legalCaseSourceFingerprint(activeCase), activeCase?.hearingDate, activeCase?.judgmentDate, activeCase?.appealDeadline, activeCase?.enforcementDeadline]);
  const confirmReview = useAppConfirm(reviewScope);
  const reviewRequest = useRef<AbortController | null>(null);
  const reviewDocument = useLegalDocument('', { error: reviewCopy.materialReviewFailed });
  const reviewUrl = activeCase && selectedMaterial ? '/api/legal/cases/' + encodeURIComponent(activeCase.id) + '/materials/' + encodeURIComponent(selectedMaterial.id) + '/review' : '';
  useEffect(() => {
    const controller = new AbortController(); reviewRequest.current = controller;
    setMaterialReview(null); setReviewError('');
    // The existing case snapshot writer runs first; reads do not create a second writer.
    const timer = window.setTimeout(() => { if (reviewUrl) void apiJson<MaterialReview>(reviewUrl, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setMaterialReview(value); })
      .catch(error => { if (!controller.signal.aborted) setReviewError(error.message || reviewCopy.materialReviewFailed); }); }, 600);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [reviewScope, reviewUrl]);
  const recordMaterialReview = (decision: 'confirmed' | 'revoked' | 'removed') => reviewDocument.generate(async signal => {
    const removing = decision === 'removed';
    if (!activeCase || !selectedMaterial || !reviewRequest.current || (removing ? !onRemoveMaterial : !selectedMaterial.content)) return '';
    const requestSignal = AbortSignal.any([signal, reviewRequest.current.signal]);
    try {
    if (!orgId) await syncPersonalLegalCaseToRuntime(activeCase, requestSignal);
    requestSignal.throwIfAborted();
    const current = await apiJson<MaterialReview>(reviewUrl, { signal: requestSignal });
    if ((current.content || '').trim() !== (selectedMaterial.content || '').trim()) throw new Error(reviewCopy.materialReviewChanged);
    const confirmed = await confirmReview({ title: removing ? reviewCopy.materialRemove : reviewCopy.materialReviewTitle,
      message: removing ? reviewCopy.materialRemoveMessage(selectedMaterial.title) : decision === 'confirmed' ? reviewCopy.materialReviewMessage(selectedMaterial.title) : reviewCopy.materialReviewRevoke,
      confirmText: removing ? reviewCopy.materialRemove : decision === 'confirmed' ? reviewCopy.materialReviewConfirm : reviewCopy.materialReviewRevoke,
      cancelText: reviewCopy.materialReviewCancel, tone: removing ? 'danger' : 'default', signal: requestSignal });
    requestSignal.throwIfAborted();
    if (!confirmed) return '';
    if (removing) {
      if (!await onRemoveMaterial!(activeCase.id, selectedMaterial.id, current.revision, requestSignal)) throw new Error(reviewCopy.materialRemoveFailed);
      requestSignal.throwIfAborted(); setSelectedMaterialId('');
      return reviewCopy.materialRemoved;
    }
    const saved = await apiJson<MaterialReview>(reviewUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: current.revision, decision }), signal: requestSignal });
    requestSignal.throwIfAborted();
    setMaterialReview(saved); setReviewError('');
    return decision === 'confirmed' ? reviewCopy.materialReviewRecorded(saved.reviewedAt || '') : reviewCopy.materialReviewRevoked;
    } catch (error) { if (requestSignal.aborted) return ''; throw error; }
  });
  const removeSelectedMaterial = () => recordMaterialReview('removed');

  const stageLabels = legalStageLabels();

  const update = (patch: Partial<LegalCaseFile>) => {
    if (!activeCase) return;
    onUpdateCase(activeCase.id, patch);
  };

  const filteredCases = useMemo(() => {
    const q = caseFilter.trim().toLowerCase();
    if (!q) return cases;
    return cases.filter(item => [
      item.title,
      item.caseNumber,
      item.party,
      item.cause,
      item.court,
      item.judge,
      item.notes,
    ].join('\n').toLowerCase().includes(q));
  }, [caseFilter, cases]);

  const calculateAppealDeadline = () => {
    if (!activeCase?.judgmentDate) {
      toast.info(uiMessage('legal-hub.enter-the-judgment-date-first.b19faa56d5'));
      return;
    }
    const deadline = addDays(activeCase.judgmentDate, 15);
    update({ appealDeadline: deadline });
    toast.success(uiMessage('legal-hub.appeal-deadline-calculated-with-the.46cc282758'));
  };

  const createDateReminder = (kind: 'hearing' | 'appeal' | 'enforcement') => {
    if (!activeCase) return;
    const date =
      kind === 'hearing' ? activeCase.hearingDate :
      kind === 'appeal' ? activeCase.appealDeadline :
      activeCase.enforcementDeadline;
    if (!date) {
      toast.info(uiMessage('legal-hub.enter-the-date-first.1349d04548'));
      return;
    }
    const label =
      kind === 'hearing' ? uiMessage('legal-hub.hearing-reminder.59c173ecb2') :
      kind === 'appeal' ? uiMessage('legal-hub.appeal-deadline-reminder.e731769a1e') :
      uiMessage('legal-hub.enforcement-reminder.6b6c485b5d');
    const caseName = activeCase.title || activeCase.party || activeCase.caseNumber || uiMessage('legal-hub.untitled-case.796e2578d9');
    void onCreateReminder(`${label}: ${caseName}`, date);
  };

  const extractNotice = async (signal: AbortSignal) => {
    if (!activeCase || !noticeText.trim()) return '';
    // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
    const caseNumber = noticeText.match(/[（(]\d{4}[）)][^，。；;\n]{2,80}(?:号|字第?\d+号?)/)?.[0] || '';
    // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
    const court = noticeText.match(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/)?.[0] || '';
    // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
    const dateMatch = noticeText.match(/(?:开庭(?:时间|日期)?|庭审(?:时间|日期)?)\s*[：:为是]?\s*(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/)
      // i18n-allow: Recognize an explicitly scheduled hearing in supplied input.
      || noticeText.match(/(?:定于|将于)\s*(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:(?!\d{4}[年/-]|[。\n；;]).){0,40}(?:开庭|庭审)/)
      // i18n-allow: Recognize an explicit dated hearing verb in supplied input.
      || noticeText.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s*(?:上午|下午)?\d{1,2}(?:[:：时]\d{1,2})?分?)?\s*(?:开庭|庭审)/);
    const hearingDate = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
      : '';
    const patch: Partial<LegalCaseFile> = {};
    if (caseNumber && !activeCase.caseNumber) patch.caseNumber = caseNumber;
    if (court && !activeCase.court) patch.court = court;
    if (hearingDate) patch.hearingDate = hearingDate;
    if (Object.keys(patch).length && !await onUpdateCase(activeCase.id, patch)) throw new Error(uiMessage('legal-hub.failed-to-save-case.90f7d722b2'));
    signal.throwIfAborted();
    if (!await onAddMaterial('note', uiMessage('legal-hub.hearing-notice-sms.10239017c5'), noticeText, 'notice')) throw new Error(uiMessage('legal-hub.failed-to-archive-material.4ed52ef083'));
    signal.throwIfAborted();
    return uiMessage('legal-hub.notice-extracted-review-case-number.77a3bafd0a');
  };

  const processNoticeLink = () => {
    if (!activeCase || !noticeText.trim()) return;
    return notice.generate(async signal => {
      await extractNotice(signal);
      if (!/https?:\/\/\S+/i.test(noticeText)) return uiMessage('legal-hub.notice-extracted-no-downloadable-link.44ba9b77e8');
      return runLegalTool('legal_process_notice_link', {
        ...legalCaseToolArgs(activeCase, orgId),
        message: noticeText,
        noticeText,
        title: CHINA_LEGAL_TOOL_COPY.noticeLinkMaterial,
        confirmedForKb: false,
        includeExtractedText: true,
        extractedTextLimit: 8000,
      }, signal);
    });
  };

  return { materialReview, reviewError, reviewDocument, recordMaterialReview, removeSelectedMaterial, canRemoveMaterial: Boolean(onRemoveMaterial), activeCase, onCreateCase, selectedMaterialId, onStartConsultation, orgBacked, onRefreshCases, refreshing, caseFilter, setCaseFilter, filteredCases, onSelectCase, stageLabels, canDeleteCases, onDeleteCase, update, onSetView, onCreatePlan, createDateReminder, calculateAppealDeadline, onOpenMeetingNotes, noticeText, setNoticeText, notice, extractNotice, noticeLoading, processNoticeLink, noticeStatus, setSelectedMaterialId };
}
