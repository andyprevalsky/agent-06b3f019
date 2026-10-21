/**
 * Close-time merge into the user's one browser template (plan row A6).
 *
 *   harvested jar ──every site with cookies──▶ classify in memory against the
 *   heads (one read for all its sites): not VALID / unchanged / superseded need
 *   no write ──changed──▶ one short transaction per (site, account) under the
 *   per-(user, site) advisory lock: read the head and that account's template
 *   cookies, apply keep-best (worldStateKeepBest.ts), write only when the
 *   incoming login wins.
 *
 * The receipt lists every site the task forked, every site that reached a
 * transaction, and unforked sites whose expired or superseded login lost to a
 * template login; other unforked sites that needed no write are omitted (a
 * persistent profile can hold hundreds). Pure DB logic: the CDP read is the
 * caller's.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { canonicalAuthRealm, authRealmFromCookieDomain } from '../authRealm';
import { domainVariants } from '../browserCookies';
import { prisma, runTransactionWithRetry } from '../database';
import { createLogger } from '../logger';
import { signedInRealmsForBrowserSession } from './sessionAuthPersist';
import {
  assessSiteCredentials,
  assertLegacyBrowserAccount,
  DEFAULT_TEMPLATE_ACCOUNT,
  decideKeepBest,
  expiryIsLater,
  incomingValidatedAtMs,
  nextSuperseded,
  ROOT_BROWSER_SOURCE,
  siteCookies,
  type KeepBestInput,
  type KeepBestRule,
  type KeptOutcome,
  type SiteCredentialState,
  type WorldStateCookie,
} from './worldStateKeepBest';

const log = createLogger('BrowserWorldState');

export const ROOT_BROWSER_PROFILE = DEFAULT_TEMPLATE_ACCOUNT;
const MAX_COOKIES_PER_SITE = 400;
const MAX_HARVEST_SITES = 500;
const MAX_MERGE_SITES = 64;
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const CHROME_EPOCH_OFFSET_MICROSECONDS = BigInt(CHROME_EPOCH_OFFSET_SECONDS) * 1_000_000n;

export type WorldStateWriterKind = 'agent' | 'root';
export type SiteMergeOutcome = 'merged' | KeptOutcome;

export interface SiteMergeReceipt {
  site: string;
  /** Template account (CookieBundle browserProfile under rose_root). */
  account: string;
  outcome: SiteMergeOutcome;
  /** The keep-best rule that decided a collision; null when none was needed. */
  rule: KeepBestRule | null;
  base_revision: number;
  head_revision: number;
  merged_revision: number | null;
}

export interface WorldStateMergeReceipt {
  task_id: string;
  kind: WorldStateWriterKind;
  sites: SiteMergeReceipt[];
}

/**
 * Deterministic `BrowserSession.agentId` of a user's home browser (RFC 4122
 * v5 layout over sha256). It has no Agent row; the id only marks its sessions.
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

function chromeEpochMicroseconds(unixSeconds?: number): bigint | null {
  if (unixSeconds === undefined || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  return BigInt(Math.floor(unixSeconds)) * 1_000_000n + CHROME_EPOCH_OFFSET_MICROSECONDS;
}

function unixSecondsFromChrome(micros: bigint | null, hasExpires: boolean): number | undefined {
  if (!hasExpires || micros === null || micros <= 0n) return undefined;
  return Number(micros / 1_000_000n) - CHROME_EPOCH_OFFSET_SECONDS;
}

function sameSiteToChrome(value: WorldStateCookie['sameSite']): number {
  if (value === 'Strict') return 2;
  if (value === 'None') return 0;
  return 1;
}

interface ForkRow {
  id: string;
  site: string;
  account: string;
  baseRevision: number;
  baseFingerprint: string;
  baseAuthKeys: string[];
  baseObservedAt: Date | null;
  mergedRevision: number | null;
}

interface HeadRow {
  site: string;
  account: string;
  revision: number;
  authFingerprint: string;
  authExpiresAt: Date | null;
  supersededFingerprints: string[];
}

interface MergeContext {
  userId: string;
  browserSessionId: string;
  agentId: string;
  kind: WorldStateWriterKind;
  sessionStartedAtMs: number;
  nowMs: number;
  cookies: WorldStateCookie[];
}

interface SitePlan {
  site: string;
  account: string;
  incoming: SiteCredentialState;
  fork: ForkRow | undefined;
  hasEvidence: boolean;
}

/** age(I): see worldStateKeepBest.ts. */
function incomingAgeMs(context: MergeContext, plan: SitePlan): number {
  if (plan.hasEvidence) return context.nowMs;
  if (plan.fork === undefined) return context.sessionStartedAtMs;
  if (plan.fork.baseFingerprint !== plan.incoming.fingerprint) return context.nowMs;
  return plan.fork.baseObservedAt?.getTime() ?? context.sessionStartedAtMs;
}

