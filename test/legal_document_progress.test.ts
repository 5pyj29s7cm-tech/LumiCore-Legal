import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { legalDocumentProgress } from '../server/regions/packs/cn/legal_document_progress';

let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); });
afterAll(() => app.cleanup());
const body = '# 测试文书\n已付款记录及本案合同的关联、剩余货款的到期时间和质量异议均须逐项核对，当前不确定承担违约责任。';
describe('source-scoped legal document progress', () => {
  it('persists pending review separately from a reviewed document across requests', () => {
    const state = legalDocumentProgress('owner/case/source-v1');
    state.save('complaint', body, true);
    state.save('cross-examination', body, false);
    const restored = legalDocumentProgress('owner/case/source-v1');
    expect(restored.get('complaint')).toEqual({ markdown: body, reviewed: true });
    expect(restored.get('cross-examination')?.reviewed).toBe(false);
    expect(legalDocumentProgress('other-owner/case/source-v1').get('complaint')).toBeUndefined();
    expect(legalDocumentProgress('owner/case/source-v2').get('complaint')).toBeUndefined();
  });
  it('does not reuse a stale checkpoint or forcefully regenerate from it', () => {
    const state = legalDocumentProgress('expiry'); state.save('document', body, true);
    expect(legalDocumentProgress('expiry', true).get('document')).toBeUndefined();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    try { expect(legalDocumentProgress('expiry').get('document')).toBeUndefined(); } finally { vi.useRealTimers(); }
  });
  it('keeps disabled transient progress out of persistent storage', () => {
    legalDocumentProgress(null).save('document', body, true);
    expect(legalDocumentProgress(null).get('document')).toBeUndefined();
  });
});
