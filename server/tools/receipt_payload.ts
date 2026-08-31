import type { ToolExecutionRecord } from './types';

/** Decode the receipt/result compatibility shapes emitted by adapters. */
export function parseNestedJson(value: unknown, maxDepth = 5): unknown {
  let parsed = value;
  for (let depth = 0; depth < maxDepth && typeof parsed === 'string'; depth += 1) {
    const current = parsed.trim();
    if (!current) return '';
    try { parsed = JSON.parse(current); } catch { break; }
  }
  return parsed;
}

export function hasMeaningfulReceiptValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value === 'string' ? Boolean(value.trim()) : true;
}

export function toolRecordTerminalPayload(
  record: Pick<ToolExecutionRecord, 'receipt' | 'result'>,
): unknown {
  const receipt = parseNestedJson(record.receipt);
  return hasMeaningfulReceiptValue(receipt) ? receipt : parseNestedJson(record.result);
}

export function toolRecordHasTerminalPayload(
  record: Pick<ToolExecutionRecord, 'receipt' | 'result'>,
): boolean {
  return hasMeaningfulReceiptValue(toolRecordTerminalPayload(record));
}

export function toolRecordTerminalText(
  record: Pick<ToolExecutionRecord, 'receipt' | 'result'>,
): string {
  const payload = toolRecordTerminalPayload(record);
  if (!hasMeaningfulReceiptValue(payload)) return '';
  if (typeof payload === 'string') return payload.trim();
  try { return JSON.stringify(payload); } catch { return String(payload); }
}

export function parseReceiptObject(value: unknown): Record<string, any> | null {
  const parsed = parseNestedJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, any>
    : null;
}
