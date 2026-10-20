/**
 * Root browser world state, split by website (plan row A6).
 *
 *   Root (one per user)                          browser task X (agent or Root)
 *   BrowserSiteState(user, site) rev r ──fork S──▶ existing injection gives X the
 *   Cookie + CookieBundle "rose_root"              selected bundle for S; record
 *          ▲                                       BrowserSiteFork(X, S){r, f0, keys0}
 *          │                                                │ X works, may sign in
 *          └──── merge S (guarded LWW, below) ◀─── close: harvest X's jar once
 *
 * A site is a registrable domain (`canonicalAuthRealm`). Fork is scoped: only
 * the sites a task prepares through `/prepare-auth` are recorded, and only
 * those are merge candidates for an agent, so a close never copies a full jar.
 *
 * Merge rule for task X and forked site S, evaluated under a per-(user, site)
 * advisory lock. `f` is the fingerprint of the live auth cookies for S (name,
 * domain, path, value; expiry ignored), `keys` their (domain, name, path) set.
 *   1. f1 = ''                                   → no_login      (skip)
 *   2. f1 = f0                                   → unchanged     (skip)
 *   3. agent and keys0 ⊄ keys1                   → signed_out    (skip)
 *   4. agent, f0 = '' and no sign-in evidence    → no_login_signal (skip; anonymous
 *      cookies never become Root state). Evidence = completed in-browser auth
 *      assistance for S on X, or S in the close request's `signed_in_sites`
 *      (the agent typed a saved password there).
 *   5. head(S).revision ≠ r                      → stale         (skip; Root moved
 *      on after X forked S, so X cannot clobber the newer login)
 *   6. otherwise                                 → merged: Root's S cookies := X's,
 *      head revision r+1, and X's base := (r+1, f1, keys1).
 * Updating X's base on merge makes a retried close (rule 20) see f1 = f0 and
 * report `unchanged` while `mergedRevision` keeps the merge on record, so a
 * revision is never bumped twice for one login.
 *
 * The Root browser session itself follows rules 1, 2 and 5. Its open forks every
 * site already in its jar, so cookies an agent left in the shared profile are a
 * base, not a new login; a site first seen at its close forks at (0, '').
 *
 * 10k agents: per-user/per-site rows only. A fork is one head read plus one
 * upsert; a close is one CDP cookie read plus one short transaction per forked
 * site, bounded by MAX_MERGE_SITES. Nothing fans in across agents or users.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Cookie } from 'playwright';
import { isAuthCredentialCookieName } from '../authCookies';
import {
  authRealmFromCookieDomain,
  canonicalAuthRealm,
  cookieDomainForStartUrl,
} from '../authRealm';
import { domainVariants } from '../browserCookies';
import { prisma, runTransactionWithRetry } from '../database';
import { createLogger } from '../logger';
import { steelCdpConnectionUrl } from '../steel/urls';
import { withTimeout } from '../steel/injectionTimeouts';
import {
  remoteWsUrlLooksPersistable,
  shouldPersistSignedInBrowserState,
  signedInRealmsForBrowserSession,
} from './sessionAuthPersist';

const log = createLogger('BrowserWorldState');

export const ROOT_BROWSER_SOURCE = 'rose_root';
export const ROOT_BROWSER_PROFILE = '';
const MAX_COOKIES_PER_SITE = 400;
const MAX_AUTH_KEYS_PER_SITE = 64;
const MAX_MERGE_SITES = 64;
const MAX_ROOT_FORK_SITES = 500;
const MERGE_TIMEOUT_MS = 6_000;
const CHROME_EPOCH_OFFSET_MICROSECONDS = 11_644_473_600n * 1_000_000n;

export type WorldStateWriterKind = 'agent' | 'root';
export type SiteMergeOutcome =
  'merged' | 'unchanged' | 'no_login' | 'signed_out' | 'no_login_signal' | 'stale';

export interface WorldStateCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface SiteMergeReceipt {
  site: string;
  outcome: SiteMergeOutcome;
  base_revision: number;
  head_revision: number;
  merged_revision: number | null;
}

export interface WorldStateMergeReceipt {
  task_id: string;
  kind: WorldStateWriterKind;
  sites: SiteMergeReceipt[];
}

/** Kill switch; the world-state layer is on unless explicitly disabled. */
export function browserWorldStateEnabled(): boolean {
  const raw = (process.env.BROWSER_WORLD_STATE ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw);
}

