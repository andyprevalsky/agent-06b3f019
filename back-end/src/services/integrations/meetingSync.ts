/**
 * Meeting-provider sync: one-click sign-in, then the user's meetings are kept in the
 * grep document store.
 *
 *   start sign-in ──register client + PKCE──> [pending sign-in in config]
 *        │ user signs in on the provider; callback with ?code&state
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
 *   remove stored meetings the provider no longer lists there (deleted).
 *        │
 *        ├─ done ───────────> [CONNECTED, next = +15 min (or now while backfilling)]
 *        ├─ grant rejected ─> [EXPIRED] (sign in again)
 *        └─ other error ────> [SYNC_FAILED, next = +15 min]
 *
 * One row per user/provider (UserDataProviderSyncState, source = provider id); a claim is a
 * single `FOR UPDATE SKIP LOCKED` UPDATE, so any number of backend replicas
 * share the work and a user is synced by one of them at a time. A claim older
 * than STALE_CLAIM_MS (crashed replica) is reclaimable. Writes are keyed
 * upserts, so a repeated window is harmless.
 */

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import { decryptPlaidAccessToken, encryptPlaidAccessToken } from '../../providers/plaidCredentials';
import { upsertDataDocuments } from '../../domains/integrations/repo.documents';
import { IntegrationStatus, IntegrationType } from '../../domains/integrations/types';
import type { MeetingProvider, MeetingSession, MeetingTokens, Fetcher } from './meetingProvider';
import { meetingDocuments, meetingSources } from './meetingDocuments';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const MEETING_SYNC_INTERVAL_MS = 15 * MINUTE;
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

interface MeetingConfig {
  /** Survives consuming pending until this callback commits or a newer start supersedes it. */
  signInGeneration?: string;
  encryptedTokens?: string;
  accountEmail?: string | null;
  pending?: PendingConfig;
}

interface MeetingCursor {
  lastPolledAt?: string;
  /** Oldest instant the backfill has covered so far. */
  backfillEnd?: string;
  backfillDone?: boolean;
}

export interface MeetingSyncOptions {
  fetcher?: Fetcher;
  now?: () => Date;
  deadlineMs?: number;
}

export type MeetingSyncResult =
  | { outcome: 'synced' | 'partial'; meetings: number; deleted: number }
  | { outcome: 'not_claimed' | 'superseded' }
  | { outcome: 'failed' | 'expired'; error: string };

export class MeetingSignInError extends Error {
  constructor(
    readonly code: 'STATE_INVALID' | 'STATE_EXPIRED' | 'EXCHANGE_FAILED',
    message: string
  ) {
    super(message);
    this.name = 'MeetingSignInError';
  }
}

