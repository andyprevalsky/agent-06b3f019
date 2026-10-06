/**
 * Keeps Google Calendar and Drive documents current for grep.
 *
 * Demand-driven, never a cron: a source is refreshed when the account connects
 * and when a grep targets it after the freshness window. Work is therefore
 * proportional to agents actually reading that source. One row in
 * `UserDataProviderSyncState` per (user, source) is both the cursor and the
 * lease, so concurrent greps for one user share a single refresh and no state
 * is shared between users.
 *
 * Google is the source of truth: a row Google no longer returns is deleted, and
 * rows of an account that is no longer connected are deleted on the next
 * refresh, whatever the disconnect path was.
 */

import { EmailProvider, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import { retryWithBackoff } from '../../providers/retry';
import { GOOGLE_OAUTH_SCOPES } from '../../domains/integrations/googleScopes';
import { getValidAccessToken } from './gmailSync';
import {
  LeaseLostError,
  STATUS_CONNECTED,
  STATUS_FAILED,
  STATUS_NOT_CONNECTED,
  STATUS_SYNCING,
  claimSyncLease,
  type SyncLease,
} from './googleWorkspaceSyncLease';
import {
  driveChangedSince,
  fetchDriveText,
  getDriveStartPageToken,
  listCalendarEvents,
  listDriveFiles,
  type Fetcher,
} from './googleWorkspaceApi';
import {
  DRIVE_INITIAL_CONTENT_FILES,
  DRIVE_MAX_FILES,
  GOOGLE_CALENDAR_SOURCE,
  GOOGLE_DRIVE_SOURCE,
  GOOGLE_WORKSPACE_SOURCES,
  calendarEventToDocument,
  calendarWindow,
  documentHash,
  driveFileToDocument,
  driveFolderPaths,
  driveTextRequest,
  textDigest,
  type DriveContentState,
  type GoogleDriveFile,
  type GoogleWorkspaceDocument,
  type GoogleWorkspaceSource,
} from './googleWorkspaceDocuments';

const log = createLogger('GoogleWorkspaceSync');

/** A grep sees data at most this old; also the retry spacing after a failure. */
export const GOOGLE_SOURCE_FRESHNESS_MS = 60_000;
const CONTENT_CONCURRENCY = 5;
const WRITE_CHUNK = 500;
const ON_DEMAND_TEXT_LIMIT = 10;

/**
 * When a caller re-reads the state of a refresh that another caller is running.
 * Long enough for the usual incremental refresh; a first sync of a large Drive
 * runs far longer, and a search during it should answer from stored rows soon.
 */
const IN_FLIGHT_POLL_DELAYS_MS = [150, 300, 600, 1200];

export type GoogleSyncOutcome = 'fresh' | 'in_progress' | 'not_connected' | 'refreshed' | 'failed';

export interface GoogleSyncOptions {
  fetcher?: Fetcher;
  now?: Date;
  /** Refresh even inside the freshness window (used when an account connects). */
  force?: boolean;
  /** How often a running refresh renews its lease (tests shorten it). */
  leaseRenewMs?: number;
}

interface AccountCredential {
  id: string;
  email: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

interface StoredRow {
  id: string;
  externalId: string;
  contentHash: string;
  metadata: Prisma.JsonValue | null;
}

type AccountCursors = Record<string, { pageToken?: string }>;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * Accounts that can serve Calendar and Drive. One connected before Rose asked
 * for those permissions is left out: Google refuses it every time, and that is
 * a missing grant to report as not connected, not a failing refresh.
 *
 * `sync_failed` stays in: it means a transient or server-side fault, the grant
 * is intact, and the user must not be asked to reconnect for it. Only
 * `needs_reconnect` (the grant is gone) takes an account out.
 */
function workspaceAccountWhere(userId: string): Prisma.EmailIntegrationCredentialWhereInput {
  return {
    userId,
    provider: EmailProvider.GMAIL,
    state: { in: ['connected', 'sync_failed'] },
    email: { not: null },
    refreshToken: { not: null },
    scopes: { hasEvery: [...GOOGLE_OAUTH_SCOPES] },
  };
}

/** Whether the user has any Google account Calendar and Drive can be read from. */
export async function hasGoogleWorkspaceAccount(userId: string): Promise<boolean> {
  const account = await prisma.emailIntegrationCredential.findFirst({
    where: workspaceAccountWhere(userId),
    select: { id: true },
  });
  return account !== null;
}

/** The Google accounts Calendar and Drive are read from, for showing what is searchable. */
export async function googleWorkspaceAccountEmails(userId: string): Promise<string[]> {
  const accounts = await prisma.emailIntegrationCredential.findMany({
    where: workspaceAccountWhere(userId),
    select: { email: true },
    orderBy: { email: 'asc' },
  });
  return accounts
    .map((account) => account.email)
    .filter((email): email is string => email !== null);
}

async function connectedAccounts(userId: string): Promise<AccountCredential[]> {
  const rows = await prisma.emailIntegrationCredential.findMany({
    where: workspaceAccountWhere(userId),
    select: {
      id: true,
      email: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      scopes: true,
    },
  });
  return rows.filter((row): row is AccountCredential => row.email !== null);
}

async function storedRows(
  userId: string,
  source: GoogleWorkspaceSource,
  accountEmail: string
): Promise<Map<string, StoredRow>> {
  const rows = await prisma.userDataDocument.findMany({
    where: { userId, source, googleAccountEmail: accountEmail },
    select: { id: true, externalId: true, contentHash: true, metadata: true },
  });
  return new Map(rows.map((row) => [row.externalId, row]));
}

/**
 * Make the stored rows of one account equal `documents`: create what is new,
 * update what changed (by hash), delete what Google no longer returns.
 */
export async function applyGoogleDocuments(params: {
  userId: string;
  source: GoogleWorkspaceSource;
  accountEmail: string;
  documents: GoogleWorkspaceDocument[];
  stored?: Map<string, StoredRow>;
}): Promise<{ created: number; updated: number; removed: number }> {
  const { userId, source, accountEmail, documents } = params;
  const stored = params.stored ?? (await storedRows(userId, source, accountEmail));
  const seen = new Set<string>();
  const creates: Prisma.UserDataDocumentCreateManyInput[] = [];
  let updated = 0;

  for (const doc of documents) {
    if (seen.has(doc.externalId)) continue;
    seen.add(doc.externalId);
    const metadata = doc.metadata as Prisma.InputJsonObject;
    const row = stored.get(doc.externalId);
    if (row === undefined) {
      creates.push({
        userId,
        source,
        googleAccountEmail: accountEmail,
        externalId: doc.externalId,
        title: doc.title,
        content: doc.content,
        url: doc.url,
        metadata,
        sourceUpdatedAt: doc.sourceUpdatedAt,
        contentHash: doc.contentHash,
      });
      continue;
    }
    if (row.contentHash === doc.contentHash) continue;
    await prisma.userDataDocument.update({
      where: { id: row.id },
      data: {
        title: doc.title,
        url: doc.url ?? null,
        metadata,
        sourceUpdatedAt: doc.sourceUpdatedAt ?? null,
        contentHash: doc.contentHash,
        lastSeenAt: new Date(),
        deletedAt: null,
        ...(doc.keepStoredContent === true ? {} : { content: doc.content }),
      },
    });
    updated += 1;
  }

  for (const batch of chunks(creates, WRITE_CHUNK)) {
    await prisma.userDataDocument.createMany({ data: batch, skipDuplicates: true });
  }
  const removedIds = [...stored.values()]
    .filter((row) => !seen.has(row.externalId))
    .map((row) => row.id);
  for (const batch of chunks(removedIds, WRITE_CHUNK)) {
    await prisma.userDataDocument.deleteMany({ where: { id: { in: batch } } });
  }
  return { created: creates.length, updated, removed: removedIds.length };
}

async function syncCalendarAccount(params: {
  userId: string;
  accountEmail: string;
  token: string;
  fetcher: Fetcher;
  now: Date;
  keepAlive: () => Promise<void>;
}): Promise<void> {
  const events = await listCalendarEvents(params.token, calendarWindow(params.now), params.fetcher);
  await params.keepAlive();
  const documents = events
    .map((event) => calendarEventToDocument(event, params.accountEmail))
    .filter((doc): doc is GoogleWorkspaceDocument => doc !== null);
  const counts = await applyGoogleDocuments({
    userId: params.userId,
    source: GOOGLE_CALENDAR_SOURCE,
    accountEmail: params.accountEmail,
    documents,
  });
  log.info('Calendar refreshed', { userId: params.userId, events: documents.length, ...counts });
}

/** What to do about one Drive file's text on this refresh. */
function plannedDriveContent(
  file: GoogleDriveFile,
  row: StoredRow | undefined,
  withinBudget: boolean
): DriveContentState | 'fetch' {
  if (driveTextRequest(file) === null) return { kind: 'none' };
  const meta = asRecord(row?.metadata);
  const digest = meta.contentDigest;
  const indexed = meta.contentIndexed === true && typeof digest === 'string';
  if (indexed && meta.modifiedTime === file.modifiedTime) {
    return { kind: 'stored', digest, truncated: meta.contentTruncated === true };
  }
  return indexed || withinBudget ? 'fetch' : { kind: 'none' };
}

async function syncDriveAccount(params: {
  userId: string;
  accountEmail: string;
  token: string;
  fetcher: Fetcher;
  pageToken?: string;
  keepAlive: () => Promise<void>;
}): Promise<{ pageToken: string }> {
  const { userId, accountEmail, token, fetcher, keepAlive } = params;
  let nextPageToken: string;
  if (params.pageToken === undefined) {
    // Taken before listing, so a change made during the listing is seen next time.
    nextPageToken = await getDriveStartPageToken(token, fetcher);
  } else {
    const delta = await driveChangedSince(token, params.pageToken, fetcher);
    if (!delta.changed) return { pageToken: delta.nextPageToken };
    nextPageToken = delta.nextPageToken;
  }

  // Any change re-lists, because a folder rename moves every path below it.
  // Unchanged files keep their stored text, so only changed text is downloaded.
  const { files, truncated } = await listDriveFiles(token, DRIVE_MAX_FILES, fetcher);
  await keepAlive();
  const folderPaths = driveFolderPaths(files);
  const stored = await storedRows(userId, GOOGLE_DRIVE_SOURCE, accountEmail);
  let textBudget = DRIVE_INITIAL_CONTENT_FILES;
  const plans = files.map((file) => {
    const textCapable = driveTextRequest(file) !== null;
    const plan = plannedDriveContent(
      file,
      stored.get(`${accountEmail}:${file.id}`),
      textCapable && textBudget > 0
    );
    if (textCapable) textBudget -= 1;
    return { file, plan };
  });
  const documents = await mapWithConcurrency(plans, CONTENT_CONCURRENCY, async ({ file, plan }) => {
    let content: DriveContentState = { kind: 'none' };
    if (plan === 'fetch') {
      const text = await fetchDriveText(token, file, fetcher);
      if (text !== null) content = { kind: 'fetched', ...text };
      // A first sync can download hundreds of files; keep the lease alive so
      // a later search does not start a second full sync alongside this one.
      await keepAlive();
    } else {
      content = plan;
    }
    return driveFileToDocument({
      file,
      folderPath: folderPaths.get(file.id) ?? 'My Drive',
      accountEmail,
      content,
    });
  });
  const counts = await applyGoogleDocuments({
    userId,
    source: GOOGLE_DRIVE_SOURCE,
    accountEmail,
    documents,
    stored,
  });
  log.info('Drive refreshed', { userId, files: files.length, truncated, ...counts });
  return { pageToken: nextPageToken };
}

async function removeDisconnectedAccounts(
  userId: string,
  source: string,
  connectedEmails: string[]
): Promise<void> {
  await prisma.userDataDocument.deleteMany({
    where: {
      userId,
      source,
      OR: [{ googleAccountEmail: null }, { googleAccountEmail: { notIn: connectedEmails } }],
    },
  });
}

async function syncAccount(params: {
  userId: string;
  source: GoogleWorkspaceSource;
  account: AccountCredential;
  fetcher: Fetcher;
  now: Date;
  pageToken?: string;
  keepAlive: () => Promise<void>;
}): Promise<{ pageToken?: string }> {
  const { userId, source, account, fetcher, now, keepAlive } = params;
  const token = await getValidAccessToken(account);
  if (token === null) throw new Error('No usable Google access token for this account');
  if (source === GOOGLE_CALENDAR_SOURCE) {
    await syncCalendarAccount({
      userId,
      accountEmail: account.email,
      token,
      fetcher,
      now,
      keepAlive,
    });
    return {};
  }
  return syncDriveAccount({
    userId,
    accountEmail: account.email,
    token,
    fetcher,
    pageToken: params.pageToken,
    keepAlive,
  });
}

/**
 * Bring one Google source up to date for a user unless it already is.
 * Never throws: a failed refresh leaves the previous rows searchable.
 */
export async function ensureGoogleSourceFresh(
  userId: string,
  source: GoogleWorkspaceSource,
  options: GoogleSyncOptions = {}
): Promise<GoogleSyncOutcome> {
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  let lease: SyncLease | null = null;
  try {
    const state = await prisma.userDataProviderSyncState.findUnique({
      where: { userId_source: { userId, source } },
    });
    const age = (date: Date | null | undefined): number =>
      date === null || date === undefined ? Infinity : now.getTime() - date.getTime();
    if (options.force !== true) {
      if (age(state?.lastSuccessfulSyncAt) < GOOGLE_SOURCE_FRESHNESS_MS) return 'fresh';
      const failedRecently =
        state?.status === STATUS_FAILED && age(state.lastStartedAt) < GOOGLE_SOURCE_FRESHNESS_MS;
      if (failedRecently) return 'failed';
    }
    lease = await claimSyncLease(userId, source, now, options.leaseRenewMs);
    if (lease === null) return 'in_progress';
    const held = lease;

    const accounts = await connectedAccounts(userId);
    await removeDisconnectedAccounts(
      userId,
      source,
      accounts.map((account) => account.email)
    );
    const previous = asRecord(asRecord(state?.cursor).accounts) as AccountCursors;
    const cursors: AccountCursors = {};
    let failures = 0;
    for (const account of accounts) {
      try {
        cursors[account.email] = await syncAccount({
          userId,
          source,
          account,
          fetcher,
          now,
          pageToken: previous[account.email]?.pageToken,
          keepAlive: () => held.keepAlive(),
        });
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        failures += 1;
        cursors[account.email] = previous[account.email] ?? {};
        log.warn('Google source refresh failed for an account', {
          userId,
          source,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // An account disconnected while its rows were being written must not keep
    // them: the purge only removes rows that existed when it was requested.
    const stillConnected = await connectedAccounts(userId);
    await removeDisconnectedAccounts(
      userId,
      source,
      stillConnected.map((account) => account.email)
    );
    const succeeded = accounts.length > 0 && failures === 0;
    const written = await held.finish({
      status:
        accounts.length === 0 ? STATUS_NOT_CONNECTED : succeeded ? STATUS_CONNECTED : STATUS_FAILED,
      cursor: { accounts: cursors },
      lastError: failures === 0 ? null : `${failures} of ${accounts.length} accounts failed`,
      ...(succeeded ? { lastSuccessfulSyncAt: now } : {}),
    });
    // The refresh that took over owns the state and its outcome.
    if (!written) return 'in_progress';
    if (accounts.length === 0) return 'not_connected';
    return succeeded ? 'refreshed' : 'failed';
  } catch (error) {
    if (error instanceof LeaseLostError) {
      log.info('Google source refresh stopped: another refresh took over', { userId, source });
      return 'in_progress';
    }
    log.error('Google source refresh failed', {
      userId,
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    await lease?.fail('refresh failed');
    return 'failed';
  }
}

/**
 * `ensureGoogleSourceFresh`, but the caller waits at most `waitMs`. A refresh
 * that takes longer (a first Drive sync on a large account) keeps running and
 * the caller is told it is `in_progress`, so a grep answers from the rows
 * already stored instead of outliving its own request timeout.
 */
export async function ensureGoogleSourceFreshWithin(
  userId: string,
  source: GoogleWorkspaceSource,
  waitMs: number,
  options: GoogleSyncOptions = {}
): Promise<GoogleSyncOutcome> {
  const deadline = Date.now() + waitMs;
  const refresh = ensureGoogleSourceFresh(userId, source, options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<GoogleSyncOutcome>((resolve) => {
    timer = setTimeout(() => resolve('in_progress'), waitMs);
  });
  let outcome: GoogleSyncOutcome;
  try {
    outcome = await Promise.race([refresh, waited]);
  } finally {
    clearTimeout(timer);
  }
  if (outcome !== 'in_progress') return outcome;
  // Another caller holds the refresh (searches often arrive in pairs). Its
  // result is this caller's result too, so wait for it rather than answer
  // "still syncing" over rows that are a moment from being current.
  const delays = inFlightPollDelays(deadline - Date.now());
  if (delays.length === 0) return outcome;
  return retryWithBackoff(() => observedOutcome(userId, source), {
    maxRetries: delays.length + 1,
    fixedDelays: delays,
    shouldRetryResult: (observed) => observed === 'in_progress',
    component: 'GoogleWorkspaceSync in-flight refresh',
  });
}

/** The waits that fit in the time a caller has left, shortest first. */
function inFlightPollDelays(remainingMs: number): number[] {
  const delays: number[] = [];
  let spent = 0;
  for (const delay of IN_FLIGHT_POLL_DELAYS_MS) {
    if (spent + delay > remainingMs) break;
    delays.push(delay);
    spent += delay;
  }
  return delays;
}

/** What a refresh run by someone else has come to, read from its state row. */
async function observedOutcome(
  userId: string,
  source: GoogleWorkspaceSource
): Promise<GoogleSyncOutcome> {
  const state = await prisma.userDataProviderSyncState.findUnique({
    where: { userId_source: { userId, source } },
    select: { status: true, lastSuccessfulSyncAt: true },
  });
  if (state === null || state.status === STATUS_SYNCING) return 'in_progress';
  if (state.status === STATUS_NOT_CONNECTED) return 'not_connected';
  if (state.status === STATUS_FAILED) return 'failed';
  const age = Date.now() - (state.lastSuccessfulSyncAt?.getTime() ?? 0);
  return age < GOOGLE_SOURCE_FRESHNESS_MS ? 'fresh' : 'in_progress';
}

/**
 * Fetch text for Drive rows that are name-and-path only, when an agent has
 * addressed them by path. Bounded per call; failures leave the rows unchanged.
 */
export async function ensureDriveText(
  userId: string,
  documentIds: string[],
  options: Pick<GoogleSyncOptions, 'fetcher'> = {}
): Promise<number> {
  const fetcher = options.fetcher ?? fetch;
  if (documentIds.length === 0) return 0;
  const rows = await prisma.userDataDocument.findMany({
    where: { id: { in: documentIds }, userId, source: GOOGLE_DRIVE_SOURCE, deletedAt: null },
    select: { id: true, title: true, url: true, metadata: true, googleAccountEmail: true },
  });
  const pending = rows
    .map((row) => {
      const meta = asRecord(row.metadata);
      const file: GoogleDriveFile = {
        id: String(meta.fileId ?? ''),
        mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : undefined,
        size: typeof meta.size === 'string' ? meta.size : undefined,
      };
      return { row, meta, file };
    })
    .filter(
      ({ meta, file }) =>
        meta.contentIndexed !== true && file.id !== '' && driveTextRequest(file) !== null
    )
    .slice(0, ON_DEMAND_TEXT_LIMIT);
  if (pending.length === 0) return 0;

  const accounts = new Map((await connectedAccounts(userId)).map((a) => [a.email, a]));
  const tokens = new Map<string, Promise<string | null>>();
  const tokenFor = (account: AccountCredential): Promise<string | null> => {
    const known = tokens.get(account.email);
    if (known !== undefined) return known;
    const pendingToken = getValidAccessToken(account);
    tokens.set(account.email, pendingToken);
    return pendingToken;
  };
  const loaded = await mapWithConcurrency(pending, CONTENT_CONCURRENCY, async (item) => {
    const { row, meta, file } = item;
    const account = accounts.get(row.googleAccountEmail ?? '');
    if (account === undefined) return false;
    try {
      const token = await tokenFor(account);
      if (token === null) return false;
      const text = await fetchDriveText(token, file, fetcher);
      if (text === null) return false;
      const contentDigest = textDigest(text.text);
      const metadata: Record<string, unknown> = {
        ...meta,
        contentIndexed: true,
        contentDigest,
        ...(text.truncated ? { contentTruncated: true } : {}),
      };
      await prisma.userDataDocument.update({
        where: { id: row.id },
        data: {
          content: text.text,
          metadata: metadata as Prisma.InputJsonObject,
          contentHash: documentHash({
            title: row.title,
            contentDigest,
            url: row.url ?? undefined,
            metadata,
          }),
        },
      });
      return true;
    } catch (error) {
      log.warn('Drive text fetch failed', {
        userId,
        documentId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  });
  return loaded.filter(Boolean).length;
}

/**
 * `ensureDriveText`, but the caller waits at most `waitMs`. Downloads that take
 * longer finish in the background, so a search answers from what is stored
 * instead of outliving its request timeout.
 */
export async function ensureDriveTextWithin(
  userId: string,
  documentIds: string[],
  waitMs: number,
  options: Pick<GoogleSyncOptions, 'fetcher'> = {}
): Promise<void> {
  const loading = ensureDriveText(userId, documentIds, options).catch((error: unknown) => {
    log.warn('Drive text fetch failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([loading, waited]);
  } finally {
    clearTimeout(timer);
  }
}

/** First sync after an account connects; runs in the background. */
export function startGoogleWorkspaceSync(userId: string): void {
  for (const source of GOOGLE_WORKSPACE_SOURCES) {
    void ensureGoogleSourceFresh(userId, source, { force: true });
  }
}
