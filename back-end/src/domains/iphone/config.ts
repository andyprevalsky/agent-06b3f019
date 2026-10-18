// Identity comes from the persisted, authenticated account, never request feature flags.
export const ALLOWED_ACCOUNT_IDS = ['c49b4ce3-3489-499d-bfbd-846d04ba6275'] as const;
export const ALLOWED_VERIFIED_PHONES: readonly string[] = ['+19729777432'];
export const QUEUE_TIMEOUT_MS = 300_000;
export const LEASE_TIMEOUT_MS = 120_000;
export const TERMINAL_AGENT_STATUSES = [
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
] as const;

export function permitted(
  user: { userId: string; phone: string | null; isAnonymous: boolean } | null
): boolean {
  if (user === null) return false;
  if (ALLOWED_ACCOUNT_IDS.some((id) => id === user.userId)) return true;
  return !user.isAnonymous && user.phone !== null && ALLOWED_VERIFIED_PHONES.includes(user.phone);
}
export const AUTH_REJECTED_RESPONSE = '__REJECTED__';

export function deadlineElapsed(deadline: Date | null, now: Date): boolean {
  return deadline === null || deadline.getTime() <= now.getTime();
}
