import type { ToolExecutionRecord } from '../tools/types';
import { parseReceiptObject, toolRecordSucceeded } from '../tools/receipt_payload';
import { isCanonicalToolExecutionRecord } from '../tools/canonical_execution_record';
import { withoutNegatedLookupClauses, genericExternalCommit } from './normalized_action_intent';
import { hasRequestedArtifactMutation } from './tool_intent';
import { inspectPersistedToolExecutionReceipt } from '../tools/persisted_execution_receipt';
import { affirmativeActionInstructionClauses } from './action_instruction_clauses';

export function hasContinuousStockWatchIntent(text: string): boolean {
  return /(?:\u6301\u7eed|\u4e00\u76f4|\u5b9e\u65f6|\u76d8\u4e2d|\u5f00\u59cb|\u6b63\u5728)?.{0,12}(?:\u76ef\u76d8|\u76d1\u63a7|\u9884\u8b66|\u63d0\u9192)|(?:watch|monitor|track|alert|watchlist|price\s*alert|market\s*alert)/iu
    .test(text || '');
}

export function hasContinuousStockWatchEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.error) return false;
    const name = String(record.name || '');
    const result = String(record.result || '');
    return /(?:alert|watchlist|reminder|autonomy_(?:register|set|list)_workflow|work_takeover_task_(?:create|advance|autorun|verify_result))/i.test(name)
      || /(?:alert|watchlist|reminder|scheduled|monitoring|workflow|price\s*alert|market\s*alert|\u9884\u8b66|\u63d0\u9192|\u76ef\u76d8\u4efb\u52a1|\u76d1\u63a7\u4efb\u52a1)/iu.test(result);
  });
}

export function requiresLegalCurrentLawGate(text: string): boolean {
  if (
    /(?:\u68c0\u7d22\u8ba1\u5212|\u68c0\u7d22\u884c\u52a8\u5355|\u5916\u90e8\u68c0\u7d22|\u6765\u6e90\u767b\u8bb0|\u6388\u6743\u534f\u4f5c|\u88c1\u5224\u6587\u4e66\u7f51|\u4eba\u6c11\u6cd5\u9662\u6848\u4f8b\u5e93|\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|research plan|source register|authorized collaboration)/iu.test(text || '') &&
    !/(?:\u8d77\u8bc9\u72b6|\u8981\u7d20\u5f0f\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1\u610f\u89c1|\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1\u4e66|\u59d4\u6258\u624b\u7eed|\u7acb\u6848\u6750\u6599|\u8bc1\u636e\u76ee\u5f55|\u5408\u540c|\u534f\u8bae|\u6807\u4e66|\u6295\u6807\u4e66|\u6b63\u5f0f\u6587\u4e66|\u4ea4\u4ed8\u5305|pleading|complaint|defense|legal\s+opinion|contract|agreement|bid|tender|filing\s+packet|evidence\s+catalog)/iu.test(text || '')
  ) {
    return false;
  }
  return /(?:\u8d77\u8bc9\u72b6|\u8981\u7d20\u5f0f\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1\u610f\u89c1|\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1\u4e66|\u59d4\u6258\u624b\u7eed|\u7acb\u6848\u6750\u6599|\u8bc1\u636e\u76ee\u5f55|\u5408\u540c|\u534f\u8bae|\u6807\u4e66|\u6295\u6807\u4e66|\u6587\u4e66|\u8bc9\u72b6|pleading|complaint|defense|legal\s+opinion|contract|agreement|bid|tender|filing\s+packet|evidence\s+catalog)/iu
    .test(text || '');
}

