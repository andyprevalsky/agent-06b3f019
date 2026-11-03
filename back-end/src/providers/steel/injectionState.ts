import { log } from './types';
import {
  injectOriginPayload,
  type InitScriptContext,
  type OriginPayloadRef,
} from './injectionOriginPayload';
import type { OriginPayloadContext } from './injectionOriginPage';

type LocalStorageOriginState = OriginPayloadRef | { origin: string; entries: unknown };
type IndexedDBOriginState = OriginPayloadRef | { origin: string; databases: unknown };
type CacheStorageOriginState = OriginPayloadRef | { origin: string; caches: unknown };

/**
 * The first-party origin a stored localStorage key restores into, or null.
 * The Mac reader drops the storage key's first byte (`ttps://host`); repair only
 * that loss. Partitioned third-party keys (`<origin>/^0<top-level-site>`) and
 * extension/internal schemes have no first-party document to restore into.
 */
export function restorableLocalStorageOrigin(storageKey: string): string | null {
  const candidate = /^ttps?:\/\//.test(storageKey) ? `h${storageKey}` : storageKey;
  try {
    const url = new URL(candidate);
    const web = url.protocol === 'https:' || url.protocol === 'http:';
    return web && url.origin === candidate ? candidate : null;
  } catch {
    return null;
  }
}

export async function injectLocalStorageState(
  context: OriginPayloadContext,
  localStorageOrigins: LocalStorageOriginState[],
  startTime: number,
  signal?: AbortSignal
): Promise<{ injected: boolean; originCount: number }> {
  // One origin can have a Mac row and a cloud-harvest row. Restore them in one
  // visit, oldest first, so the newer value of a shared key wins.
  const restorable = localStorageOrigins
    .flatMap((row) => {
      const origin = restorableLocalStorageOrigin(row.origin);
      return origin === null ? [] : [{ row, origin }];
    })
    .sort(
      (a, b) =>
        a.origin.localeCompare(b.origin) ||
        ('updatedAt' in a.row ? a.row.updatedAt.getTime() : 0) -
          ('updatedAt' in b.row ? b.row.updatedAt.getTime() : 0)
    );
  log.info(
    `  [localStorage] Injecting for ${restorable.length} of ${localStorageOrigins.length} stored keys...`
  );
  const restored = new Set<string>();
  for (const { row, origin } of restorable) {
    const injected = await injectOriginPayload(
      context,
      row,
      'LocalStorageOrigin',
      `
      for (const entry of data) {
        try { localStorage.setItem(entry.key, entry.value); } catch (e) {}
      }`,
      'entries' in row ? row.entries : undefined,
      origin,
      signal
    );
    if (injected) restored.add(origin);
  }
  log.info(`  [localStorage] Injected (${Date.now() - startTime}ms)`);
  return { injected: restored.size > 0, originCount: restored.size };
}

export async function injectIndexedDBState(
  context: OriginPayloadContext,
  indexedDBOrigins: IndexedDBOriginState[],
  startTime: number,
  signal?: AbortSignal
): Promise<{ injected: boolean; originCount: number }> {
  log.info(`  [indexedDB] Injecting for ${indexedDBOrigins.length} origins...`);
  let restored = 0;
  for (const origin of indexedDBOrigins) {
    const injected = await injectOriginPayload(
      context,
      origin,
      'IndexedDBOrigin',
      `
      const matchingDatabases = data;
      if (!matchingDatabases) return;
      async function injectDatabase(dbInfo) {
        return new Promise((resolve) => {
          const createStores = (db) => {
            for (const store of dbInfo.objectStores) {
              if (!db.objectStoreNames.contains(store.name)) {
                try { db.createObjectStore(store.name); } catch (err) {}
              }
            }
          };
          const restoreRecords = async (db) => {
            try {
              await Promise.all(dbInfo.objectStores.map((store) => {
                if (!db.objectStoreNames.contains(store.name) || !store.records?.length) return;
                return new Promise((settled) => {
                  try {
                    const tx = db.transaction(store.name, 'readwrite');
                    tx.oncomplete = () => settled(true);
                    tx.onabort = () => settled(false);
                    const objectStore = tx.objectStore(store.name);
                    for (const record of store.records) {
                      try { objectStore.put(record.value, record.key); } catch (err) {}
                    }
                  } catch (err) { settled(false); }
                });
              }));
            } finally {
              db.close();
              resolve(true);
            }
          };
          const checkRequest = indexedDB.open(dbInfo.name);
          checkRequest.onerror = () => resolve(false);
          checkRequest.onupgradeneeded = (e) => createStores(e.target.result);
          checkRequest.onsuccess = (e) => {
            const existingDb = e.target.result;
            if (dbInfo.objectStores.every(store => existingDb.objectStoreNames.contains(store.name))) {
              void restoreRecords(existingDb);
              return;
            }
            const request = indexedDB.open(dbInfo.name, existingDb.version + 1);
            existingDb.close();
            request.onerror = () => resolve(false);
            request.onupgradeneeded = (event) => createStores(event.target.result);
            request.onsuccess = (event) => { void restoreRecords(event.target.result); };
          };
          checkRequest.onblocked = () => resolve(false);
        });
      }
      return (async () => {
        for (const dbInfo of matchingDatabases) {
          await injectDatabase(dbInfo);
        }
      })();
`,
      'databases' in origin ? origin.databases : undefined,
      origin.origin,
      signal
    );
    if (injected) restored++;
  }
  log.info(`  [indexedDB] Injected (${Date.now() - startTime}ms)`);
  return { injected: restored > 0, originCount: restored };
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
  context: OriginPayloadContext,
  cacheStorageOrigins: CacheStorageOriginState[],
  startTime: number,
  signal?: AbortSignal
): Promise<{ injected: boolean; originCount: number }> {
  log.info(`  [cacheStorage] Injecting metadata for ${cacheStorageOrigins.length} origins...`);
  let restored = 0;
  for (const origin of cacheStorageOrigins) {
    const names =
      'caches' in origin
        ? (origin.caches as Array<{ name: string }>).map((c) => ({ name: c.name }))
        : undefined;
    const injected = await injectOriginPayload(
      context,
      origin,
      'CacheStorageOrigin',
      `
      if (!data || data.length === 0) return;
      return (async function() {
        for (const cache of data) {
          try { await caches.open(cache.name); } catch (e) {}
        }
      })();`,
      names,
      origin.origin,
      signal
    );
    if (injected) restored++;
  }
  log.info(`  [cacheStorage] Injected (${Date.now() - startTime}ms)`);
  return { injected: restored > 0, originCount: restored };
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
