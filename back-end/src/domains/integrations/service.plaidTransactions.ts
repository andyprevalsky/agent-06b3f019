/**
 * Plaid Transactions sync service.
 *
 * System context:
 *   Plaid Link/exchange -> PlaidItem(access token + cursor)
 *     -> /transactions/sync pages -> normalized PlaidTransaction rows
 *     -> /api/data/grep source=transactions -> explore agents
 *     -> sync progress of the user's `plaid` row (transactions saved; Plaid
 *        reports no up-front total, so the bar is indeterminate until synced)
 */

import type { Transaction } from 'plaid';
import { createLogger } from '../../providers/logger';
import {
  acquireLease,
  holdLease,
  leaseHeldPredicate,
  putEphemeral,
  takeEphemeral,
} from '../../providers/sharedState';
import { isPlaidError, syncTransactions } from '../../providers/plaid';
import { decryptPlaidAccessTokenOrThrow } from '../../providers/plaidCredentials';
import {
  findActivePlaidItemsWithTokens,
  findPlaidItemByPlaidItemId,
  getPlaidItemAccountByExternalId,
  markPlaidItemSyncFailed,
  markPlaidItemSyncing,
  markPlaidItemSyncSucceeded,
  markPlaidTransactionRemoved,
  upsertPlaidTransaction,
  type PlaidTransactionUpsertInput,
} from './repo.plaid';
import { reportProgressBestEffort } from './service.progress';
import type { ProgressWriteInput } from './syncAccountsContract';

const log = createLogger('PlaidTransactions');

/**
 * Best-effort sync progress of the user's one `plaid` Integration row (always
 * accountId ''): transactions saved per /transactions/sync page, total unknown.
 */
function plaidRunProgress(userId: string, itemRowId: string) {
  const runId = `plaid-sync:${itemRowId}:${Date.now()}`;
  const report = (input: Omit<ProgressWriteInput, 'runId'>) =>
    reportProgressBestEffort({
      userId,
      provider: 'plaid',
      accountId: '',
      input: { runId, ...input },
    });
  return {
    start: () => report({ state: 'syncing', unit: 'transactions', done: 0, total: null }),
    saved: (done: number) => report({ state: 'syncing', done }),
    finish: (done: number) => report({ state: 'synced', done }),
    fail: (err: unknown) => report({ state: 'failed', error: syncErrorMessage(err) }),
  };
}

function syncErrorMessage(err: unknown): string {
  if (isPlaidError(err)) return err.response.data.error_message;
  return err instanceof Error ? err.message : String(err);
}

