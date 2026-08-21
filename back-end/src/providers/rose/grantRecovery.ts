/**
 * Registration seam for compute-grant recovery on the completion path.
 *
 * WHY A HOOK RATHER THAN A DIRECT IMPORT
 * --------------------------------------
 * The recovery implementation lives in the compute-grants domain, which reaches
 * the database and (in production) a browser. The rose provider must not depend
 * on either -- it is the lowest layer and is exercised by tests that have no DB.
 * Registering a hook at bootstrap keeps that dependency pointing one way.
 *
 * WHEN NOTHING IS REGISTERED the completion path behaves exactly as it did
 * before: a revoked grant falls through to the waterfall. Recovery is strictly
 * an upgrade, never a new failure mode.
 */

export interface GrantRecoveryRequest {
  userId: string;
  provider: 'claude' | 'codex';
  accountId: string;
  grantId?: string;
  /** HTTP status observed from the provider. */
  status: number;
  /** Raw error body -- revocation is decided from this, not the status. */
  body: string;
}

export interface GrantRecoveryResult {
  /** A replacement token when recovery succeeded; absent otherwise. */
  accessToken?: string;
  /** Machine-readable outcome, mirrored into logs. */
  status: string;
  reason: string;
}

export type GrantRecoveryHook = (req: GrantRecoveryRequest) => Promise<GrantRecoveryResult>;

let hook: GrantRecoveryHook | null = null;

/** Wire recovery in at bootstrap. Passing null disables it (used by tests). */
export function registerGrantRecovery(next: GrantRecoveryHook | null): void {
  hook = next;
}

export function getGrantRecovery(): GrantRecoveryHook | null {
  return hook;
}

/**
 * Attempt recovery, converting any failure into "no token".
 *
 * Recovery is best-effort by construction: if it throws, the caller must still
 * fall through to the waterfall rather than fail the user's request. A broken
 * re-minter degrades cost, never availability.
 */
export async function tryRecoverGrant(
  req: GrantRecoveryRequest
): Promise<GrantRecoveryResult | null> {
  const current = hook;
  if (current === null) return null;
  try {
    return await current(req);
  } catch (err) {
    return {
      status: 'recovery_threw',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
