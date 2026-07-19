/**
 * SMS Supervisor resilience helpers.
 *
 * Small, generic wrappers that keep a transient failure from escaping the
 * supervisor loop into the webhook's top-level catch (which fires the generic
 * "something went wrong" SMS). Kept separate from supervisorHandler.ts so the
 * retry/guard policy is unit-testable without a live LLM/socket and the handler
 * stays under its line budget.
 */

import type { ToolResult } from './supervisorTools';

/**
 * Retry an idempotent async op that may throw transiently, with exponential
 * backoff. Returns the first success; rethrows the last error only after every
 * attempt fails.
 *
 * Used for the round's LLM call: Rose already races providers internally, so the
 * residual throw class (peer-closed / [NO END] mid-stream, socket timeout, a
 * stray 429) is transient — retrying turns "Sorry, something went wrong" into a
 * real answer. `sleep` is injectable so tests run without real delay.
 */
export async function callWithRetries<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    attempts: number;
    baseDelayMs: number;
    onRetry?: (attempt: number, error: unknown) => void;
    sleep?: (ms: number) => Promise<void>;
    // When aborted (run superseded by a newer inbound, or /clear), stop
    // retrying immediately rather than burning the remaining attempts + backoff
    // on a request whose result will be discarded anyway.
    signal?: AbortSignal;
  }
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted before attempt');
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      // Don't retry a run that has already been aborted/superseded.
      if (opts.signal?.aborted || attempt >= opts.attempts) break;
      opts.onRetry?.(attempt, error);
      await sleep(opts.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/**
 * Run a tool dispatch, converting a THROWN error into a failure ToolResult
 * instead of letting it escape the supervisor loop. A thrown tool/environment
 * error (e.g. a Prisma blip in refreshEnvironmentSnapshot) would otherwise
 * propagate all the way to the webhook's top-level catch and fire the generic
 * "something went wrong" SMS; as a failure result it's fed back to the model as
 * a normal tool error so it can recover or apologize contextually.
 */
export async function dispatchToolSafely(
  tool: string,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    return {
      tool,
      success: false,
      result: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
