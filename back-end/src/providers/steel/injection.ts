/**
 * Steel browser data injection — cookies, fingerprint, localStorage, IndexedDB, permissions, cacheStorage.
 */

import { prisma } from '../database';
import { isAuthCredentialCookieName } from '../authCookies';
import { canonicalAuthRealm, cookieDomainForStartUrl } from '../authRealm';
import { cookieSelectionWhere, domainVariants } from '../browserCookies';
import { playwrightCookiesFromRows, storedCookieIsLive } from './injectionCookies';
import { benchmarkSavedBrowserAuthDisabled } from '../benchmarkBrowserAuth';
import { type FingerprintData, log } from './types';
import { steelCdpConnectionUrl } from './urls';
import type { InjectedCookieBundle } from '../browser/worldStateKeepBest';
import { createOriginPayloadWriter } from './injectionOriginPage';
import {
  injectCacheStorageState,
  injectIndexedDBState,
  injectLocalStorageState,
  injectPermissionState,
  injectScrollbarState,
} from './injectionState';
import {
  browserStateInjectionTimeoutMs,
  credentialCdpConnectTimeoutMs,
  withTimeout,
} from './injectionTimeouts';

interface CookieBundleCandidate {
  id: string;
  browserSource: string;
  browserProfile: string;
  disabledAt: Date | null;
  cookieCount: number;
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

/**
 * Cookie SELECTION for the browser agent: the target realm PLUS every SSO realm.
 *
 * Delegates to the shared canonical path (providers/browserCookies) so the agent
 * and the compute connectors select cookies identically -- the browser agent
 * always gets SSO cookies. Boundary-aware variants (`www.` → parent, `.domain`,
 * subdomains) live in `cookieSelectionWhere`; the earlier inline copy is gone.
 *
 * Rank bundles using only their own realm; carry SSO cookies from the selected
 * profile afterward. Attribute mapping uses the same canonical normalisation
 * as the compute connectors, without reselecting or mixing profiles.
 */
function cookieDomainWhere(authRealm: string): { OR: Array<Record<string, unknown>> } {
  return cookieSelectionWhere(authRealm);
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

async function cookieSummaryForBundle(params: {
  userId: string;
  cookieDomain: string;
  browserSource: string;
  browserProfile: string;
}) {
  // Count only auth-looking cookies. Analytics/tracking rows on the realm
  // (Instacart `_gcl_au`/`_ttp`/`device_uuid`, etc.) previously made
  // cookieCount>0 and selectTopCookieBundle returned the bundle as an
  // "authentication source", which recorded "Credential referenced" while the
  // page stayed signed-out and burned the agent on a login path.
  const cookies = await prisma.cookie.findMany({
    where: {
      userId: params.userId,
      browserSource: params.browserSource,
      browserProfile: params.browserProfile,
      OR: domainVariants(params.cookieDomain),
    },
    select: { name: true, creationUtc: true, expiresUtc: true, hasExpires: true },
  });
  const authCookies = cookies.filter(
    (cookie) => storedCookieIsLive(cookie) && isAuthCredentialCookieName(cookie.name)
  );
  let freshestCookieUtc: bigint | null = null;
  for (const cookie of authCookies) {
    if (cookie.creationUtc === null || cookie.creationUtc === undefined) continue;
    if (freshestCookieUtc === null || cookie.creationUtc > freshestCookieUtc) {
      freshestCookieUtc = cookie.creationUtc;
    }
  }
  return {
    cookieCount: authCookies.length,
    freshestCookieUtc,
  };
}

async function selectTopCookieBundle(params: {
  userId: string;
  authRealm: string;
  cookieDomain: string;
}): Promise<CookieBundleCandidate | null> {
  const bundles = await prisma.cookieBundle.findMany({
    where: { userId: params.userId, authRealm: params.authRealm },
  });
  if (bundles.length === 0) return null;

  const candidates = await Promise.all(
    bundles
      .filter((bundle) => bundle.disabledAt === null)
      .map(async (bundle) => {
        const summary = await cookieSummaryForBundle({
          userId: params.userId,
          cookieDomain: params.cookieDomain,
          browserSource: bundle.browserSource,
          browserProfile: bundle.browserProfile,
        });
        return {
          id: bundle.id,
          browserSource: bundle.browserSource,
          browserProfile: bundle.browserProfile,
          disabledAt: bundle.disabledAt,
          ...summary,
        };
      })
  );

  // An enabled marker without a matching *auth* cookie row is not an
  // authentication source. Tracking-only realm cookies still produced
  // cookieCount>0 historically and recorded "credential applied" while the
  // page stayed signed-out. Require auth-looking names (same bar as
  // authenticated-domain discovery in integrations/config.ts).
  const injectableCandidates = candidates.filter((candidate) => candidate.cookieCount > 0);

  injectableCandidates.sort((a, b) => {
    if ((a.disabledAt === null) !== (b.disabledAt === null)) {
      return a.disabledAt === null ? -1 : 1;
    }
    const aFresh = a.freshestCookieUtc ?? 0n;
    const bFresh = b.freshestCookieUtc ?? 0n;
    return aFresh > bFresh ? -1 : aFresh < bFresh ? 1 : 0;
  });
  return injectableCandidates[0] ?? null;
}

export async function resolveBrowserAuthCredentialSource(params: {
  userId: string;
  authRealm: string;
  steelContextId: string | null;
  /** Where the realm's cookies are stored; differs from the realm only under an ?authRealm= override. */
  cookieDomain?: string;
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
      cookieDomain: params.cookieDomain ?? params.authRealm,
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
  options?: {
    browser?: import('playwright').Browser;
    /**
     * Runs on this same connection once the realm's cookies are in place, so a
     * caller can snapshot the jar the session actually starts from (the
     * browser-template fork) without a second CDP handshake, together with the
     * one CookieBundle (account) injected for the realm, or null. Its failure
     * is logged and never fails credential preparation.
     */
    onCookiesReady?: (
      context: import('playwright').BrowserContext,
      injectedBundle: InjectedCookieBundle | null
    ) => Promise<void>;
  }
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
  const cookieDomain = cookieDomainForStartUrl(url);
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
    prisma.integration.findFirst({
      // Integration's unique key now includes accountId; this lookup wants the
      // user's browser_fingerprint row regardless of account, so findFirst keeps
      // the original behaviour without pinning an accountId.
      where: { userId, name: 'browser_fingerprint' },
    }),
    prisma.localStorageOrigin.findMany({
      where: originDomainFilter,
      select: { id: true, userId: true, origin: true, hash: true, updatedAt: true },
    }),
    prisma.indexedDBOrigin.findMany({
      where: originDomainFilter,
      select: { id: true, userId: true, origin: true, hash: true, updatedAt: true },
    }),
    prisma.browserPermission.findMany({ where: originDomainFilter }),
    prisma.cacheStorageOrigin.findMany({
      where: originDomainFilter,
      select: { id: true, userId: true, origin: true, hash: true, updatedAt: true },
    }),
  ]);
  log.info(`  [1/9] DB fetch complete (${Date.now() - startTime}ms)`);

  if (!dbSession?.wsUrl) {
    throw new Error('No WebSocket URL found for session');
  }

  let cookies: Awaited<ReturnType<typeof prisma.cookie.findMany>> = [];
  const steelContextId =
    dbSession.provider === 'steel' ? (dbSession.providerProfileId ?? null) : null;
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
    cookieDomain,
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
        ...cookieDomainWhere(cookieDomain),
        browserSource: authSource.browserSource,
        browserProfile: authSource.browserProfile,
      },
    });
    if (cookies.length === 0) {
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
      const connectTimeoutMs = credentialCdpConnectTimeoutMs();
      log.info(`  [3/9] Connecting to CDP...`, { connectTimeoutMs });
      browser = await chromium.connectOverCDP(steelCdpConnectionUrl(dbSession.wsUrl), {
        timeout: connectTimeoutMs,
      });
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
        const playwrightCookies = playwrightCookiesFromRows(cookies);

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

    if (options?.onCookiesReady !== undefined) {
      try {
        await options.onCookiesReady(
          context,
          authSource.kind === 'cookie_bundle' && hasCookies ? authSource : null
        );
      } catch (error) {
        log.warn('  [cookies] Post-injection snapshot failed; continuing', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // A BrowserContext is one remote Playwright channel. Concurrent
    // addInitScript mutations can starve that channel indefinitely, so enqueue
    // browser-state mutations serially and bound the entire best-effort phase.
    log.info(`  [4/5] Injecting browser state serially...`);
    const injectionTasks: Array<() => Promise<void>> = [];
    const injectionAbort = new AbortController();
    const originWriter = createOriginPayloadWriter(context, injectionAbort.signal);

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
      injectionTasks.push(async () => {
        try {
          localStorageResult = await injectLocalStorageState(
            originWriter,
            localStorageOrigins,
            startTime,
            injectionAbort.signal
          );
        } catch (error) {
          log.error('Failed to inject localStorage', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }

    // 4. Inject IndexedDB if available
    if (hasIndexedDB) {
      injectionTasks.push(async () => {
        try {
          indexedDBResult = await injectIndexedDBState(
            originWriter,
            indexedDBOrigins,
            startTime,
            injectionAbort.signal
          );
        } catch (error) {
          log.error('Failed to inject indexedDB', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }

    // 5. Inject permissions if available
    // Uses JavaScript override for permission query checks
    if (hasPermissions) {
      injectionTasks.push(async () => {
        try {
          permissionsResult = await injectPermissionState(context, permissions, startTime);
        } catch (error) {
          log.error('Failed to inject permissions', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }

    // 6. Inject Cache Storage metadata if available
    // Pre-opens caches so sites that check for cache existence work correctly
    if (hasCacheStorage) {
      injectionTasks.push(async () => {
        try {
          cacheStorageResult = await injectCacheStorageState(
            originWriter,
            cacheStorageOrigins,
            startTime,
            injectionAbort.signal
          );
        } catch (error) {
          log.error('Failed to inject cacheStorage', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }

    // 7. Always inject scrollbar-hiding CSS to ensure viewport matches screenshot (1280x800)
    // This prevents coordinate mismatch where viewport reports 1265 (with scrollbar) but screenshot is 1280
    injectionTasks.push(async () => {
      try {
        await injectScrollbarState(context, startTime);
      } catch (error) {
        log.error('Failed to inject scrollbar CSS', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    const stateTimeoutMs = browserStateInjectionTimeoutMs();
    // Deliberately propagates. `steel-injection.blackbox.ts` cements that a
    // browser-state timeout REJECTS rather than resuming with partial state:
    // a session silently missing localStorage/IndexedDB/permissions is harder
    // to diagnose than a loud, bounded failure. Do not soften this without
    // changing that invariant first.
    // withTimeout is a Promise.race and cannot cancel the IIFE, so without this
    // flag the serial loop keeps writing localStorage/IndexedDB/permission/cache
    // state into a context the caller already treats as failed.
    let injectionAborted = false;
    try {
      await withTimeout(
        (async () => {
          try {
            for (const injectState of injectionTasks) {
              if (injectionAborted) break;
              await injectState();
            }
          } finally {
            await originWriter.close();
          }
        })(),
        stateTimeoutMs,
        `Browser state injection timed out after ${stateTimeoutMs}ms`
      );
    } catch (error) {
      injectionAborted = true;
      injectionAbort.abort();
      throw error;
    }
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
