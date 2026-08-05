/** Timeout helpers for browser state/credential injection. */

const DEFAULT_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_BROWSER_STATE_INJECTION_TIMEOUT_MS = 15_000;

export function credentialCdpConnectTimeoutMs(): number {
  const configured = Number(process.env.BROWSER_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS;
}

export function browserStateInjectionTimeoutMs(): number {
  const configured = Number(process.env.BROWSER_STATE_INJECTION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_BROWSER_STATE_INJECTION_TIMEOUT_MS;
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
