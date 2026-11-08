/**
 * GitHub rate limits for every backend call made with the server GitHub token.
 *
 *   caller ──githubFetch──► blocked? ──yes, reset beyond the wait budget──► GithubRateLimitedError
 *                              │                                            (GitHub is never called)
 *                              └─ no / short ──► GitHub ──403|429 limit──► block until reset
 *                                                                           ├─ GET/HEAD, fits budget: wait, retry
 *                                                                           └─ otherwise: GithubRateLimitedError
 *
 * Every code-agent path shares ONE token and therefore one GitHub bucket, so
 * the block is process-wide: the first limited response stops every later call
 * until the reset GitHub reported, instead of each request finding out for
 * itself (2026-10-28: repo creates kept a secondary limit alive for hours).
 *
 * Classification follows GitHub's documented rules
 * (docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api):
 *  - 403/429 with `retry-after`: do not retry until that many seconds passed;
 *  - 403/429 with `x-ratelimit-remaining: 0`: do not retry before `x-ratelimit-reset`;
 *  - a secondary-limit 403 with neither: wait at least a minute. GitHub identifies
 *    this one only by its message, so the JSON `message` is read for that single
 *    case (and only for a 403); every other signal is status and headers. A 429 is
 *    always a limit.
 *
 * A write (POST/PATCH/PUT/DELETE) that was sent is never retried here; the typed
 * error carries the reset time and the caller decides (CLAUDE.md rule 20).
 *
 * 10k agents: once limited, every call fails fast on the in-memory block with no
 * GitHub traffic and no waiting; only blocks that end within the wait budget
 * are waited out, and at most three attempts are made per call.
 */
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';

const log = createLogger('GithubRateLimit');

export type GithubRateLimitKind = 'primary' | 'secondary';

export interface GithubRateLimitInfo {
  kind: GithubRateLimitKind;
  status: number;
  /** Epoch ms before which GitHub must not be called again with this token. */
  resetAtMs: number;
  /** `x-ratelimit-resource` (core, search, ...), when GitHub sent it. */
  resource: string | null;
}

/** GitHub: "wait for at least one minute" when a secondary limit names no reset. */
const SECONDARY_DEFAULT_WAIT_MS = 60_000;
/** `x-ratelimit-reset` has one-second granularity; never retry exactly on the edge. */
const WAIT_BUFFER_MS = 1_000;
const MAX_ATTEMPTS = 3;
/** Longest one call may spend waiting out a limit (session create has a 60s client timeout). */
const DEFAULT_MAX_WAIT_MS = Number(process.env.GITHUB_RATE_LIMIT_MAX_WAIT_MS ?? 15_000);