export function claimsLegalDocumentCompletion(text: string): boolean {
  return String(text || '').split(/[。！？!?\n]/u).some(clause => {
    if (/(?:\u5c1a\u672a|\u6ca1\u6709|\u4e0d\u80fd|\u4e0d\u5f97|\u4e0d\u7b49\u540c|\u4e0d\u6784\u6210|\u4e0d\u4f5c\u4e3a|\u5f85\u6838\u9a8c|not\s+(?:a|complete|ready|formal)|cannot)/iu.test(clause)) return false;
    return /(?:\u8d77\u8bc9\u72b6|\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1\u610f\u89c1|\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1\u4e66|\u59d4\u6258\u624b\u7eed|\u7acb\u6848\u6750\u6599|\u8bc1\u636e\u76ee\u5f55|\u5408\u540c|\u534f\u8bae|\u6807\u4e66|\u6295\u6807\u4e66|\u6587\u4e66|pleading|complaint|defense|legal\s+opinion|contract|agreement|bid|tender).{0,24}(?:\u5df2(?:\u7ecf)?(?:\u751f\u6210|\u5b8c\u6210|\u8d77\u8349|\u5199\u597d|\u51fa\u5177|\u4ea4\u4ed8)|\u751f\u6210\u5b8c\u6210|\u6b63\u5f0f\u53ef\u7528|\u53ef(?:\u4ee5)?\u76f4\u63a5\u4f7f\u7528|completed|created|generated|ready)|(?:\u5df2(?:\u7ecf)?(?:\u751f\u6210|\u5b8c\u6210|\u8d77\u8349|\u5199\u597d|\u51fa\u5177|\u4ea4\u4ed8)|completed|created|generated).{0,24}(?:\u8d77\u8bc9\u72b6|\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1\u610f\u89c1|\u4ee3\u7406\u8bcd|\u6cd5\u5f8b\u610f\u89c1\u4e66|\u59d4\u6258\u624b\u7eed|\u7acb\u6848\u6750\u6599|\u8bc1\u636e\u76ee\u5f55|\u5408\u540c|\u534f\u8bae|\u6807\u4e66|\u6295\u6807\u4e66|\u6587\u4e66|pleading|complaint|defense|legal\s+opinion|contract|agreement|bid|tender)/iu.test(clause);
  });
}

// The full-delivery handler owns law, source and reasoning checks. Body text
// and successful drafting/searching cannot upgrade a document into that result.
export function hasLegalCurrentLawGateEvidence(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    const receipt = parseReceiptObject(record.receipt);
    return record.name === 'legal_finalize_delivery_package' && toolRecordSucceeded(record)
      && receipt?.ok === true && receipt.status === 'generated';
  });
}

export function hasLegalExternalPlatformSignal(text: string): boolean {
  return /(?:\u6cd5\u9662\u7acb\u6848\u7f51|\u7f51\u4e0a\u7acb\u6848|\u4eba\u6c11\u6cd5\u9662\u5728\u7ebf\u670d\u52a1|\u6cd5\u9662\u5728\u7ebf\u670d\u52a1|\u4e2d\u56fd\u88c1\u5224\u6587\u4e66\u7f51|\u88c1\u5224\u6587\u4e66\u7f51|\u4eba\u6c11\u6cd5\u9662\u6848\u4f8b\u5e93|\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|\u5929\u773c\u67e5|\u56fd\u5bb6\u4f01\u4e1a\u4fe1\u7528|\u6267\u884c\u4fe1\u606f\u516c\u5f00|wenshu|fachan|qichacha|court\s+filing|judgments?\s+online)/iu
    .test(text || '');
}

export function describesAuthorizedLegalExternalHandoff(text: string): boolean {
  return /(?:\u6388\u6743\u534f\u4f5c|\u534a\u81ea\u52a8|\u884c\u52a8\u5355|\u4ea4\u63a5\u5355|\u6765\u6e90\u767b\u8bb0|\u7ed3\u679c\u5f52\u6863|\u5f85\u5f8b\u5e08|\u5f85\u4eba\u5de5|\u4eba\u5de5\u6838\u5bf9|\u4eba\u5de5\u63d0\u4ea4|\u9700\u8981\u767b\u5f55|\u9700\u8981\u9a8c\u8bc1|\u4e0d\u4f1a\u81ea\u52a8|\u4e0d\u81ea\u52a8|\u672a\u63d0\u4ea4|\u4e0d\u7b7e\u540d|\u4e0d\u7f34\u8d39|\u4e0d\u786e\u8ba4\u9001\u8fbe|authorized collaboration|handoff|source register|manual review|not submit|not sign|not pay)/iu
    .test(text || '');
}

export function claimsExternalLegalPlatformFinalAction(text: string): boolean {
  const value = text || '';
  if (/(?:\u4e0d\u4f1a|\u4e0d\u80fd|\u4e0d\u5e94|\u672a|\u5f85|\u9700\u8981|\u5fc5\u987b).{0,14}(?:\u63d0\u4ea4|\u7acb\u6848|\u7b7e\u540d|\u7b7e\u7f72|\u7f34\u8d39|\u9001\u8fbe|\u64a4\u56de|\u548c\u89e3|submit|sign|pay|service|settle)/iu.test(value)) {
    return false;
  }
  return /(?:(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u81ea\u52a8|\u5168\u81ea\u52a8).{0,24}(?:\u63d0\u4ea4\u7acb\u6848|\u7acb\u6848\u63d0\u4ea4|\u7f51\u4e0a\u7acb\u6848|\u7b7e\u540d|\u7b7e\u7f72|\u7f34\u8d39|\u786e\u8ba4\u9001\u8fbe|\u64a4\u56de|\u548c\u89e3\u627f\u8bfa|\u5bf9\u5916\u63d0\u4ea4))|(?:(?:auto|fully automatic|completed).{0,24}(?:filing|submitted|signature|signed|payment|paid|service|settlement))|(?:bypass(?:ed)?\s+(?:captcha|2fa|verification))/iu
    .test(value);
}

