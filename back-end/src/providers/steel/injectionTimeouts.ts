/** Timeout helpers for browser state/credential injection. */

const DEFAULT_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_BROWSER_STATE_INJECTION_TIMEOUT_MS = 15_000;

/** Node stores a timer delay in a signed 32-bit int. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * `setTimeout` silently collapses a fractional or out-of-range delay to 1ms, so
 * `0.5` or `2147483648` would make injection "time out" almost immediately.
 * Accept only positive integers inside the timer range; anything else falls
 * back to the default.
 */
function timerDelayFromEnv(raw: string | undefined, fallbackMs: number): number {
  const configured = Number(raw);
  const usable = Number.isInteger(configured) && configured > 0 && configured <= MAX_TIMER_DELAY_MS;
  return usable ? configured : fallbackMs;
}

export function credentialCdpConnectTimeoutMs(): number {
  return timerDelayFromEnv(
    process.env.BROWSER_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS,
    DEFAULT_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS
  );
}

export function browserStateInjectionTimeoutMs(): number {
  return timerDelayFromEnv(
    process.env.BROWSER_STATE_INJECTION_TIMEOUT_MS,
    DEFAULT_BROWSER_STATE_INJECTION_TIMEOUT_MS
  );
}

/** Distinguishes "we ran out of time" from a genuine injection failure. */
export class BrowserStateInjectionTimeout extends Error {
  readonly isBrowserStateInjectionTimeout = true;
  constructor(message: string) {
    super(message);
    this.name = 'BrowserStateInjectionTimeout';
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserStateInjectionTimeout(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
