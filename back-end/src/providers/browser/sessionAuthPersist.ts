/**
 * Persist a Kernel/Steel/Tilion sign-in before its session ends so the next
 * browser-agent call — including the other provider — injects it through the
 * existing CookieBundle / LocalStorageOrigin path.
 *
 *   completed in-browser auth assistance (live_view | manual_otp | manual_step)
 *     └─▶ close: harvest ONLY those realms ─▶ CookieBundle(cloud_persistent) + LocalStorageOrigin
 *   later init (same or other provider) ──injectUserData──▶ signed-in browser
 *
 * Realms the user never signed into on this session are not harvested. Their
 * cookies carry no sign-in, yet a harvest stamps them with a fresh creationUtc,
 * which would outrank the user's real Mac/Chrome bundle in selectTopCookieBundle
 * and overwrite an earlier signed-in harvest.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Cookie } from 'playwright';
import { isAuthCredentialCookieName } from '../authCookies';
import { authRealmFromCookieDomain, canonicalAuthRealm } from '../authRealm';
import { benchmarkSavedBrowserAuthDisabled } from '../benchmarkBrowserAuth';
import { domainVariants } from '../browserCookies';
import { prisma, runTransactionWithRetry } from '../database';
import { createLogger } from '../logger';
import { createOriginPayloadWriter } from '../steel/injectionOriginPage';
import { steelCdpConnectionUrl } from '../steel/urls';
import { BrowserStateInjectionTimeout, withTimeout } from '../steel/injectionTimeouts';
import { benchmarkIsolatedBrowserProfilesEnabled } from './benchmarkProfileIsolation';
import { storedBrowserProvider } from './types';

const log = createLogger('BrowserSessionAuthPersist');
const CHROME_EPOCH_OFFSET_MICROSECONDS = 11_644_473_600n * 1_000_000n;
// One budget covers connect, reads and writes: the worker gives the whole close
// request 10s and the provider release still follows harvest.
const DEFAULT_PERSIST_TIMEOUT_MS = 6_000;
const MAX_COOKIES_PER_REALM = 400;
const MAX_ORIGINS = 40;
// These modes finish inside our cloud browser. `local_browser` signs in on the
// user's own Chrome, which reaches us through cookie sync instead.
const CLOUD_BROWSER_SIGN_IN_MODES = ['live_view', 'manual_otp', 'manual_step'];
const READ_LOCAL_STORAGE_SCRIPT = `(() => {
  const entries = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const name = localStorage.key(i);
    if (name) entries.push({ name, value: localStorage.getItem(name) ?? '' });
  }
  return entries;
})()`;

export const CLOUD_PERSISTENT_BROWSER_PROFILE = 'cloud_persistent';

type LocalStorageEntry = { name: string; value: string };
type OriginLocalStorage = { origin: string; localStorage: LocalStorageEntry[] };
type HarvestContext = Pick<BrowserContext, 'pages' | 'newPage' | 'newCDPSession'>;
type HarvestBudget = { remainingMs: () => number; spent: () => boolean };

export type PersistSignedInBrowserStateResult = {
  persisted: boolean;
  reason?: string;
  warning?: string;
  cookieCount: number;
  realmCount: number;
  localStorageOriginCount: number;
};

export function persistSignedInBrowserStateTimeoutMs(): number {
  const configured = Number(process.env.BROWSER_SESSION_AUTH_PERSIST_TIMEOUT_MS);
  if (Number.isInteger(configured) && configured > 0 && configured <= 60_000) {
    return configured;
  }
  return DEFAULT_PERSIST_TIMEOUT_MS;
}

export function remoteWsUrlLooksPersistable(wsUrl: string): boolean {
  try {
    const url = new URL(wsUrl);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'wss:') return false;
    return !['example', 'example.com', 'localhost', '127.0.0.1'].includes(host);
  } catch {
    return false;
  }
}

function chromeEpochMicroseconds(unixSeconds?: number): bigint | null {
  if (unixSeconds === undefined || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return null;
  }
  return BigInt(Math.floor(unixSeconds)) * 1_000_000n + CHROME_EPOCH_OFFSET_MICROSECONDS;
}

function nowChromeEpochMicroseconds(): bigint {
  return BigInt(Date.now()) * 1_000n + CHROME_EPOCH_OFFSET_MICROSECONDS;
}

function hashLocalStorageEntries(entries: Array<{ key: string; value: string }>): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function mergeLocalStorageEntries(
  existing: unknown,
  incoming: Array<{ key: string; value: string }>
): Array<{ key: string; value: string }> {
  const merged = new Map<string, string>();
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (item === null || typeof item !== 'object') continue;
      const row = item as { key?: unknown; value?: unknown };
      if (typeof row.key !== 'string' || row.key === '' || typeof row.value !== 'string') continue;
      merged.set(row.key, row.value);
    }
  }
  for (const entry of incoming) merged.set(entry.key, entry.value);
  return [...merged.entries()].map(([key, value]) => ({ key, value }));
}

export function shouldPersistSignedInBrowserState(session: {
  provider: string;
  providerProfileSource?: string | null;
  wsUrl?: string | null;
}): { persist: boolean; reason?: string } {
  if (benchmarkSavedBrowserAuthDisabled()) {
    return { persist: false, reason: 'saved_browser_auth_disabled' };
  }
  if (benchmarkIsolatedBrowserProfilesEnabled()) {
    return { persist: false, reason: 'benchmark_isolated_profiles' };
  }
  const provider = storedBrowserProvider(session.provider);
  // Browser Use is not harvested. Tilion is: its single CDP slot is free once
  // the worker detaches before close (ordering documented in index.ts); a 4409
  // collision fails the harvest within budget and the release still runs.
  if (provider !== 'kernel' && provider !== 'steel' && provider !== 'tilion') {
    return { persist: false, reason: 'unsupported_provider' };
  }
  if (session.providerProfileSource?.startsWith('benchmark_anon') === true) {
    return { persist: false, reason: 'benchmark_anon_profile' };
  }
  return { persist: true };
}

/** Realms whose sign-in the user completed inside this cloud browser session. */
export async function signedInRealmsForBrowserSession(params: {
  browserSessionId: string;
  userId: string;
}): Promise<string[]> {
  const requests = await prisma.userAuthAssistanceRequest.findMany({
    where: {
      browserSessionId: params.browserSessionId,
      userId: params.userId,
      completedAt: { not: null },
      mode: { in: CLOUD_BROWSER_SIGN_IN_MODES },
    },
    select: { authRealm: true },
  });
  return [
    ...new Set(
      requests
        .map((request) => canonicalAuthRealm(request.authRealm))
        .filter((realm) => realm !== '')
    ),
  ];
}

