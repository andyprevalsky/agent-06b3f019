import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../geoip';
import { retryWithBackoff } from '../retry';
import { persistBrowserSessionRow } from '../browser/sessionPersist';
import { log } from './types';
import { steelCdpConnectionUrl } from './urls';

const SESSION_VALIDATION_TIMEOUT = 10000;
const WS_BACKOFF_DELAYS = [100, 400, 800];
type CdpConnector = (wsUrl: string) => Promise<Browser>;

async function defaultCdpConnector(wsUrl: string): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(wsUrl);
}

/**
 * Connect to the session via CDP and validate it, returning the OPEN browser
 * connection on success (null on failure). Callers that keep the connection
 * (e.g. to reuse it for user-data injection, saving a second 3-5s CDP
 * handshake) are responsible for closing it.
 */
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

export async function connectValidatedBrowser(
  wsUrl: string,
  onFailure?: (error: unknown) => void,
  connectBrowser: CdpConnector = defaultCdpConnector
): Promise<Browser | null> {
  try {
    let connected: Browser | undefined;
    await retryWithBackoff(
      async () => {
        let browser: Browser | undefined;
        try {
          browser = await Promise.race([
            connectBrowser(steelCdpConnectionUrl(wsUrl)),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Connection timeout')), SESSION_VALIDATION_TIMEOUT)
            ),
          ]);
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
          throw error;
        }
      },
      {
        maxRetries: 3,
        fixedDelays: WS_BACKOFF_DELAYS,
        component: 'Steel session validation',
        isRetryable: (error) => safeValidationFailureReason(error) !== 'Authentication rejected',
      }
    );
    return connected ?? null;
  } catch (error) {
    onFailure?.(error);
    log.info('  Session validation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function validateSessionConnectionWithReason(
  wsUrl: string,
  connectBrowser?: CdpConnector
): Promise<SteelConnectionValidationResult> {
  let failureReason: Exclude<SteelConnectionValidationResult, { valid: true }>['failureReason'] =
    'Session validation failed';
  const browser = await connectValidatedBrowser(
    wsUrl,
    (error) => {
      failureReason = safeValidationFailureReason(error);
    },
    connectBrowser
  );
  if (browser === null) return { valid: false, failureReason };
  await browser.close().catch(() => {});
  return { valid: true };
}

export async function validateSessionConnection(wsUrl: string): Promise<boolean> {
  return (await validateSessionConnectionWithReason(wsUrl)).valid;
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