export function githubApiBase(): string {
  return (process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
}

export class GithubRateLimitedError extends Error {
  readonly code = 'GITHUB_RATE_LIMITED';

  constructor(
    readonly info: GithubRateLimitInfo,
    /** True when the request reached GitHub; false when the block stopped it first. */
    readonly sent: boolean = true
  ) {
    super(
      `GitHub rate limit reached (${info.kind}${info.resource ? `, ${info.resource}` : ''}); ` +
        `retry after ${new Date(info.resetAtMs).toISOString()}.`
    );
    this.name = 'GithubRateLimitedError';
  }

  /** ISO-8601 UTC time GitHub allows the next call. */
  get resetAt(): string {
    return new Date(this.info.resetAtMs).toISOString();
  }

  retryAfterSeconds(nowMs: number = Date.now()): number {
    return Math.max(1, Math.ceil((this.info.resetAtMs - nowMs) / 1000));
  }
}

function retryAfterMs(headers: Headers, nowMs: number): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

function namesSecondaryLimit(bodyText: string): boolean {
  try {
    const message = (JSON.parse(bodyText) as { message?: unknown }).message;
    return typeof message === 'string' && message.toLowerCase().includes('secondary rate limit');
  } catch {
    return false;
  }
}

/** The limit a 403/429 response reports, or null when it is not a rate limit. */
export function classifyGithubRateLimit(
  status: number,
  headers: Headers,
  bodyText: string,
  nowMs: number = Date.now()
): GithubRateLimitInfo | null {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = retryAfterMs(headers, nowMs);
  const exhausted = headers.get('x-ratelimit-remaining') === '0';
  const resetEpochS = Number(headers.get('x-ratelimit-reset'));
  const resetKnown = exhausted && Number.isFinite(resetEpochS) && resetEpochS > 0;
  if (retryAfter === null && !resetKnown && status === 403 && !namesSecondaryLimit(bodyText)) {
    return null; // a 403 for another reason (permissions, abuse block, ...)
  }
  const waitMs =
    retryAfter ?? (resetKnown ? resetEpochS * 1000 - nowMs : SECONDARY_DEFAULT_WAIT_MS);
  return {
    kind: exhausted ? 'primary' : 'secondary',
    status,
    resetAtMs: nowMs + Math.max(0, waitMs),
    resource: headers.get('x-ratelimit-resource'),
  };
}

const block = { current: null as GithubRateLimitInfo | null };

/** Remember a limit; a later reset extends the block, an earlier one never shortens it. */
export function noteGithubRateLimit(info: GithubRateLimitInfo): void {
  if (block.current === null || info.resetAtMs > block.current.resetAtMs) block.current = info;
}

/** The limit still in force, or null. */
export function activeGithubRateLimit(nowMs: number = Date.now()): GithubRateLimitInfo | null {
  const current = block.current;
  return current !== null && nowMs < current.resetAtMs ? current : null;
}

/** Test hook: drop the process-wide block between cases. */
export function resetGithubRateLimitStateForTests(): void {
  block.current = null;
}

export interface GithubRequestOptions {
  fetchImpl?: typeof fetch;
  /** Longest this call may wait for a limit to end; 0 never waits. Default 15s. */
  maxWaitMs?: number;
  component?: string;
}

/**
 * fetch for GitHub with the rate-limit rules above. Resolves with the response
 * (any status except a rate limit); rejects with GithubRateLimitedError when the
 * limit outlasts the wait budget or a sent write was limited.
 */
export async function githubFetch(
  url: string,
  init: RequestInit = {},
  options: GithubRequestOptions = {}
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const method = (init.method ?? 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'HEAD';
  const deadlineMs = Date.now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const fitsBudget = (error: GithubRateLimitedError): boolean =>
    error.info.resetAtMs + WAIT_BUFFER_MS <= deadlineMs;

  return retryWithBackoff(
    async () => {
      const blocked = activeGithubRateLimit();
      if (blocked !== null) throw new GithubRateLimitedError(blocked, false);
      const response = await fetchImpl(url, init);
      let bodyText = '';
      if (response.status === 403 || response.status === 429) {
        bodyText = await response.clone().text();
      }
      const info = classifyGithubRateLimit(response.status, response.headers, bodyText);
      if (info === null) return response;
      noteGithubRateLimit(info);
      log.warn('GitHub rate limited', {
        url: new URL(url).pathname,
        method,
        kind: info.kind,
        status: info.status,
        resetAt: new Date(info.resetAtMs).toISOString(),
      });
      throw new GithubRateLimitedError(info);
    },
    {
      maxRetries: MAX_ATTEMPTS,
      component: options.component ?? 'GithubFetch',
      // A blocked call was never sent, so waiting and sending it is its first
      // attempt; a sent write is never replayed. Reads may be retried.
      isRetryable: (error) =>
        error instanceof GithubRateLimitedError && (!error.sent || idempotent) && fitsBudget(error),
      getBackoffDelayMs: (error) =>
        error instanceof GithubRateLimitedError
          ? Math.max(0, error.info.resetAtMs - Date.now()) + WAIT_BUFFER_MS
          : 0,
    }
  );
}