/**
 * Deterministic `BrowserSession.agentId` of a user's Root browser (RFC 4122
 * v5 layout over sha256). Root has no Agent row; the id only marks its sessions.
 */
export function rootBrowserAgentId(userId: string): string {
  const hex = createHash('sha256').update(`rose-root-browser:${userId}`).digest('hex');
  const variant = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The world-state site for a URL, or null when the URL has no realm or its
 * cookies live under a different host (a dev tunnel's `?authRealm=` fixture
 * override), which Root state never models.
 */
export function worldStateSiteForUrl(url: string): string | null {
  const site = canonicalAuthRealm(url);
  if (site === '') return null;
  return cookieDomainForStartUrl(url) === site ? site : null;
}

/** The site a `/prepare-auth` for `targetUrl` forks, or null when not tracked. */
export function worldStateForkSite(
  session: { provider: string; providerProfileSource?: string | null; wsUrl?: string | null },
  targetUrl: string
): string | null {
  if (!browserWorldStateEnabled()) return null;
  if (!shouldPersistSignedInBrowserState(session).persist) return null;
  return worldStateSiteForUrl(targetUrl);
}

function cookieIsLive(expires: number | undefined, nowEpochSeconds: number): boolean {
  if (expires === undefined || !Number.isFinite(expires) || expires <= 0) return true;
  return expires > nowEpochSeconds;
}

export function siteCookies<T extends Pick<WorldStateCookie, 'name' | 'domain'>>(
  cookies: T[],
  site: string
): T[] {
  return cookies.filter(
    (cookie) => cookie.name !== '' && authRealmFromCookieDomain(cookie.domain) === site
  );
}

function liveAuthCookies(
  cookies: WorldStateCookie[],
  site: string,
  nowEpochSeconds: number
): WorldStateCookie[] {
  return siteCookies(cookies, site).filter(
    (cookie) =>
      cookie.value !== '' &&
      isAuthCredentialCookieName(cookie.name) &&
      cookieIsLive(cookie.expires, nowEpochSeconds)
  );
}

function authKey(cookie: WorldStateCookie): string {
  return `${cookie.domain.toLowerCase()}|${cookie.name}|${cookie.path ?? '/'}`;
}

export interface SiteAuthSnapshot {
  fingerprint: string;
  keys: string[];
}

/** Fingerprint + key set of one site's live auth cookies; '' when signed out. */
export function siteAuthSnapshot(
  cookies: WorldStateCookie[],
  site: string,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000)
): SiteAuthSnapshot {
  const auth = liveAuthCookies(cookies, site, nowEpochSeconds)
    .map((cookie) => [authKey(cookie), cookie.value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (auth.length === 0) return { fingerprint: '', keys: [] };
  return {
    fingerprint: createHash('sha256').update(JSON.stringify(auth)).digest('hex'),
    keys: [...new Set(auth.map(([key]) => key))].slice(0, MAX_AUTH_KEYS_PER_SITE),
  };
}

export async function readRootSiteRevision(userId: string, site: string): Promise<number> {
  const head = await prisma.browserSiteState.findUnique({
    where: { userId_site: { userId, site } },
    select: { revision: true },
  });
  return head?.revision ?? 0;
}

/**
 * Record (or refresh) task X's fork of `site`. `baseRevision` must be read
 * BEFORE the injected cookies were selected: a merge that lands in between then
 * makes X's base older than what it received, which can only cost X a merge,
 * never let it clobber a newer login.
 */
export async function recordSiteFork(params: {
  browserSessionId: string;
  userId: string;
  agentId: string;
  site: string;
  baseRevision: number;
  liveCookies: WorldStateCookie[];
}): Promise<void> {
  const snapshot = siteAuthSnapshot(params.liveCookies, params.site);
  await prisma.browserSiteFork.upsert({
    where: {
      browserSessionId_site: { browserSessionId: params.browserSessionId, site: params.site },
    },
    create: {
      userId: params.userId,
      browserSessionId: params.browserSessionId,
      agentId: params.agentId,
      site: params.site,
      baseRevision: params.baseRevision,
      baseFingerprint: snapshot.fingerprint,
      baseAuthKeys: snapshot.keys,
    },
    update: {
      baseRevision: params.baseRevision,
      baseFingerprint: snapshot.fingerprint,
      baseAuthKeys: snapshot.keys,
    },
  });
  log.info('world_state.fork', {
    browserSessionId: params.browserSessionId,
    agentId: params.agentId,
    site: params.site,
    baseRevision: params.baseRevision,
    signedIn: snapshot.fingerprint !== '',
  });
}

/**
 * Fork every site of a Root browser's jar at open: the persistent profile's own
 * cookies become Root's base, so only sites the user actually changes merge.
 */
export async function recordRootForks(params: {
  browserSessionId: string;
  userId: string;
  agentId: string;
  liveCookies: WorldStateCookie[];
}): Promise<string[]> {
  const sites = [
    ...new Set(params.liveCookies.map((cookie) => authRealmFromCookieDomain(cookie.domain))),
  ]
    .filter((site) => site !== '')
    .sort()
    .slice(0, MAX_ROOT_FORK_SITES);
  if (sites.length === 0) return [];
  const heads = await prisma.browserSiteState.findMany({
    where: { userId: params.userId, site: { in: sites } },
    select: { site: true, revision: true },
  });
  const revisionBySite = new Map(heads.map((head) => [head.site, head.revision]));
  for (const site of sites) {
    await recordSiteFork({
      ...params,
      site,
      baseRevision: revisionBySite.get(site) ?? 0,
    });
  }
  return sites;
}

function chromeEpochMicroseconds(unixSeconds?: number): bigint | null {
  if (unixSeconds === undefined || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  return BigInt(Math.floor(unixSeconds)) * 1_000_000n + CHROME_EPOCH_OFFSET_MICROSECONDS;
}

function nowChromeEpochMicroseconds(): bigint {
  return BigInt(Date.now()) * 1_000n + CHROME_EPOCH_OFFSET_MICROSECONDS;
}

function sameSiteToChrome(value: WorldStateCookie['sameSite']): number {
  if (value === 'Strict') return 2;
  if (value === 'None') return 0;
  return 1;
}

interface ForkRow {
  site: string;
  baseRevision: number;
  baseFingerprint: string;
  baseAuthKeys: string[];
  mergedRevision: number | null;
}

function decideOutcome(params: {
  kind: WorldStateWriterKind;
  fork: ForkRow;
  snapshot: SiteAuthSnapshot;
  headRevision: number;
  hasSignInEvidence: boolean;
}): SiteMergeOutcome | 'merge' {
  const { kind, fork, snapshot, headRevision } = params;
  if (snapshot.fingerprint === '') return 'no_login';
  if (snapshot.fingerprint === fork.baseFingerprint) return 'unchanged';
  if (kind === 'agent') {
    const current = new Set(snapshot.keys);
    if (fork.baseAuthKeys.some((key) => !current.has(key))) return 'signed_out';
    if (fork.baseFingerprint === '' && !params.hasSignInEvidence) return 'no_login_signal';
  }
  if (headRevision !== fork.baseRevision) return 'stale';
  return 'merge';
}

async function mergeOneSite(params: {
  userId: string;
  browserSessionId: string;
  agentId: string;
  kind: WorldStateWriterKind;
  site: string;
  cookies: WorldStateCookie[];
  hasSignInEvidence: boolean;
  deadlineAtMs?: number;
}): Promise<SiteMergeReceipt> {
  const snapshot = siteAuthSnapshot(params.cookies, params.site);
  const siteJar = siteCookies(params.cookies, params.site).slice(0, MAX_COOKIES_PER_SITE);
  return runTransactionWithRetry(
    async (tx) => {
      // Sibling tasks of one user can close on the same site at once.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-world:${params.userId}:${params.site}`}))`;
      const existing = await tx.browserSiteFork.findUnique({
        where: {
          browserSessionId_site: { browserSessionId: params.browserSessionId, site: params.site },
        },
      });
      // A Root session's newly seen site forks at (0, '') so the same rule applies.
      const fork: ForkRow = existing ?? {
        site: params.site,
        baseRevision: 0,
        baseFingerprint: '',
        baseAuthKeys: [],
        mergedRevision: null,
      };
      const head = await tx.browserSiteState.findUnique({
        where: { userId_site: { userId: params.userId, site: params.site } },
      });
      const headRevision = head?.revision ?? 0;
      const decision = decideOutcome({
        kind: params.kind,
        fork,
        snapshot,
        headRevision,
        hasSignInEvidence: params.hasSignInEvidence,
      });

      if (decision !== 'merge') {
        if (existing !== null) {
          await tx.browserSiteFork.update({
            where: { id: existing.id },
            data: { lastOutcome: decision },
          });
        }
        return {
          site: params.site,
          outcome: decision,
          base_revision: fork.baseRevision,
          head_revision: headRevision,
          merged_revision: fork.mergedRevision,
        };
      }

      const revision = headRevision + 1;
      const now = nowChromeEpochMicroseconds();
      await tx.cookie.deleteMany({
        where: {
          userId: params.userId,
          browserSource: ROOT_BROWSER_SOURCE,
          browserProfile: ROOT_BROWSER_PROFILE,
          OR: domainVariants(params.site),
        },
      });
      await tx.cookie.createMany({
        data: siteJar.map((cookie) => {
          const expiresUtc = chromeEpochMicroseconds(cookie.expires);
          return {
            id: randomUUID(),
            userId: params.userId,
            domain: cookie.domain,
            name: cookie.name,
            path: cookie.path ?? '/',
            value: cookie.value,
            expiresUtc,
            isSecure: cookie.secure ?? false,
            isHttpOnly: cookie.httpOnly ?? false,
            browserSource: ROOT_BROWSER_SOURCE,
            browserProfile: ROOT_BROWSER_PROFILE,
            // Freshest login wins bundle selection, as for every other source.
            creationUtc: now,
            hasExpires: expiresUtc !== null,
            isPersistent: expiresUtc !== null,
            sameSite: sameSiteToChrome(cookie.sameSite),
          };
        }),
        // Partitioned (CHIPS) copies share domain/name/path; the row key has none.
        skipDuplicates: true,
      });
      await tx.cookieBundle.upsert({
        where: {
          userId_authRealm_browserSource_browserProfile: {
            userId: params.userId,
            authRealm: params.site,
            browserSource: ROOT_BROWSER_SOURCE,
            browserProfile: ROOT_BROWSER_PROFILE,
          },
        },
        create: {
          userId: params.userId,
          authRealm: params.site,
          browserSource: ROOT_BROWSER_SOURCE,
          browserProfile: ROOT_BROWSER_PROFILE,
          accountLabel: 'Root browser',
        },
        update: { disabledAt: null, disabledReason: null },
      });
      const writer = {
        revision,
        authFingerprint: snapshot.fingerprint,
        cookieCount: siteJar.length,
        lastWriterTaskId: params.browserSessionId,
        lastWriterAgentId: params.kind === 'agent' ? params.agentId : null,
        lastWriterKind: params.kind,
      };
      await tx.browserSiteState.upsert({
        where: { userId_site: { userId: params.userId, site: params.site } },
        create: { userId: params.userId, site: params.site, ...writer },
        update: writer,
      });
      const forkData = {
        baseRevision: revision,
        baseFingerprint: snapshot.fingerprint,
        baseAuthKeys: snapshot.keys,
        mergedRevision: revision,
        mergedAt: new Date(),
        lastOutcome: 'merged',
      };
      if (existing === null) {
        await tx.browserSiteFork.create({
          data: {
            userId: params.userId,
            browserSessionId: params.browserSessionId,
            agentId: params.agentId,
            site: params.site,
            ...forkData,
          },
        });
      } else {
        await tx.browserSiteFork.update({ where: { id: existing.id }, data: forkData });
      }
      return {
        site: params.site,
        outcome: 'merged' as const,
        base_revision: fork.baseRevision,
        head_revision: revision,
        merged_revision: revision,
      };
    },
    params.deadlineAtMs === undefined ? undefined : { deadlineAtMs: params.deadlineAtMs }
  );
}

/**
 * Merge a harvested jar into Root, one site at a time. Pure DB logic: the CDP
 * read is the caller's (see mergeSessionWorldState), so tests drive it with a
 * local browser's cookies.
 */
export async function mergeHarvestedSites(params: {
  browserSessionId: string;
  cookies: WorldStateCookie[];
  signedInSites?: string[];
  deadlineAtMs?: number;
}): Promise<WorldStateMergeReceipt | null> {
  const session = await prisma.browserSession.findUnique({
    where: { id: params.browserSessionId },
    select: {
      id: true,
      agentId: true,
      context: { select: { userId: true } },
      siteForks: { select: { site: true }, orderBy: { site: 'asc' } },
    },
  });
  if (session === null || session.context.userId === '') return null;
  const userId = session.context.userId;
  const kind: WorldStateWriterKind =
    session.agentId === rootBrowserAgentId(userId) ? 'root' : 'agent';
  const forked = session.siteForks.map((fork) => fork.site);
  const candidates =
    kind === 'root'
      ? [
          ...new Set([
            ...forked,
            ...params.cookies.map((cookie) => authRealmFromCookieDomain(cookie.domain)),
          ]),
        ]
          .filter((site) => site !== '')
          .sort()
      : forked;
  const evidence = new Set([
    ...(await signedInRealmsForBrowserSession({ browserSessionId: session.id, userId })),
    ...(params.signedInSites ?? [])
      .map((site) => canonicalAuthRealm(site))
      .filter((site) => site !== ''),
  ]);
  const sites: SiteMergeReceipt[] = [];
  for (const site of candidates.slice(0, MAX_MERGE_SITES)) {
    if (params.deadlineAtMs !== undefined && Date.now() >= params.deadlineAtMs) {
      log.warn('world_state.merge_deadline', { browserSessionId: session.id, skippedFrom: site });
      break;
    }
    sites.push(
      await mergeOneSite({
        userId,
        browserSessionId: session.id,
        agentId: session.agentId,
        kind,
        site,
        cookies: params.cookies,
        hasSignInEvidence: evidence.has(site),
        deadlineAtMs: params.deadlineAtMs,
      })
    );
  }
  const merged = sites.filter((site) => site.outcome === 'merged').map((site) => site.site);
  log.info('world_state.merge', {
    browserSessionId: session.id,
    agentId: session.agentId,
    kind,
    candidates: candidates.length,
    merged,
    outcomes: Object.fromEntries(sites.map((site) => [site.site, site.outcome])),
  });
  return { task_id: session.id, kind, sites };
}

export function worldStateCookiesFrom(cookies: Cookie[]): WorldStateCookie[] {
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  }));
}