/**
 * A sibling close can hold a realm's advisory lock. `withTimeout` abandons the
 * wait but not the transaction, so a spent budget also refuses the next write.
 */
async function writeWithinBudget(
  budget: HarvestBudget,
  message: string,
  write: () => Promise<unknown>
): Promise<void> {
  if (budget.spent()) throw new BrowserStateInjectionTimeout(message);
  await withTimeout(write(), budget.remainingMs(), message);
}

async function persistHarvestedCookies(
  userId: string,
  browserSource: string,
  cookies: Cookie[],
  signedInRealms: ReadonlySet<string>,
  budget: HarvestBudget
): Promise<{ cookieCount: number; realmCount: number }> {
  const now = nowChromeEpochMicroseconds();
  const byRealm = new Map<string, Cookie[]>();
  for (const cookie of cookies) {
    if (cookie.name === '') continue;
    const authRealm = authRealmFromCookieDomain(cookie.domain);
    if (!signedInRealms.has(authRealm)) continue;
    const group = byRealm.get(authRealm) ?? [];
    if (group.length < MAX_COOKIES_PER_REALM) group.push(cookie);
    byRealm.set(authRealm, group);
  }

  let cookieCount = 0;
  let realmCount = 0;
  for (const [authRealm, realmCookies] of byRealm) {
    // selectTopCookieBundle never injects a bundle without an auth-looking
    // cookie, while an enabled bundle still hides the minted-account option.
    if (!realmCookies.some((cookie) => isAuthCredentialCookieName(cookie.name))) continue;
    await writeWithinBudget(budget, 'Timed out persisting signed-in browser cookies', () =>
      runTransactionWithRetry(async (tx) => {
        // Sibling browser sessions of one user can close on the same realm at once.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-auth-persist:cookies:${userId}:${browserSource}:${authRealm}`}))`;
        await tx.cookie.deleteMany({
          where: {
            userId,
            browserSource,
            browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
            OR: domainVariants(authRealm),
          },
        });
        await tx.cookie.createMany({
          data: realmCookies.map((cookie) => {
            const expiresUtc = chromeEpochMicroseconds(cookie.expires);
            return {
              id: randomUUID(),
              userId,
              domain: cookie.domain,
              name: cookie.name,
              path: cookie.path || '/',
              value: cookie.value,
              expiresUtc,
              isSecure: cookie.secure,
              isHttpOnly: cookie.httpOnly,
              browserSource,
              browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
              creationUtc: now,
              hasExpires: expiresUtc !== null,
              isPersistent: expiresUtc !== null,
              sameSite: cookie.sameSite === 'Strict' ? 2 : cookie.sameSite === 'None' ? 0 : 1,
            };
          }),
          // Partitioned (CHIPS) copies share domain/name/path; the row key has no
          // partition, and injection never sets one.
          skipDuplicates: true,
        });
        await tx.cookieBundle.upsert({
          where: {
            userId_authRealm_browserSource_browserProfile: {
              userId,
              authRealm,
              browserSource,
              browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
            },
          },
          create: {
            userId,
            authRealm,
            browserSource,
            browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
          },
          update: { disabledAt: null, disabledReason: null },
        });
      })
    );
    cookieCount += realmCookies.length;
    realmCount += 1;
  }
  return { cookieCount, realmCount };
}

