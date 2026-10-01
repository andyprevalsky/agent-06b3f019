/**
 * Router stream bound: one deadline per router attempt, the chat timeout from
 * the attempt's start, with no shorter no-progress bound inside it.
 *
 * The router needs a complete decision, and while the Cerebras primary stalls
 * its serving path is the Rose OpenRouter failover, whose time to first
 * content grows with the router context. On the 30-message, 24k-token prod
 * router request from agent e8f2279b (2026-10-01, n=24, timed from the turn
 * start) the failover emitted first content at p50 1.8s / p90 3.8s / max 8.6s
 * and closed the decision in 4.1–19.1s (p50 6.0s, p90 10.7s); the previous
 * 3s bound killed every one. The bound holds only while each failover request
 * picks its GLM host by throughput (OPENROUTER_FAST_CHAT_PROVIDER, fresh
 * session per request): pinned to a slow host that price-weighted routing
 * favors, the same request finished at p90 16.6s.
 */

import { CHAT_TIMEOUT_MS } from '../rose/cerebrasRoute';

export const DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS = CHAT_TIMEOUT_MS;

export interface RouterCompletionDeadline {
  signal: AbortSignal;
  expired(): boolean;
  dispose(): void;
}

export function chatRouterCompletionTimeoutMs(): number {
  const configured = Number(process.env.CHAT_ROUTER_COMPLETION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS;
}

export function createRouterCompletionDeadline(timeoutMs: number): RouterCompletionDeadline {
  const controller = new AbortController();
  let didExpire = false;
  const timer = setTimeout(() => {
    didExpire = true;
    controller.abort(new Error(`Chat router completion exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    expired: () => didExpire,
    dispose: () => clearTimeout(timer),
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
