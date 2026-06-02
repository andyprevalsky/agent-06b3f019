/**
 * Steel browser data injection — cookies, fingerprint, localStorage, IndexedDB, permissions, cacheStorage.
 */

import { prisma } from '../database';
import { canonicalAuthRealm } from '../authRealm';
import { buildFingerprintScript } from './injectionScripts';
import { type FingerprintData, log } from './types';
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
    params.steelContextId !== null && params.authRealm !== ''
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
  startUrl: string
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
  // Extract registrable domain (e.g. "www.amazon.com" → "amazon.com")
  const parts = hostname.split('.');
  const registrableDomain = parts.length > 2 ? parts.slice(-2).join('.') : hostname;
  const authRealm = canonicalAuthRealm(url);
  // Match: exact domain, with leading dot, and registrable domain variants
  const domainVariants = [
    hostname, // "www.amazon.com"
    `.${hostname}`, // ".www.amazon.com"
    registrableDomain, // "amazon.com"
    `.${registrableDomain}`, // ".amazon.com"
  ];
  const uniqueDomains = [...new Set(domainVariants)];
  // Origin-based tables (localStorage, IndexedDB, cacheStorage, permissions) store
  // origins like "https://domain.com". Use boundary-aware endsWith matching to
  // avoid false positives (e.g. "evilamazon.com" matching "amazon.com").
  const originDomainFilter = {
    userId,
    OR: [
      { origin: { endsWith: `://${registrableDomain}` } }, // exact: https://amazon.com
      { origin: { contains: `://${registrableDomain}:` } }, // exact with port: https://amazon.com:8443
      { origin: { endsWith: `.${registrableDomain}` } }, // subdomain: https://www.amazon.com
      { origin: { contains: `.${registrableDomain}:` } }, // subdomain with port: https://www.amazon.com:8443
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
    throw new Error('No WebSocket URL found for session');
  }

  let cookies: Awaited<ReturnType<typeof prisma.cookie.findMany>> = [];
  const steelContextId = dbSession.context.contextId;
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
  }

  const hasCookies = cookies.length > 0;
  const fp = (integration?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  const hasFingerprint = !!fp && envEnabled('BROWSER_AGENT_FINGERPRINT_INJECTION_ENABLED', true);
  const hasLocalStorage = localStorageOrigins.length > 0;
  const hasIndexedDB = indexedDBOrigins.length > 0;
  const hasPermissions = permissions.length > 0;
  const hasCacheStorage = cacheStorageOrigins.length > 0;

  log.info(
    `  Cookies: ${hasCookies ? cookies.length : 'none'}, Fingerprint: ${hasFingerprint ? 'yes' : 'no'}, localStorage: ${hasLocalStorage ? localStorageOrigins.length + ' origins' : 'none'}, IndexedDB: ${hasIndexedDB ? indexedDBOrigins.length + ' origins' : 'none'}, Permissions: ${hasPermissions ? permissions.length + ' grants' : 'none'}, CacheStorage: ${hasCacheStorage ? cacheStorageOrigins.length + ' origins' : 'none'}`
  );

  // Note: We always need CDP connection now to inject scrollbar CSS
  // (previously returned early when no cookies/fingerprint)

  // Connect via Playwright (single connection for both operations)
  const { chromium } = await import('playwright');
  let browser;

  try {
    log.info(`  [3/9] Connecting to CDP...`);
    browser = await chromium.connectOverCDP(dbSession.wsUrl);
    const context = browser.contexts()[0];
    log.info(`  [3/9] CDP connected (${Date.now() - startTime}ms)`);

    let cookieResult = {
      injected: false,
      cookieCount: 0,
      authSource: authSource.kind,
      credentialRef: authSource.credentialRef,
    };
    let fingerprintResult = { injected: false };
    let localStorageResult = { injected: false, originCount: 0 };
    let indexedDBResult = { injected: false, originCount: 0 };
    let permissionsResult = { injected: false, grantCount: 0 };
    let cacheStorageResult = { injected: false, originCount: 0 };

    // Run all injections in parallel for performance
    log.info(`  [4/5] Injecting browser state in parallel...`);
    const injectionPromises: Promise<void>[] = [];

    // 1. Inject cookies if available
    if (hasCookies) {
      injectionPromises.push(
        (async () => {
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

            const validCookies = playwrightCookies.filter((c) => c.name && c.value);
            log.info(
              `  [cookies] Transform complete, ${validCookies.length} valid (${Date.now() - startTime}ms)`
            );

            // Inject all cookies in one CDP call
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
          }
        })()
      );
    }

    // 2. Inject fingerprint via CDP + JS script if available
    if (hasFingerprint && fp) {
      injectionPromises.push(
        (async () => {
          try {
            log.info(`  [fingerprint] Injecting via CDP and script...`);

            // Get the page for init script injection
            const page = context.pages()[0];
            if (!page) {
              log.error(`  [fingerprint] ❌ No page available for CDP session`);
              return;
            }

            // Create page-level CDP session for Client Hints override
            // (User-Agent is already set at Steel session creation level)
            const cdpSession = await context.newCDPSession(page);

            // IMPORTANT: Network.enable MUST be called before setUserAgentOverride
            // Without this, the userAgentMetadata won't affect HTTP headers
            await cdpSession.send('Network.enable');

            // 2a. Set Client Hints at HTTP header level via CDP
            // User-Agent is already set by Steel, we just need the metadata for Sec-CH-UA-* headers
            if (fp.userAgentData) {
              log.info(`  [fingerprint] Setting Client Hints via CDP...`);
              const userAgentOverrideParams = {
                userAgent: fp.navigator.userAgent, // Must match what Steel set
                acceptLanguage: fp.navigator.languages.join(','),
                platform: fp.navigator.platform,
                userAgentMetadata: {
                  brands: fp.userAgentData.brands,
                  fullVersionList: fp.userAgentData.fullVersionList,
                  platform: fp.userAgentData.platform,
                  platformVersion: fp.userAgentData.platformVersion,
                  architecture: fp.userAgentData.architecture,
                  model: fp.userAgentData.model,
                  mobile: fp.userAgentData.mobile,
                  bitness: fp.userAgentData.bitness,
                },
              };
              await cdpSession.send('Network.setUserAgentOverride', userAgentOverrideParams);
              log.info(
                `  [fingerprint] ✅ Client Hints: platform=${fp.userAgentData.platform}, arch=${fp.userAgentData.architecture}`
              );
            }

            // 2b. Disable WebRTC IP leak (prevent real IP from being exposed)
            log.info(`  [fingerprint] Disabling WebRTC IP leak via CDP...`);
            try {
              // Use WebRTC IP handling policy to prevent leaks
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDP method not in Playwright's type defs
              await cdpSession.send('Emulation.setAutomationOverride' as any, {
                enabled: false,
              });
            } catch {
              // This CDP method may not be available in all Chrome versions
              log.info(`  [fingerprint] WebRTC leak prevention not available via CDP`);
            }

            // 2d. Inject comprehensive JS fingerprint spoofing script
            const fingerprintScript = buildFingerprintScript(fp);

            await context.addInitScript(fingerprintScript);
            log.info(`  [fingerprint] ✅ Injected (${Date.now() - startTime}ms)`);
            fingerprintResult = { injected: true };
          } catch (error) {
            log.error('Failed to inject fingerprint', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })()
      );
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
    // Always disconnect from the browser (doesn't close the Steel session)
    if (browser) {
      log.info(`  [5/5] Closing CDP connection...`);
      await browser.close();
      log.info(`🔐 [injectUserData] COMPLETE (${Date.now() - startTime}ms total)`);
    }
  }
}
