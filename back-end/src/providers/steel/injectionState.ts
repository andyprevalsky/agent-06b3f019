import { log } from './types';

interface InitScriptContext {
  addInitScript(script: string): Promise<unknown>;
}

export async function injectLocalStorageState(
  context: InitScriptContext,
  localStorageOrigins: Array<{ origin: string; entries: unknown }>,
  startTime: number
): Promise<{ injected: boolean; originCount: number }> {
  log.info(`  [localStorage] Injecting for ${localStorageOrigins.length} origins...`);
  const localStorageByOrigin: Record<string, Array<{ key: string; value: string }>> = {};
  for (const origin of localStorageOrigins) {
    let cleanOrigin = origin.origin;
    if (cleanOrigin.startsWith('ttps://')) {
      cleanOrigin = 'https://' + cleanOrigin.slice(7);
    } else if (!cleanOrigin.startsWith('http')) {
      cleanOrigin = 'https://' + cleanOrigin;
    }
    if (cleanOrigin.includes('/^0')) {
      cleanOrigin = cleanOrigin.split('/^0')[0];
    }
    localStorageByOrigin[cleanOrigin] = origin.entries as Array<{ key: string; value: string }>;
  }

  await context.addInitScript(`
    (function() {
      const allLocalStorage = ${JSON.stringify(localStorageByOrigin)};
      const currentOrigin = window.location.origin;
      for (const [origin, entries] of Object.entries(allLocalStorage)) {
        if (currentOrigin === origin ||
            currentOrigin.endsWith(origin.replace('https://', '.')) ||
            origin.includes(currentOrigin.replace('https://', ''))) {
          for (const entry of entries) {
            try { localStorage.setItem(entry.key, entry.value); } catch (e) {}
          }
          log.info('[localStorage] Injected', entries.length, 'entries for', currentOrigin);
        }
      }
    })();
  `);
  log.info(`  [localStorage] Injected (${Date.now() - startTime}ms)`);
  return { injected: true, originCount: localStorageOrigins.length };
}

export async function injectIndexedDBState(
  context: InitScriptContext,
  indexedDBOrigins: Array<{ origin: string; databases: unknown }>,
  startTime: number
): Promise<{ injected: boolean; originCount: number }> {
  log.info(`  [indexedDB] Injecting for ${indexedDBOrigins.length} origins...`);
  const indexedDBByOrigin: Record<string, unknown> = {};
  for (const origin of indexedDBOrigins) {
    indexedDBByOrigin[origin.origin] = origin.databases;
  }

  await context.addInitScript(`
    (function() {
      const allIndexedDB = ${JSON.stringify(indexedDBByOrigin)};
      const currentOrigin = window.location.origin;
      let matchingDatabases = null;
      for (const [origin, databases] of Object.entries(allIndexedDB)) {
        if (currentOrigin === origin ||
            currentOrigin.includes(origin.replace('https://', '').replace('http://', ''))) {
          matchingDatabases = databases;
          break;
        }
      }
      if (!matchingDatabases) return;
      async function injectDatabase(dbInfo) {
        return new Promise((resolve) => {
          const checkRequest = indexedDB.open(dbInfo.name);
          checkRequest.onerror = () => resolve(false);
          checkRequest.onsuccess = (e) => {
            const existingDb = e.target.result;
            const request = indexedDB.open(dbInfo.name, existingDb.version + 1);
            existingDb.close();
            request.onerror = () => resolve(false);
            request.onupgradeneeded = (event) => {
              const db = event.target.result;
              for (const store of dbInfo.objectStores) {
                if (!db.objectStoreNames.contains(store.name)) {
                  try { db.createObjectStore(store.name); } catch (err) {}
                }
              }
            };
            request.onsuccess = (event) => {
              const db = event.target.result;
              for (const store of dbInfo.objectStores) {
                if (db.objectStoreNames.contains(store.name) && store.records && store.records.length > 0) {
                  try {
                    const tx = db.transaction(store.name, 'readwrite');
                    const objectStore = tx.objectStore(store.name);
                    for (const record of store.records) {
                      try { objectStore.put(record.value, record.key); } catch (err) {}
                    }
                  } catch (err) {}
                }
              }
              db.close();
              resolve(true);
            };
          };
          checkRequest.onblocked = () => resolve(false);
        });
      }
      (async () => {
        for (const dbInfo of matchingDatabases) {
          await injectDatabase(dbInfo);
        }
      })();
    })();
  `);
  log.info(`  [indexedDB] Injected (${Date.now() - startTime}ms)`);
  return { injected: true, originCount: indexedDBOrigins.length };
}

