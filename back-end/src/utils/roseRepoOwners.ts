/**
 * Accounts that own the private Rose-Ai-Labs/rose repository and get its Rose
 * project and clone grant out of the box (rose-builds-rose PJ4). Deliberately
 * its own explicit list: adding a Rose Desktop pilot or a Rose-in-Rose dev
 * account never grants repository access.
 */
export const ROSE_REPO_OWNER_USER_IDS: readonly string[] = [
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy
];

export function isRoseRepoOwner(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && userId !== '' && ROSE_REPO_OWNER_USER_IDS.includes(userId);
}
