import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../geoip';
import { retryWithBackoff } from '../retry';
import { persistBrowserSessionRow } from '../browser/sessionPersist';
import { log } from './types';
import { steelCdpConnectionUrl } from './urls';

const SESSION_VALIDATION_TIMEOUT = 10000;
const WS_BACKOFF_DELAYS = [100, 400, 800];
export const STEEL_CDP_TIMEOUT_MESSAGE = 'Steel CDP connection timeout';

/**
 * Playwright CDP errors can embed the credential-bearing connect URL. Keep the
 * failure cause for callers and logs, redact any URL, and give every timeout
 * one stable message so replacement can recognize a CDP transport outage.
 */
function safeCdpFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return new Error(STEEL_CDP_TIMEOUT_MESSAGE);
  return new Error(message.replace(/\b(?:wss?|https?):\/\/\S+/gi, '<redacted-url>'));
}

type CdpConnector = (wsUrl: string) => Promise<Browser>;

export type BrowserValidation =
  { browser: Browser; failure: null } | { browser: null; failure: string };

export type SteelConnectionValidationResult =
  | { valid: true }
  | {
      valid: false;
      failureReason:
        | 'Connection timeout'
        | 'Connection error'
        | 'Authentication rejected'
        | 'Session validation failed';
    };

function safeValidationFailureReason(
  error: unknown
): Exclude<SteelConnectionValidationResult, { valid: true }>['failureReason'] {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|\b403\b|unauthorized|forbidden/i.test(message)) {
    return 'Authentication rejected';
  }
  if (/timeout|timed out|etimedout/i.test(message)) return 'Connection timeout';
  if (
    /econnrefused|econnreset|enotfound|eai_again|socket hang up|connection error/i.test(message)
  ) {
    return 'Connection error';
  }
  return 'Session validation failed';
}

/** The provider's terminal verdict for a session, or null while it may still accept CDP. */
export type SessionStartupProbe = () => Promise<string | null>;

class SessionStartupFailedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SessionStartupFailedError';
  }
}

async function connectSteelCdp(wsUrl: string): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(steelCdpConnectionUrl(wsUrl));
}

/**
 * Steel marks a session whose browser never booted `failed` (release reason
 * `startup_failed`) a few seconds after creation, and that session never
 * accepts CDP. A failed status lookup returns null so validation keeps trying.
 */