/** Persisted receipt (fork rows only); what a retried close returns. */
export async function persistedMergeReceipt(
  browserSessionId: string
): Promise<WorldStateMergeReceipt | null> {
  const session = await prisma.browserSession.findUnique({
    where: { id: browserSessionId },
    select: {
      id: true,
      agentId: true,
      context: { select: { userId: true } },
      siteForks: { orderBy: { site: 'asc' } },
    },
  });
  if (session === null) return null;
  const heads = await prisma.browserSiteState.findMany({
    where: {
      userId: session.context.userId,
      site: { in: session.siteForks.map((fork) => fork.site) },
    },
    select: { site: true, revision: true },
  });
  const headBySite = new Map(heads.map((head) => [head.site, head.revision]));
  return {
    task_id: session.id,
    kind: session.agentId === rootBrowserAgentId(session.context.userId) ? 'root' : 'agent',
    sites: session.siteForks.map((fork) => ({
      site: fork.site,
      outcome: (fork.lastOutcome ?? 'unchanged') as SiteMergeOutcome,
      base_revision: fork.baseRevision,
      head_revision: headBySite.get(fork.site) ?? 0,
      merged_revision: fork.mergedRevision,
    })),
  };
}

/**
 * Harvest a live session's jar once and merge its forked sites into Root.
 * Best-effort and bounded: a failure never blocks the provider close.
 */
