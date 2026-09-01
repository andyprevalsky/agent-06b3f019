const FAST_MODE_WRITE_THROUGH_USER_IDS = new Set([
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy
  '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', // Tamy
]);

export function shouldWriteFastModeCacheForUser(userId: string | null | undefined): boolean {
  return userId !== null && userId !== undefined && FAST_MODE_WRITE_THROUGH_USER_IDS.has(userId);
}

export function resolveFastModeWriteEnabled(
  fastModeCacheEnabled: boolean | undefined,
  userId: string | null | undefined
): boolean {
  if (fastModeCacheEnabled === false) {
    return false;
  }
  return fastModeCacheEnabled === true || shouldWriteFastModeCacheForUser(userId);
}
