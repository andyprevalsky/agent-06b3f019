/**
 * Steel browser data injection — cookies, fingerprint, localStorage, IndexedDB, permissions, cacheStorage.
 */

import { prisma } from '../database';
import { canonicalAuthRealm } from '../authRealm';
import { type FingerprintData, log } from './types';
import { steelCdpConnectionUrl } from './urls';
import {
  injectCacheStorageState,
  injectIndexedDBState,
  injectLocalStorageState,
  injectPermissionState,
  injectScrollbarState,
} from './injectionState';

interface CookieBundleCandidate {
  id: string;
  browserSource: string;
  browserProfile: string;
  disabledAt: Date | null;
  freshestCookieUtc: bigint | null;
}

export type BrowserAuthCredentialSource =
  | {
      kind: 'steel_session';
      id: string;
      contextId: string;
      credentialRef: { kind: 'steel_session'; id: string };
    }
  | {
      kind: 'cookie_bundle';
      id: string;
      browserSource: string;
      browserProfile: string;
      disabledAt: Date | null;
      freshestCookieUtc: bigint | null;
      credentialRef: { kind: 'cookie_bundle'; id: string };
    }
  | { kind: 'none'; credentialRef: null };

interface SteelRealmCookieSummary {
  cookieCount: number;
  hasRealmCookies: boolean;
  checkedAt: string;
}

function cookieDomainWhere(authRealm: string) {
  return {
    OR: [
      { domain: authRealm },
      { domain: `.${authRealm}` },
      { domain: { endsWith: `.${authRealm}` } },
    ],
  };
}

function benchmarkSavedBrowserAuthDisabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH ?? '').trim().toLowerCase()
  );
}

function envEnabled(name: string, defaultValue = true): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw.trim().toLowerCase());
}

export function steelCookieMatchesAuthRealm(cookieDomain: string | undefined, authRealm: string) {
  const normalizedDomain = (cookieDomain ?? '').trim().toLowerCase().replace(/^\./, '');
  return normalizedDomain === authRealm || normalizedDomain.endsWith(`.${authRealm}`);
}

function cookieExpiryIsLive(expires: unknown, nowEpochSeconds: number) {
  if (expires === undefined || expires === null) return true;
  const numeric = typeof expires === 'number' ? expires : Number(expires);
  if (!Number.isFinite(numeric) || numeric <= 0) return true;
  return numeric > nowEpochSeconds;
}

export function summarizeSteelCookiesForRealm(
  cookies: Array<{ domain?: string; expires?: unknown; expirationDate?: unknown }>,
  authRealm: string,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000)
): SteelRealmCookieSummary {
  const realmCookies = cookies.filter((cookie) => {
    const expires = cookie.expires ?? cookie.expirationDate;
    return (
      steelCookieMatchesAuthRealm(cookie.domain, authRealm) &&
      cookieExpiryIsLive(expires, nowEpochSeconds)
    );
  });
  return {
    cookieCount: realmCookies.length,
    hasRealmCookies: realmCookies.length > 0,
    checkedAt: new Date(nowEpochSeconds * 1000).toISOString(),
  };
}

async function getSteelSessionRealmCookieSummary(
  sessionId: string,
  authRealm: string
): Promise<SteelRealmCookieSummary> {
  const { steel } = await import('./session');
  const context = (await steel.sessions.context(sessionId)) as {
    cookies?: Array<{ domain?: string; expires?: unknown; expirationDate?: unknown }>;
  };
  return summarizeSteelCookiesForRealm(context.cookies ?? [], authRealm);
}

async function freshestCookieUtcForBundle(params: {
  userId: string;
  authRealm: string;
  browserSource: string;
  browserProfile: string;
}) {
  const result = await prisma.cookie.aggregate({
    where: {
      userId: params.userId,
      browserSource: params.browserSource,
      browserProfile: params.browserProfile,
      ...cookieDomainWhere(params.authRealm),
    },
    _max: { creationUtc: true },
  });
  return result._max.creationUtc;
}

