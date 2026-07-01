const FAST_MODE_WRITE_THROUGH_USER_IDS = new Set(['1f85ff25-6e29-4c1b-8739-f917bd101a30']);

export function shouldWriteFastModeCacheForUser(userId: string | null | undefined): boolean {
  return userId !== null && userId !== undefined && FAST_MODE_WRITE_THROUGH_USER_IDS.has(userId);
}