async function persistHarvestedLocalStorage(
  userId: string,
  origins: OriginLocalStorage[],
  budget: HarvestBudget
): Promise<{ written: number; warning?: string }> {
  let written = 0;
  for (const originState of origins.slice(0, MAX_ORIGINS)) {
    const incoming = originState.localStorage
      .filter((entry) => entry.name !== '')
      .map((entry) => ({ key: entry.name, value: entry.value }));
    if (incoming.length === 0) continue;
    try {
      await writeWithinBudget(budget, 'Timed out persisting signed-in browser localStorage', () =>
        runTransactionWithRetry(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-auth-persist:storage:${userId}:${originState.origin}`}))`;
          const existing = await tx.localStorageOrigin.findUnique({
            where: { userId_origin: { userId, origin: originState.origin } },
          });
          const entries = mergeLocalStorageEntries(existing?.entries, incoming);
          const hash = hashLocalStorageEntries(entries);
          if (existing !== null && existing.hash === hash) return;
          await tx.localStorageOrigin.upsert({
            where: { userId_origin: { userId, origin: originState.origin } },
            create: { userId, origin: originState.origin, entries, hash },
            update: { entries, hash },
          });
        })
      );
    } catch (error) {
      if (!(error instanceof BrowserStateInjectionTimeout)) throw error;
      return { written, warning: error.message };
    }
    written += 1;
  }
  return { written };
}