export function createMeetingSync<S extends MeetingSession>(provider: MeetingProvider<S>) {
  const {
    id: PROVIDER,
    label,
    beginSignIn,
    exchangeCode,
    getAccountEmail,
    getMeetingNotes,
    getTranscript,
    listMeetingsBetween,
    refreshTokens,
  } = provider;
  const SOURCES = meetingSources(PROVIDER);
  const TRANSCRIPT_SOURCE = `${PROVIDER}_transcript`;
  const log = createLogger(`${label}Sync`);
  const where = (userId: string) => ({ userId_source: { userId, source: PROVIDER } });

  function readTokens(config: MeetingConfig): MeetingTokens | null {
    if (typeof config.encryptedTokens !== 'string') return null;
    const plain = decryptPlaidAccessToken(config.encryptedTokens);
    if (plain === null) return null;
    try {
      return JSON.parse(plain) as MeetingTokens;
    } catch {
      return null;
    }
  }

  const sealTokens = (tokens: MeetingTokens) => encryptPlaidAccessToken(JSON.stringify(tokens));

  async function setIntegrationStatus(
    userId: string,
    status: IntegrationStatus,
    failureReason: string | null,
    now: Date
  ): Promise<void> {
    const synced = status === IntegrationStatus.CONNECTED;
    await prisma.integration.updateMany({
      where: { userId, name: PROVIDER },
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
   * Start a one-click sign-in; returns the provider URL the browser opens.
   * `redirectUri` is the Rose frontend callback page, which hands the code to
   * the authenticated `completeSignIn` (never an unauthenticated callback).
   */
  async function startSignIn(
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
    const patch = JSON.stringify({ pending: pendingConfig, signInGeneration: pending.state });
    // One atomic upsert orders concurrent starts and disconnects; it merges only
    // the sign-in fields so refreshing the existing grant remains independent.
    await prisma.$executeRaw`
      INSERT INTO "UserDataProviderSyncState"
        (id, "userId", source, status, config, cursor, "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${userId}, ${PROVIDER}, 'PENDING', ${patch}::jsonb, '{}'::jsonb, now(), now())
      ON CONFLICT ("userId", source) DO UPDATE
      SET config = COALESCE("UserDataProviderSyncState".config, '{}'::jsonb) || EXCLUDED.config,
          "updatedAt" = now()
    `;
    return { authorizeUrl: pending.authorizeUrl };
  }

  /**
   * Atomically take this user's pending sign-in when its state matches, so a
   * duplicate callback cannot use (or later clobber) a sign-in twice.
   */
  async function consumePending(
    userId: string,
    state: string
  ): Promise<{ pending: PendingConfig; rowId: string } | null> {
    const rows = await prisma.$queryRaw<Array<{ pending: PendingConfig; rowId: string }>>`
    UPDATE "UserDataProviderSyncState" t
    SET config = jsonb_set(t.config - 'pending', '{signInGeneration}', to_jsonb(${state}::text)), "updatedAt" = now()
    FROM (
      SELECT id, config->'pending' AS pending FROM "UserDataProviderSyncState"
      WHERE "userId" = ${userId} AND source = ${PROVIDER}
        AND config->'pending'->>'state' = ${state}
      FOR UPDATE
    ) old
    WHERE t.id = old.id
    RETURNING old.pending AS pending, t.id AS "rowId"
  `;
    return rows[0] ?? null;
  }

  /**
   * Finish the sign-in for the AUTHENTICATED user who started it. The frontend
   * callback page posts the provider's `code` and `state` here with the user's own
   * session. The state names its user, and it must be this caller: a victim who
   * is tricked into approving an attacker's sign-in link lands back in their own
   * session, so the attacker's state is refused and no tokens move accounts.
   */
  async function completeSignIn(
    userId: string,
    state: string,
    code: string,
    opts: { fetcher?: Fetcher; now?: Date } = {}
  ): Promise<{ accountEmail: string | null }> {
    if (state.split('.')[0] !== userId) {
      throw new MeetingSignInError(
        'STATE_INVALID',
        `This ${label} sign-in belongs to another user`
      );
    }
    const consumed = await consumePending(userId, state);
    if (consumed === null) {
      throw new MeetingSignInError('STATE_INVALID', `Unknown or already used ${label} sign-in`);
    }
    const { pending, rowId } = consumed;
    const now = opts.now ?? new Date();
    if (pending.expiresAt < now.getTime()) {
      throw new MeetingSignInError('STATE_EXPIRED', `${label} sign-in expired; try again`);
    }
    let tokens: MeetingTokens;
    let accountEmail: string | null;
    try {
      tokens = await exchangeCode(pending, code, opts.fetcher, now.getTime());
      const session = await provider.openSession(tokens.accessToken, opts.fetcher);
      try {
        accountEmail = await getAccountEmail(session);
      } finally {
        await session.close();
      }
    } catch (error) {
      throw new MeetingSignInError(
        'EXCHANGE_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
    const encryptedTokens = sealTokens(tokens);
    const switched = await runTransactionWithRetry(async (tx) => {
      // Same state-row-first lock order as sync/disconnect. The row identity
      // fences delete/recreate; the persisted generation fences newer starts,
      // even after those callbacks have consumed their own pending sign-in.
      const [current] = await tx.$queryRaw<Array<{ id: string; config: MeetingConfig | null }>>`
        SELECT id, config FROM "UserDataProviderSyncState"
        WHERE "userId" = ${userId} AND source = ${PROVIDER}
        FOR UPDATE
      `;
      if (current?.id !== rowId || current.config?.signInGeneration !== state) {
        throw new MeetingSignInError(
          'STATE_INVALID',
          `${label} sign-in was superseded or disconnected`
        );
      }
      const config = current.config;
      const previousEmail = config.accountEmail ?? null;
      const hadGrant = config.encryptedTokens !== undefined;
      const switched =
        hadGrant &&
        (previousEmail === null || accountEmail === null || previousEmail !== accountEmail);
      await tx.userDataProviderSyncState.update({
        where: where(userId),
        data: {
          status: 'CONNECTED',
          config: { encryptedTokens, accountEmail } as Prisma.InputJsonValue,
          ...(switched || !hadGrant ? { cursor: {} } : {}),
          nextSyncAt: now,
          lastError: null,
          lastStartedAt: null,
        },
      });
      if (switched)
        await tx.userDataDocument.deleteMany({ where: { userId, source: { in: [...SOURCES] } } });
      await tx.integration.upsert({
        where: { userId_name_accountId: { userId, name: PROVIDER, accountId: '' } },
        create: {
          userId,
          name: PROVIDER,
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
      });
      return switched;
    });
    log.info(`${label} connected`, { userId, switched });
    return { accountEmail };
  }

  /** Remove the grant, the sync state and every synced provider document. */
  async function disconnect(userId: string): Promise<{ deletedDocuments: number }> {
    // State row first (same lock order as a fenced sync write).
    const [, documents] = await prisma.$transaction([
      prisma.userDataProviderSyncState.deleteMany({ where: { userId, source: PROVIDER } }),
      prisma.userDataDocument.deleteMany({ where: { userId, source: { in: [...SOURCES] } } }),
      prisma.integration.deleteMany({ where: { userId, name: PROVIDER } }),
    ]);
    log.info(`${label} disconnected`, { userId, deletedDocuments: documents.count });
    return { deletedDocuments: documents.count };
  }

  async function getStatus(userId: string) {
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
        where: { userId, source: { in: [...SOURCES] }, deletedAt: null },
        _count: true,
      }),
    ]);
    const config = (state?.config ?? {}) as MeetingConfig;
    const connected = state !== null && typeof config.encryptedTokens === 'string';
    return {
      connected,
      status: connected ? (state.status as SyncStatus) : 'NOT_CONNECTED',
      accountEmail: config.accountEmail ?? null,
      backfillDone: ((state?.cursor ?? {}) as MeetingCursor).backfillDone === true,
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
      super(`${label} sync claim superseded (disconnect, new sign-in or reclaim)`);
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
      WHERE s.source = ${PROVIDER}
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
    source: PROVIDER,
    status: 'SYNCING',
    lastStartedAt: c.token,
  });

  /** Run `fn` in a transaction holding this run's claim row locked; throws if lost. */
  async function fenced<T>(c: Claim, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runTransactionWithRetry(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "UserDataProviderSyncState"
      WHERE "userId" = ${c.userId} AND source = ${PROVIDER}
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

  async function saveCursor(c: Claim, cursor: MeetingCursor): Promise<void> {
    const { count } = await prisma.userDataProviderSyncState.updateMany({
      where: owned(c),
      data: { cursor: cursor as Prisma.InputJsonValue },
    });
    if (count !== 1) throw new ClaimLostError();
  }

  /** An open MCP session that can refresh its token and reopen mid-run. */
  class Connection {
    session: S | null = null;

    constructor(
      private readonly c: Claim,
      private tokens: MeetingTokens,
      private readonly opts: MeetingSyncOptions,
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
      WHERE "userId" = ${this.c.userId} AND source = ${PROVIDER}
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
        this.session = await provider.openSession(this.tokens.accessToken, this.opts.fetcher);
      } catch (error) {
        if (!provider.isAuthError(error)) throw error;
        await this.refresh();
        this.session = await provider.openSession(this.tokens.accessToken, this.opts.fetcher);
      }
    }

    /**
     * Run `fn` on the session; when the token expires mid-run (401), refresh it,
     * reopen and retry once. Only a refused refresh reaches EXPIRED.
     */
    async use<T>(fn: (session: S) => Promise<T>): Promise<T> {
      if (this.session === null) await this.open();
      const session = this.session;
      if (session === null) throw new Error(`${label} session did not open`);
      try {
        return await fn(session);
      } catch (error) {
        if (!provider.isAuthError(error)) throw error;
        await this.close();
        await this.refresh();
        this.session = await provider.openSession(this.tokens.accessToken, this.opts.fetcher);
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
    session: S,
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
            source: TRANSCRIPT_SOURCE,
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
      // Notes the provider did not return this time leave the stored note and summary
      // as they are; only a layer the provider explicitly returned without is gone. An unfetched
      // transcript is kept too.
      const note = notes.get(meeting.id);
      const documents = meetingDocuments(provider, meeting, note, transcript).filter(
        (doc) => note !== undefined || doc.source === TRANSCRIPT_SOURCE
      );
      const gone = SOURCES.filter(
        (source) =>
          !documents.some((doc) => doc.source === source) &&
          !(source === TRANSCRIPT_SOURCE && transcript === undefined) &&
          !(source !== TRANSCRIPT_SOURCE && note === undefined)
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
    // Stored meetings in this window that the provider no longer lists were deleted.
    const removed = await fenced(c, (tx) =>
      tx.userDataDocument.updateMany({
        where: {
          userId,
          source: { in: [...SOURCES] },
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
  async function runClaimed(c: Claim, opts: MeetingSyncOptions): Promise<MeetingSyncResult> {
    const { userId } = c;
    const clock = opts.now ?? (() => new Date());
    const deadline = clock().getTime() + (opts.deadlineMs ?? RUN_DEADLINE_MS);
    const state = await prisma.userDataProviderSyncState.findUniqueOrThrow({
      where: where(userId),
      select: { config: true, cursor: true },
    });
    const config = (state.config ?? {}) as MeetingConfig;
    const cursor = { ...((state.cursor ?? {}) as MeetingCursor) };
    const tokens = readTokens(config);
    if (tokens === null) {
      const reason = `${label} sign-in is unreadable; connect ${label} again`;
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
        nextSyncAt: done ? new Date(now.getTime() + MEETING_SYNC_INTERVAL_MS) : now,
      });
      if (!ended) throw new ClaimLostError();
      await setIntegrationStatus(userId, IntegrationStatus.CONNECTED, null, now);
      log.info(`${label} synced`, { userId, meetings, deleted, backfillDone: done });
      return { outcome: done ? 'synced' : 'partial', meetings, deleted };
    } catch (error) {
      const now = clock();
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      if (error instanceof ClaimLostError) {
        log.info(`${label} sync stopped: claim superseded`, { userId });
        return { outcome: 'superseded' };
      }
      if (provider.isAuthError(error)) {
        // A new sign-in rotates the grant under a running sync; that run lost its
        // claim and must not mark the fresh connection expired.
        const reason = `${label} sign-in expired; connect ${label} again`;
        if (!(await finish(c, 'EXPIRED', { lastError: reason, nextSyncAt: now }))) {
          return { outcome: 'superseded' };
        }
        await setIntegrationStatus(userId, IntegrationStatus.EXPIRED, reason, now);
        log.warn(`${label} grant rejected`, { userId, error: message.slice(0, 200) });
        return { outcome: 'expired', error: reason };
      }
      const failed = await finish(c, 'SYNC_FAILED', {
        lastError: message,
        nextSyncAt: new Date(now.getTime() + MEETING_SYNC_INTERVAL_MS),
      });
      if (!failed) return { outcome: 'superseded' };
      await setIntegrationStatus(userId, IntegrationStatus.SYNC_FAILED, message, now);
      log.error(`${label} sync failed`, { userId, error: message.slice(0, 200) });
      return { outcome: 'failed', error: message };
    } finally {
      await conn.close();
    }
  }

  /** Sync one user now (after sign-in, manual refresh). No-op if a run holds it. */
  async function syncUser(
    userId: string,
    opts: MeetingSyncOptions = {}
  ): Promise<MeetingSyncResult> {
    const [claimed] = await claim((opts.now ?? (() => new Date()))(), 1, userId);
    if (claimed === undefined) return { outcome: 'not_claimed' };
    return runClaimed(claimed, opts);
  }

  /**
   * Cron entry: sync up to CRON_BATCH due users per tick. Each worker claims one
   * user just before running it, so a claim's age always matches its run and a
   * queued claim can never go stale and be taken by another replica.
   */
  async function runSyncJob(opts: MeetingSyncOptions = {}): Promise<number> {
    const clock = opts.now ?? (() => new Date());
    let budget = CRON_BATCH;
    let claimed = 0;
    const worker = async () => {
      while (budget > 0) {
        budget -= 1;
        const [next] = await claim(clock(), 1);
        if (next === undefined) return;
        claimed += 1;
        await runClaimed(next, opts).catch((error: unknown) =>
          log.error(`${label} run crashed`, {
            userId: next.userId,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    };
    await Promise.all(Array.from({ length: CRON_CONCURRENCY }, worker));
    return claimed;
  }

  return { startSignIn, completeSignIn, disconnect, getStatus, syncUser, runSyncJob };
}
