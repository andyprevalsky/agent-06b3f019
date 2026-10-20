/**
 * Pure derivation of the sync-progress account of each Integration row.
 *
 *   Integration row ──► health (status + Google credential state) ─┐
 *                                                                  ├─► ONE IntegrationAccount per row
 *   IntegrationSyncProgress (same name + accountId) ───────────────┘
 *   progress with no row yet (a first sync before its row write) ──► that provider's one account
 *
 * State precedence:
 *   1. the row needs the user: EXPIRED row, or a Google credential that needs
 *      reconnecting (`needs_reconnect`) — the red dot, whatever a run says;
 *   2. a live run (`syncing`, written within PROGRESS_STALE_AFTER_MS) or the
 *      finished run of a connected row — the bar;
 *   3. otherwise the row's own status (CONNECTED synced, SYNCING syncing,
 *      SYNC_FAILED sync_failed, NOT_CONNECTED idle), with no bar.
 * A disconnected (NOT_CONNECTED) row never shows a finished run's bar, and a
 * run whose writer vanished mid-sync falls back to the row (no stuck bar).
 */

import type { ProgressRow } from './repo.progress';
import { derivedRowLabel } from './service.accountLabels';
import { asSyncState, iso, progressOf } from './service.progressSnapshot';
import {
  PROGRESS_STALE_AFTER_MS,
  TERMINAL_SYNC_STATES,
  toWireAccountId,
  type AccountState,
  type AccountsByProvider,
  type IntegrationAccount,
  type SyncState,
} from './syncAccountsContract';

interface EmailCredentialSource {
  email: string | null;
  state: string;
  lastErrorReason: string | null;
}

/** Fields of an Integration row the account view reads (full or light rows fit). */
export interface AccountViewRow {
  name: string;
  accountId: string;
  accountEmail: string | null;
  status: string;
  lastSyncAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  failureReason: string | null;
  emailCredentials?: EmailCredentialSource[];
}

const ROW_STATUS_STATE: Record<string, AccountState> = {
  CONNECTED: 'synced',
  SYNCING: 'syncing',
  SYNC_FAILED: 'sync_failed',
  EXPIRED: 'EXPIRED',
  NOT_CONNECTED: 'idle',
};

const RUN_STATE: Record<SyncState, AccountState> = {
  idle: 'idle',
  syncing: 'syncing',
  synced: 'synced',
  failed: 'sync_failed',
  needs_reconnect: 'needs_reconnect',
};

const isTerminal = (state: SyncState) => TERMINAL_SYNC_STATES.includes(state);

const keyOf = (provider: string, accountId: string) => `${provider}\u0000${accountId}`;

function rowHealth(row: AccountViewRow): { state: AccountState; lastError: string | null } {
  const reconnect = (row.emailCredentials ?? []).find((c) => c.state === 'needs_reconnect');
  if (reconnect !== undefined) return { state: 'needs_reconnect', lastError: reconnect.lastErrorReason };
  const state = ROW_STATUS_STATE[row.status] ?? 'idle';
  const failed = state === 'sync_failed' || state === 'EXPIRED';
  return { state, lastError: failed ? row.failureReason : null };
}

function connectedEmails(row: AccountViewRow): string[] {
  return (row.emailCredentials ?? [])
    .map((credential) => credential.email)
    .filter((email): email is string => email !== null && email !== '');
}

/** A run still syncing whose writer has not written for too long lost its writer. */
function isLiveOrFinished(progress: ProgressRow, now: Date): boolean {
  const state = asSyncState(progress.state);
  if (isTerminal(state)) return true;
  return now.getTime() - progress.updatedAt.getTime() < PROGRESS_STALE_AFTER_MS;
}

function usableRun(
  row: AccountViewRow,
  progress: ProgressRow | null,
  now: Date
): ProgressRow | null {
  if (progress === null || !isLiveOrFinished(progress, now)) return null;
  const finished = isTerminal(asSyncState(progress.state));
  return finished && row.status === 'NOT_CONNECTED' ? null : progress;
}

export function accountOfRow(
  row: AccountViewRow,
  progress: ProgressRow | null,
  now: Date
): IntegrationAccount {
  const health = rowHealth(row);
  const run = usableRun(row, progress, now);
  const runState = run === null ? null : RUN_STATE[asSyncState(run.state)];
  const needsUser = health.state === 'needs_reconnect' || health.state === 'EXPIRED';
  const state = needsUser ? health.state : (runState ?? health.state);
  const rowLastSync = row.lastSuccessfulSyncAt ?? row.lastSyncAt;
  return {
    provider: row.name,
    accountId: toWireAccountId(row.accountId),
    label: row.accountEmail ?? derivedRowLabel(row.name, connectedEmails(row)),
    state,
    progress: run === null ? null : progressOf(run),
    lastSyncAt: iso(run?.lastSyncedAt ?? rowLastSync),
    lastError: needsUser || run === null ? health.lastError : run.lastError,
  };
}

/** A first sync that reported progress before its Integration row was written. */
function accountOfRowlessRun(progress: ProgressRow, now: Date): IntegrationAccount | null {
  const state = asSyncState(progress.state);
  if (isTerminal(state) || !isLiveOrFinished(progress, now)) return null;
  return {
    provider: progress.provider,
    accountId: toWireAccountId(progress.accountId),
    label: derivedRowLabel(progress.provider, []),
    state: RUN_STATE[state],
    progress: progressOf(progress),
    lastSyncAt: iso(progress.lastSyncedAt),
    lastError: progress.lastError,
  };
}

/**
 * Every Integration row's account, grouped by provider (row name). A progress
 * row with no Integration row is listed only while its run is live.
 */
export function buildAccountsView(input: {
  rows: AccountViewRow[];
  progress: ProgressRow[];
  now: Date;
}): AccountsByProvider {
  const progressByKey = new Map(input.progress.map((p) => [keyOf(p.provider, p.accountId), p]));
  const accountsByProvider: AccountsByProvider = {};
  const push = (account: IntegrationAccount) => {
    (accountsByProvider[account.provider] ??= []).push(account);
  };
  for (const row of input.rows) {
    const key = keyOf(row.name, row.accountId);
    push(accountOfRow(row, progressByKey.get(key) ?? null, input.now));
    progressByKey.delete(key);
  }
  for (const progress of progressByKey.values()) {
    const account = accountOfRowlessRun(progress, input.now);
    if (account !== null) push(account);
  }
  return accountsByProvider;
}
