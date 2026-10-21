/**
 * Browser state carried between Tilion sessions (resume, rotation, provider switch).
 *
 * old session ──CDP storageState + per-frame LS/IDB read──┐   (4409 if another client is attached)
 *            └─REST GET /context (cookies+LS)─┤   (fails while a client is attached)
 *                                             ▼
 *            pause snapshot map / live harvest ──▶ restoreTilionBrowserState(new browser)
 */
import type { Browser, BrowserContext, Cookie } from 'playwright';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { recoveryOriginStorageScript } from './recoveryOriginStorage';
import {
  mintTilionConnectUrl,
  redactTilionSecrets,
  tilionRequest,
  tilionSessionPath,
} from './tilionClient';

const log = createLogger('Tilion');

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

// Browser state captured when a Tilion session pauses lives on the task's own
// BrowserSession row (`pausedBrowserState`), so any backend instance can resume
// it and nothing accumulates in process memory. One bounded blob per task,
// cleared by the resume that consumes it or by a final close.
export const PAUSED_STATE_MAX_BYTES = 512 * 1024;

function serializedBytes(state: StorageState): number {
  return Buffer.byteLength(JSON.stringify(state), 'utf8');
}

/** Fit the snapshot under the cap: drop IndexedDB first, then localStorage; cookies last. */
export function boundPausedState(state: StorageState): StorageState | null {
  const steps: StorageState[] = [
    state,
    {
      cookies: state.cookies,
      origins: state.origins.map(({ origin, localStorage }) => ({ origin, localStorage })),
    },
    { cookies: state.cookies, origins: [] },
  ];
  return steps.find((candidate) => serializedBytes(candidate) <= PAUSED_STATE_MAX_BYTES) ?? null;
}

function isStorageState(value: unknown): value is StorageState {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as StorageState).cookies) &&
    Array.isArray((value as StorageState).origins)
  );
}

export async function savePausedState(sessionId: string, state: StorageState): Promise<boolean> {
  const bounded = boundPausedState(state);
  if (bounded === null) {
    log.warn('Paused browser state exceeds the cap even as cookies only; not stored', {
      sessionId,
      cookies: state.cookies.length,
    });
    return false;
  }
  if (bounded !== state) {
    log.warn('Paused browser state trimmed to fit the cap', {
      sessionId,
      maxBytes: PAUSED_STATE_MAX_BYTES,
      originsKept: bounded.origins.length,
    });
  }
  const json = JSON.stringify(bounded);
  const updated = await prisma.$executeRaw`
    UPDATE "BrowserSession" SET "pausedBrowserState" = ${json}::jsonb WHERE "sessionId" = ${sessionId}`;
  return updated === 1;
}

/** The snapshot the task's paused session left, if the row still points at that session. */
export async function loadPausedState(
  taskId: string,
  sessionId: string
): Promise<StorageState | null> {
  const rows = await prisma.$queryRaw<Array<{ state: unknown }>>`
    SELECT "pausedBrowserState" AS state FROM "BrowserSession"
    WHERE "id" = ${taskId} AND "sessionId" = ${sessionId}`;
  const state = rows[0]?.state;
  return isStorageState(state) ? state : null;
}

export async function clearPausedState(where: { taskId: string } | { sessionId: string }) {
  if ('taskId' in where) {
    await prisma.$executeRaw`
      UPDATE "BrowserSession" SET "pausedBrowserState" = NULL
      WHERE "id" = ${where.taskId} AND "pausedBrowserState" IS NOT NULL`;
  } else {
    await prisma.$executeRaw`
      UPDATE "BrowserSession" SET "pausedBrowserState" = NULL
      WHERE "sessionId" = ${where.sessionId} AND "pausedBrowserState" IS NOT NULL`;
  }
}

// ── browser state carry ──────────────────────────────────────────────────────