export async function injectPermissionState(
  context: InitScriptContext,
  permissions: Array<{ origin: string; permission: string; setting: number }>,
  startTime: number
): Promise<{ injected: boolean; grantCount: number }> {
  log.info(`  [permissions] Injecting ${permissions.length} permission grants...`);
  const permissionGrants = permissions.map((p) => ({
    origin: p.origin,
    permission: p.permission,
    setting: p.setting,
  }));

  await context.addInitScript(`
    (function() {
      'use strict';
      const grants = ${JSON.stringify(permissionGrants)};
      function matchOrigin(pattern, origin) {
        if (pattern === origin) return true;
        if (pattern.startsWith('[*.]')) {
          const domain = pattern.slice(4);
          const originHost = new URL(origin).hostname;
          return originHost === domain || originHost.endsWith('.' + domain);
        }
        return false;
      }
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = async function(descriptor) {
        const grant = grants.find(g =>
          g.permission === descriptor.name && matchOrigin(g.origin, window.location.origin)
        );
        if (!grant) return originalQuery(descriptor);
        return {
          state: grant.setting === 1 ? 'granted' : 'denied',
          name: descriptor.name,
          onchange: null,
          addEventListener: function() {},
          removeEventListener: function() {},
          dispatchEvent: function() { return true; },
        };
      };
    })();
  `);
  log.info(`  [permissions] Injected (${Date.now() - startTime}ms)`);
  return { injected: true, grantCount: permissions.length };
}

export async function injectCacheStorageState(
  context: InitScriptContext,
  cacheStorageOrigins: Array<{ origin: string; caches: unknown }>,
  startTime: number
): Promise<{ injected: boolean; originCount: number }> {
  log.info(`  [cacheStorage] Injecting metadata for ${cacheStorageOrigins.length} origins...`);
  const cachesByOrigin: Record<string, Array<{ name: string }>> = {};
  for (const origin of cacheStorageOrigins) {
    const caches = origin.caches as Array<{ name: string; size?: number }>;
    cachesByOrigin[origin.origin] = caches.map((c) => ({ name: c.name }));
  }

  await context.addInitScript(`
    (function() {
      'use strict';
      const cachesByOrigin = ${JSON.stringify(cachesByOrigin)};
      const currentOrigin = window.location.origin;
      let matchingCaches = null;
      for (const [origin, caches] of Object.entries(cachesByOrigin)) {
        if (currentOrigin === origin ||
            currentOrigin.includes(origin.replace('https://', '').replace('http://', ''))) {
          matchingCaches = caches;
          break;
        }
      }
      if (!matchingCaches || matchingCaches.length === 0) return;
      (async function() {
        for (const cache of matchingCaches) {
          try { await caches.open(cache.name); } catch (e) {}
        }
      })();
    })();
  `);
  log.info(`  [cacheStorage] Injected (${Date.now() - startTime}ms)`);
  return { injected: true, originCount: cacheStorageOrigins.length };
}

export async function injectScrollbarState(
  context: InitScriptContext,
  startTime: number
): Promise<void> {
  await context.addInitScript(`
    (function() {
      const style = document.createElement('style');
      style.id = 'yutori-scrollbar-hide';
      style.textContent = \`
        *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
        * { -ms-overflow-style: none !important; scrollbar-width: none !important; }
      \`;
      if (document.head) {
        document.head.appendChild(style);
      } else {
        document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
      }
    })();
  `);
  log.info(
    `  [scrollbar] CSS injected for consistent 1280x800 viewport (${Date.now() - startTime}ms)`
  );
}