const COMPANY_LOOKUP_KINDS = [
    ['registration', /\u5de5\u5546|\u767b\u8bb0|registration/iu, 'get_company_registration_info'],
    ['shareholders', /\u80a1\u4e1c|shareholder/iu, 'get_shareholder_info'],
    ['controller', /\u5b9e\u63a7|\u5b9e\u9645\u63a7\u5236|controller/iu, 'get_actual_controller'],
    ['risk', /\u98ce\u9669|risk/iu, 'get_company_risk_scan'],
    ['enforcement', /\u88ab\u6267\u884c|enforcement/iu, 'get_judgment_debtor_info'],
    ['dishonesty', /\u5931\u4fe1|dishonesty/iu, 'get_dishonest_info'],
    ['restrictions', /\u9650\u9ad8|\u9650\u5236\u9ad8\u6d88\u8d39|restriction/iu, 'get_high_consumption_restriction'],
] as const;

export function claimsExternalLegalPlatformResult(text: string, taskText = ''): boolean {
  const goal = withoutNegatedLookupClauses(taskText);
  return affirmativeActionInstructionClauses(String(text || '')).some(({ probe }) => {
    const value = probe.replace(/\s+/gu, ' ');
    // i18n-allow: Past-tense negative reports, unlike imperative prohibition.
    if (/^\s*(?:(?:我|我们|本轮|当前)\s*)*(?:没有|并未|尚未|未|不曾)|^\s*(?:(?:I|we)\s+)?(?:have\s+not|haven't|did\s+not|didn't)\b/iu.test(value)) return false;
    // A plan or pending-login clause cannot erase a separate completed-query
    // assertion. Quoted, hypothetical and negated clauses are data, not claims.
    const explicitResult = /\u5df2(?:\u7ecf)?(?:\u5728[^。！？!?;\n]{0,24})?(?:\u67e5\u5230|\u68c0\u7d22\u5230|\u627e\u5230|\u67e5\u8be2\u5230|\u4e0b\u8f7d\u5230|\u6293\u53d6\u5230)/u.test(value);
    if (describesAuthorizedLegalExternalHandoff(value) && !explicitResult) return false;
    // A completed query may name only its requested field, not repeat the platform
    // or company. Reuse the source owner's ranges; this never resolves a subject
    // or grants execution. The current canonical source still has to prove it.
    if (explicitResult && COMPANY_LOOKUP_KINDS.some(([, pattern]) => pattern.test(goal) && pattern.test(value))) return true;
    return /(?:(?:\u5df2\u7ecf|\u5df2|\u5b8c\u6210|\u67e5\u5230|\u68c0\u7d22\u5230|\u627e\u5230|\u67e5\u8be2\u5230|\u4e0b\u8f7d\u5230|\u6293\u53d6\u5230).{0,36}(?:\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|\u88c1\u5224\u6587\u4e66|\u6848\u4f8b\u5e93|\u516c\u53f8|\u88ab\u6267\u884c|\u6cd5\u9662|\u7ed3\u679c))|(?:(?:\u6cd5\u8749|\bAlpha\b|\u4f01\u67e5\u67e5|\u88c1\u5224\u6587\u4e66\u7f51|\u4eba\u6c11\u6cd5\u9662\u6848\u4f8b\u5e93).{0,36}(?:\u67e5\u5230|\u68c0\u7d22\u5230|\u627e\u5230|\u7ed3\u679c|result))/iu.test(value);
  });
}