async function selectTopCookieBundle(params: {
  userId: string;
  authRealm: string;
}): Promise<CookieBundleCandidate | null> {
  const bundles = await prisma.cookieBundle.findMany({
    where: { userId: params.userId, authRealm: params.authRealm },
  });
  if (bundles.length === 0) return null;

  const candidates = await Promise.all(
    bundles
      .filter((bundle) => bundle.disabledAt === null)
      .map(async (bundle) => ({
        id: bundle.id,
        browserSource: bundle.browserSource,
        browserProfile: bundle.browserProfile,
        disabledAt: bundle.disabledAt,
        freshestCookieUtc: await freshestCookieUtcForBundle({
          userId: params.userId,
          authRealm: params.authRealm,
          browserSource: bundle.browserSource,
          browserProfile: bundle.browserProfile,
        }),
      }))
  );

  candidates.sort((a, b) => {
    if ((a.disabledAt === null) !== (b.disabledAt === null)) {
      return a.disabledAt === null ? -1 : 1;
    }
    const aFresh = a.freshestCookieUtc ?? 0n;
    const bFresh = b.freshestCookieUtc ?? 0n;
    return aFresh > bFresh ? -1 : aFresh < bFresh ? 1 : 0;
  });
  return candidates[0] ?? null;
}

export async function resolveBrowserAuthCredentialSource(params: {
  userId: string;
  authRealm: string;
  steelContextId: string | null;
  steelSessionHasRealmCookies?: boolean;
  // Pass the already-fetched SteelSessionAuth row (or explicit null) to skip
  // re-querying it — injectUserData looks it up moments earlier.
  preloadedSteelAuth?: Awaited<ReturnType<typeof prisma.steelSessionAuth.findUnique>>;
}): Promise<BrowserAuthCredentialSource> {
  if (benchmarkSavedBrowserAuthDisabled()) {
    log.info('  [cookies] Benchmark anon mode active; skipping saved browser auth selection', {
      userId: params.userId,
      authRealm: params.authRealm,
      steelContextId: params.steelContextId,
    });
    return { kind: 'none', credentialRef: null };
  }

  const steelAuth =
    params.preloadedSteelAuth !== undefined
      ? params.preloadedSteelAuth
      : params.steelContextId !== null && params.authRealm !== ''
        ? await prisma.steelSessionAuth.findUnique({
            where: {
              userId_contextId_authRealm: {
                userId: params.userId,
                contextId: params.steelContextId,
                authRealm: params.authRealm,
              },
            },
          })
        : null;

  if (
    steelAuth !== null &&
    steelAuth.disabledAt === null &&
    params.steelSessionHasRealmCookies !== false
  ) {
    return {
      kind: 'steel_session',
      id: steelAuth.id,
      contextId: steelAuth.contextId,
      credentialRef: { kind: 'steel_session', id: steelAuth.id },
    };
  }

  if (params.authRealm !== '') {
    const topBundle = await selectTopCookieBundle({
      userId: params.userId,
      authRealm: params.authRealm,
    });
    if (topBundle !== null) {
      return {
        kind: 'cookie_bundle',
        id: topBundle.id,
        browserSource: topBundle.browserSource,
        browserProfile: topBundle.browserProfile,
        disabledAt: topBundle.disabledAt,
        freshestCookieUtc: topBundle.freshestCookieUtc,
        credentialRef: { kind: 'cookie_bundle', id: topBundle.id },
      };
    }
  }

  return { kind: 'none', credentialRef: null };
}

