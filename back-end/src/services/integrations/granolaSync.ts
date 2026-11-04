/**
 * Granola sync: one-click sign-in, then the user's meetings are kept in the
 * grep document store.
 *
 *   start sign-in ──register client + PKCE──> [pending sign-in in config]
 *        │ user signs in on Granola; callback with ?code&state
 *        ▼
 *   tokens stored encrypted ──> [CONNECTED, nextSyncAt=now]
 *        │ cron tick (every 5 min) / manual sync claims the row
 *        ▼
 *   [SYNCING] refresh token if near expiry, open the MCP session, then
 *     1. recent window: since the last poll (48 h overlap, catches edited
 *        summaries); the first run takes the last 14 days
 *     2. backfill: older 14-day windows, newest first, back BACKFILL_DAYS,
 *        as many as fit in the run deadline
 *   In every listed window: upsert note/summary/transcript documents, and
 *   remove stored meetings Granola no longer lists there (deleted).
 *        │
 *        ├─ done ───────────> [CONNECTED, next = +15 min (or now while backfilling)]
 *        ├─ grant rejected ─> [EXPIRED] (sign in again)
 *        └─ other error ────> [SYNC_FAILED, next = +15 min]
 *
 * One row per user (UserDataProviderSyncState, source "granola"); a claim is a
 * single `FOR UPDATE SKIP LOCKED` UPDATE, so any number of backend replicas
 * share the work and a user is synced by one of them at a time. A claim older
 * than STALE_CLAIM_MS (crashed replica) is reclaimable. Writes are keyed
 * upserts, so a repeated window is harmless.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import { decryptPlaidAccessToken, encryptPlaidAccessToken } from '../../providers/plaidCredentials';
import { upsertDataDocuments } from '../../domains/integrations/repo.documents';
import { IntegrationStatus, IntegrationType } from '../../domains/integrations/types';
import {
  GranolaMcpError,
  GranolaSession,
  beginSignIn,
  exchangeCode,
  getAccountEmail,
  getMeetingNotes,
  getTranscript,
  listMeetingsBetween,
  refreshTokens,
  type Fetcher,
  type GranolaTokens,
} from './granolaMcp';
import {
  GRANOLA_PROVIDER,
  GRANOLA_SOURCES,
  GRANOLA_TRANSCRIPT_SOURCE,
  granolaMeetingDocuments,
} from './granolaDocuments';

const log = createLogger('GranolaSync');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const GRANOLA_SYNC_INTERVAL_MS = 15 * MINUTE;
const STALE_CLAIM_MS = 15 * MINUTE;
const RUN_DEADLINE_MS = 4 * MINUTE;
const SIGN_IN_TTL_MS = 15 * MINUTE;
const RECENT_OVERLAP_MS = 2 * DAY;
const FIRST_WINDOW_MS = 14 * DAY;
const BACKFILL_WINDOW_MS = 14 * DAY;
export const BACKFILL_DAYS = 365;
/** Transcripts can still change for a day after a meeting; older ones are final. */
const TRANSCRIPT_SETTLE_MS = DAY;
const REFRESH_SKEW_MS = 2 * MINUTE;
const CRON_BATCH = 20;
const CRON_CONCURRENCY = 5;

type SyncStatus = 'PENDING' | 'CONNECTED' | 'SYNCING' | 'SYNC_FAILED' | 'EXPIRED';

