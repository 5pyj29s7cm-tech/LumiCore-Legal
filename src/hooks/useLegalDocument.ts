import { useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import { useApp } from '../contexts/AppContext';
import { apiJson } from '../services/apiClient';
import { uiMessage } from '../i18n/uiMessages';
import { importKnowledgeFiles, type KnowledgeFileSource } from '../lib/knowledgeFileImport';
import { fileImportCopy } from '../i18n/locales/fileImport';
import { getLocale } from '../i18n/runtime';
import type { LegalCaseFile } from '../lib/legalCaseStore';
import { isLegalSourceMaterial } from '../../shared/legal_workflow_receipts';

export function useLegalDocumentScope(caseId?: string, orgId?: string): string {
  const { user, workDomain, orgConnection } = useApp();
  return JSON.stringify([user?.uid, workDomain, orgId || (workDomain === 'work' ? orgConnection?.orgId : ''), caseId]);
}

/** The owning component is keyed by account, organization and case. */
export function useLegalDocument(initialText: string, copy: { error: string; uploadFailed?: string; empty?: string; uploaded?: string }, restore?: { caseFile?: LegalCaseFile | null; toolName: string }) {
  const { workDomain, orgConnection } = useApp();
  const scopedFileUrl = (path: string) => path + '?domain=' + (workDomain === 'work' ? 'work&orgId=' + encodeURIComponent(orgConnection?.orgId || '') : 'personal');
  const [text, setText] = useState(initialText);
  const [output, setOutput] = useState({ text: '', error: '' });
  const [busy, setBusy] = useState<'' | 'upload' | 'generate' | 'archive'>('');
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current?.abort(); };
  }, []);

  const run = async (kind: 'upload' | 'generate' | 'archive', operation: (signal: AbortSignal) => Promise<string>) => {
    if (!active.current || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind);
    if (kind === 'generate') setOutput({ text: '', error: '' });
    try {
      const value = await operation(controller.signal);
      if (controller.signal.aborted) return;
      if (kind === 'upload') {
        setText(previous => [previous, value].filter(Boolean).join('\n\n'));
        if (copy.uploaded) toast.success(copy.uploaded);
      } else if (kind === 'archive') {
        if (value) toast.success(value);
      } else setOutput({ text: value, error: '' });
    } catch (error: any) {
      if (!controller.signal.aborted) {
        const message = error?.message || copy.uploadFailed || copy.error;
        if (kind !== 'archive') setOutput({ text: '', error: `${copy.error}: ${message}` });
        if (kind !== 'generate') toast.error(message);
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy('');
    }
  };

  const upload = (source: ChangeEvent<HTMLInputElement> | KnowledgeFileSource, parse?: (data: any, signal: AbortSignal) => Promise<string>) => {
    const files = Array.isArray(source) ? source : Array.from(source.currentTarget.files || []);
    if (!Array.isArray(source)) source.currentTarget.value = '';
    if (!files.length) return;
    return run('upload', async signal => {
      const data = await importKnowledgeFiles(files as KnowledgeFileSource, scopedFileUrl, signal);
      signal.throwIfAborted();
      let content: string;
      if (parse) content = await parse(data, signal);
      else {
        const copy = fileImportCopy[getLocale()];
        if (data.failed.length) throw new Error(copy.failed + ' ' + data.failed.map((file: any) => file.fileName).join(', '));
        const sections: string[] = [];
        for (const file of data.files) {
          const full = await apiJson<any>(scopedFileUrl('/api/files/text/' + encodeURIComponent(file.id)), { method: 'POST', signal });
          signal.throwIfAborted();
          if (full.truncated !== false || !full.text?.trim()) throw new Error(file.name + ': ' + copy.incomplete);
          sections.push('# ' + file.name + '\n' + full.text);
        }
        content = sections.join('\n\n');
      }
      if (!content) throw new Error(copy.empty || copy.error);
      return content;
    });
  };
  const save = (operation: () => boolean | Promise<boolean>, success = '') => run('archive', async () => {
    if (!await operation()) throw new Error(uiMessage('legal-hub.failed-to-archive-material.4ed52ef083'));
    return success;
  });
  const historical = restore?.caseFile?.workflowRuns?.find(run => run.tool === restore.toolName);
  const historicalText = historical?.displayText ?? (restore?.caseFile?.materials || [])
    .filter(material => historical?.materialIds.includes(material.id) && material.source === 'tool' && !isLegalSourceMaterial(material))
    .map(material => material.content || '').filter(Boolean).join('\n\n');
  const restoredResult = !output.text && !output.error && !busy ? historical : undefined;
  return { text, setText, result: output.error || output.text || (restoredResult ? historicalText || restoredResult.status : ''), restoredResult, successfulResult: output.text, busy, upload, scopedFileUrl, save, read: (operation: (signal: AbortSignal) => Promise<string>) => run('upload', operation), generate: (operation: (signal: AbortSignal) => Promise<string>) => run('generate', operation) };
}
