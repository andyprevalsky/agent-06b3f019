export const DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS = 3_000;

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
