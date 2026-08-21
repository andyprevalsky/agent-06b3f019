/**
 * Classification of compute-grant failures observed on the Rose completion path.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 * -----------------------------------
 * Liveness of a compute grant is detected from REAL traffic -- when an agent
 * actually uses the token -- not from scheduled probes. That makes this function
 * the single decision point for "is this grant dead, and should we re-mint it?",
 * so it is worth isolating and testing exhaustively.
 *
 * THE TWO MISTAKES THIS EXISTS TO PREVENT
 * ---------------------------------------
 * 1. Treating a RATE LIMIT as a dead grant. A 429 (including a far-future 5h/7d
 *    usage window) means "come back later", NOT "this credential is finished".
 *    Re-minting on a 429 would burn a fresh grant on every rate limit and hide
 *    the real problem. This repo has already been bitten by the mirror-image bug,
 *    where a far-future usage window caused credential rotation.
 *
 * 2. Deciding on the STATUS CODE alone. Anthropic signals revocation as a 401 AND
 *    as a 403 with the reason only in the body, so `status !== 401` reports a
 *    revoked grant as healthy -- suppressing the very re-mint that would fix it.
 *    Revocation is therefore matched on the BODY, and 403 is included.
 *
 * Measured strings (2026-08-18, live endpoints):
 *   401 {"type":"error","error":{"type":"authentication_error",
 *        "message":"OAuth access token has been revoked."}}
 *   400 {"error":"invalid_grant",
 *        "error_description":"Refresh token not found or invalid"}
 */

export type ComputeGrantVerdict =
  /** Grant is permanently unusable. Re-mint from the account connection. */
  | 'revoked'
  /** Temporarily throttled. The grant is FINE -- never re-mint on this. */
  | 'rate_limited'
  /** Account is out of credits/quota. Grant is valid; re-minting won't help. */
  | 'payment_required'
  /** Authentication failed for a reason that is not revocation (e.g. bad scope). */
  | 'auth_other'
  /** Not a grant failure at all. */
  | 'not_a_grant_failure';

export interface ComputeGrantFailure {
  verdict: ComputeGrantVerdict;
  /** True only when the correct response is to mint a replacement grant. */
  shouldRemint: boolean;
  /** Human-readable justification, for logs and the lineage ledger. */
  reason: string;
}

/**
 * Body markers that mean the grant itself has been destroyed server-side.
 * Sourced from live responses plus the official clients' own terminal-error sets
 * (`refresh_token_*` are Codex's first-class revocation codes).
 */
const REVOKED_MARKERS: RegExp[] = [
  /oauth (?:access )?token has been revoked/i,
  /\btoken_revoked\b/i,
  /refresh token (?:was )?revoked/i,
  /refresh token not found or invalid/i,
  /\brefresh_token_invalidated\b/i,
  /\brefresh_token_reused\b/i,
  /\brefresh_token_expired\b/i,
  /\binvalid_refresh_token\b/i,
  /\binvalid_grant\b/i,
  /your session has ended/i,
  /log ?out and sign in again/i,
];

/** Markers meaning "account can't pay", which a new grant would not fix. */
const PAYMENT_MARKERS: RegExp[] = [
  /credit balance is too low/i,
  /out of credits/i,
  /purchase credits/i,
  /usage limit reached/i,
  /\busage_limit_reached\b/i,
];

export interface ClassifyInput {
  status: number;
  /** Raw response body. May be empty; classification must not require it. */
  body?: string;
}

/**
 * Decide what a failed compute-grant call means.
 *
 * Ordering is deliberate: rate limiting and payment are checked BEFORE
 * revocation, because their bodies can contain overlapping language and
 * mis-ranking them is exactly how a throttle turns into a spurious re-mint.
 */
export function classifyComputeGrantFailure(input: ClassifyInput): ComputeGrantFailure {
  const body = input.body ?? '';
  const { status } = input;

  if (status >= 200 && status < 300) {
    return {
      verdict: 'not_a_grant_failure',
      shouldRemint: false,
      reason: `success (${status})`,
    };
  }

  // (1) Throttling first, and unconditionally. A 429 NEVER means a dead grant,
  // no matter how far in the future the reset is.
  if (status === 429) {
    return {
      verdict: 'rate_limited',
      shouldRemint: false,
      reason: 'rate limited (429) -- grant is healthy, retry or rotate, never re-mint',
    };
  }

  // (2) Out of credits. The credential is valid; a fresh grant on the same
  // account would fail identically, so re-minting is pure waste.
  if (status === 402 || PAYMENT_MARKERS.some((re) => re.test(body))) {
    return {
      verdict: 'payment_required',
      shouldRemint: false,
      reason: `payment/quota exhausted (${status}) -- a new grant would not help`,
    };
  }

  // (3) Revocation, matched on the BODY so 401 and 403 are both caught.
  if (REVOKED_MARKERS.some((re) => re.test(body))) {
    return {
      verdict: 'revoked',
      shouldRemint: true,
      reason: `grant revoked (${status}) -- mint a replacement from the account connection`,
    };
  }

  // (4) Auth failure with no revocation marker. Do NOT re-mint blindly: an
  // unrecognised auth error is more likely a scope/config bug, and re-minting
  // would loop while hiding it.
  if (status === 401 || status === 403) {
    return {
      verdict: 'auth_other',
      shouldRemint: false,
      reason:
        `auth failed (${status}) without a revocation marker -- ` +
        'not re-minting; investigate scope/config',
    };
  }

  return {
    verdict: 'not_a_grant_failure',
    shouldRemint: false,
    reason: `status ${status} is not a grant failure`,
  };
}
