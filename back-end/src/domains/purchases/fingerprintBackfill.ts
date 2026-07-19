import * as repo from './repo';

// The lazy backfill only covers purchases created before canonical fingerprints shipped. Every
// scanned legacy row is persisted into an indexed key, so its cost is paid at most once.
const ROLLOUT_CUTOFF = new Date('2026-07-20T00:00:00.000Z');
const HISTORY_START = new Date(0);
const legacyBackfills = new Map<string, Promise<void>>();
type BackfillScope = 'history' | 'recent';

async function ensureIndexed(userId: string, since: Date, scope: BackfillScope): Promise<void> {
  const indexedSince =
    scope === 'history'
      ? HISTORY_START
      : new Date(Math.floor(since.getTime() / (60 * 60 * 1000)) * 60 * 60 * 1000);
  if (indexedSince >= ROLLOUT_CUTOFF) return;
  // A history request must never join a narrower recent request. Recent windows are rounded down
  // to an hour, making each coalesced request a safe superset of every caller's exact cache window.
  const backfillKey = `${userId}:${scope}:${indexedSince.getTime()}`;
  const inFlight = legacyBackfills.get(backfillKey);
  if (inFlight) return inFlight;

  const backfill = repo
    .backfillLegacyCanonicalFingerprints(userId, indexedSince, ROLLOUT_CUTOFF)
    .then(() => undefined)
    .finally(() => {
      if (legacyBackfills.get(backfillKey) === backfill) legacyBackfills.delete(backfillKey);
    });
  legacyBackfills.set(backfillKey, backfill);
  return backfill;
}

export async function ensureRecentLegacyFingerprintsIndexed(
  userId: string,
  since: Date
): Promise<void> {
  return ensureIndexed(userId, since, 'recent');
}

export async function ensureAllLegacyFingerprintsIndexed(userId: string): Promise<void> {
  return ensureIndexed(userId, HISTORY_START, 'history');
}
