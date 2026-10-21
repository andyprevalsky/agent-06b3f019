/**
 * The user's one browser template, split by website and account (plan row A6).
 *
 *   template (one per user)                         browser task X (agent or home browser)
 *   BrowserSiteState(user, site, account) ─fork S─▶ injection gives X ONE account's
 *   Cookie + CookieBundle (rose_root, account)      bundle for S; record
 *          ▲                                        BrowserSiteFork(X, S){account, r, f0, keys0, age0}
 *          │                                                 │ X works, may sign in anywhere
 *          └── keep-best per (site, account) ◀── close: harvest X's whole jar once
 *
 * Every credential percolates: each site in X's jar at close is a candidate,
 * forked or not, with or without sign-in evidence. Collisions between two
 * states of the same account resolve by keep-best (worldStateKeepBest.ts, the
 * rule and its definitions); different accounts never compete. The merge
 * itself lives in worldStateMerge.ts. Percolation is on unless
 * BROWSER_WORLD_STATE=off; the home browser only opens when the user asks.
 *
 * 10k agents: per-(user, site, account) rows only. A fork is one head read plus
 * one upsert; a close is one CDP cookie read, one head read for its jar's sites
 * and one short transaction per changed site (bounded by MAX_MERGE_SITES), each
 * under a per-(user, site) advisory lock. Nothing fans in across users.
 */
import type { Browser, BrowserContext, Cookie } from 'playwright';
import {
  authRealmFromCookieDomain,
  canonicalAuthRealm,
  cookieDomainForStartUrl,
} from '../authRealm';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { steelCdpConnectionUrl } from '../steel/urls';
import { withTimeout } from '../steel/injectionTimeouts';
import {
  remoteWsUrlLooksPersistable,
  shouldPersistSignedInBrowserState,
} from './sessionAuthPersist';
import {
  mergeHarvestedSites,
  persistedMergeReceipt,
  type WorldStateMergeReceipt,
} from './worldStateMerge';
import {
  assertLegacyBrowserAccount,
  siteAuthSnapshot,
  type WorldStateCookie,
} from './worldStateKeepBest';

export {
  assessSiteCredentials,
  DEFAULT_TEMPLATE_ACCOUNT,
  ROOT_BROWSER_SOURCE,
  siteAuthSnapshot,
  siteCookies,
  templateAccountFor,
  type InjectedCookieBundle,
  type KeepBestRule,
  type WorldStateCookie,
} from './worldStateKeepBest';
export {
  mergeHarvestedSites,
  persistedMergeReceipt,
  ROOT_BROWSER_PROFILE,
  rootBrowserAgentId,
  type SiteMergeOutcome,
  type SiteMergeReceipt,
  type WorldStateMergeReceipt,
  type WorldStateWriterKind,
} from './worldStateMerge';

const log = createLogger('BrowserWorldState');
const MAX_ROOT_FORK_SITES = 500;
const MERGE_TIMEOUT_MS = 6_000;

/** Kill switch; the world-state layer is on unless explicitly disabled. */
export function browserWorldStateEnabled(): boolean {
  const raw = (process.env.BROWSER_WORLD_STATE ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw);
}

/**
 * The world-state site for a URL, or null when the URL has no realm or its
 * cookies live under a different host (a dev tunnel's `?authRealm=` fixture
 * override), which the template never models.
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

export async function readRootSiteRevision(
  userId: string,
  site: string,
  account: string
): Promise<number> {
  const head = await prisma.browserSiteState.findUnique({
    where: { userId_site_account: { userId, site, account } },
    select: { revision: true },
  });
  return head?.revision ?? 0;
}

/**
 * Record (or refresh) task X's fork of `site` for one template `account`.
 * `baseRevision` must be read BEFORE the injected cookies were selected, and
 * `baseObservedAt` is the injected login's age (null when nothing was injected).
 */
export async function recordSiteFork(params: {
  browserSessionId: string;
  userId: string;
  agentId: string;
  site: string;
  account: string;
  baseRevision: number;
  baseObservedAt?: Date | null;
  liveCookies: WorldStateCookie[];
}): Promise<void> {
  assertLegacyBrowserAccount(params.account);
  const snapshot = siteAuthSnapshot(params.liveCookies, params.site);
  const base = {
    account: params.account,
    baseRevision: params.baseRevision,
    baseFingerprint: snapshot.fingerprint,
    baseAuthKeys: snapshot.keys,
    baseObservedAt: params.baseObservedAt ?? null,
    forkedAt: new Date(),
  };
  await prisma.browserSiteFork.upsert({
    where: {
      browserSessionId_site: { browserSessionId: params.browserSessionId, site: params.site },
    },
    create: {
      userId: params.userId,
      browserSessionId: params.browserSessionId,
      agentId: params.agentId,
      site: params.site,
      ...base,
    },
    update: base,
  });
  log.info('world_state.fork', {
    browserSessionId: params.browserSessionId,
    agentId: params.agentId,
    site: params.site,
    account: params.account,
    baseRevision: params.baseRevision,
    signedIn: snapshot.fingerprint !== '',
  });
}

/**
 * Fork every site of the home browser's jar at open, each on the account the
 * open injected for it (`accountBySite`, '' for the profile's own logins), so
 * only what the user then changes is a new login.
 */
export async function recordRootForks(params: {
  browserSessionId: string;
  userId: string;
  agentId: string;
  liveCookies: WorldStateCookie[];
  accountBySite: Map<string, string>;
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
    select: { site: true, account: true, revision: true, observedAt: true },
  });
  const headOf = new Map(heads.map((head) => [`${head.site}|${head.account}`, head]));
  for (const site of sites) {
    const account = params.accountBySite.get(site) ?? '';
    const head = headOf.get(`${site}|${account}`);
    await recordSiteFork({
      browserSessionId: params.browserSessionId,
      userId: params.userId,
      agentId: params.agentId,
      site,
      account,
      baseRevision: head?.revision ?? 0,
      baseObservedAt: params.accountBySite.has(site) ? (head?.observedAt ?? null) : null,
      liveCookies: params.liveCookies,
    });
  }
  return sites;
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

/**
 * Harvest a live session's jar once and percolate every site's credentials
 * into the template. Best-effort and bounded: a failure never blocks the
 * provider close.
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
      status: true,
      wsUrl: true,
      provider: true,
      providerProfileSource: true,
    },
  });
  if (session === null) return null;
  if (!shouldPersistSignedInBrowserState(session).persist) return null;
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