export function httpOriginFromUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    const parsed = value.includes('://')
      ? new URL(value)
      : new URL(`https://${value.replace(/^\./, '')}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.hostname === '') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function localStorageEntriesFrom(value: unknown): LocalStorageEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (item === null || typeof item !== 'object') return [];
    const row = item as { name?: unknown; value?: unknown };
    return typeof row.name === 'string' && row.name !== '' && typeof row.value === 'string'
      ? [{ name: row.name, value: row.value }]
      : [];
  });
}

function mergeOriginLocalStorage(
  into: Map<string, Map<string, string>>,
  origin: string,
  entries: LocalStorageEntry[]
): void {
  if (entries.length === 0) return;
  const existing = into.get(origin) ?? new Map<string, string>();
  for (const entry of entries) existing.set(entry.name, entry.value);
  into.set(origin, existing);
}

function originStates(byOrigin: Map<string, Map<string, string>>): OriginLocalStorage[] {
  return [...byOrigin.entries()].map(([origin, entries]) => ({
    origin,
    localStorage: [...entries.entries()].map(([name, value]) => ({ name, value })),
  }));
}

/**
 * Playwright `storageState()` only snapshots origins visited on *this*
 * Playwright connection, so a fresh CDP connect at close sees no localStorage
 * even while the signed-in tab is open. Read open pages first, then probe the
 * remaining candidate origins in injection's exact-origin synthetic document:
 * no site request is made and a saved service worker cannot answer it.
 */
async function readHarvestableLocalStorage(
  context: HarvestContext,
  candidateOrigins: string[],
  includeOrigin: (origin: string) => boolean,
  into: Map<string, Map<string, string>>,
  signal?: AbortSignal
): Promise<void> {
  for (const page of context.pages()) {
    signal?.throwIfAborted();
    const origin = httpOriginFromUrl(page.url());
    if (origin === null || !includeOrigin(origin)) continue;
    try {
      const entries = localStorageEntriesFrom(await page.evaluate(READ_LOCAL_STORAGE_SCRIPT));
      mergeOriginLocalStorage(into, origin, entries);
    } catch {
      // The tab may have navigated away while harvest was running.
    }
  }

  const missing = [...new Set(candidateOrigins)]
    .filter((origin) => httpOriginFromUrl(origin) === origin)
    .filter((origin) => includeOrigin(origin) && !into.has(origin))
    .slice(0, MAX_ORIGINS);
  if (missing.length === 0) return;
  const reader = createOriginPayloadWriter(context, signal);
  try {
    for (const origin of missing) {
      const entries = localStorageEntriesFrom(
        await reader.writeOriginScript(origin, READ_LOCAL_STORAGE_SCRIPT)
      );
      mergeOriginLocalStorage(into, origin, entries);
    }
  } finally {
    await reader.close().catch(() => undefined);
  }
}

export async function collectHarvestableLocalStorage(
  context: HarvestContext,
  candidateOrigins: string[],
  includeOrigin: (origin: string) => boolean = () => true
): Promise<OriginLocalStorage[]> {
  const byOrigin = new Map<string, Map<string, string>>();
  await readHarvestableLocalStorage(context, candidateOrigins, includeOrigin, byOrigin);
  return originStates(byOrigin);
}

export async function persistSignedInBrowserState(
  sessionId: string,
  options: { browser?: Browser; currentUrl?: string } = {}
): Promise<PersistSignedInBrowserStateResult> {
  const skipped = { persisted: false, cookieCount: 0, realmCount: 0, localStorageOriginCount: 0 };
  const session = await prisma.browserSession.findUnique({
    where: { sessionId },
    include: { context: true },
  });
  if (session === null) return { ...skipped, reason: 'session_not_found' };
  const gate = shouldPersistSignedInBrowserState(session);
  if (!gate.persist) return { ...skipped, reason: gate.reason };
  const userId = session.context.userId;
  if (userId === '') return { ...skipped, reason: 'missing_user' };

  const providedBrowser = options.browser;
  if (
    providedBrowser === undefined &&
    (session.wsUrl === null || session.wsUrl === '' || !remoteWsUrlLooksPersistable(session.wsUrl))
  ) {
    return { ...skipped, reason: 'unpersistable_ws_url' };
  }
  const signedInRealms = new Set(
    await signedInRealmsForBrowserSession({ browserSessionId: session.id, userId })
  );
  if (signedInRealms.size === 0) return { ...skipped, reason: 'no_signed_in_realm' };
  const browserSource = storedBrowserProvider(session.provider);

  const deadline = Date.now() + persistSignedInBrowserStateTimeoutMs();
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const budget: HarvestBudget = { remainingMs, spent: () => Date.now() >= deadline };
  const closeBrowserWhenDone = providedBrowser === undefined;
  let browser = providedBrowser;
  try {
    if (browser === undefined) {
      const { chromium } = await import('playwright');
      const connecting = chromium.connectOverCDP(steelCdpConnectionUrl(session.wsUrl ?? ''), {
        timeout: remainingMs(),
      });
      browser = await withTimeout(
        connecting,
        remainingMs(),
        'Timed out connecting to harvest signed-in browser state'
      ).catch((error: unknown) => {
        void connecting.then((late) => late.close()).catch(() => undefined);
        throw error;
      });
    }
    const context = browser.contexts()[0];
    if (context === undefined) return { ...skipped, reason: 'missing_browser_context' };

    const cookies = await withTimeout(
      context.cookies(),
      remainingMs(),
      'Timed out reading signed-in browser cookies'
    );
    const cookieResult = await persistHarvestedCookies(
      userId,
      browserSource,
      cookies,
      signedInRealms,
      budget
    );

    const inSignedInRealm = (origin: string) => signedInRealms.has(canonicalAuthRealm(origin));
    const candidateOrigins = [
      httpOriginFromUrl(options.currentUrl ?? session.currentUrl),
      httpOriginFromUrl(session.startUrl),
      ...cookies.map((cookie) => httpOriginFromUrl(cookie.domain)),
    ].filter((origin): origin is string => origin !== null);
    const byOrigin = new Map<string, Map<string, string>>();
    const abort = new AbortController();
    let warning: string | undefined;
    try {
      await withTimeout(
        readHarvestableLocalStorage(
          context,
          candidateOrigins,
          inSignedInRealm,
          byOrigin,
          abort.signal
        ),
        remainingMs(),
        'Timed out reading signed-in browser localStorage'
      );
    } catch (error) {
      abort.abort();
      warning = error instanceof Error ? error.message : String(error);
      log.warn('Signed-in localStorage harvest incomplete; cookies already persisted', {
        sessionId,
        provider: browserSource,
        error: warning,
      });
    }
    const storageWrite = await persistHarvestedLocalStorage(userId, originStates(byOrigin), budget);
    const localStorageOriginCount = storageWrite.written;
    if (storageWrite.warning !== undefined) {
      warning =
        warning === undefined ? storageWrite.warning : `${warning}; ${storageWrite.warning}`;
      log.warn('Signed-in localStorage persist incomplete; cookies already persisted', {
        sessionId,
        provider: browserSource,
        error: storageWrite.warning,
      });
    }
    if (cookieResult.realmCount === 0 && localStorageOriginCount === 0) {
      return { ...skipped, reason: 'no_signed_in_state', ...(warning ? { warning } : {}) };
    }
    log.info('Persisted signed-in browser state', {
      sessionId,
      provider: browserSource,
      signedInRealms: [...signedInRealms],
      cookieCount: cookieResult.cookieCount,
      realmCount: cookieResult.realmCount,
      localStorageOriginCount,
    });
    return {
      persisted: true,
      ...cookieResult,
      localStorageOriginCount,
      ...(warning ? { warning } : {}),
    };
  } finally {
    if (closeBrowserWhenDone && browser !== undefined) {
      await browser.close().catch(() => undefined);
    }
  }
}
