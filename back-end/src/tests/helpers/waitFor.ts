/**
 * Canonical condition wait and controlled clock for backend tests.
 *
 * A fixed `await sleep(200)` used as synchronization passes on an idle host and
 * fails under CPU load. Wait for the observable condition instead:
 *
 *   const row = await waitFor('agent row persisted', () => findAgent(id), { timeoutMs: 10_000 });
 *
 * State flow:
 *
 *   probe ──truthy──▶ resolve(value)
 *     │ undefined / null / false (or an ignored error)
 *     ▼
 *   deadline passed? ──yes──▶ WaitTimeoutError(last observed value / error)
 *     │ no
 *     ▼
 *   clock.sleep(min(interval, remaining)), interval = min(interval * backoff, max) ──▶ probe
 *
 * The probe runs at least once and once more at the deadline. Tests that do
 * deadline arithmetic inject `FakeClock`: its `sleep` advances time without
 * waiting, so a 15-minute scenario cannot be shifted by host load.
 * `scripts/check_test_sleeps.py` rejects new literal sleeps in test files.
 */

export interface WaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** Time moves only through `advance` or `sleep`; `sleep` resolves on the next microtask. */
export class FakeClock implements WaitClock {
  readonly sleeps: number[] = [];
  private current: number;

  constructor(startMs = 1_700_000_000_000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error('FakeClock cannot move backwards');
    this.current += ms;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.advance(Math.max(0, ms));
  }
}

export interface WaitForOptions {
  timeoutMs?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  backoff?: number;
  /** Return true for errors that mean "not ready yet"; others reject immediately. */
  ignoreError?: (error: unknown) => boolean;
  clock?: WaitClock;
}

const REPR_LIMIT = 2000;
const NOT_OBSERVED: unique symbol = Symbol('not observed');

function describeValue(value: unknown): string {
  let text: string;
  try {
    text = value instanceof Error ? `${value.name}: ${value.message}` : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = text ?? String(value);
  return text.length > REPR_LIMIT
    ? `${text.slice(0, REPR_LIMIT)}... [${text.length - REPR_LIMIT} more chars]`
    : text;
}

export class WaitTimeoutError extends Error {
  constructor(
    readonly description: string,
    readonly timeoutMs: number,
    readonly attempts: number,
    readonly lastValue: unknown,
    readonly lastError: unknown
  ) {
    let observed: string;
    if (lastError !== undefined) observed = `last error ${describeValue(lastError)}`;
    else if (lastValue === NOT_OBSERVED) observed = 'no observation';
    else observed = `last value ${describeValue(lastValue)}`;
    super(
      `Timed out after ${timeoutMs}ms waiting for ${description} (${attempts} checks; ${observed})`
    );
    this.name = 'WaitTimeoutError';
  }
}

type Pending = undefined | null | false;

/**
 * Poll `probe` until it returns a value other than undefined/null/false and
 * resolve with that value. A number as the third argument is `timeoutMs`.
 */
export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | Pending> | T | Pending,
  options: number | WaitForOptions = {}
): Promise<T> {
  const opts: WaitForOptions = typeof options === 'number' ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const maxIntervalMs = opts.maxIntervalMs ?? 250;
  const backoff = opts.backoff ?? 2;
  const clock = opts.clock ?? systemClock;
  const initialIntervalMs = opts.initialIntervalMs ?? 10;
  if (timeoutMs < 0) throw new Error('timeoutMs must be >= 0');
  if (initialIntervalMs <= 0 || maxIntervalMs <= 0) throw new Error('intervals must be > 0');
  if (backoff < 1) throw new Error('backoff must be >= 1');
  const deadline = clock.now() + timeoutMs;
  let attempts = 0;
  let lastValue: unknown = NOT_OBSERVED;
  let lastError: unknown = undefined;

  // Recursive poll (not while + setTimeout): matches the backend's
  // no-restricted-syntax ban on hand-rolled retry loops.
  const poll = async (intervalMs: number): Promise<T> => {
    attempts += 1;
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value as T;
      lastValue = value;
      lastError = undefined;
    } catch (error) {
      if (!opts.ignoreError?.(error)) throw error;
      lastError = error;
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      throw new WaitTimeoutError(description, timeoutMs, attempts, lastValue, lastError);
    }
    await clock.sleep(Math.min(intervalMs, remaining));
    return poll(Math.min(intervalMs * backoff, maxIntervalMs));
  };
  return poll(initialIntervalMs);
}
