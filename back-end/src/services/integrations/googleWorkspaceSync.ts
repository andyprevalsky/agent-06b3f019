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
import { type StoredRow, applyGoogleDocuments, storedRows } from './googleWorkspaceDocumentStore';
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
const ON_DEMAND_TEXT_LIMIT = 10;
/**
 * Rows without text to consider when a search addresses a path. Text is loaded
 * for the newest `ON_DEMAND_TEXT_LIMIT` that can have any, so the pool has to
 * reach past files that never will (PDFs, images) to the documents behind them.
 */
export const ON_DEMAND_TEXT_CANDIDATES = 200;

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
  /** Most Drive files one refresh lists (tests shorten it). */
  driveMaxFiles?: number;
}

interface AccountCredential {
  id: string;
  email: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

type AccountCursors = Record<string, { pageToken?: string }>;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

async function syncCalendarAccount(params: {
  userId: string;
  accountEmail: string;
  token: string;
  fetcher: Fetcher;
  now: Date;
  keepAlive: () => Promise<void>;
}): Promise<void> {
  const events = await listCalendarEvents(
    params.token,
    calendarWindow(params.now),
    params.fetcher,
    params.keepAlive
  );
  const documents = events
    .map((event) => calendarEventToDocument(event, params.accountEmail))
    .filter((doc): doc is GoogleWorkspaceDocument => doc !== null);
  const counts = await applyGoogleDocuments({
    userId: params.userId,
    source: GOOGLE_CALENDAR_SOURCE,
    accountEmail: params.accountEmail,
    documents,
    keepAlive: params.keepAlive,
  });
  log.info('Calendar refreshed', { userId: params.userId, events: documents.length, ...counts });
}

/**
 * How far back a listing cut off at the file cap reached (it is ordered newest
 * first). With no usable timestamp it reached nowhere, so nothing is removed.
 */
function oldestModifiedTime(files: GoogleDriveFile[]): Date {
  let oldest = Infinity;
  for (const file of files) {
    const modified = Date.parse(file.modifiedTime ?? '');
    if (!Number.isNaN(modified) && modified < oldest) oldest = modified;
  }
  return new Date(Number.isFinite(oldest) ? oldest : 8.64e15);
}

/** The text a stored row already holds, and the file version it was read from. */
function storedText(
  row: StoredRow | undefined
): { content: DriveContentState; modifiedTime: string | undefined } | null {
  const meta = asRecord(row?.metadata);
  const digest = meta.contentDigest;
  if (meta.contentIndexed !== true || typeof digest !== 'string') return null;
  return {
    content: { kind: 'stored', digest, truncated: meta.contentTruncated === true },
    modifiedTime: typeof meta.modifiedTime === 'string' ? meta.modifiedTime : undefined,
  };
}

/** What to do about one Drive file's text on this refresh. */
function plannedDriveContent(
  file: GoogleDriveFile,
  row: StoredRow | undefined,
  withinBudget: boolean
): DriveContentState | 'fetch' {
  if (driveTextRequest(file) === null) return { kind: 'none' };
  const held = storedText(row);
  if (held !== null && held.modifiedTime === file.modifiedTime) return held.content;
  return held !== null || withinBudget ? 'fetch' : { kind: 'none' };
}

async function syncDriveAccount(params: {
  userId: string;
  accountEmail: string;
  token: string;
  fetcher: Fetcher;
  pageToken?: string;
  maxFiles: number;
  keepAlive: () => Promise<void>;
}): Promise<{ pageToken?: string }> {
  const { userId, accountEmail, token, fetcher, keepAlive } = params;
  let nextPageToken: string;
  if (params.pageToken === undefined) {
    // Taken before listing, so a change made during the listing is seen next time.
    nextPageToken = await getDriveStartPageToken(token, fetcher);
    await keepAlive();
  } else {
    const delta = await driveChangedSince(token, params.pageToken, fetcher, keepAlive);
    if (!delta.changed) return { pageToken: delta.nextPageToken };
    nextPageToken = delta.nextPageToken;
  }

  // Any change re-lists, because a folder rename moves every path below it.
  // Unchanged files keep their stored text, so only changed text is downloaded.
  const { files, truncated } = await listDriveFiles(token, params.maxFiles, fetcher, keepAlive);
  const folderPaths = driveFolderPaths(files);
  const stored = await storedRows(userId, GOOGLE_DRIVE_SOURCE, accountEmail);
  let textBudget = DRIVE_INITIAL_CONTENT_FILES;
  const plans = files.map((file) => {
    const textCapable = driveTextRequest(file) !== null;
    const row = stored.get(`${accountEmail}:${file.id}`);
    const plan = plannedDriveContent(file, row, textCapable && textBudget > 0);
    if (textCapable) textBudget -= 1;
    return { file, row, plan };
  });
  const documents = await mapWithConcurrency(plans, CONTENT_CONCURRENCY, async (planned) => {
    const { file, row, plan } = planned;
    let content: DriveContentState = { kind: 'none' };
    let version = file;
    if (plan === 'fetch') {
      const text = await fetchDriveText(token, file, fetcher);
      const held = storedText(row);
      if (text === 'unavailable') {
        // Google could not serve this file's text right now. Keep the stored
        // text and the version it was read from, so the next listing fetches
        // it again; the name and path still follow the listing.
        if (held !== null) {
          content = held.content;
          version = { ...file, modifiedTime: held.modifiedTime };
        }
      } else if (text !== null) {
        content = { kind: 'fetched', ...text };
      }
      // A first sync can download hundreds of files; keep the lease alive so
      // a later search does not start a second full sync alongside this one.
      await keepAlive();
    } else {
      content = plan;
    }
    return driveFileToDocument({
      file: version,
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
    listedSince: truncated ? oldestModifiedTime(files) : undefined,
    keepAlive,
  });
  log.info('Drive refreshed', { userId, files: files.length, truncated, ...counts });
  // A row this refresh could not write (it changed under it) still holds the
  // old name and path. Keeping the old cursor makes the next refresh list again.
  return { pageToken: counts.skipped > 0 ? params.pageToken : nextPageToken };
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
  driveMaxFiles: number;
  keepAlive: () => Promise<void>;
}): Promise<{ pageToken?: string }> {
  const { userId, source, account, fetcher, now, keepAlive } = params;
  const token = await getValidAccessToken(account);
  if (token === null) throw new Error('No usable Google access token for this account');
  await keepAlive();
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
    maxFiles: params.driveMaxFiles,
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
          driveMaxFiles: options.driveMaxFiles ?? DRIVE_MAX_FILES,
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
      // A disconnect also ends the lease (its purge deletes the state row), and
      // rows this refresh wrote after the purge ran would otherwise stay behind.
      await connectedAccounts(userId)
        .then((accounts) =>
          removeDisconnectedAccounts(
            userId,
            source,
            accounts.map((account) => account.email)
          )
        )
        .catch(() => undefined);
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
    select: {
      id: true,
      title: true,
      url: true,
      metadata: true,
      contentHash: true,
      googleAccountEmail: true,
    },
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
      if (text === null || text === 'unavailable') return false;
      const contentDigest = textDigest(text.text);
      const metadata: Record<string, unknown> = {
        ...meta,
        contentIndexed: true,
        contentDigest,
        ...(text.truncated ? { contentTruncated: true } : {}),
      };
      // Written only if the row is still the one read above. A refresh that
      // changed it in between owns the newer path and metadata, and this text
      // is fetched again the next time the file is addressed.
      const written = await prisma.userDataDocument.updateMany({
        where: { id: row.id, contentHash: row.contentHash },
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
      return written.count === 1;
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

export { applyGoogleDocuments };
