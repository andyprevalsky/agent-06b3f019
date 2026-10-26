import { demoCacheEnv } from './demoCacheEnv';

/**
 * DEMO recorder accounts. The shared store is keyed by goal text, not owner, so
 * every reader of a DEMO prompt replays whatever was stored under it. Only these
 * accounts (which also run benchmarks, sim guests and demos) may write; any
 * other user's live outputs would otherwise be replayed to the next user.
 * Mirror: agents/providers/demo_cache/context.py::WRITE_THROUGH_USER_IDS.
 */
const FAST_MODE_WRITE_THROUGH_USER_IDS = new Set([
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy
  '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', // Tamy
]);

const READ_ONLY_FLAG_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Authoritative read-only cache mode for this process. Same flag and values as
 * the Python worker (`cache_writes_disabled`); pre-deploy shared-cache batches
 * set it so live fallbacks can never be recorded into the shared prod cache.
 */
export function demoCacheWritesDisabled(): boolean {
  const raw = demoCacheEnv('DEMO_CACHE_DISABLE_WRITE_THROUGH') ?? '';
  return READ_ONLY_FLAG_VALUES.has(raw.trim().toLowerCase());
}

export function demoCacheWriteEnabled(demoCacheReadEnabled: boolean): boolean {
  return demoCacheReadEnabled && !demoCacheWritesDisabled();
}

export function shouldWriteDemoCacheForUser(userId: string | null | undefined): boolean {
  return userId !== null && userId !== undefined && FAST_MODE_WRITE_THROUGH_USER_IDS.has(userId);
}

export function resolveFastModeWriteEnabled(
  fastModeCacheEnabled: boolean | undefined,
  userId: string | null | undefined
): boolean {
  if (fastModeCacheEnabled === false || demoCacheWritesDisabled()) {
    return false;
  }
  return shouldWriteDemoCacheForUser(userId);
}