interface PendingConfig {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

interface GranolaConfig {
  encryptedTokens?: string;
  accountEmail?: string | null;
  pending?: PendingConfig;
}

interface GranolaCursor {
  lastPolledAt?: string;
  /** Oldest instant the backfill has covered so far. */
  backfillEnd?: string;
  backfillDone?: boolean;
}

export interface GranolaSyncOptions {
  fetcher?: Fetcher;
  now?: () => Date;
  deadlineMs?: number;
}

export type GranolaSyncResult =
  | { outcome: 'synced' | 'partial'; meetings: number; deleted: number }
  | { outcome: 'not_claimed' | 'superseded' }
  | { outcome: 'failed' | 'expired'; error: string };

export class GranolaSignInError extends Error {
  constructor(
    readonly code: 'STATE_INVALID' | 'STATE_EXPIRED' | 'EXCHANGE_FAILED',
    message: string
  ) {
    super(message);
    this.name = 'GranolaSignInError';
  }
}

const where = (userId: string) => ({ userId_source: { userId, source: GRANOLA_PROVIDER } });

function readTokens(config: GranolaConfig): GranolaTokens | null {
  if (typeof config.encryptedTokens !== 'string') return null;
  const plain = decryptPlaidAccessToken(config.encryptedTokens);
  if (plain === null) return null;
  try {
    return JSON.parse(plain) as GranolaTokens;
  } catch {
    return null;
  }
}

const sealTokens = (tokens: GranolaTokens) => encryptPlaidAccessToken(JSON.stringify(tokens));

async function loadConfig(userId: string): Promise<GranolaConfig | null> {
  const row = await prisma.userDataProviderSyncState.findUnique({
    where: where(userId),
    select: { config: true },
  });
  return row === null ? null : ((row.config ?? {}) as GranolaConfig);
}

async function setIntegrationStatus(
  userId: string,
  status: IntegrationStatus,
  failureReason: string | null,
  now: Date
): Promise<void> {
  const synced = status === IntegrationStatus.CONNECTED;
  await prisma.integration.updateMany({
    where: { userId, name: GRANOLA_PROVIDER },
    data: {
      status,
      failureReason,
      lastSyncAt: now,
      ...(synced ? { lastSuccessfulSyncAt: now } : { lastFailedSyncAt: now }),
    },
  });
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/**
 * Start a one-click sign-in; returns the Granola URL the browser opens.
 * `redirectUri` is the Rose frontend callback page, which hands the code to
 * the authenticated `completeGranolaSignIn` (never an unauthenticated callback).
 */
export async function startGranolaSignIn(
  userId: string,
  opts: { redirectUri: string; fetcher?: Fetcher; now?: Date }
): Promise<{ authorizeUrl: string }> {
  const pending = await beginSignIn(opts.redirectUri, userId, opts.fetcher);
  const now = (opts.now ?? new Date()).getTime();
  const pendingConfig: PendingConfig = {
    state: pending.state,
    verifier: pending.verifier,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    expiresAt: now + SIGN_IN_TTL_MS,
  };
  await prisma.user.upsert({
    where: { userId },
    create: { userId, isAnonymous: true },
    update: {},
  });
  const existing = await loadConfig(userId);
  if (existing === null) {
    await prisma.userDataProviderSyncState.create({
      data: {
        userId,
        source: GRANOLA_PROVIDER,
        status: 'PENDING',
        config: { pending: pendingConfig } as unknown as Prisma.InputJsonValue,
        cursor: {},
      },
    });
  } else {
    // A reconnect keeps the current grant until the new sign-in completes; only
    // the `pending` key is written so a concurrent token refresh is not undone.
    await prisma.$executeRaw`
      UPDATE "UserDataProviderSyncState"
      SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{pending}', ${JSON.stringify(pendingConfig)}::jsonb),
          "updatedAt" = now()
      WHERE "userId" = ${userId} AND source = ${GRANOLA_PROVIDER}
    `;
  }
  return { authorizeUrl: pending.authorizeUrl };
}

/**
 * Atomically take this user's pending sign-in when its state matches, so a
 * duplicate callback cannot use (or later clobber) a sign-in twice.
 */
async function consumePending(userId: string, state: string): Promise<PendingConfig | null> {
  const rows = await prisma.$queryRaw<Array<{ pending: PendingConfig | null }>>`
    UPDATE "UserDataProviderSyncState" t
    SET config = t.config - 'pending', "updatedAt" = now()
    FROM (
      SELECT id, config->'pending' AS pending FROM "UserDataProviderSyncState"
      WHERE "userId" = ${userId} AND source = ${GRANOLA_PROVIDER}
        AND config->'pending'->>'state' = ${state}
      FOR UPDATE
    ) old
    WHERE t.id = old.id
    RETURNING old.pending AS pending
  `;
  return rows[0]?.pending ?? null;
}

/**
 * Finish the sign-in for the AUTHENTICATED user who started it. The frontend
 * callback page posts Granola's `code` and `state` here with the user's own
 * session. The state names its user, and it must be this caller: a victim who
 * is tricked into approving an attacker's sign-in link lands back in their own
 * session, so the attacker's state is refused and no tokens move accounts.
 */
export async function completeGranolaSignIn(
  userId: string,
  state: string,
  code: string,
  opts: { fetcher?: Fetcher; now?: Date } = {}
): Promise<{ accountEmail: string | null }> {
  if (state.split('.')[0] !== userId) {
    throw new GranolaSignInError('STATE_INVALID', 'This Granola sign-in belongs to another user');
  }
  const pending = await consumePending(userId, state);
  if (pending === null) {
    throw new GranolaSignInError('STATE_INVALID', 'Unknown or already used Granola sign-in');
  }
  const now = opts.now ?? new Date();
  if (pending.expiresAt < now.getTime()) {
    throw new GranolaSignInError('STATE_EXPIRED', 'Granola sign-in expired; try again');
  }
  let tokens: GranolaTokens;
  let accountEmail: string | null;
  try {
    tokens = await exchangeCode(pending, code, opts.fetcher, now.getTime());
    const session = await GranolaSession.open(tokens.accessToken, opts.fetcher);
    try {
      accountEmail = await getAccountEmail(session);
    } finally {
      await session.close();
    }
  } catch (error) {
    throw new GranolaSignInError(
      'EXCHANGE_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }
  const config = (await loadConfig(userId)) ?? {};
  // A different Granola account starts clean: the old account's meetings go.
  // An unknown identity on either side may be a different account.
  const previousEmail = config.accountEmail ?? null;
  const hadGrant = config.encryptedTokens !== undefined;
  const switched =
    hadGrant && (previousEmail === null || accountEmail === null || previousEmail !== accountEmail);
  await prisma.$transaction([
    ...(switched
      ? [
          prisma.userDataDocument.deleteMany({
            where: { userId, source: { in: [...GRANOLA_SOURCES] } },
          }),
        ]
      : []),
    prisma.userDataProviderSyncState.update({
      where: where(userId),
      data: {
        status: 'CONNECTED',
        config: { encryptedTokens: sealTokens(tokens), accountEmail } as Prisma.InputJsonValue,
        ...(switched || !hadGrant ? { cursor: {} } : {}),
        nextSyncAt: now,
        lastError: null,
        // Fences out any run still holding the previous claim (see claimToken).
        lastStartedAt: null,
      },
    }),
    prisma.integration.upsert({
      where: { userId_name_accountId: { userId, name: GRANOLA_PROVIDER, accountId: '' } },
      create: {
        userId,
        name: GRANOLA_PROVIDER,
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        accountEmail,
      },
      update: {
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        failureReason: null,
        accountEmail,
      },
    }),
  ]);
  log.info('Granola connected', { userId, switched });
  return { accountEmail };
}

/** Remove the grant, the sync state and every synced Granola document. */
export async function disconnectGranola(userId: string): Promise<{ deletedDocuments: number }> {
  const [documents] = await prisma.$transaction([
    prisma.userDataDocument.deleteMany({ where: { userId, source: { in: [...GRANOLA_SOURCES] } } }),
    prisma.userDataProviderSyncState.deleteMany({ where: { userId, source: GRANOLA_PROVIDER } }),
    prisma.integration.deleteMany({ where: { userId, name: GRANOLA_PROVIDER } }),
  ]);
  log.info('Granola disconnected', { userId, deletedDocuments: documents.count });
  return { deletedDocuments: documents.count };
}

export async function getGranolaStatus(userId: string) {
  const [state, counts] = await Promise.all([
    prisma.userDataProviderSyncState.findUnique({
      where: where(userId),
      select: {
        status: true,
        config: true,
        cursor: true,
        lastSuccessfulSyncAt: true,
        lastError: true,
      },
    }),
    prisma.userDataDocument.groupBy({
      by: ['source'],
      where: { userId, source: { in: [...GRANOLA_SOURCES] }, deletedAt: null },
      _count: true,
    }),
  ]);
  const config = (state?.config ?? {}) as GranolaConfig;
  const connected = state !== null && typeof config.encryptedTokens === 'string';
  return {
    connected,
    status: connected ? (state.status as SyncStatus) : 'NOT_CONNECTED',
    accountEmail: config.accountEmail ?? null,
    backfillDone: ((state?.cursor ?? {}) as GranolaCursor).backfillDone === true,
    lastSuccessfulSyncAt: state?.lastSuccessfulSyncAt?.toISOString() ?? null,
    lastError: state?.lastError ?? null,
    documents: Object.fromEntries(counts.map((row) => [row.source, row._count])),
  };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * A run's claim token is the `lastStartedAt` its claim wrote (DB clock, so two
 * claims never share one). Disconnect deletes the row and a new sign-in clears
 * `lastStartedAt`, so either fences out a run still in flight: every write
 * below re-checks the token under a row lock and the run stops when it is gone.
 */
class ClaimLostError extends Error {
  constructor() {
    super('Granola sync claim superseded (disconnect, new sign-in or reclaim)');
    this.name = 'ClaimLostError';
  }
}

interface Claim {
  userId: string;
  token: Date;
}

/**
 * Claim due rows (or one user's row when `userId` is given, regardless of
 * `nextSyncAt`). Returns each claimed user with its claim token.
 */
async function claim(now: Date, limit: number, userId?: string): Promise<Claim[]> {
  const stale = new Date(now.getTime() - STALE_CLAIM_MS);
  const due =
    userId === undefined
      ? Prisma.sql`s.status IN ('CONNECTED', 'SYNC_FAILED') AND s."nextSyncAt" <= ${now}`
      : Prisma.sql`s."userId" = ${userId} AND s.status IN ('CONNECTED', 'SYNC_FAILED')`;
  return prisma.$queryRaw<Claim[]>`
    UPDATE "UserDataProviderSyncState" t
    SET status = 'SYNCING', "lastStartedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
    WHERE t.id IN (
      SELECT s.id FROM "UserDataProviderSyncState" s
      WHERE s.source = ${GRANOLA_PROVIDER}
        AND (${due} OR (s.status = 'SYNCING' AND s."lastStartedAt" < ${stale}${
          userId === undefined ? Prisma.empty : Prisma.sql` AND s."userId" = ${userId}`
        }))
      ORDER BY s."nextSyncAt" ASC NULLS FIRST
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING t."userId" AS "userId", t."lastStartedAt" AS token
  `;
}

const owned = (c: Claim) => ({
  userId: c.userId,
  source: GRANOLA_PROVIDER,
  status: 'SYNCING',
  lastStartedAt: c.token,
});

/** Run `fn` in a transaction holding this run's claim row locked; throws if lost. */
async function fenced<T>(c: Claim, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "UserDataProviderSyncState"
      WHERE "userId" = ${c.userId} AND source = ${GRANOLA_PROVIDER}
        AND status = 'SYNCING' AND "lastStartedAt" = ${c.token}
      FOR UPDATE
    `;
    if (rows.length === 0) throw new ClaimLostError();
    return fn(tx);
  });
}

/** Ends the run; false when the claim was lost (nothing is written then). */
async function finish(
  c: Claim,
  status: SyncStatus,
  data: { lastError?: string | null; nextSyncAt: Date; success?: Date }
): Promise<boolean> {
  const { count } = await prisma.userDataProviderSyncState.updateMany({
    where: owned(c),
    data: {
      status,
      nextSyncAt: data.nextSyncAt,
      ...(data.lastError === undefined ? {} : { lastError: data.lastError }),
      ...(data.success === undefined ? {} : { lastSuccessfulSyncAt: data.success }),
    },
  });
  return count === 1;
}

async function saveCursor(c: Claim, cursor: GranolaCursor): Promise<void> {
  const { count } = await prisma.userDataProviderSyncState.updateMany({
    where: owned(c),
    data: { cursor: cursor as Prisma.InputJsonValue },
  });
  if (count !== 1) throw new ClaimLostError();
}

/** An open MCP session that can refresh its token and reopen mid-run. */
class Connection {
  session: GranolaSession | null = null;

  constructor(
    private readonly c: Claim,
    private tokens: GranolaTokens,
    private readonly opts: GranolaSyncOptions,
    private readonly clock: () => Date
  ) {}

  private async refresh(): Promise<void> {
    this.tokens = await refreshTokens(this.tokens, this.opts.fetcher, this.clock().getTime());
    // Only the token field, and only while this run still owns the row: a
    // stale copy of the config must never undo a newer sign-in.
    const updated = await prisma.$executeRaw`
      UPDATE "UserDataProviderSyncState"
      SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{encryptedTokens}', to_jsonb(${sealTokens(this.tokens)}::text)),
          "updatedAt" = now()
      WHERE "userId" = ${this.c.userId} AND source = ${GRANOLA_PROVIDER}
        AND status = 'SYNCING' AND "lastStartedAt" = ${this.c.token}
    `;
    if (updated !== 1) throw new ClaimLostError();
  }

  async open(): Promise<void> {
    if (
      this.tokens.expiresAt !== null &&
      this.tokens.expiresAt - REFRESH_SKEW_MS <= this.clock().getTime()
    ) {
      await this.refresh();
    }
    try {
      this.session = await GranolaSession.open(this.tokens.accessToken, this.opts.fetcher);
    } catch (error) {
      if (!(error instanceof GranolaMcpError && error.reconnect)) throw error;
      await this.refresh();
      this.session = await GranolaSession.open(this.tokens.accessToken, this.opts.fetcher);
    }
  }

  /**
   * Run `fn` on the session; when the token expires mid-run (401), refresh it,
   * reopen and retry once. Only a refused refresh reaches EXPIRED.
   */
  async use<T>(fn: (session: GranolaSession) => Promise<T>): Promise<T> {
    if (this.session === null) await this.open();
    const session = this.session;
    if (session === null) throw new GranolaMcpError('Granola session did not open');
    try {
      return await fn(session);
    } catch (error) {
      if (!(error instanceof GranolaMcpError && error.reconnect)) throw error;
      await this.close();
      await this.refresh();
      this.session = await GranolaSession.open(this.tokens.accessToken, this.opts.fetcher);
      return fn(this.session);
    }
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = null;
  }
}

/** Sync every meeting in [startMs, endMs); returns stored and removed counts. */
async function syncWindow(
  c: Claim,
  session: GranolaSession,
  startMs: number,
  endMs: number,
  now: Date
): Promise<{ meetings: number; deleted: number }> {
  const { userId } = c;
  const listed = await listMeetingsBetween(session, startMs, endMs);
  const ids = listed.map((meeting) => meeting.id);
  const notes = await getMeetingNotes(session, ids);
  const haveTranscript = new Set(
    (
      await prisma.userDataDocument.findMany({
        where: {
          userId,
          source: GRANOLA_TRANSCRIPT_SOURCE,
          externalId: { in: ids },
          deletedAt: null,
        },
        select: { externalId: true },
      })
    ).map((row) => row.externalId)
  );
  for (const meeting of listed) {
    const settled = Date.parse(meeting.meetingAt) < now.getTime() - TRANSCRIPT_SETTLE_MS;
    const transcript =
      settled && haveTranscript.has(meeting.id)
        ? undefined
        : await getTranscript(session, meeting.id);
    // Notes Granola did not return this time leave the stored note and summary
    // as they are; only a layer Granola returned without is gone. An unfetched
    // transcript is kept too.
    const note = notes.get(meeting.id);
    const documents = granolaMeetingDocuments(meeting, note, transcript).filter(
      (doc) => note !== undefined || doc.source === GRANOLA_TRANSCRIPT_SOURCE
    );
    const gone = GRANOLA_SOURCES.filter(
      (source) =>
        !documents.some((doc) => doc.source === source) &&
        !(source === GRANOLA_TRANSCRIPT_SOURCE && transcript === undefined) &&
        !(source !== GRANOLA_TRANSCRIPT_SOURCE && note === undefined)
    );
    await fenced(c, async (tx) => {
      await upsertDataDocuments(userId, documents, tx);
      if (gone.length > 0) {
        await tx.userDataDocument.updateMany({
          where: { userId, externalId: meeting.id, source: { in: gone }, deletedAt: null },
          data: { deletedAt: now },
        });
      }
    });
  }
  // Stored meetings in this window that Granola no longer lists were deleted.
  const removed = await fenced(c, (tx) =>
    tx.userDataDocument.updateMany({
      where: {
        userId,
        source: { in: [...GRANOLA_SOURCES] },
        sourceUpdatedAt: { gte: new Date(startMs), lt: new Date(endMs) },
        externalId: { notIn: ids },
        deletedAt: null,
      },
      data: { deletedAt: now },
    })
  );
  return { meetings: listed.length, deleted: removed.count };
}

/** One sync run for a user whose row this process has already claimed. */
async function runClaimed(c: Claim, opts: GranolaSyncOptions): Promise<GranolaSyncResult> {
  const { userId } = c;
  const clock = opts.now ?? (() => new Date());
  const deadline = clock().getTime() + (opts.deadlineMs ?? RUN_DEADLINE_MS);
  const state = await prisma.userDataProviderSyncState.findUniqueOrThrow({
    where: where(userId),
    select: { config: true, cursor: true },
  });
  const config = (state.config ?? {}) as GranolaConfig;
  const cursor = { ...((state.cursor ?? {}) as GranolaCursor) };
  const tokens = readTokens(config);
  if (tokens === null) {
    const reason = 'Granola sign-in is unreadable; connect Granola again';
    if (await finish(c, 'EXPIRED', { lastError: reason, nextSyncAt: clock() })) {
      await setIntegrationStatus(userId, IntegrationStatus.EXPIRED, reason, clock());
    }
    return { outcome: 'expired', error: reason };
  }

  let meetings = 0;
  let deleted = 0;
  const conn = new Connection(c, tokens, opts, clock);
  try {
    await conn.open();
    const started = clock();
    const recentStart =
      cursor.lastPolledAt === undefined
        ? started.getTime() - FIRST_WINDOW_MS
        : Date.parse(cursor.lastPolledAt) - RECENT_OVERLAP_MS;
    const recent = await conn.use((session) =>
      syncWindow(c, session, recentStart, started.getTime() + DAY, started)
    );
    meetings += recent.meetings;
    deleted += recent.deleted;
    cursor.lastPolledAt = started.toISOString();
    cursor.backfillEnd ??= new Date(recentStart).toISOString();
    await saveCursor(c, cursor);

    const oldest = started.getTime() - BACKFILL_DAYS * DAY;
    while (cursor.backfillDone !== true && clock().getTime() < deadline) {
      const end = Date.parse(cursor.backfillEnd);
      const start = Math.max(end - BACKFILL_WINDOW_MS, oldest);
      const window = await conn.use((session) => syncWindow(c, session, start, end, clock()));
      meetings += window.meetings;
      deleted += window.deleted;
      cursor.backfillEnd = new Date(start).toISOString();
      if (start <= oldest) cursor.backfillDone = true;
      await saveCursor(c, cursor);
    }

    const now = clock();
    const done = cursor.backfillDone === true;
    const ended = await finish(c, 'CONNECTED', {
      lastError: null,
      success: now,
      nextSyncAt: done ? new Date(now.getTime() + GRANOLA_SYNC_INTERVAL_MS) : now,
    });
    if (!ended) throw new ClaimLostError();
    await setIntegrationStatus(userId, IntegrationStatus.CONNECTED, null, now);
    log.info('Granola synced', { userId, meetings, deleted, backfillDone: done });
    return { outcome: done ? 'synced' : 'partial', meetings, deleted };
  } catch (error) {
    const now = clock();
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    if (error instanceof ClaimLostError) {
      log.info('Granola sync stopped: claim superseded', { userId });
      return { outcome: 'superseded' };
    }
    if (error instanceof GranolaMcpError && error.reconnect) {
      // A new sign-in rotates the grant under a running sync; that run lost its
      // claim and must not mark the fresh connection expired.
      const reason = 'Granola sign-in expired; connect Granola again';
      if (!(await finish(c, 'EXPIRED', { lastError: reason, nextSyncAt: now }))) {
        return { outcome: 'superseded' };
      }
      await setIntegrationStatus(userId, IntegrationStatus.EXPIRED, reason, now);
      log.warn('Granola grant rejected', { userId, error: message.slice(0, 200) });
      return { outcome: 'expired', error: reason };
    }
    const failed = await finish(c, 'SYNC_FAILED', {
      lastError: message,
      nextSyncAt: new Date(now.getTime() + GRANOLA_SYNC_INTERVAL_MS),
    });
    if (!failed) return { outcome: 'superseded' };
    await setIntegrationStatus(userId, IntegrationStatus.SYNC_FAILED, message, now);
    log.error('Granola sync failed', { userId, error: message.slice(0, 200) });
    return { outcome: 'failed', error: message };
  } finally {
    await conn.close();
  }
}

/** Sync one user now (after sign-in, manual refresh). No-op if a run holds it. */
export async function syncGranolaUser(
  userId: string,
  opts: GranolaSyncOptions = {}
): Promise<GranolaSyncResult> {
  const [claimed] = await claim((opts.now ?? (() => new Date()))(), 1, userId);
  if (claimed === undefined) return { outcome: 'not_claimed' };
  return runClaimed(claimed, opts);
}

/** Cron entry: sync every due user, a bounded batch per tick. */
export async function runGranolaSyncJob(opts: GranolaSyncOptions = {}): Promise<number> {
  const users = await claim((opts.now ?? (() => new Date()))(), CRON_BATCH);
  const queue = [...users];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await runClaimed(next, opts).catch((error: unknown) =>
        log.error('Granola run crashed', {
          userId: next.userId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(CRON_CONCURRENCY, users.length) }, worker));
  return users.length;
}
