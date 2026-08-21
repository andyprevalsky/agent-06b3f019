/**
 * Cache a capability probe only after it succeeds.
 *
 * Concurrent callers share the same in-flight attempt, but a rejected attempt
 * is evicted so a transient database failure cannot poison the process for the
 * rest of the seed run.
 */
export function createRetryableProbe<T>(probe: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;

  return () => {
    if (cached !== undefined) return cached;

    const attempt = probe();
    cached = attempt;
    void attempt.catch(() => {
      if (cached === attempt) cached = undefined;
    });
    return attempt;
  };
}
