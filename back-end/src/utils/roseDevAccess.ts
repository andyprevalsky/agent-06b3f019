/**
 * Rose dev accounts: the server-side allowlist for Rose-in-Rose (A1) and other
 * Rose Desktop surfaces whose backend must refuse everyone else (403).
 *
 * The ids MUST equal the front-end Rose Desktop flag
 * (`front-end/src/lib/roseDesktop.ts` ROSE_DESKTOP_USER_IDS);
 * `src/tests/structural/rose-dev-access.test.ts` fails the build on drift.
 */
export const ROSE_DEV_USER_IDS: readonly string[] = [
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy
];

/**
 * Extra dev ids from `ROSE_DEV_USER_IDS_EXTRA` (comma-separated) for
 * non-production stacks (local benchmarks, test fixtures). Unset in production.
 * Read per call so a test stack can toggle it without a restart.
 */
function envRoseDevUserIds(): string[] {
  const raw = process.env.ROSE_DEV_USER_IDS_EXTRA;
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function isRoseDevUser(userId: string | null | undefined): boolean {
  if (typeof userId !== 'string' || userId === '') return false;
  return ROSE_DEV_USER_IDS.includes(userId) || envRoseDevUserIds().includes(userId);
}

/** 403 body for a dev-only route. */
export const ROSE_DEV_ONLY_BODY = {
  error: 'Rose-in-Rose is limited to Rose dev accounts',
  code: 'ROSE_DEV_ONLY',
} as const;