export async function injectUserData(
  sessionId: string,
  userId: string,
  startUrl: string,
  options?: { browser?: import('playwright').Browser }
): Promise<{
  cookies: {
    injected: boolean;
    cookieCount: number;
    authSource: BrowserAuthCredentialSource['kind'];
    credentialRef: BrowserAuthCredentialSource['credentialRef'];
  };
  fingerprint: { injected: boolean };
  indexedDB: { injected: boolean; originCount: number };
  localStorage: { injected: boolean; originCount: number };
  permissions: { injected: boolean; grantCount: number };
  cacheStorage: { injected: boolean; originCount: number };
}> {
  const startTime = Date.now();
  log.info(`🔐 [injectUserData] START for session ${sessionId}`);

  // Build cookie domain filter from start_url
  // Cookie domains use leading dots for subdomain matching (e.g. ".amazon.com" matches "www.amazon.com")
  // We need to query for both ".domain.com" and "domain.com" variants
  let url = startUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  const hostname = new URL(url).hostname;
  const authRealm = canonicalAuthRealm(url);
  // Match the exact host plus the canonical auth realm. Never infer a
  // registrable domain by taking the last two labels: for example.co.uk that
  // would become co.uk and cross a credential boundary.
  const domainVariants = [
    hostname, // "www.amazon.com"
    `.${hostname}`, // ".www.amazon.com"
    authRealm, // "amazon.com"
    `.${authRealm}`, // ".amazon.com"
  ];
  const uniqueDomains = [...new Set(domainVariants)];
  // Origin-based tables (localStorage, IndexedDB, cacheStorage, permissions) store
  // origins like "https://domain.com". Use boundary-aware endsWith matching to
  // avoid false positives (e.g. "evilamazon.com" matching "amazon.com").
  const originDomainFilter = {
    userId,
    OR: [
      { origin: { endsWith: `://${authRealm}` } }, // exact: https://amazon.com
      { origin: { contains: `://${authRealm}:` } }, // exact with port: https://amazon.com:8443
      { origin: { endsWith: `.${authRealm}` } }, // subdomain: https://www.amazon.com
      { origin: { contains: `.${authRealm}:` } }, // subdomain with port: https://www.amazon.com:8443
    ],
  };
  log.info(
    `  [cookies] Filtering to domains for start_url "${startUrl}": ${uniqueDomains.join(', ')}`
  );

  // Fetch session, fingerprint, localStorage, IndexedDB, permissions, and cacheStorage in parallel.
  // Cookie rows are intentionally fetched after selecting one credential source
  // for this auth realm: either the persistent Steel context or one CookieBundle.
  log.info(`  [1/9] Fetching user data from DB...`);
  const [
    dbSession,
    integration,
    localStorageOrigins,
    indexedDBOrigins,
    permissions,
    cacheStorageOrigins,
  ] = await Promise.all([
    prisma.browserSession.findUnique({
      where: { sessionId },
      include: { context: true },
    }),
    prisma.integration.findUnique({
      where: { userId_name: { userId, name: 'browser_fingerprint' } },
    }),
    prisma.localStorageOrigin.findMany({ where: originDomainFilter }),
    prisma.indexedDBOrigin.findMany({ where: originDomainFilter }),
    prisma.browserPermission.findMany({ where: originDomainFilter }),
    prisma.cacheStorageOrigin.findMany({ where: originDomainFilter }),
  ]);
  log.info(`  [1/9] DB fetch complete (${Date.now() - startTime}ms)`);

  if (!dbSession?.wsUrl) {
    if (options?.browser) {
      await options.browser.close().catch(() => {});
    }
    throw new Error('No WebSocket URL found for session');
  }

  let cookies: Awaited<ReturnType<typeof prisma.cookie.findMany>> = [];
  const steelContextId = dbSession.provider === 'steel' ? dbSession.context.contextId : null;
  const steelAuthForVerification =
    steelContextId !== null && authRealm !== ''
      ? await prisma.steelSessionAuth.findUnique({
          where: {
            userId_contextId_authRealm: {
              userId,
              contextId: steelContextId,
              authRealm,
            },
          },
        })
      : null;
  const steelCookieSummary =
    steelAuthForVerification !== null && steelAuthForVerification.disabledAt === null
      ? await getSteelSessionRealmCookieSummary(sessionId, authRealm)
      : null;
  const authSource = await resolveBrowserAuthCredentialSource({
    userId,
    authRealm,
    steelContextId,
    steelSessionHasRealmCookies: steelCookieSummary?.hasRealmCookies,
    preloadedSteelAuth: steelAuthForVerification,
  });

  if (authSource.kind === 'steel_session') {
    log.info('  [cookies] Steel context has prioritized auth; skipping cookie injection', {
      userId,
      authRealm,
      contextId: steelContextId,
      steelSessionAuthId: authSource.id,
      steelCookieCount: steelCookieSummary?.cookieCount ?? null,
    });
  } else if (authSource.kind === 'cookie_bundle') {
    if (steelCookieSummary !== null && !steelCookieSummary.hasRealmCookies) {
      log.info(
        '  [cookies] Steel auth marker exists but current session has no realm cookies; falling through to CookieBundle',
        {
          userId,
          authRealm,
          contextId: steelContextId,
        }
      );
    }
    log.info('  [cookies] Selected CookieBundle for injection', {
      userId,
      authRealm,
      cookieBundleId: authSource.id,
      browserSource: authSource.browserSource,
      browserProfile: authSource.browserProfile,
      disabled: authSource.disabledAt !== null,
    });
    cookies = await prisma.cookie.findMany({
      where: {
        userId,
        ...cookieDomainWhere(authRealm),
        browserSource: authSource.browserSource,
        browserProfile: authSource.browserProfile,
      },
    });
    if (cookies.length === 0) {
      if (options?.browser) {
        await options.browser.close().catch(() => {});
      }
      throw new Error(
        `Cookie bundle ${authSource.id} was selected for ${authRealm} but contains no cookie rows`
      );
    }
  }

  const hasCookies = cookies.length > 0;
  const fp = (integration?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  const hasFingerprint = !!fp && envEnabled('BROWSER_AGENT_FINGERPRINT_INJECTION_ENABLED', true);
  const hasLocalStorage = localStorageOrigins.length > 0;
  const hasIndexedDB = indexedDBOrigins.length > 0;
  const hasPermissions = permissions.length > 0;
  const hasCacheStorage = cacheStorageOrigins.length > 0;
  const selectedCookieBundleId = authSource.kind === 'cookie_bundle' ? authSource.id : null;

  log.info(
    `  Cookies: ${hasCookies ? cookies.length : 'none'}, Fingerprint: ${hasFingerprint ? 'yes' : 'no'}, localStorage: ${hasLocalStorage ? localStorageOrigins.length + ' origins' : 'none'}, IndexedDB: ${hasIndexedDB ? indexedDBOrigins.length + ' origins' : 'none'}, Permissions: ${hasPermissions ? permissions.length + ' grants' : 'none'}, CacheStorage: ${hasCacheStorage ? cacheStorageOrigins.length + ' origins' : 'none'}`
  );

  // Note: We always need CDP connection now to inject scrollbar CSS
  // (previously returned early when no cookies/fingerprint)

  // Connect via Playwright (single connection for both operations). Reuse the
  // caller's already-validated connection when provided — a fresh CDP
  // handshake to Steel costs 3-5s.
  let browser;
  const closeBrowserWhenDone = options?.browser === undefined;

  try {
    if (options?.browser) {
      browser = options.browser;
      log.info(`  [3/9] Reusing validated CDP connection (${Date.now() - startTime}ms)`);
    } else {
      const { chromium } = await import('playwright');
      log.info(`  [3/9] Connecting to CDP...`);
      browser = await chromium.connectOverCDP(steelCdpConnectionUrl(dbSession.wsUrl));
      log.info(`  [3/9] CDP connected (${Date.now() - startTime}ms)`);
    }
    const context = browser.contexts()[0];
    if (context === undefined) {
      throw new Error('Validated CDP browser has no context for credential injection');
    }

    let cookieResult = {
      injected: false,
      cookieCount: 0,
      authSource: authSource.kind,
      credentialRef: authSource.credentialRef,
    };
    const fingerprintResult = { injected: false };
    let localStorageResult = { injected: false, originCount: 0 };
    let indexedDBResult = { injected: false, originCount: 0 };
    let permissionsResult = { injected: false, grantCount: 0 };
    let cacheStorageResult = { injected: false, originCount: 0 };

    // Credential-critical cookies must complete before best-effort browser
    // state mutates the live context. A failed /prepare-auth request must not
    // leave localStorage, IndexedDB, permissions, or cache state half-applied.
    if (hasCookies) {
      try {
        log.info(`  [cookies] Transforming ${cookies.length} cookies...`);
        const CHROME_EPOCH_OFFSET = 11644473600;
        const playwrightCookies = cookies.map((cookie) => {
          let expires: number | undefined;

          if (cookie.expiresUtc && cookie.expiresUtc > 0n) {
            expires = Math.floor(Number(cookie.expiresUtc) / 1000000) - CHROME_EPOCH_OFFSET;
            if (expires < Date.now() / 1000) {
              expires = undefined;
            }
          }

          return {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path || '/',
            expires,
            secure: cookie.isSecure,
            httpOnly: cookie.isHttpOnly,
            sameSite: 'Lax' as const,
          };
        });

        const invalidCookies = playwrightCookies.filter((cookie) => cookie.name === '');
        if (invalidCookies.length > 0) {
          log.warn('Ignoring cookie rows without names', {
            cookieBundleId: selectedCookieBundleId ?? 'unknown',
            invalidCookieCount: invalidCookies.length,
          });
        }
        const validCookies = playwrightCookies.filter((cookie) => cookie.name !== '');
        if (validCookies.length === 0) {
          throw new Error(
            `Cookie bundle ${selectedCookieBundleId ?? 'unknown'} contains ${invalidCookies.length} cookie row(s) without a name`
          );
        }
        // Empty cookie values are valid and must not be filtered out.
        log.info(
          `  [cookies] Transform complete, ${validCookies.length} valid (${Date.now() - startTime}ms)`
        );

        log.info(`  [cookies] Injecting via CDP...`);
        await context.addCookies(validCookies);
        log.info(`  [cookies] ✅ Injected (${Date.now() - startTime}ms)`);
        cookieResult = {
          injected: true,
          cookieCount: validCookies.length,
          authSource: authSource.kind,
          credentialRef: authSource.credentialRef,
        };
      } catch (error) {
        log.error('Failed to inject cookies', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new AggregateError(
          [
            new Error('Failed to inject cookies', {
              cause: error instanceof Error ? error : new Error(String(error)),
            }),
          ],
          'Browser credential injection failed'
        );
      }
    }

    // Run non-credential browser-state injections in parallel for performance.
    log.info(`  [4/5] Injecting browser state in parallel...`);
    const injectionPromises: Promise<void>[] = [];

    // 2. Fingerprint: NOT injected here on purpose. CDP-level settings
    // (Network.setUserAgentOverride, addInitScript, Emulation overrides) are
    // scoped to the CDP connection that created them and vanish when this
    // connection closes — see agents/helpers/fingerprint_injection.py (header)
    // and agents/browser_tools/dom_service.py connect() for the same finding.
    // The worker applies the identical override + init script on its own
    // persistent connection (from the fingerprint_injection payload this init
    // response returns) before any navigation, so the 5 serial CDP round trips
    // this used to spend here were dead work on the critical path.
    if (hasFingerprint) {
      log.info(`  [fingerprint] Deferred to worker connection (payload in init response)`);
    }

    // 3. Inject localStorage if available
    if (hasLocalStorage) {
      injectionPromises.push(
        (async () => {
          try {
            localStorageResult = await injectLocalStorageState(
              context,
              localStorageOrigins,
              startTime
            );
          } catch (error) {
            log.error('Failed to inject localStorage', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })()
      );
    }

    // 4. Inject IndexedDB if available
    if (hasIndexedDB) {
      injectionPromises.push(
        (async () => {
          try {
            indexedDBResult = await injectIndexedDBState(context, indexedDBOrigins, startTime);
          } catch (error) {
            log.error('Failed to inject indexedDB', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })()
      );
    }

    // 5. Inject permissions if available
    // Uses JavaScript override for permission query checks
    if (hasPermissions) {
      injectionPromises.push(
        (async () => {
          try {
            permissionsResult = await injectPermissionState(context, permissions, startTime);
          } catch (error) {
            log.error('Failed to inject permissions', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })()
      );
    }

    // 6. Inject Cache Storage metadata if available
    // Pre-opens caches so sites that check for cache existence work correctly
    if (hasCacheStorage) {
      injectionPromises.push(
        (async () => {
          try {
            cacheStorageResult = await injectCacheStorageState(
              context,
              cacheStorageOrigins,
              startTime
            );
          } catch (error) {
            log.error('Failed to inject cacheStorage', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })()
      );
    }

    // 7. Always inject scrollbar-hiding CSS to ensure viewport matches screenshot (1280x800)
    // This prevents coordinate mismatch where viewport reports 1265 (with scrollbar) but screenshot is 1280
    injectionPromises.push(
      (async () => {
        try {
          await injectScrollbarState(context, startTime);
        } catch (error) {
          log.error('Failed to inject scrollbar CSS', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })()
    );

    // Wait for all injections to complete in parallel
    await Promise.all(injectionPromises);
    log.info(`  [4/5] ✅ All injections complete (${Date.now() - startTime}ms)`);
    return {
      cookies: cookieResult,
      fingerprint: fingerprintResult,
      indexedDB: indexedDBResult,
      localStorage: localStorageResult,
      permissions: permissionsResult,
      cacheStorage: cacheStorageResult,
    };
  } finally {
    // Disconnect only connections opened here. Callers may pass a validated
    // browser they continue using after credential preparation.
    // Fire-and-forget: the connection is being discarded, and awaiting the
    // websocket teardown put ~350-400ms on the init critical path.
    if (browser && closeBrowserWhenDone) {
      log.info(`  [5/5] Closing CDP connection (async)...`);
      void browser.close().catch(() => {});
      log.info(`🔐 [injectUserData] COMPLETE (${Date.now() - startTime}ms total)`);
    } else if (browser) {
      log.info(`🔐 [injectUserData] COMPLETE (${Date.now() - startTime}ms total)`);
    }
  }
}
