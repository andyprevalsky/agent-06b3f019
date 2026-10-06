/**
 * Persist signed-in Kernel/Steel cookies + localStorage before a session ends
 * so the next browser-agent call — including the other provider — can inject
 * them through the existing CookieBundle / LocalStorageOrigin path.
 *
 *   Kernel/Steel page ──storageState──▶ CookieBundle + LocalStorageOrigin
 *   later init (same or other provider) ──injectUserData──▶ signed-in browser
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Browser, Cookie } from 'playwright';
import { isAuthCredentialCookieName } from '../authCookies';
import { authRealmFromCookieDomain } from '../authRealm';
import { benchmarkSavedBrowserAuthDisabled } from '../benchmarkBrowserAuth';
import { domainVariants } from '../browserCookies';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { steelCdpConnectionUrl } from '../steel/urls';
import { withTimeout } from '../steel/injectionTimeouts';
import { benchmarkIsolatedBrowserProfilesEnabled } from './benchmarkProfileIsolation';
import { storedBrowserProvider } from './types';

const log = createLogger('BrowserSessionAuthPersist');
const CHROME_EPOCH_OFFSET_MICROSECONDS = 11_644_473_600n * 1_000_000n;
const DEFAULT_PERSIST_TIMEOUT_MS = 8_000;
const MAX_COOKIES = 400;
const MAX_ORIGINS = 40;

export const CLOUD_PERSISTENT_BROWSER_PROFILE = 'cloud_persistent';

export type PersistSignedInBrowserStateResult = {
  persisted: boolean;
  reason?: string;
  cookieCount: number;
  realmCount: number;
  localStorageOriginCount: number;
};

export function persistSignedInBrowserStateTimeoutMs(): number {
  const configured = Number(process.env.BROWSER_SESSION_AUTH_PERSIST_TIMEOUT_MS);
  if (Number.isInteger(configured) && configured > 0 && configured <= 60_000) {
    return configured;
  }
  return DEFAULT_PERSIST_TIMEOUT_MS;
}

export function remoteWsUrlLooksPersistable(wsUrl: string): boolean {
  try {
    const url = new URL(wsUrl);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'wss:') return false;
    return !['example', 'example.com', 'localhost', '127.0.0.1'].includes(host);
  } catch {
    return false;
  }
}

function chromeEpochMicroseconds(unixSeconds?: number): bigint | null {
  if (unixSeconds === undefined || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return null;
  }
  return BigInt(Math.floor(unixSeconds)) * 1_000_000n + CHROME_EPOCH_OFFSET_MICROSECONDS;
}

function nowChromeEpochMicroseconds(): bigint {
  return BigInt(Date.now()) * 1_000n + CHROME_EPOCH_OFFSET_MICROSECONDS;
}

function hashLocalStorageEntries(entries: Array<{ key: string; value: string }>): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function mergeLocalStorageEntries(
  existing: unknown,
  incoming: Array<{ key: string; value: string }>
): Array<{ key: string; value: string }> {
  const merged = new Map<string, string>();
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (item === null || typeof item !== 'object') continue;
      const row = item as { key?: unknown; value?: unknown };
      if (typeof row.key !== 'string' || row.key === '' || typeof row.value !== 'string') continue;
      merged.set(row.key, row.value);
    }
  }
  for (const entry of incoming) merged.set(entry.key, entry.value);
  return [...merged.entries()].map(([key, value]) => ({ key, value }));
}

export function shouldPersistSignedInBrowserState(session: {
  provider: string;
  providerProfileSource?: string | null;
  wsUrl?: string | null;
}): { persist: boolean; reason?: string } {
  if (benchmarkSavedBrowserAuthDisabled()) {
    return { persist: false, reason: 'saved_browser_auth_disabled' };
  }
  if (benchmarkIsolatedBrowserProfilesEnabled()) {
    return { persist: false, reason: 'benchmark_isolated_profiles' };
  }
  const provider = storedBrowserProvider(session.provider);
  if (provider !== 'kernel' && provider !== 'steel') {
    return { persist: false, reason: 'unsupported_provider' };
  }
  if (session.providerProfileSource?.startsWith('benchmark_anon') === true) {
    return { persist: false, reason: 'benchmark_anon_profile' };
  }
  return { persist: true };
}

async function persistHarvestedCookies(
  userId: string,
  browserSource: string,
  cookies: Cookie[]
): Promise<{ cookieCount: number; realmCount: number }> {
  const now = nowChromeEpochMicroseconds();
  const byRealm = new Map<string, Cookie[]>();
  for (const cookie of cookies.slice(0, MAX_COOKIES)) {
    if (cookie.name === '') continue;
    const authRealm = authRealmFromCookieDomain(cookie.domain);
    if (authRealm === '') continue;
    const group = byRealm.get(authRealm) ?? [];
    group.push(cookie);
    byRealm.set(authRealm, group);
  }

  for (const [authRealm, realmCookies] of byRealm) {
    await prisma.cookie.deleteMany({
      where: {
        userId,
        browserSource,
        browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
        OR: domainVariants(authRealm),
      },
    });
    await prisma.cookie.createMany({
      data: realmCookies.map((cookie) => {
        const expiresUtc = chromeEpochMicroseconds(cookie.expires);
        return {
          id: randomUUID(),
          userId,
          domain: cookie.domain,
          name: cookie.name,
          path: cookie.path || '/',
          value: cookie.value,
          expiresUtc,
          isSecure: cookie.secure,
          isHttpOnly: cookie.httpOnly,
          browserSource,
          browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
          creationUtc: now,
          hasExpires: expiresUtc !== null,
          isPersistent: expiresUtc !== null,
          sameSite: cookie.sameSite === 'Strict' ? 2 : cookie.sameSite === 'None' ? 0 : 1,
        };
      }),
    });
    const clearDisabled = realmCookies.some((cookie) => isAuthCredentialCookieName(cookie.name));
    await prisma.cookieBundle.upsert({
      where: {
        userId_authRealm_browserSource_browserProfile: {
          userId,
          authRealm,
          browserSource,
          browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
        },
      },
      create: {
        userId,
        authRealm,
        browserSource,
        browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
      },
      update: clearDisabled ? { disabledAt: null, disabledReason: null } : {},
    });
  }
  return { cookieCount: cookies.length, realmCount: byRealm.size };
}

async function persistHarvestedLocalStorage(
  userId: string,
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>
): Promise<number> {
  let written = 0;
  for (const originState of origins.slice(0, MAX_ORIGINS)) {
    const incoming = originState.localStorage
      .filter((entry) => entry.name !== '')
      .map((entry) => ({ key: entry.name, value: entry.value }));
    if (incoming.length === 0) continue;
    const existing = await prisma.localStorageOrigin.findUnique({
      where: { userId_origin: { userId, origin: originState.origin } },
    });
    const entries = mergeLocalStorageEntries(existing?.entries, incoming);
    const hash = hashLocalStorageEntries(entries);
    if (existing !== null && existing.hash === hash) {
      written += 1;
      continue;
    }
    await prisma.localStorageOrigin.upsert({
      where: { userId_origin: { userId, origin: originState.origin } },
      create: { userId, origin: originState.origin, entries, hash },
      update: { entries, hash },
    });
    written += 1;
  }
  return written;
}

export async function persistSignedInBrowserState(
  sessionId: string,
  options: { browser?: Browser } = {}
): Promise<PersistSignedInBrowserStateResult> {
  const skipped = { persisted: false, cookieCount: 0, realmCount: 0, localStorageOriginCount: 0 };
  const session = await prisma.browserSession.findUnique({
    where: { sessionId },
    include: { context: true },
  });
  if (session === null) return { ...skipped, reason: 'session_not_found' };
  const gate = shouldPersistSignedInBrowserState(session);
  if (!gate.persist) return { ...skipped, reason: gate.reason };
  const userId = session.context.userId;
  if (userId === '') return { ...skipped, reason: 'missing_user' };

  const providedBrowser = options.browser;
  if (
    providedBrowser === undefined &&
    (session.wsUrl === null || session.wsUrl === '' || !remoteWsUrlLooksPersistable(session.wsUrl))
  ) {
    return { ...skipped, reason: 'unpersistable_ws_url' };
  }

  const closeBrowserWhenDone = providedBrowser === undefined;
  let browser = providedBrowser;
  try {
    if (browser === undefined) {
      const { chromium } = await import('playwright');
      browser = await withTimeout(
        chromium.connectOverCDP(steelCdpConnectionUrl(session.wsUrl ?? ''), {
          timeout: persistSignedInBrowserStateTimeoutMs(),
        }),
        persistSignedInBrowserStateTimeoutMs(),
        'Timed out connecting to harvest signed-in browser state'
      );
    }
    const context = browser.contexts()[0];
    if (context === undefined) return { ...skipped, reason: 'missing_browser_context' };
    const state = await withTimeout(
      context.storageState(),
      persistSignedInBrowserStateTimeoutMs(),
      'Timed out reading signed-in browser storage'
    );
    if (state.cookies.length === 0 && state.origins.length === 0) {
      return { ...skipped, reason: 'empty_storage' };
    }
    const cookies = await persistHarvestedCookies(userId, session.provider, state.cookies);
    const localStorageOriginCount = await persistHarvestedLocalStorage(userId, state.origins);
    log.info('Persisted signed-in browser state', {
      sessionId,
      provider: session.provider,
      cookieCount: cookies.cookieCount,
      realmCount: cookies.realmCount,
      localStorageOriginCount,
    });
    return { persisted: true, ...cookies, localStorageOriginCount };
  } finally {
    if (closeBrowserWhenDone && browser !== undefined) {
      await browser.close().catch(() => undefined);
    }
  }
}
