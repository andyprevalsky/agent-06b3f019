/**
 * Steel browser data injection — cookies, fingerprint, localStorage, IndexedDB, permissions, cacheStorage.
 */

import { prisma } from '../database';
import { buildFingerprintScript } from './injectionScripts';
import { type FingerprintData, log } from './types';

export async function injectUserData(
  sessionId: string,
  userId: string,
  startUrl: string
): Promise<{
  cookies: { injected: boolean; cookieCount: number };
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
  // Match: exact domain, with leading dot, and registrable domain variants
  const domainVariants = [
    hostname, // "www.amazon.com"
    `.${hostname}`, // ".www.amazon.com"
    registrableDomain, // "amazon.com"
    `.${registrableDomain}`, // ".amazon.com"
  ];
  const uniqueDomains = [...new Set(domainVariants)];
  const cookieDomainFilter = { userId, domain: { in: uniqueDomains } };
  log.info(
    `  [cookies] Filtering to domains for start_url "${startUrl}": ${uniqueDomains.join(', ')}`
  );

  // Fetch cookies, fingerprint, localStorage, IndexedDB, permissions, and cacheStorage in parallel
  log.info(`  [1/9] Fetching user data from DB...`);
  const [
    cookies,
    integration,
    localStorageOrigins,
    indexedDBOrigins,
    permissions,
    cacheStorageOrigins,
  ] = await Promise.all([
    prisma.cookie.findMany({ where: cookieDomainFilter }),
    prisma.integration.findUnique({
      where: { userId_name: { userId, name: 'browser_fingerprint' } },
    }),
    prisma.localStorageOrigin.findMany({ where: { userId } }),
    prisma.indexedDBOrigin.findMany({ where: { userId } }),
    prisma.browserPermission.findMany({ where: { userId } }),
    prisma.cacheStorageOrigin.findMany({ where: { userId } }),
  ]);
  log.info(`  [1/9] DB fetch complete (${Date.now() - startTime}ms)`);

  const hasCookies = cookies.length > 0;
  const fp = (integration?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  const hasFingerprint = !!fp;
  const hasLocalStorage = localStorageOrigins.length > 0;
  const hasIndexedDB = indexedDBOrigins.length > 0;
  const hasPermissions = permissions.length > 0;
  const hasCacheStorage = cacheStorageOrigins.length > 0;

  log.info(
    `  Cookies: ${hasCookies ? cookies.length : 'none'}, Fingerprint: ${hasFingerprint ? 'yes' : 'no'}, localStorage: ${hasLocalStorage ? localStorageOrigins.length + ' origins' : 'none'}, IndexedDB: ${hasIndexedDB ? indexedDBOrigins.length + ' origins' : 'none'}, Permissions: ${hasPermissions ? permissions.length + ' grants' : 'none'}, CacheStorage: ${hasCacheStorage ? cacheStorageOrigins.length + ' origins' : 'none'}`
  );

  // Note: We always need CDP connection now to inject scrollbar CSS
  // (previously returned early when no cookies/fingerprint)

  // Get session info to get WebSocket URL
  log.info(`  [2/9] Fetching session wsUrl from DB...`);
  const dbSession = await prisma.browserSession.findUnique({
    where: { sessionId },
  });
  log.info(`  [2/9] Session fetch complete (${Date.now() - startTime}ms)`);

  if (!dbSession?.wsUrl) {
    throw new Error('No WebSocket URL found for session');
  }

  // Connect via Playwright (single connection for both operations)
  const { chromium } = await import('playwright');
  let browser;

  try {
    log.info(`  [3/9] Connecting to CDP...`);
    browser = await chromium.connectOverCDP(dbSession.wsUrl);
    const context = browser.contexts()[0];
    log.info(`  [3/9] CDP connected (${Date.now() - startTime}ms)`);

    let cookieResult = { injected: false, cookieCount: 0 };
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
            cookieResult = { injected: true, cookieCount: validCookies.length };
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
            log.info(`  [localStorage] Injecting for ${localStorageOrigins.length} origins...`);

            // Build origin -> entries map
            const localStorageByOrigin: Record<string, Array<{ key: string; value: string }>> = {};
            for (const origin of localStorageOrigins) {
              // Fix origin format if needed
              let cleanOrigin = origin.origin;
              if (cleanOrigin.startsWith('ttps://')) {
                cleanOrigin = 'https://' + cleanOrigin.slice(7);
              } else if (!cleanOrigin.startsWith('http')) {
                cleanOrigin = 'https://' + cleanOrigin;
              }
              // Handle partitioned storage format
              if (cleanOrigin.includes('/^0')) {
                cleanOrigin = cleanOrigin.split('/^0')[0];
              }
              localStorageByOrigin[cleanOrigin] = origin.entries as Array<{
                key: string;
                value: string;
              }>;
            }

            const localStorageScript = `
            (function() {
              const allLocalStorage = ${JSON.stringify(localStorageByOrigin)};
              const currentOrigin = window.location.origin;

              for (const [origin, entries] of Object.entries(allLocalStorage)) {
                // Check if current origin matches
                if (currentOrigin === origin ||
                    currentOrigin.endsWith(origin.replace('https://', '.')) ||
                    origin.includes(currentOrigin.replace('https://', ''))) {

                  for (const entry of entries) {
                    try {
                      localStorage.setItem(entry.key, entry.value);
                    } catch (e) {}
                  }
                  log.info('[localStorage] ✅ Injected', entries.length, 'entries for', currentOrigin);
                }
              }
            })();
          `;

            await context.addInitScript(localStorageScript);
            log.info(`  [localStorage] ✅ Injected (${Date.now() - startTime}ms)`);
            localStorageResult = { injected: true, originCount: localStorageOrigins.length };
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
            log.info(`  [indexedDB] Injecting for ${indexedDBOrigins.length} origins...`);

            // Build origin -> databases map
            interface IDBRecord {
              key: unknown;
              value: unknown;
            }
            interface IDBObjectStore {
              name: string;
              records: IDBRecord[];
            }
            interface IDBDatabase {
              name: string;
              objectStores: IDBObjectStore[];
            }

            const indexedDBByOrigin: Record<string, IDBDatabase[]> = {};
            for (const origin of indexedDBOrigins) {
              indexedDBByOrigin[origin.origin] = origin.databases as unknown as IDBDatabase[];
            }

            // IndexedDB injection is more complex - we need to recreate databases, object stores, and records
            const indexedDBScript = `
            (function() {
              const allIndexedDB = ${JSON.stringify(indexedDBByOrigin)};
              const currentOrigin = window.location.origin;

              // Find matching data for current origin
              let matchingDatabases = null;
              for (const [origin, databases] of Object.entries(allIndexedDB)) {
                if (currentOrigin === origin ||
                    currentOrigin.includes(origin.replace('https://', '').replace('http://', ''))) {
                  matchingDatabases = databases;
                  break;
                }
              }

              if (!matchingDatabases) return;

              // Helper to inject data into a database
              async function injectDatabase(dbInfo) {
                return new Promise((resolve) => {
                  // First, try to open existing database to get version
                  const checkRequest = indexedDB.open(dbInfo.name);

                  checkRequest.onerror = () => {
                    log.warn('[IndexedDB] Failed to check database:', dbInfo.name);
                    resolve(false);
                  };

                  checkRequest.onsuccess = (e) => {
                    const existingDb = e.target.result;
                    const currentVersion = existingDb.version;
                    existingDb.close();

                    // Open with incremented version to trigger upgrade
                    const request = indexedDB.open(dbInfo.name, currentVersion + 1);

                    request.onerror = () => {
                      log.warn('[IndexedDB] Failed to open database:', dbInfo.name);
                      resolve(false);
                    };

                    request.onupgradeneeded = (e) => {
                      const db = e.target.result;

                      // Create object stores that don't exist
                      for (const store of dbInfo.objectStores) {
                        if (!db.objectStoreNames.contains(store.name)) {
                          try {
                            db.createObjectStore(store.name);
                          } catch (err) {}
                        }
                      }
                    };

                    request.onsuccess = (e) => {
                      const db = e.target.result;

                      // Add records to each object store
                      for (const store of dbInfo.objectStores) {
                        if (db.objectStoreNames.contains(store.name) && store.records && store.records.length > 0) {
                          try {
                            const tx = db.transaction(store.name, 'readwrite');
                            const objectStore = tx.objectStore(store.name);

                            for (const record of store.records) {
                              try {
                                objectStore.put(record.value, record.key);
                              } catch (e) {}
                            }
                          } catch (e) {}
                        }
                      }

                      db.close();
                      log.info('[IndexedDB] ✅ Injected database:', dbInfo.name);
                      resolve(true);
                    };
                  };

                  checkRequest.onblocked = () => {
                    log.warn('[IndexedDB] Database blocked:', dbInfo.name);
                    resolve(false);
                  };
                });
              }

              // Inject all databases
              (async () => {
                for (const dbInfo of matchingDatabases) {
                  await injectDatabase(dbInfo);
                }
              })();
            })();
          `;

            await context.addInitScript(indexedDBScript);
            log.info(`  [indexedDB] ✅ Injected (${Date.now() - startTime}ms)`);
            indexedDBResult = { injected: true, originCount: indexedDBOrigins.length };
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
            log.info(`  [permissions] Injecting ${permissions.length} permission grants...`);

            // Build permission data for JavaScript injection
            const permissionGrants = permissions.map((p) => ({
              origin: p.origin,
              permission: p.permission,
              setting: p.setting,
            }));

            // JavaScript injection to override navigator.permissions.query
            const permissionScript = `
            (function() {
              'use strict';

              const grants = ${JSON.stringify(permissionGrants)};

              // Helper to match origin patterns
              function matchOrigin(pattern, origin) {
                // Exact match
                if (pattern === origin) return true;

                // Wildcard pattern: "[*.]example.com" matches "*.example.com"
                if (pattern.startsWith('[*.]')) {
                  const domain = pattern.slice(4);
                  const originHost = new URL(origin).hostname;
                  return originHost === domain || originHost.endsWith('.' + domain);
                }

                return false;
              }

              // Override navigator.permissions.query
              const originalQuery = navigator.permissions.query.bind(navigator.permissions);
              navigator.permissions.query = async function(descriptor) {
                const permName = descriptor.name;
                const currentOrigin = window.location.origin;

                // Find matching grant
                const grant = grants.find(g =>
                  g.permission === permName && matchOrigin(g.origin, currentOrigin)
                );

                if (grant) {
                  const state = grant.setting === 1 ? 'granted' : 'denied';
                  return {
                    state,
                    name: permName,
                    onchange: null,
                    addEventListener: function() {},
                    removeEventListener: function() {},
                    dispatchEvent: function() { return true; },
                  };
                }

                // Fall back to original for unmatched permissions
                return originalQuery(descriptor);
              };

              log.info('[Permissions] ✅ Permission overrides injected for', grants.length, 'grants');
            })();
          `;

            await context.addInitScript(permissionScript);
            log.info(`  [permissions] ✅ Injected (${Date.now() - startTime}ms)`);
            permissionsResult = { injected: true, grantCount: permissions.length };
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
            log.info(
              `  [cacheStorage] Injecting metadata for ${cacheStorageOrigins.length} origins...`
            );

            // Build origin -> caches map
            const cachesByOrigin: Record<string, Array<{ name: string }>> = {};
            for (const origin of cacheStorageOrigins) {
              const caches = origin.caches as Array<{ name: string; size?: number }>;
              cachesByOrigin[origin.origin] = caches.map((c) => ({ name: c.name }));
            }

            const cacheStorageScript = `
            (function() {
              'use strict';

              const cachesByOrigin = ${JSON.stringify(cachesByOrigin)};
              const currentOrigin = window.location.origin;

              // Find matching caches for current origin
              let matchingCaches = null;
              for (const [origin, caches] of Object.entries(cachesByOrigin)) {
                if (currentOrigin === origin ||
                    currentOrigin.includes(origin.replace('https://', '').replace('http://', ''))) {
                  matchingCaches = caches;
                  break;
                }
              }

              if (!matchingCaches || matchingCaches.length === 0) return;

              // Pre-open caches (doesn't add any data, just creates empty caches)
              (async function() {
                for (const cache of matchingCaches) {
                  try {
                    await caches.open(cache.name);
                    log.info('[CacheStorage] ✅ Opened cache:', cache.name);
                  } catch (e) {
                    log.warn('[CacheStorage] Failed to open cache:', cache.name, e);
                  }
                }
              })();
            })();
          `;

            await context.addInitScript(cacheStorageScript);
            log.info(`  [cacheStorage] ✅ Injected (${Date.now() - startTime}ms)`);
            cacheStorageResult = { injected: true, originCount: cacheStorageOrigins.length };
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
          const scrollbarHideScript = `
          (function() {
            const style = document.createElement('style');
            style.id = 'yutori-scrollbar-hide';
            style.textContent = \`
              /* Hide scrollbars on ALL elements for consistent 1280x800 viewport */
              *::-webkit-scrollbar {
                display: none !important;
                width: 0 !important;
                height: 0 !important;
              }
              * {
                -ms-overflow-style: none !important;
                scrollbar-width: none !important;
              }
            \`;
            if (document.head) {
              document.head.appendChild(style);
            } else {
              document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
            }
          })();
        `;
          await context.addInitScript(scrollbarHideScript);
          log.info(
            `  [scrollbar] ✅ CSS injected for consistent 1280x800 viewport (${Date.now() - startTime}ms)`
          );
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
