import fs from 'node:fs';
import { listStatuteVerificationCatalog } from '../../server/legal/kb';
import { loadStatuteAuthorityRefreshState, saveStatuteAuthorityRefreshState } from '../../server/legal/statute_authority_store';
import { createStatuteTextSnapshot } from '../../server/regions/packs/cn/statute_provisions';

// Official NPC DOCX extracted on 2026-09-18; isolated test data, never installed in user state.
export const civilCodeText = () => fs.readFileSync(new URL('./civil-code-official.txt', import.meta.url), 'utf8');
export function installCivilCodeFixture() {
  const entry = listStatuteVerificationCatalog().find(item => item.key === '民法典')!;
  const state = loadStatuteAuthorityRefreshState();
  state.checks[entry.sourceTitle] = {
    title: entry.sourceTitle, status: 'verified', checkedAt: '2026-09-18T00:00:00.000Z',
    expectedVersionDate: entry.verification.versionDate, expectedEffectiveDate: entry.verification.effectiveDate,
    expectedArticleMax: entry.verification.articleMax!, expectedRecordId: entry.recordId,
    lastVerifiedAt: '2026-09-18T00:00:00.000Z', reviewAfter: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), reasons: [], consecutiveFailures: 0,
    observed: {
      recordId: entry.recordId!, title: entry.sourceTitle, versionDate: entry.verification.versionDate,
      effectiveDate: entry.verification.effectiveDate, effectivenessCode: 3, category: '法律',
      issuingAuthority: '全国人民代表大会', articleMax: entry.verification.articleMax!, sourceUrl: entry.verification.sourceUrl,
    },
    originalText: createStatuteTextSnapshot(civilCodeText(), entry.verification.articleMax!, {
      recordId: entry.recordId!, versionDate: entry.verification.versionDate,
      fetchedAt: '2026-09-18T00:00:00.000Z', sourceUrl: entry.verification.sourceUrl,
    }),
  };
  saveStatuteAuthorityRefreshState(state);
  return state.checks[entry.sourceTitle];
}
