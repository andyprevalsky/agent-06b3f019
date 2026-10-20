/**
 * Per-Item Plaid sync progress (plan row I5) on the shared I0 progress core.
 *
 *   syncPlaidItemTransactions(item)          IntegrationSyncProgress
 *     start ──────► syncing { done: 0, total: null, unit: 'transactions' }
 *     each page with more to come ─► syncing { done: saved so far }  (≤ 1 write/s)
 *     last page ──► synced  { done: N, total: N }
 *        └ Plaid still preparing history ─► syncing { phase: 'waiting_for_plaid', done: N }
 *     error ──────► needs_reconnect (ITEM_LOGIN_REQUIRED) | failed
 *   ITEM webhook (update mode needed) ─► needs_reconnect
 *
 * accountId = PlaidItem.id, so every run of one Item (exchange, cron, webhook,
 * update mode) writes the same row; each run has a fresh runId, which retires
 * the previous one. Plaid gives no up-front total, so a running sync is
 * indeterminate: `total` stays null until the run knows its count. Right after
 * Link, Plaid answers NOT_READY / INITIAL_UPDATE_COMPLETE while it still pulls
 * history; that run stays open (`waiting_for_plaid`) and the next run (Plaid's
 * SYNC_UPDATES_AVAILABLE webhook or the 5-minute cron) supersedes it, rather
 * than claiming "synced" for data that has not arrived.
 * Progress is best-effort: a failed write is logged and never fails the sync.
 *
 * 10k rule: per Item per page, one progress call (one row lock + one read, and
 * a write at most once per second via the core's coalescing), plus the start and
 * terminal transitions. One row per Item; nothing is shared across Items.
 */

import { randomUUID } from '../../providers/crypto';
import { createLogger } from '../../providers/logger';
import { reportIntegrationProgress } from './service.progress';
import type { ProgressWriteInput, SyncState } from './syncAccountsContract';

const log = createLogger('PlaidSyncProgress');

export const PLAID_PROGRESS_PROVIDER = 'plaid';
export const PLAID_PROGRESS_UNIT = 'transactions';
/** Phase of a run that ended while Plaid was still preparing the Item's history. */
export const PLAID_WAITING_PHASE = 'waiting_for_plaid';
/** progressWriteSchema bound on `error`. */
const MAX_ERROR_LENGTH = 2_000;

type TerminalProblem = Extract<SyncState, 'failed' | 'needs_reconnect'>;
type ProgressBody = Omit<ProgressWriteInput, 'runId' | 'seq'>;

export interface PlaidSyncProgress {
  /** More pages follow; `done` = transactions saved so far in this run. */
  saved(done: number): Promise<void>;
  /** The run finished; its count is now known. */
  finish(done: number): Promise<void>;
  /** The run fetched everything Plaid had, but Plaid is still preparing history. */
  waitingForPlaid(done: number): Promise<void>;
  fail(errorCode: string, message: string): Promise<void>;
}

/** Same rule as the Item status: only a login problem needs the user to reconnect. */
export function plaidErrorSyncState(errorCode: string): TerminalProblem {
  return errorCode === 'ITEM_LOGIN_REQUIRED' ? 'needs_reconnect' : 'failed';
}

function runWriter(userId: string, itemRowId: string, now?: () => Date) {
  const runId = `plaid-sync-${randomUUID()}`;
  let seq = 0;
  return async (body: ProgressBody): Promise<void> => {
    seq += 1;
    try {
      await reportIntegrationProgress({
        userId,
        provider: PLAID_PROGRESS_PROVIDER,
        accountId: itemRowId,
        input: { runId, seq, ...body },
        now: now?.(),
      });
    } catch (error: unknown) {
      log.warn('Plaid sync progress write failed; the sync continues', {
        userId,
        itemRowId,
        runId,
        state: body.state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

const errorText = (message: string) => message.slice(0, MAX_ERROR_LENGTH);

/** Opens a sync run for one Item and reports it as syncing with an unknown total. */
export async function startPlaidSyncProgress(params: {
  userId: string;
  itemRowId: string;
  /** Test seam: the progress clock (the coalescing window). Defaults to now. */
  now?: () => Date;
}): Promise<PlaidSyncProgress> {
  const write = runWriter(params.userId, params.itemRowId, params.now);
  await write({ state: 'syncing', done: 0, total: null, unit: PLAID_PROGRESS_UNIT });
  return {
    saved: (done) => write({ state: 'syncing', done }),
    finish: (done) => write({ state: 'synced', done, total: done }),
    // A phase change resets carried fields, so the unit and unknown total are restated.
    waitingForPlaid: (done) =>
      write({
        state: 'syncing',
        phase: PLAID_WAITING_PHASE,
        done,
        total: null,
        unit: PLAID_PROGRESS_UNIT,
      }),
    fail: (errorCode, message) =>
      write({ state: plaidErrorSyncState(errorCode), error: errorText(message) }),
  };
}

/** An ITEM webhook says the user must go through update mode: one terminal run. */
export async function reportPlaidItemNeedsReconnect(params: {
  userId: string;
  itemRowId: string;
  message: string;
}): Promise<void> {
  const write = runWriter(params.userId, params.itemRowId);
  await write({ state: 'needs_reconnect', error: errorText(params.message) });
}
