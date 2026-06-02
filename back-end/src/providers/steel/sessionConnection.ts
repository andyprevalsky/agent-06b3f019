import { randomUUID } from 'node:crypto';
import { prisma } from '../database';
import { type ProxyGeoLocation, DEFAULT_GEOLOCATION } from '../geoip';
import { retryWithBackoff } from '../retry';
import { log } from './types';

const SESSION_VALIDATION_TIMEOUT = 10000;
const WS_BACKOFF_DELAYS = [100, 400, 800];

export async function validateSessionConnection(wsUrl: string): Promise<boolean> {
  try {
    await retryWithBackoff(
      async () => {
        const { chromium } = await import('playwright');
        let browser;
        try {
          browser = await Promise.race([
            chromium.connectOverCDP(wsUrl),
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
        } finally {
          if (browser !== undefined) {
            await browser.close().catch(() => {});
          }
        }
      },
      {
        maxRetries: 3,
        fixedDelays: WS_BACKOFF_DELAYS,
        component: 'Steel session validation',
        isRetryable: () => true,
      }
    );
    return true;
  } catch (error) {
    log.info('  Session validation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function createLocalBrowserSession(
  dbContextId: string,
  agentId: string,
  startUrl?: string
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
  const dbSession = await prisma.browserSession.create({
    data: {
      contextId: dbContextId,
      agentId,
      sessionId,
      debugUrl,
      wsUrl,
      status: 'ACTIVE',
      startUrl: startUrl !== undefined && startUrl !== '' ? startUrl : undefined,
    },
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