function parsePlaidDate(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLocationSummary(tx: Transaction): string | null {
  const location = tx.location;
  const parts = [
    location.address,
    location.city,
    location.region,
    location.postal_code,
    location.country,
  ].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.length > 0 ? parts.join(', ') : null;
}

function normalizeTransaction(tx: Transaction): PlaidTransactionUpsertInput {
  const date = parsePlaidDate(tx.date);
  if (date === null) {
    throw new Error(`Plaid transaction ${tx.transaction_id} has invalid date '${tx.date}'`);
  }

  return {
    plaidTransactionId: tx.transaction_id,
    plaidAccountExternalId: tx.account_id,
    date,
    authorizedDate: parsePlaidDate(tx.authorized_date),
    datetime: parsePlaidDate(tx.datetime),
    authorizedDatetime: parsePlaidDate(tx.authorized_datetime),
    name: tx.name,
    merchantName: tx.merchant_name ?? null,
    originalDescription: tx.original_description ?? null,
    amount: tx.amount,
    isoCurrencyCode: tx.iso_currency_code ?? null,
    unofficialCurrencyCode: tx.unofficial_currency_code ?? null,
    category: tx.category ?? [],
    categoryId: tx.category_id ?? null,
    personalFinanceCategory: tx.personal_finance_category?.primary ?? null,
    personalFinanceDetailed: tx.personal_finance_category?.detailed ?? null,
    paymentChannel: tx.payment_channel ?? null,
    locationSummary: formatLocationSummary(tx),
    pending: tx.pending,
    pendingTransactionId: tx.pending_transaction_id ?? null,
    accountOwner: tx.account_owner ?? null,
    checkNumber: tx.check_number ?? null,
  };
}

async function applyTransaction(
  userId: string,
  plaidItemRowId: string,
  tx: Transaction
): Promise<boolean> {
  const account = await getPlaidItemAccountByExternalId(plaidItemRowId, tx.account_id);
  if (!account) {
    log.warn('Skipping Plaid transaction for unknown account', {
      userId,
      plaidItemRowId,
      plaidAccountId: tx.account_id,
      plaidTransactionId: tx.transaction_id,
    });
    return false;
  }
  await upsertPlaidTransaction(userId, plaidItemRowId, account.id, normalizeTransaction(tx));
  return true;
}

const PLAID_SYNC_LEASE_NAMESPACE = 'plaid-item-sync';
const PLAID_RESYNC_NAMESPACE = 'plaid-item-resync';
// Renewed while held; a crashed instance's lease expires, so it never wedges the item.
const PLAID_SYNC_LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * Claim exclusive sync of one Plaid item (cron and webhooks can both start one).
 * Returns the claim (a write fence plus its release), or null when another
 * sync owns the item.
 */
export interface PlaidItemSyncClaim {
  /** True only while this claim still owns the item: fences the cursor write. */
  fence: ReturnType<typeof leaseHeldPredicate>;
  release: () => Promise<void>;
}

export async function claimPlaidItemSync(itemRowId: string): Promise<PlaidItemSyncClaim | null> {
  const token = await acquireLease(PLAID_SYNC_LEASE_NAMESPACE, itemRowId, PLAID_SYNC_LEASE_TTL_MS);
  if (token === null) return null;
  // Renewed while the sync runs, so a long first sync never loses the item to
  // a second concurrent sync.
  const lease = holdLease(PLAID_SYNC_LEASE_NAMESPACE, itemRowId, token, PLAID_SYNC_LEASE_TTL_MS);
  return {
    fence: leaseHeldPredicate(PLAID_SYNC_LEASE_NAMESPACE, itemRowId, token),
    release: () => lease.release(),
  };
}

/** Release an item's sync claim, then run once more if a sync was requested meanwhile. */
async function settlePlaidItemSyncClaim(
  item: { id: string; plaidItemId: string },
  releaseClaim: () => Promise<void>
): Promise<void> {
  await releaseClaim().catch((error: unknown) => {
    log.warn('Plaid item sync claim release failed; it expires on its own', {
      plaidItemId: item.plaidItemId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if ((await takeEphemeral(PLAID_RESYNC_NAMESPACE, item.id)) !== undefined) {
    void syncPlaidItemTransactions(item.id).catch(() => undefined);
  }
}

/**
 * The running sync may already be past its last page: ask its holder to go
 * again so a webhook arriving mid-sync is never dropped.
 */
async function requestPlaidResync(item: { id: string; plaidItemId: string }): Promise<void> {
  await putEphemeral(
    PLAID_RESYNC_NAMESPACE,
    item.id,
    { requestedAt: Date.now() },
    PLAID_SYNC_LEASE_TTL_MS
  );
  log.info('Plaid item sync already running; resync requested', { plaidItemId: item.plaidItemId });
}

/** Write a finished sync's cursor unless this sync lost its lease to a newer one. */
async function recordPlaidSyncSuccess(
  item: { id: string; plaidItemId: string },
  cursor: string | null,
  webhookAt: Date | undefined,
  claim: PlaidItemSyncClaim
): Promise<boolean> {
  if (await markPlaidItemSyncSucceeded(item.id, cursor, webhookAt, claim.fence)) return true;
  log.warn('Plaid sync lost its lease; cursor write fenced', { plaidItemId: item.plaidItemId });
  return false;
}

async function recordPlaidSyncFailure(
  item: { id: string; userId: string; plaidItemId: string },
  err: unknown
): Promise<void> {
  if (isPlaidError(err)) {
    const code = err.response.data.error_code;
    const message = err.response.data.error_message;
    await markPlaidItemSyncFailed(item.id, code, message);
    log.warn('Plaid transaction sync failed with Plaid error', {
      userId: item.userId,
      plaidItemId: item.plaidItemId,
      code,
    });
    return;
  }
  await markPlaidItemSyncFailed(
    item.id,
    'SYNC_FAILED',
    err instanceof Error ? err.message : String(err)
  );
  log.error('Plaid transaction sync failed', {
    userId: item.userId,
    plaidItemId: item.plaidItemId,
    error: err instanceof Error ? err.message : String(err),
  });
}

export async function syncPlaidItemTransactions(
  itemRowId: string,
  options: {
    webhookAt?: Date;
    syncPage?: typeof syncTransactions;
  } = {}
): Promise<{
  added: number;
  modified: number;
  removed: number;
  cursor: string | null;
  skipped?: true;
}> {
  const item = await findActivePlaidItemsWithTokens().then((items) =>
    items.find((candidate) => candidate.id === itemRowId)
  );
  if (!item) {
    throw new Error(`Plaid item ${itemRowId} is not active or has no access token`);
  }

  const claim = await claimPlaidItemSync(item.id);
  if (claim === null) {
    await requestPlaidResync(item);
    return { added: 0, modified: 0, removed: 0, cursor: item.cursor ?? null, skipped: true };
  }
  try {
    await markPlaidItemSyncing(item.id);
    const progress = plaidRunProgress(item.userId, item.id);
    await progress.start();

    let cursor: string | null = item.cursor ?? null;
    let added = 0;
    let modified = 0;
    let removed = 0;

    try {
      const accessToken = decryptPlaidAccessTokenOrThrow(item.encryptedAccessToken);
      const syncPage = options.syncPage ?? syncTransactions;
      let hasMore = true;

      while (hasMore) {
        const page = await syncPage(accessToken, cursor);
        for (const tx of page.added) {
          if (await applyTransaction(item.userId, item.id, tx)) added += 1;
        }
        for (const tx of page.modified) {
          if (await applyTransaction(item.userId, item.id, tx)) modified += 1;
        }
        for (const tx of page.removed) {
          await markPlaidTransactionRemoved(tx.transaction_id);
          removed += 1;
        }

        cursor = page.next_cursor || cursor;
        hasMore = page.has_more;
        if (hasMore) await progress.saved(added + modified + removed);
      }

      if (!(await recordPlaidSyncSuccess(item, cursor, options.webhookAt, claim))) {
        return { added, modified, removed, cursor: item.cursor ?? null, skipped: true };
      }
      await progress.finish(added + modified + removed);
      log.info('Plaid transaction sync complete', {
        userId: item.userId,
        plaidItemId: item.plaidItemId,
        added,
        modified,
        removed,
      });
      return { added, modified, removed, cursor };
    } catch (err) {
      await progress.fail(err);
      await recordPlaidSyncFailure(item, err);
      throw err;
    }
  } finally {
    await settlePlaidItemSyncClaim(item, claim.release);
  }
}

export async function syncPlaidTransactionsByPlaidItemId(
  plaidItemId: string,
  options: { webhookAt?: Date } = {}
): Promise<{ ok: true; skipped?: true }> {
  const item = await findPlaidItemByPlaidItemId(plaidItemId);
  if (!item) {
    log.warn('Ignoring Plaid webhook for unknown item', { plaidItemId });
    return { ok: true, skipped: true };
  }
  await syncPlaidItemTransactions(item.id, options);
  return { ok: true };
}

export async function runPlaidTransactionSyncJob(): Promise<void> {
  const items = await findActivePlaidItemsWithTokens();
  for (const item of items) {
    try {
      await syncPlaidItemTransactions(item.id);
    } catch {
      // Per-item errors are already logged and persisted by syncPlaidItemTransactions.
    }
  }
}
