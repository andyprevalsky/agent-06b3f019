/**
 * Browser state carried between Tilion sessions (resume, rotation, provider switch).
 *
 * old session ──CDP storageState(indexedDB)──┐   (4409 if another client is attached)
 *            └─REST GET /context (cookies+LS)─┤   (fails while a client is attached)
 *                                             ▼
 *            pause snapshot map / live harvest ──▶ restoreTilionBrowserState(new browser)
 */
import type { Browser, BrowserContext, Cookie } from 'playwright';
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

// Browser state captured when a session is paused, read back by the next
// resume of the same task. Process-local and bounded: a resume served by
// another backend instance falls back to the persisted user data that the
// resume path re-injects (sessionAuthPersist / injectUserData).
const pausedState = new Map<string, { state: StorageState; savedAt: number }>();
const PAUSED_STATE_TTL_MS = 2 * 60 * 60_000;
const PAUSED_STATE_MAX = 200;

export function rememberPausedState(sessionId: string, state: StorageState): void {
  pausedState.delete(sessionId);
  pausedState.set(sessionId, { state, savedAt: Date.now() });
  while (pausedState.size > PAUSED_STATE_MAX) {
    const oldest = pausedState.keys().next().value;
    if (oldest === undefined) break;
    pausedState.delete(oldest);
  }
}

export function takePausedState(sessionId: string): StorageState | null {
  const entry = pausedState.get(sessionId);
  pausedState.delete(sessionId);
  if (!entry || Date.now() - entry.savedAt > PAUSED_STATE_TTL_MS) return null;
  return entry.state;
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
        if (context) return await context.storageState({ indexedDB: true });
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