function expirySeconds(at: Date | null): number | null {
  return at === null ? null : Math.floor(at.getTime() / 1000);
}

/** With nothing injected, the jar's login belongs to the account already holding it. */
function accountHolding(heads: HeadRow[], fingerprint: string): string {
  const current = heads.find((head) => head.authFingerprint === fingerprint);
  if (current !== undefined) return current.account;
  const replaced = heads.find((head) => head.supersededFingerprints.includes(fingerprint));
  return replaced?.account ?? DEFAULT_TEMPLATE_ACCOUNT;
}

async function writeTemplateLogin(
  tx: Prisma.TransactionClient,
  context: MergeContext,
  plan: SitePlan,
  written: {
    revision: number;
    validatedAt: Date | null;
    observedAt: Date;
    superseded: string[];
  }
): Promise<void> {
  const { userId, browserSessionId } = context;
  const siteJar = siteCookies(context.cookies, plan.site).slice(0, MAX_COOKIES_PER_SITE);
  const createdAt = BigInt(context.nowMs) * 1_000n + CHROME_EPOCH_OFFSET_MICROSECONDS;
  const account = plan.account;
  await tx.cookie.deleteMany({
    where: {
      userId,
      browserSource: ROOT_BROWSER_SOURCE,
      browserProfile: account,
      OR: domainVariants(plan.site),
    },
  });
  await tx.cookie.createMany({
    data: siteJar.map((cookie) => {
      const expiresUtc = chromeEpochMicroseconds(cookie.expires);
      return {
        id: randomUUID(),
        userId,
        domain: cookie.domain,
        name: cookie.name,
        path: cookie.path ?? '/',
        value: cookie.value,
        expiresUtc,
        isSecure: cookie.secure ?? false,
        isHttpOnly: cookie.httpOnly ?? false,
        browserSource: ROOT_BROWSER_SOURCE,
        browserProfile: account,
        // The freshest login wins bundle selection, as for every other source.
        creationUtc: createdAt,
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
        userId,
        authRealm: plan.site,
        browserSource: ROOT_BROWSER_SOURCE,
        browserProfile: account,
      },
    },
    create: {
      userId,
      authRealm: plan.site,
      browserSource: ROOT_BROWSER_SOURCE,
      browserProfile: account,
      accountLabel: account === DEFAULT_TEMPLATE_ACCOUNT ? 'Root browser' : null,
    },
    update: { disabledAt: null, disabledReason: null },
  });
  const head = {
    revision: written.revision,
    authFingerprint: plan.incoming.fingerprint,
    authExpiresAt:
      plan.incoming.expiresAt === null ? null : new Date(plan.incoming.expiresAt * 1000),
    validatedAt: written.validatedAt,
    observedAt: written.observedAt,
    supersededFingerprints: written.superseded,
    cookieCount: siteJar.length,
    lastWriterTaskId: browserSessionId,
    lastWriterAgentId: context.kind === 'agent' ? context.agentId : null,
    lastWriterKind: context.kind,
  };
  await tx.browserSiteState.upsert({
    where: { userId_site_account: { userId, site: plan.site, account } },
    create: { userId, site: plan.site, account, ...head },
    update: head,
  });
  const forkData = {
    account,
    baseRevision: written.revision,
    baseFingerprint: plan.incoming.fingerprint,
    baseAuthKeys: plan.incoming.keys,
    baseObservedAt: written.observedAt,
    mergedRevision: written.revision,
    mergedAt: new Date(context.nowMs),
    lastOutcome: 'merged',
  };
  await tx.browserSiteFork.upsert({
    where: { browserSessionId_site: { browserSessionId, site: plan.site } },
    create: {
      userId,
      browserSessionId,
      agentId: context.agentId,
      site: plan.site,
      ...forkData,
    },
    update: forkData,
  });
}

/** One (site, account) under the site lock: keep-best, then write only on a take. */
async function mergeOneAccount(
  context: MergeContext,
  plan: SitePlan,
  deadlineAtMs?: number
): Promise<SiteMergeReceipt> {
  assertLegacyBrowserAccount(plan.account);
  const { userId } = context;
  const nowSeconds = Math.floor(context.nowMs / 1000);
  return runTransactionWithRetry(
    async (tx) => {
      // Sibling tasks of one user can close on the same site at once.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-world:${userId}:${plan.site}`}))`;
      const head = await tx.browserSiteState.findUnique({
        where: { userId_site_account: { userId, site: plan.site, account: plan.account } },
      });
      const rows = await tx.cookie.findMany({
        where: {
          userId,
          browserSource: ROOT_BROWSER_SOURCE,
          browserProfile: plan.account,
          OR: domainVariants(plan.site),
        },
        select: {
          name: true,
          value: true,
          domain: true,
          path: true,
          expiresUtc: true,
          hasExpires: true,
        },
      });
      const template = assessSiteCredentials(
        rows.map((row) => ({
          name: row.name,
          value: row.value,
          domain: row.domain,
          path: row.path,
          expires: unixSecondsFromChrome(row.expiresUtc, row.hasExpires),
        })),
        plan.site,
        nowSeconds
      );
      const input: KeepBestInput = {
        incoming: plan.incoming,
        template,
        hasEvidence: plan.hasEvidence,
        forkBaseKeys: plan.fork?.baseAuthKeys ?? [],
        supersededFingerprints: head?.supersededFingerprints ?? [],
        templateValidatedAtMs: head?.validatedAt?.getTime() ?? null,
        templateAgeMs: head?.observedAt?.getTime() ?? null,
        incomingAgeMs: incomingAgeMs(context, plan),
        nowMs: context.nowMs,
      };
      const decision = decideKeepBest(input);
      const headRevision = head?.revision ?? 0;
      const receipt = {
        site: plan.site,
        account: plan.account,
        base_revision: plan.fork?.baseRevision ?? 0,
      };
      if (decision.take === 'template') {
        const refresh =
          decision.outcome === 'unchanged' &&
          plan.hasEvidence &&
          head !== null &&
          head.lastWriterTaskId !== context.browserSessionId;
        if (refresh) {
          await tx.browserSiteState.update({
            where: { id: head.id },
            data: { validatedAt: new Date(context.nowMs) },
          });
        }
        if (plan.fork !== undefined) {
          await tx.browserSiteFork.update({
            where: { id: plan.fork.id },
            data: { lastOutcome: decision.outcome },
          });
        }
        return {
          ...receipt,
          outcome: decision.outcome,
          rule: decision.rule,
          head_revision: headRevision,
          merged_revision: plan.fork?.mergedRevision ?? null,
        };
      }
      const validatedAtMs = incomingValidatedAtMs(input);
      const revision = headRevision + 1;
      await writeTemplateLogin(tx, context, plan, {
        revision,
        validatedAt: validatedAtMs === null ? null : new Date(validatedAtMs),
        observedAt: new Date(input.incomingAgeMs),
        superseded: nextSuperseded(
          head?.supersededFingerprints ?? [],
          [template.fingerprint, head?.authFingerprint ?? '', plan.fork?.baseFingerprint ?? ''],
          plan.incoming.fingerprint
        ),
      });
      return {
        ...receipt,
        outcome: 'merged' as const,
        rule: decision.rule,
        head_revision: revision,
        merged_revision: revision,
      };
    },
    deadlineAtMs === undefined ? undefined : { deadlineAtMs }
  );
}

/** A decision that needs no transaction (no write to the template). */
function quietOutcome(plan: SitePlan, head: HeadRow | undefined): KeptOutcome | null {
  if (plan.incoming.status !== 'valid') {
    return plan.incoming.status === 'empty' ? 'no_login' : 'expired';
  }
  if (plan.hasEvidence || head === undefined) return null;
  if (
    head.authFingerprint === plan.incoming.fingerprint &&
    !expiryIsLater(plan.incoming.expiresAt, expirySeconds(head.authExpiresAt))
  ) {
    return 'unchanged';
  }
  return head.supersededFingerprints.includes(plan.incoming.fingerprint) ? 'superseded' : null;
}

/**
 * An unforked site is reported only when it collided with a template login and
 * lost (expired or superseded); unchanged and credential-free sites are not.
 */
function reportsUnforkedCollision(outcome: KeptOutcome, head: HeadRow | undefined): boolean {
  return head !== undefined && (outcome === 'expired' || outcome === 'superseded');
}

function planPriority(plan: SitePlan): number {
  if (plan.hasEvidence) return 0;
  return plan.fork === undefined ? 2 : 1;
}

/**
 * Merge a harvested jar into the template: every site with cookies, forked
 * or not, one (site, account) at a time. Pure DB logic: tests drive it with
 * a local browser's cookies or a synthetic jar.
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
      createdAt: true,
      context: { select: { userId: true } },
      siteForks: {
        select: {
          id: true,
          site: true,
          account: true,
          baseRevision: true,
          baseFingerprint: true,
          baseAuthKeys: true,
          baseObservedAt: true,
          mergedRevision: true,
        },
      },
    },
  });
  if (session === null || session.context.userId === '') return null;
  const userId = session.context.userId;
  const context: MergeContext = {
    userId,
    browserSessionId: session.id,
    agentId: session.agentId,
    kind: session.agentId === rootBrowserAgentId(userId) ? 'root' : 'agent',
    sessionStartedAtMs: session.createdAt.getTime(),
    nowMs: Date.now(),
    cookies: params.cookies,
  };
  const forkBySite = new Map(session.siteForks.map((fork) => [fork.site, fork]));
  const evidence = new Set([
    ...(await signedInRealmsForBrowserSession({ browserSessionId: session.id, userId })),
    ...(params.signedInSites ?? []).map((site) => canonicalAuthRealm(site)).filter((s) => s !== ''),
  ]);
  const jarSites = new Set(
    params.cookies.map((cookie) => authRealmFromCookieDomain(cookie.domain))
  );
  // Forked and signed-in sites first, so a huge jar never crowds them out.
  const sites = [
    ...new Set([
      ...[...forkBySite.keys()].sort(),
      ...[...evidence].filter((site) => jarSites.has(site)).sort(),
      ...[...jarSites].sort(),
    ]),
  ]
    .filter((site) => site !== '')
    .slice(0, MAX_HARVEST_SITES);
  const heads: HeadRow[] =
    sites.length === 0
      ? []
      : await prisma.browserSiteState.findMany({
          where: { userId, site: { in: sites } },
          select: {
            site: true,
            account: true,
            revision: true,
            authFingerprint: true,
            authExpiresAt: true,
            supersededFingerprints: true,
          },
        });

  const receipts: SiteMergeReceipt[] = [];
  const quietForks = new Map<KeptOutcome, string[]>();
  const pending: SitePlan[] = [];
  const nowSeconds = Math.floor(context.nowMs / 1000);
  for (const site of sites) {
    const fork = forkBySite.get(site);
    const incoming = assessSiteCredentials(params.cookies, site, nowSeconds);
    const siteHeads = heads.filter((head) => head.site === site);
    const account = fork?.account ?? accountHolding(siteHeads, incoming.fingerprint);
    assertLegacyBrowserAccount(account);
    const plan: SitePlan = { site, account, incoming, fork, hasEvidence: evidence.has(site) };
    const head = siteHeads.find((entry) => entry.account === account);
    const quiet = quietOutcome(plan, head);
    if (quiet === null) {
      pending.push(plan);
      continue;
    }
    if (fork !== undefined) {
      quietForks.set(quiet, [...(quietForks.get(quiet) ?? []), site]);
    } else if (!reportsUnforkedCollision(quiet, head)) {
      continue;
    }
    receipts.push({
      site,
      account,
      outcome: quiet,
      rule: null,
      base_revision: fork?.baseRevision ?? 0,
      head_revision: head?.revision ?? 0,
      merged_revision: fork?.mergedRevision ?? null,
    });
  }
  for (const [outcome, forkedSites] of quietForks) {
    await prisma.browserSiteFork.updateMany({
      where: { browserSessionId: session.id, site: { in: forkedSites } },
      data: { lastOutcome: outcome },
    });
  }
  pending.sort((a, b) => planPriority(a) - planPriority(b) || (a.site < b.site ? -1 : 1));
  for (const plan of pending.slice(0, MAX_MERGE_SITES)) {
    if (params.deadlineAtMs !== undefined && Date.now() >= params.deadlineAtMs) {
      log.warn('world_state.merge_deadline', {
        browserSessionId: session.id,
        skippedFrom: plan.site,
      });
      break;
    }
    receipts.push(await mergeOneAccount(context, plan, params.deadlineAtMs));
  }
  receipts.sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));
  log.info('world_state.merge', {
    browserSessionId: session.id,
    agentId: session.agentId,
    kind: context.kind,
    candidates: sites.length,
    transacted: Math.min(pending.length, MAX_MERGE_SITES),
    outcomes: Object.fromEntries(
      receipts.map((entry) => [`${entry.site}|${entry.account}`, entry.rule ?? entry.outcome])
    ),
  });
  return { task_id: session.id, kind: context.kind, sites: receipts };
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
    select: { site: true, account: true, revision: true },
  });
  const headOf = new Map(heads.map((head) => [`${head.site}|${head.account}`, head.revision]));
  return {
    task_id: session.id,
    kind: session.agentId === rootBrowserAgentId(session.context.userId) ? 'root' : 'agent',
    sites: session.siteForks.map((fork) => ({
      site: fork.site,
      account: fork.account,
      outcome: (fork.lastOutcome ?? 'unchanged') as SiteMergeOutcome,
      rule: null,
      base_revision: fork.baseRevision,
      head_revision: headOf.get(`${fork.site}|${fork.account}`) ?? 0,
      merged_revision: fork.mergedRevision,
    })),
  };
}