function cookieFromTilionContext(raw: Record<string, unknown>): Cookie | null {
  if (typeof raw.name !== 'string' || typeof raw.value !== 'string') return null;
  let domain = typeof raw.domain === 'string' ? raw.domain : '';
  if (!domain && typeof raw.url === 'string') {
    try {
      domain = new URL(raw.url).hostname;
    } catch {
      return null;
    }
  }
  if (!domain) return null;
  const sameSite = raw.sameSite === 'Strict' || raw.sameSite === 'None' ? raw.sameSite : 'Lax';
  return {
    name: raw.name,
    value: raw.value,
    domain,
    path: typeof raw.path === 'string' ? raw.path : '/',
    expires: typeof raw.expires === 'number' ? raw.expires : -1,
    httpOnly: raw.httpOnly === true,
    secure: raw.secure === true,
    sameSite,
  };
}

/** REST export of the current tab's cookies and localStorage (no IndexedDB). */
async function exportTilionContext(sessionId: string): Promise<StorageState | null> {
  const exported = await tilionRequest<{
    context?: {
      url?: string;
      cookies?: Array<Record<string, unknown>>;
      localStorage?: Record<string, string>;
    };
  }>(tilionSessionPath(sessionId, '/context'));
  const context = exported?.context;
  if (!context) return null;
  const cookies = (context.cookies ?? [])
    .map(cookieFromTilionContext)
    .filter((cookie): cookie is Cookie => cookie !== null);
  let origin: string | null = null;
  try {
    origin = context.url ? new URL(context.url).origin : null;
  } catch {
    origin = null;
  }
  const localStorage = Object.entries(context.localStorage ?? {}).map(([name, value]) => ({
    name,
    value: String(value),
  }));
  return {
    cookies,
    origins: origin && localStorage.length > 0 ? [{ origin, localStorage }] : [],
  };
}

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
type HarvestContext = {
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

/**
 * Best-effort snapshot of a live session's cookies, localStorage and
 * IndexedDB. A Tilion session already holding a CDP client refuses ours with
 * 4409, so Tilion falls back to the REST context export (no IndexedDB). An
 * ended session (404/410) yields null.
 */
export async function harvestBrowserState(source: {
  provider: string;
  sessionId: string;
  wsUrl: string | null;
}): Promise<StorageState | null> {
  let wsUrl = source.wsUrl;
  try {
    if (source.provider === 'tilion') wsUrl = await mintTilionConnectUrl(source.sessionId);
  } catch (error) {
    log.info('Tilion session state not harvestable (session ended?)', {
      sessionId: source.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (wsUrl) {
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(wsUrl, { timeout: 10_000 });
      try {
        const context = browser.contexts()[0];
        if (context) return await captureContextStorage(context);
      } finally {
        await browser.close().catch(() => {});
      }
    } catch (error) {
      log.warn('CDP state harvest failed', {
        provider: source.provider,
        sessionId: source.sessionId,
        error: redactTilionSecrets(error instanceof Error ? error.message : String(error)),
      });
    }
  }
  if (source.provider !== 'tilion') return null;
  try {
    return await exportTilionContext(source.sessionId);
  } catch (error) {
    log.warn('Tilion REST context export failed', {
      sessionId: source.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const MAX_RESTORED_ORIGINS = 10;

/** Write carried state into the replacement's default context through its validation client. */
export async function restoreTilionBrowserState(
  browser: Browser,
  state: StorageState
): Promise<{ cookies: number; origins: number }> {
  const context = browser.contexts()[0];
  if (!context) throw new Error('Tilion replacement session has no CDP context');
  if (state.cookies.length > 0) await context.addCookies(state.cookies);
  const origins = state.origins
    .filter(
      (origin) =>
        origin.localStorage.length > 0 ||
        ((origin as { indexedDB?: unknown[] }).indexedDB?.length ?? 0) > 0
    )
    .slice(0, MAX_RESTORED_ORIGINS);
  let restored = 0;
  if (origins.length > 0) {
    await context.addInitScript(
      recoveryOriginStorageScript(state as unknown as Record<string, unknown>)
    );
    const page = context.pages()[0] ?? (await context.newPage());
    for (const origin of origins) {
      try {
        await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        await page.evaluate(
          '(globalThis.__naviRestoreRecoveryStorage ? globalThis.__naviRestoreRecoveryStorage() : undefined)'
        );
        restored += 1;
      } catch (error) {
        log.warn('Tilion state restore skipped an origin', {
          origin: origin.origin,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { cookies: state.cookies.length, origins: restored };
}
