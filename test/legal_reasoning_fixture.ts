import { legalRuleParts } from '../server/regions/packs/cn/legal_reasoning_links';
export function reasoningChecks(quote: string, value: any) {
  return legalRuleParts(quote).map(part => ({ partId: part.id, sourceIds: value.sourceIds,
    status: value.status || 'conditional', application: value.application, conclusion: value.conclusion,
    missingPremises: value.missingPremises ?? (value.status === 'supported' ? [] : [value.limitations || '原件及本案适用前提尚待核实']) }));
}
/** Explicit migration of old test payloads, never a production parser/fallback. */
export function reasoningFixtureReply(prompt: string, payload: any): string {
  let value = payload;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return payload; } }
  const match = prompt.match(/^法条（同条各parts按原文次序合读）：(.+)$/m);
  if (!match || !value || typeof value !== 'object') return typeof payload === 'string' ? payload : JSON.stringify(payload);
  const rules = JSON.parse(match[1]);
  const drafts = prompt.includes('\n待复核分析：') ? JSON.parse(prompt.split('\n待复核分析：')[1]) : [];
  const migrate = (entry: any, reviewing: boolean) => {
    if (!entry || entry.checks || (!reviewing && !entry.ruleId)) return entry;
    const original = drafts.find((item: any) => item.index === entry.index);
    const ruleId = entry.ruleId || original?.ruleId;
    const rule = rules.find((item: any) => item.id === ruleId);
    if (!rule) return entry;
    const sourceIds = entry.sourceIds ?? [...new Set(original?.checks?.flatMap((item: any) => item.sourceIds) || [])];
    return { ...entry, ruleId, checks: rule.parts.map((part: any) => ({ partId: part.id, sourceIds,
      status: entry.status || 'conditional', application: entry.application, conclusion: entry.conclusion,
      missingPremises: entry.missingPremises ?? [entry.limitations || '原件及本案适用前提尚待核实'] })) };
  };
  return JSON.stringify({ ...value, ...(Array.isArray(value.entries) ? { entries: value.entries.map((entry: any) => migrate(entry, false)) } : {}),
    ...(Array.isArray(value.reviews) ? { reviews: value.reviews.map((entry: any) => migrate(entry, true)) } : {}) });
}
