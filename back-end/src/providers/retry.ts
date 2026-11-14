/**
 * Canonical retry utilities.
 *
 * ALL retry/backoff logic in the codebase must use these functions.
 * Hand-rolled retry loops are banned by ESLint no-restricted-syntax
 * rules in eslint.config.mjs.
 *
 * Two flavors:
 *   retryWithBackoff  — for network/API calls with exponential backoff
 *   retryOnCollision  — for unique-constraint collisions (immediate retry)
 */

import { createLogger } from './logger';

const log = createLogger('Retry');

// ── Types ──

export interface RetryOptions<T = unknown> {
  /** Maximum number of attempts (default: 3) */
  maxRetries?: number;
  /** Injectable clock for deterministic callers/tests; defaults to a real timer. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Initial backoff delay in ms (default: 1000). Doubles each attempt. */
  initialBackoffMs?: number;
  /** Fixed backoff delays per attempt. Overrides exponential if provided. */
  fixedDelays?: number[];
  /** Dynamic delay for an error, such as an API-provided absolute retry timestamp. */
  getBackoffDelayMs?: (error: unknown, attempt: number) => number;
  /** HTTP status codes that should trigger a retry (default: 408, 429, 502, 503, 504) */
  retryableStatusCodes?: Set<number>;
  /** Predicate to decide if an error is retryable. Overrides default behavior if provided. */
  isRetryable?: (error: unknown) => boolean;
  /** Predicate to retry a resolved result, such as a transient HTTP response. */
  shouldRetryResult?: (result: T) => boolean | Promise<boolean>;
  /** Cleanup performed before retrying a resolved result, such as draining a response body. */
  beforeRetryResult?: (result: T) => void | Promise<void>;
  /** Component name for log messages (default: 'Retry') */
  component?: string;
}

export interface CollisionRetryOptions {
  /** Maximum collision retry attempts (default: 5) */
  maxAttempts?: number;
  /** Prisma error code that signals a collision (default: 'P2002') */
  collisionCode?: string;
  /** Component name for log messages */
  component?: string;
}

// ── Default retryable status codes ──

export const DEFAULT_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  408, 429, 502, 503, 504,
]);

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Node stores a timer delay in a signed 32-bit int. Anything larger (or NaN, or
 * non-finite) silently collapses to a 1ms timer, which would turn a long
 * rate-limit backoff into a hot retry loop.
 */
export const MAX_BACKOFF_DELAY_MS = 2_147_483_647;

/** Bound a candidate delay to a finite, non-negative, timer-safe value. `null` if unusable. */
function normalizeDelayMs(value: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(Math.max(0, value), MAX_BACKOFF_DELAY_MS);
}

function getBackoffDelay<T>(error: unknown, attempt: number, opts: RetryOptions<T>): number {
  if (opts.getBackoffDelayMs) {
    const dynamic = normalizeDelayMs(opts.getBackoffDelayMs(error, attempt));
    if (dynamic !== null) return dynamic;
    log.warn(
      `${opts.component ?? 'Retry'}: discarding non-finite dynamic backoff delay on attempt ${attempt}, falling back to exponential backoff`
    );
  } else {
    return errorlessBackoffDelay(attempt, opts);
  }
  return errorlessBackoffDelay(attempt, opts);
}

/**
 * The delay schedule that does not depend on an error: `fixedDelays` when the
 * caller configured one, else exponential backoff. Shared by the error and
 * result retry paths so a caller's `fixedDelays` contract cannot apply to one
 * and not the other.
 */
function errorlessBackoffDelay<T>(attempt: number, opts: RetryOptions<T>): number {
  if (opts.fixedDelays && attempt - 1 < opts.fixedDelays.length) {
    const fixed = normalizeDelayMs(opts.fixedDelays[attempt - 1]);
    if (fixed !== null) return fixed;
  }
  const base = normalizeDelayMs(opts.initialBackoffMs ?? 1000) ?? 1000;
  return Math.min(base * Math.pow(2, attempt - 1), MAX_BACKOFF_DELAY_MS);
}

function defaultIsRetryable(error: unknown): boolean {
  // Network errors (fetch throws on connection refused, timeout, etc.)
  if (error instanceof TypeError) return true;
  // Errors with a retryable flag
  if (error instanceof Error && 'retryable' in error)
    return (error as { retryable: boolean }).retryable;
  return false;
}

// ── Exported utilities ──

/**
 * Retry an async operation with exponential backoff.
 *
 * Usage:
 *   const result = await retryWithBackoff(() => fetch(url), {
 *     maxRetries: 3,
 *     initialBackoffMs: 1000,
 *     component: 'SupabaseCompletions',
 *   });
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions<T> = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const component = opts.component ?? 'Retry';
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Only the operation itself belongs in this try. Result-path callbacks run
    // after it so a bug in `shouldRetryResult`/`beforeRetryResult` surfaces as
    // itself instead of being caught below and reclassified as an operation
    // failure (which would discard an already-resolved result).
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries && isRetryable(error)) {
        const delay = getBackoffDelay(error, attempt, opts);
        log.warn(`${component}: attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms`, {
          error: error instanceof Error ? error.message : String(error),
        });
        await (opts.sleep ?? sleep)(delay);
        continue;
      }

      throw error;
    }

    const retryableResult = opts.shouldRetryResult && (await opts.shouldRetryResult(result));

    if (retryableResult && attempt < maxRetries) {
      await opts.beforeRetryResult?.(result);
      // There is no error on the result path, so the dynamic `getBackoffDelayMs`
      // hook is deliberately skipped rather than invoked with `undefined` -- but
      // `fixedDelays` still applies, so share the errorless schedule instead of
      // recomputing only the exponential branch.
      const delay = errorlessBackoffDelay(attempt, opts);
      log.warn(
        `${component}: attempt ${attempt}/${maxRetries} returned a retryable result, retrying in ${delay}ms`
      );
      await (opts.sleep ?? sleep)(delay);
      continue;
    }

    if (!retryableResult && attempt > 1) {
      log.info(`${component}: succeeded on attempt ${attempt}/${maxRetries}`);
    }

    return result;
  }

  throw lastError;
}

/**
 * Retry an operation that may hit a unique-constraint collision (Prisma P2002).
 * No backoff — retries immediately with a new generated value.
 *
 * Usage:
 *   const code = await retryOnCollision(() => createShortcode(), {
 *     maxAttempts: 5,
 *     component: 'SMS Shortcode',
 *   });
 */
export async function retryOnCollision<T>(
  fn: () => Promise<T>,
  opts: CollisionRetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const collisionCode = opts.collisionCode ?? 'P2002';
  const component = opts.component ?? 'Retry';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const isPrismaCollision =
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === collisionCode;

      if (!isPrismaCollision || attempt >= maxAttempts) {
        throw error;
      }

      log.warn(`${component}: collision on attempt ${attempt}/${maxAttempts}, retrying`);
    }
  }

  throw new Error(`${component}: failed to generate unique value after ${maxAttempts} attempts`);
}