export function hasLegalExternalPlatformResultEvidence(records: ToolExecutionRecord[], current?: { requestId?: string; taskId?: string; taskText?: string }): boolean {
  const successful = records.filter(record => !record.error && String(record.result || '').trim());
  if (successful.length === 0) return false;

  return successful.some(record => {
    const name = String(record.name || '');
    const result = String(record.result || '');
    if (name === 'legal_company_database_lookup') return hasVerifiedCompanyLookupEvidence(records, current);
    if (/manual_required|captcha|2FA|QR|\u9a8c\u8bc1\u7801|\u626b\u7801|\u4ed8\u8d39|\u9700\u8981\u767b\u5f55|\u672a\u914d\u7f6e|not configured|login required/i.test(result)) {
      return false;
    }
    const resultTool = /^(legal_search_external_authorities|legal_company_database_lookup|legal_trace_assets|url_fetch_logged_in|mcp_playwright_browser_snapshot|mcp_playwright_browser_evaluate|browser_open_task)$/i.test(name);
    const hasResultMarkers = /(?:\u6765\u6e90\u767b\u8bb0|\u590d\u6838\u72b6\u6001|\u6848\u53f7|\u6cd5\u9662|\u88c1\u5224|\u80a1\u4e1c|\u88ab\u6267\u884c|\u516c\u53f8|\u641c\u7d22\u7ed3\u679c|Page URL|source-register|result|title|case|company)/iu.test(result);
    return resultTool && hasResultMarkers;
  });
}

/** The same source owner serves live public claims and durable read-query completion. */
export function hasVerifiedCompanyLookupEvidence(records: ToolExecutionRecord[], current?: { requestId?: string; taskId?: string; taskText?: string }, persistedAtomic = false): boolean {
  if (!current?.requestId || !current.taskId || !current.taskText) return false;
  const goal = withoutNegatedLookupClauses(current.taskText);
  const qccRequested = /(?:\u4f01\u67e5\u67e5|qichacha|\bqcc\b)/iu.test(goal);
  const kinds = COMPANY_LOOKUP_KINDS;
  const requestedKinds = kinds.filter(([,pattern]) => pattern.test(goal)).map(([kind]) => kind);
  if (persistedAtomic && (hasRequestedArtifactMutation(current.taskText) || genericExternalCommit(current.taskText)
    || /\u5929\u773c\u67e5|\u6cd5\u8749|\u88c1\u5224\u6587\u4e66\u7f51|\b(?:alpha|tianyancha|fachan)\b/iu.test(goal))) return false;
  const observed = records.flatMap(record => {
    if (record.name !== 'legal_company_database_lookup' || !toolRecordSucceeded(record)) return [];
    const receipt = parseReceiptObject(record.receipt), subject = String(record.arguments?.name || record.arguments?.companyName || record.arguments?.subjectName || '').trim();
    if (!subject || !goal.includes(subject) || receipt?.ok !== true || receipt.status !== 'observed' || !Array.isArray(receipt.sourceResults)
      || record.requestId !== current.requestId || record.taskId !== current.taskId) return [];
    const proof = persistedAtomic ? inspectPersistedToolExecutionReceipt({ ...record, toolName: record.name,
      outcome: record.envelope?.status, targetIdentity: record.envelope?.targetIdentity }, {
      rowTaskId: current.taskId, envelopeTaskId: current.taskId, requestId: current.requestId, outcome: 'verified_success',
    }) : undefined;
    if (persistedAtomic ? !proof?.valid || !proof.explicitlyTerminalVerified : !isCanonicalToolExecutionRecord(record)) return [];
    if (persistedAtomic && (receipt.persisted !== false || receipt.changedCaseIds?.length || receipt.articleIds?.length
      || [...goal.matchAll(/[“"「『]([^”"」』]+(?:\u516c\u53f8|\u96c6\u56e2|\u4f01\u4e1a|\u4e8b\u52a1\u6240))[”"」』]/gu)].some(match => match[1] !== subject))) return [];
    return receipt.sourceResults.filter((source: any) => source?.status === 'observed' && source.subject === subject
      && Number.isFinite(Date.parse(source.queriedAt)) && /^[a-f0-9]{64}$/.test(source.sourceTextSha256)
      && (qccRequested || persistedAtomic
        ? source.sourceEndpoint === 'https://agent.qcc.com/mcp/' + (['registration', 'shareholders', 'controller'].includes(source.queryType) ? 'company' : 'risk') + '/stream'
          && kinds.some(([kind,,tool]) => source.queryType === kind && source.sourceTool === tool)
        : typeof source.sourceEndpoint === 'string' && source.sourceEndpoint.startsWith('https://')));
  });
  return persistedAtomic || qccRequested ? (requestedKinds.length ? requestedKinds : ['registration'])
    .every(kind => observed.some(source => source.queryType === kind)) : observed.length > 0;
}