export function steelStartupProbe(
  sessionId: string,
  retrieve: (id: string) => Promise<{ status: string; releaseReason?: unknown }>
): SessionStartupProbe {
  return async () => {
    try {
      const session = await retrieve(sessionId);
      if (session.status !== 'failed') return null;
      const reason =
        typeof session.releaseReason === 'string' && session.releaseReason !== ''
          ? session.releaseReason
          : 'no release reason';
      return `Steel reported session ${sessionId} failed (${reason})`;
    } catch (error) {
      log.warn('Steel session status lookup failed during validation', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
}

/**
 * Connect to the session via CDP and validate it. On success the OPEN browser
 * connection is returned; callers that keep it (e.g. to reuse it for user-data
 * injection, saving a second 3-5s CDP handshake) are responsible for closing it.
 *
 * `startupProbe` runs before each retry: once the provider has declared the
 * session dead, the remaining connect timeouts are skipped and its verdict is
 * returned as the failure.
 */
export async function validateBrowserConnection(
  wsUrl: string,
  options: {
    startupProbe?: SessionStartupProbe;
    connect?: (wsUrl: string) => Promise<Browser>;
  } = {}
): Promise<BrowserValidation> {
  const connect = options.connect ?? connectSteelCdp;
  let attempts = 0;
  let connected: Browser | undefined;
  try {
    await retryWithBackoff(
      async () => {
        attempts += 1;
        if (attempts > 1 && options.startupProbe !== undefined) {
          const startupFailure = await options.startupProbe();
          if (startupFailure !== null) throw new SessionStartupFailedError(startupFailure);
        }
        let browser: Browser | undefined;
        let connectTimer: NodeJS.Timeout | undefined;
        try {
          const connecting = connect(wsUrl);
          browser = await Promise.race([
            connecting,
            new Promise<never>((_, reject) => {
              connectTimer = setTimeout(() => {
                // A connect that lands after the timeout must not keep the
                // session's CDP slot (Tilion admits one client; later ones get 4409).
                void connecting.then((late) => late.close()).catch(() => {});
                reject(new Error('Connection timeout'));
              }, SESSION_VALIDATION_TIMEOUT);
            }),
          ]).finally(() => clearTimeout(connectTimer));
          const contexts = browser.contexts();
          if (contexts.length === 0) {
            throw new Error('No browser contexts available');
          }
          const pages = contexts[0].pages();
          log.info(`    [WS] Connected (${contexts.length} context(s), ${pages.length} page(s))`);
          connected = browser;
        } catch (error) {
          if (browser !== undefined) {
            await browser.close().catch(() => {});
          }
          throw safeCdpFailure(error);
        }
      },
      {
        maxRetries: 3,
        fixedDelays: WS_BACKOFF_DELAYS,
        component: 'Steel session validation',
        isRetryable: (error) =>
          !(error instanceof SessionStartupFailedError) &&
          safeValidationFailureReason(error) !== 'Authentication rejected',
      }
    );
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    log.info('  Session validation failed', { error: failure });
    return { browser: null, failure };
  }
  return connected === undefined
    ? { browser: null, failure: 'CDP validation returned no browser' }
    : { browser: connected, failure: null };
}

export async function connectValidatedBrowser(wsUrl: string): Promise<Browser | null> {
  return (await validateBrowserConnection(wsUrl)).browser;
}

export async function validateSessionConnectionWithReason(
  wsUrl: string,
  connectBrowser?: CdpConnector
): Promise<SteelConnectionValidationResult> {
  const validation = await validateBrowserConnection(wsUrl, {
    ...(connectBrowser && {
      connect: (url: string) => connectBrowser(steelCdpConnectionUrl(url)),
    }),
  });
  if (validation.browser === null) {
    return { valid: false, failureReason: safeValidationFailureReason(validation.failure) };
  }
  await validation.browser.close().catch(() => {});
  return { valid: true };
}

export async function validateSessionConnection(wsUrl: string): Promise<boolean> {
  const browser = await connectValidatedBrowser(wsUrl);
  if (browser === null) return false;
  await browser.close().catch(() => {});
  return true;
}

export async function createLocalBrowserSession(
  dbContextId: string,
  agentId: string,
  startUrl?: string,
  taskId?: string
): Promise<{
  sessionId: string;
  debugUrl: string;
  taskId: string;
  wsUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  steelProfileId: string | null;
  profileSource: string;
} | null> {
  const wsUrl = process.env.LOCAL_BROWSER_CDP_URL?.trim();
  if (wsUrl === undefined || wsUrl === '') return null;

  log.info('Using local browser CDP session for browser agent egress test');
  const isValid = await validateSessionConnection(wsUrl);
  if (!isValid) {
    throw new Error('LOCAL_BROWSER_CDP_URL failed CDP validation');
  }

  const sessionId = `local-${randomUUID()}`;
  const debugUrl = process.env.LOCAL_BROWSER_DEBUG_URL?.trim() ?? wsUrl;
  const dbSession = await persistBrowserSessionRow({
    taskId,
    contextId: dbContextId,
    agentId,
    sessionId,
    debugUrl,
    wsUrl,
    startUrl: startUrl !== undefined && startUrl !== '' ? startUrl : undefined,
    provider: 'steel',
    providerProfileId: null,
    providerProfileSource: 'local',
    providerProfilePersist: false,
  });

  log.info(`Created local browser session: ${sessionId}`);
  log.info(`  Context (DB): ${dbContextId}`);
  log.info(`  CDP WebSocket URL: ${wsUrl}`);

  return {
    sessionId,
    debugUrl,
    wsUrl,
    taskId: dbSession.id,
    proxySource: 'none',
    proxyLocation: DEFAULT_GEOLOCATION,
    steelProfileId: null,
    profileSource: 'local',
  };
}
