/**
 * Typed error taxonomy for the Rose client.
 *
 * Mirrors agents/providers/rose/errors.py. Errors are classified by *cause*
 * (auth/rate-limit/invalid-request/server/stall), not provider response
 * code, so callers can branch on a single vocabulary across Anthropic and
 * OpenRouter.
 */

export class RoseError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RoseError';
    this.status = status;
  }
}

export class RoseAuthError extends RoseError {
  /**
   * True only when the provider said this grant was REVOKED, as opposed to any
   * other auth failure. Carried here because the completion path is where grant
   * death is observed (real traffic, no scheduled probes), while the decision to
   * mint a replacement is taken by the caller.
   *
   * Deliberately NOT inferred from the status code: revocation arrives as both
   * 401 and 403 with the reason only in the body, so a status-only check reports
   * a revoked grant as healthy. See `classifyComputeGrantFailure`.
   */
  readonly grantRevoked: boolean;

  constructor(message: string, status?: number, grantRevoked = false) {
    super(message, status);
    this.name = 'RoseAuthError';
    this.grantRevoked = grantRevoked;
  }
}

export class RoseRateLimitError extends RoseError {
  /**
   * The provider's OWN reset time for this credential (ISO-8601 UTC), when it
   * gave us one — from `anthropic-ratelimit-*-reset` / `retry-after` / the error
   * body. Undefined means the provider told us nothing, and only then may a
   * caller substitute a synthetic cooldown. Threading this through is what stops
   * a 5-minute default from overwriting a real multi-day usage window.
   */
  rateLimitedUntil?: string;
  constructor(message: string, status?: number, rateLimitedUntil?: string) {
    super(message, status);
    this.name = 'RoseRateLimitError';
    this.rateLimitedUntil = rateLimitedUntil;
  }
}

export class RoseInvalidRequest extends RoseError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'RoseInvalidRequest';
  }
}

export class RoseServerError extends RoseError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'RoseServerError';
  }
}

/**
 * HTTP 402 — the credential is out of credits/quota (e.g. an exhausted
 * Anthropic API key). Distinct from rate-limit (429): it won't clear on a short
 * retry, so callers should back the credential off for a while rather than
 * hammer it. Falls through like the other typed errors.
 */
export class RosePaymentRequiredError extends RoseError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'RosePaymentRequiredError';
  }
}

export class RoseStallError extends RoseError {
  constructor(message: string) {
    super(message);
    this.name = 'RoseStallError';
  }
}

export class RoseRefusalError extends RoseError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'RoseRefusalError';
  }
}

export class RoseDeadlineError extends RoseError {
  constructor(message: string) {
    super(message);
    this.name = 'RoseDeadlineError';
  }
}

export interface RoseStepError {
  model: string;
  error: RoseError;
}

export class RoseAllFailed extends RoseError {
  stepErrors: RoseStepError[];
  constructor(message: string, stepErrors: RoseStepError[]) {
    super(message);
    this.name = 'RoseAllFailed';
    this.stepErrors = stepErrors;
  }
}

/**
 * Errors that mean "claudeAuth failed before first content; try waterfall."
 * Matches _FALL_THROUGH_ERRORS in agents/providers/rose/client.py.
 */
export function isFallThroughError(err: unknown): boolean {
  return (
    err instanceof RoseInvalidRequest ||
    err instanceof RoseStallError ||
    err instanceof RoseServerError ||
    err instanceof RoseAuthError ||
    err instanceof RoseRateLimitError ||
    err instanceof RosePaymentRequiredError ||
    err instanceof RoseRefusalError
  );
}
