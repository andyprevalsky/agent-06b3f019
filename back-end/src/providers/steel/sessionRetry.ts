/** Shared Steel session-create retry budget + backoff. */

export const MAX_SESSION_RETRIES = 5;

/** Backoff between Steel create attempts so transient connection flakes can clear. */
export function sleepBeforeSteelRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(2_000, 250 * 2 ** (attempt - 1));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
