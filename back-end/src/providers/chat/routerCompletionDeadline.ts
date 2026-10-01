/**
 * Router stream bounds.
 *
 * The router needs a complete decision, and its only serving path while the
 * Cerebras primary stalls is the Rose OpenRouter failover. On the 30-message,
 * 24k-token prod router request from agent e8f2279b (2026-10-01, n=24, timed
 * from the turn start) that failover emitted first content at p50 1.8s / p90
 * 3.8s / max 8.6s, never paused more than ~0.4s between chunks, and closed the
 * decision in 4.1–19.1s (p50 6.0s, p90 10.7s). A whole-completion bound sized
 * for the healthy primary (3s) killed every failover attempt. The completion
 * cap holds only while the failover picks GLM hosts by throughput
 * (OPENROUTER_FAST_CHAT_PROVIDER): on the slow hosts that price-weighted
 * routing favors, the same request finished at p90 16.6s.
 *
 * - stall: no content/reasoning progress for this long (hung provider).
 *   Reasoning counts: the router streams it to the user as the thinking row.
 * - completion: hard cap on one attempt even while it keeps dribbling
 */

export const DEFAULT_CHAT_ROUTER_STALL_TIMEOUT_MS = 5_000;
export const DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS = 15_000;

export type RouterCompletionExpiry = 'stall' | 'completion';

export interface RouterCompletionBounds {
  stallTimeoutMs: number;
  completionTimeoutMs: number;
}

export interface RouterCompletionDeadline {
  signal: AbortSignal;
  expired(): boolean;
  expiry(): RouterCompletionExpiry | null;
  /** Re-arm the stall bound after the stream made real progress. */
  progress(): void;
  dispose(): void;
}

function positiveEnvMs(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

export function chatRouterCompletionBounds(): RouterCompletionBounds {
  const completionTimeoutMs = positiveEnvMs(
    'CHAT_ROUTER_COMPLETION_TIMEOUT_MS',
    DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS
  );
  return {
    stallTimeoutMs: Math.min(
      positiveEnvMs('CHAT_ROUTER_STALL_TIMEOUT_MS', DEFAULT_CHAT_ROUTER_STALL_TIMEOUT_MS),
      completionTimeoutMs
    ),
    completionTimeoutMs,
  };
}

export function createRouterCompletionDeadline(
  bounds: RouterCompletionBounds
): RouterCompletionDeadline {
  const controller = new AbortController();
  let expiry: RouterCompletionExpiry | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    clearTimeout(stallTimer);
    clearTimeout(completionTimer);
  };
  const expire = (kind: RouterCompletionExpiry, message: string): void => {
    if (expiry !== null) return;
    expiry = kind;
    clearTimers();
    controller.abort(new Error(message));
  };
  const armStall = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => expire('stall', `Chat router stream made no progress for ${bounds.stallTimeoutMs}ms`),
      bounds.stallTimeoutMs
    );
  };
  const completionTimer = setTimeout(
    () => expire('completion', `Chat router completion exceeded ${bounds.completionTimeoutMs}ms`),
    bounds.completionTimeoutMs
  );
  armStall();

  return {
    signal: controller.signal,
    expired: () => expiry !== null,
    expiry: () => expiry,
    progress: () => {
      if (expiry === null) armStall();
    },
    dispose: clearTimers,
  };
}

function nextBeforeDeadline<T>(
  iterator: AsyncIterator<T>,
  deadline: RouterCompletionDeadline
): Promise<IteratorResult<T>> {
  if (deadline.signal.aborted) {
    return Promise.reject(deadline.signal.reason ?? new Error('Chat router completion expired'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      deadline.signal.removeEventListener('abort', onAbort);
      reject(deadline.signal.reason ?? new Error('Chat router completion expired'));
    };
    deadline.signal.addEventListener('abort', onAbort, { once: true });
    void iterator.next().then(
      (result) => {
        deadline.signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        deadline.signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/** Enforce the deadline even if a provider ignores its AbortSignal. */
export async function* streamBeforeRouterCompletionDeadline<T>(
  stream: AsyncIterable<T>,
  deadline: RouterCompletionDeadline
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    for (;;) {
      const result = await nextBeforeDeadline(iterator, deadline);
      if (result.done) {
        exhausted = true;
        return;
      }
      yield result.value;
    }
  } catch (error) {
    if (!deadline.expired()) throw error;
  } finally {
    deadline.dispose();
    if (!exhausted && iterator.return) {
      void Promise.resolve(iterator.return()).catch(() => undefined);
    }
  }
}