export async function mergeSessionWorldState(
  sessionId: string,
  options: { browser?: Browser; signedInSites?: string[] } = {}
): Promise<WorldStateMergeReceipt | null> {
  if (!browserWorldStateEnabled()) return null;
  const session = await prisma.browserSession.findUnique({
    where: { sessionId },
    select: {
      id: true,
      agentId: true,
      status: true,
      wsUrl: true,
      provider: true,
      providerProfileSource: true,
      context: { select: { userId: true } },
      _count: { select: { siteForks: true } },
    },
  });
  if (session === null) return null;
  if (!shouldPersistSignedInBrowserState(session).persist) return null;
  const isRoot = session.agentId === rootBrowserAgentId(session.context.userId);
  // An agent merges only what it forked; with nothing forked there is no CDP work.
  if (!isRoot && session._count.siteForks === 0) return null;
  // A closed session's browser is gone: a retried close reports what was recorded.
  if (session.status === 'CLOSED') return persistedMergeReceipt(session.id);

  let browser = options.browser;
  const closeWhenDone = browser === undefined;
  if (
    browser === undefined &&
    (session.wsUrl === null || !remoteWsUrlLooksPersistable(session.wsUrl))
  ) {
    return persistedMergeReceipt(session.id);
  }
  const deadline = Date.now() + MERGE_TIMEOUT_MS;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    if (browser === undefined) {
      const { chromium } = await import('playwright');
      const connecting = chromium.connectOverCDP(steelCdpConnectionUrl(session.wsUrl ?? ''), {
        timeout: remaining(),
      });
      browser = await withTimeout(
        connecting,
        remaining(),
        'Timed out connecting to harvest browser world state'
      ).catch((error: unknown) => {
        void connecting.then((late) => late.close()).catch(() => undefined);
        throw error;
      });
    }
    const context: BrowserContext | undefined = browser.contexts()[0];
    if (context === undefined) return persistedMergeReceipt(session.id);
    const cookies = await withTimeout(
      context.cookies(),
      remaining(),
      'Timed out reading browser world state cookies'
    );
    // Not raced: a Promise.race cannot stop a transaction. Each site's short
    // transaction shares the deadline instead, and later sites are skipped.
    return await mergeHarvestedSites({
      browserSessionId: session.id,
      cookies: worldStateCookiesFrom(cookies),
      signedInSites: options.signedInSites,
      deadlineAtMs: deadline,
    });
  } catch (error) {
    log.warn('world_state.merge_failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return persistedMergeReceipt(session.id);
  } finally {
    if (closeWhenDone && browser !== undefined) await browser.close().catch(() => undefined);
  }
}
