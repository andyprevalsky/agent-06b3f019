/**
 * Tilion browser state the WORKER applies over its own CDP socket.
 *
 * A Tilion session accepts one CDP client and the agent worker holds it for the
 * whole run, so mid-run backend paths (JIT prepare-auth, inject-local-storage)
 * must not connect. They select exactly what the CDP path would inject and
 * return it as `worker_apply`; the worker applies it and nothing is reported
 * as injected by the backend.
 *
 *   prepare-auth (tilion, no validation browser)
 *     └─ resolveBrowserAuthCredentialSource → cookie rows ─┐
 *        LocalStorageOrigin rows for the auth realm ───────┴─▶ worker_apply
 *   worker: Network.setCookies(cookies); per origin: localStorage.setItem(entries)
 */
import { canonicalAuthRealm, cookieDomainForStartUrl } from '../../providers/authRealm';
import { cookieSelectionWhere } from '../../providers/browserCookies';
import { prisma } from '../../providers/database';
import { resolveBrowserAuthCredentialSource } from '../../providers/steel/injection';
import { playwrightCookiesFromRows } from '../../providers/steel/injectionCookies';
import { restorableLocalStorageOrigin } from '../../providers/steel/injectionState';

export const WORKER_APPLY_REASON = 'single_cdp_client' as const;

export interface WorkerApplyLocalStorage {
  origin: string;
  entries: Array<{ key: string; value: string }>;
}

export interface TilionWorkerApplyPayload {
  provider: 'tilion';
  reason: typeof WORKER_APPLY_REASON;
  /** Playwright/CDP cookie params (name, value, domain, path, expires, secure, httpOnly, sameSite). */
  cookies: ReturnType<typeof playwrightCookiesFromRows>;
  local_storage: WorkerApplyLocalStorage[];
}

function localStorageEntries(value: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (item === null || typeof item !== 'object') return [];
    const row = item as { key?: unknown; value?: unknown };
    return typeof row.key === 'string' && row.key !== '' && typeof row.value === 'string'
      ? [{ key: row.key, value: row.value }]
      : [];
  });
}

/** Same realm filter as injectUserData's origin tables (boundary-aware, no evilamazon.com). */
function originRealmFilter(userId: string, authRealm: string) {
  return {
    userId,
    OR: [
      { origin: { endsWith: `://${authRealm}` } },
      { origin: { contains: `://${authRealm}:` } },
      { origin: { endsWith: `.${authRealm}` } },
      { origin: { contains: `.${authRealm}:` } },
    ],
  };
}

export async function buildTilionWorkerApplyPayload(userId: string, targetUrl: string) {
  const url = /^https?:\/\//.test(targetUrl) ? targetUrl : `https://${targetUrl}`;
  const authRealm = canonicalAuthRealm(url);
  const cookieDomain = cookieDomainForStartUrl(url);
  const authSource = await resolveBrowserAuthCredentialSource({
    userId,
    authRealm,
    // Tilion has no provider-held profile: state always comes from our rows.
    steelContextId: null,
    cookieDomain,
  });
  const cookieRows =
    authSource.kind === 'cookie_bundle'
      ? await prisma.cookie.findMany({
          where: {
            userId,
            ...cookieSelectionWhere(cookieDomain),
            browserSource: authSource.browserSource,
            browserProfile: authSource.browserProfile,
          },
        })
      : [];
  const cookies = playwrightCookiesFromRows(cookieRows).filter((cookie) => cookie.name !== '');
  const origins = await prisma.localStorageOrigin.findMany({
    where: originRealmFilter(userId, authRealm),
    select: { origin: true, entries: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
  });
  // Oldest first so a newer row's value of a shared key wins, as in the CDP path.
  const byOrigin = new Map<string, Map<string, string>>();
  for (const row of origins) {
    const origin = restorableLocalStorageOrigin(row.origin);
    if (origin === null) continue;
    const merged = byOrigin.get(origin) ?? new Map<string, string>();
    for (const entry of localStorageEntries(row.entries)) merged.set(entry.key, entry.value);
    byOrigin.set(origin, merged);
  }
  const payload: TilionWorkerApplyPayload = {
    provider: 'tilion',
    reason: WORKER_APPLY_REASON,
    cookies,
    local_storage: [...byOrigin.entries()]
      .filter(([, entries]) => entries.size > 0)
      .map(([origin, entries]) => ({
        origin,
        entries: [...entries.entries()].map(([key, value]) => ({ key, value })),
      })),
  };
  return {
    payload,
    // injectUserData's result shape: nothing is injected by the backend.
    injection: {
      cookies: {
        injected: false,
        cookieCount: cookies.length,
        authSource: authSource.kind,
        credentialRef: authSource.credentialRef,
      },
      fingerprint: { injected: false },
      indexedDB: { injected: false, originCount: 0 },
      localStorage: { injected: false, originCount: payload.local_storage.length },
      permissions: { injected: false, grantCount: 0 },
      cacheStorage: { injected: false, originCount: 0 },
    },
  };
}
