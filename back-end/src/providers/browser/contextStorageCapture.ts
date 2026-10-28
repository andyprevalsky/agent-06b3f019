/**
 * Provider-neutral capture of a browser context's cookies plus the
 * localStorage/IndexedDB of every open page/frame origin. Playwright's
 * storageState() only reports origins the calling client watched being
 * navigated, so a client attached to a session someone else drove (state
 * harvest, profile change detection) misses them. Used by Tilion harvest and
 * Browser Use profile change detection.
 */
import type { BrowserContext } from 'playwright';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Per-frame storage read budget: a hung page must not stall the harvest. */
const FRAME_STORAGE_READ_TIMEOUT_MS = 3_000;
const MAX_HARVEST_ORIGINS = 20;

/**
 * In-page read of the frame's own origin: localStorage plus IndexedDB in the
 * shape recoveryOriginStorageScript restores ({name, version, stores:[{name,
 * keyPath, autoIncrement, records:[{key?, value}]}]}). Bounded by database,
 * record and time limits; values that do not survive JSON are skipped.
 */
export const FRAME_STORAGE_SCRIPT = `(async () => {
  const deadline = Date.now() + 2500;
  const localStorageItems = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const name = localStorage.key(i);
      if (name !== null) localStorageItems.push({ name, value: localStorage.getItem(name) ?? '' });
    }
  } catch {}
  const indexedDBItems = [];
  try {
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    for (const info of databases.slice(0, 10)) {
      if (!info.name || Date.now() > deadline) break;
      const db = await new Promise((resolve) => {
        const request = indexedDB.open(info.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
        request.onupgradeneeded = () => { try { request.transaction.abort(); } catch {} resolve(null); };
      });
      if (!db) continue;
      const stores = [];
      for (const storeName of Array.from(db.objectStoreNames)) {
        if (Date.now() > deadline) break;
        const store = db.transaction(storeName, 'readonly').objectStore(storeName);
        const [keys, values] = await Promise.all(
          [store.getAllKeys(undefined, 500), store.getAll(undefined, 500)].map(
            (request) => new Promise((resolve) => {
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => resolve([]);
            })
          )
        );
        const records = [];
        values.forEach((value, index) => {
          try {
            JSON.stringify(value);
            records.push(store.keyPath === null ? { key: keys[index], value } : { value });
          } catch {}
        });
        stores.push({ name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, records });
      }
      indexedDBItems.push({ name: db.name, version: db.version, stores });
      db.close();
    }
  } catch {}
  return { origin: location.origin, localStorage: localStorageItems, indexedDB: indexedDBItems };
})()`;

type StorageFrame = { url(): string; evaluate(script: string): Promise<unknown> };
export type HarvestContext = {
  storageState(options: { indexedDB: boolean }): Promise<StorageState>;
  pages(): Array<{ frames(): StorageFrame[] }>;
};
type HarvestedOrigin = StorageState['origins'][number] & { indexedDB?: unknown[] };

function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

async function readFrameStorage(frame: StorageFrame): Promise<HarvestedOrigin | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      frame.evaluate(FRAME_STORAGE_SCRIPT),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FRAME_STORAGE_READ_TIMEOUT_MS);
      }),
    ]);
    if (result === null || typeof result !== 'object') return null;
    const read = result as HarvestedOrigin;
    return typeof read.origin === 'string' && Array.isArray(read.localStorage) ? read : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cookies plus every open origin's localStorage/IndexedDB.
 *
 * Playwright's storageState() lists only origins THIS client watched being
 * navigated. The harvest is always a fresh client on a session someone else
 * drove, so it returned origins=[] while the tab still held localStorage
 * (lane E, 2026-10-21). Read each page/frame origin in-page and merge;
 * origins Playwright did report keep its data.
 */
export async function captureContextStorage(context: HarvestContext): Promise<StorageState> {
  const base = await context.storageState({ indexedDB: true });
  const byOrigin = new Map<string, HarvestedOrigin>(
    base.origins.map((origin) => [origin.origin, origin as HarvestedOrigin])
  );
  const framesByOrigin = new Map<string, StorageFrame>();
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      const origin = httpOrigin(frame.url());
      if (origin !== null && !framesByOrigin.has(origin)) framesByOrigin.set(origin, frame);
    }
  }
  const frames = [...framesByOrigin.values()].slice(0, MAX_HARVEST_ORIGINS);
  for (const read of await Promise.all(frames.map(readFrameStorage))) {
    if (read === null) continue;
    const known = byOrigin.get(read.origin);
    const merged: HarvestedOrigin = {
      origin: read.origin,
      localStorage: (known?.localStorage.length ?? 0) > 0 ? known!.localStorage : read.localStorage,
      ...((known?.indexedDB?.length ?? 0) > 0
        ? { indexedDB: known!.indexedDB }
        : (read.indexedDB?.length ?? 0) > 0
          ? { indexedDB: read.indexedDB }
          : {}),
    };
    if (merged.localStorage.length > 0 || (merged.indexedDB?.length ?? 0) > 0) {
      byOrigin.set(read.origin, merged);
    }
  }
  return { cookies: base.cookies, origins: [...byOrigin.values()] };
}
