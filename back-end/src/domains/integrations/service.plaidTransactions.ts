/**
 * Plaid Transactions sync service.
 *
 * System context:
 *   Plaid Link/exchange -> PlaidItem(access token + cursor)
 *     -> /transactions/sync pages -> normalized PlaidTransaction rows
 *     -> /api/data/grep source=transactions -> explore agents
 */

import type { Transaction } from 'plaid';
import { createLogger } from '../../providers/logger';
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

const log = createLogger('PlaidTransactions');

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

export async function syncPlaidItemTransactions(
  itemRowId: string,
  options: {
    webhookAt?: Date;
    syncPage?: typeof syncTransactions;
  } = {}
): Promise<{ added: number; modified: number; removed: number; cursor: string | null }> {
  const item = await findActivePlaidItemsWithTokens().then((items) =>
    items.find((candidate) => candidate.id === itemRowId)
  );
  if (!item) {
    throw new Error(`Plaid item ${itemRowId} is not active or has no access token`);
  }

  await markPlaidItemSyncing(item.id);

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
    }

    await markPlaidItemSyncSucceeded(item.id, cursor, options.webhookAt);
    log.info('Plaid transaction sync complete', {
      userId: item.userId,
      plaidItemId: item.plaidItemId,
      added,
      modified,
      removed,
    });
    return { added, modified, removed, cursor };
  } catch (err) {
    if (isPlaidError(err)) {
      const code = err.response.data.error_code;
      const message = err.response.data.error_message;
      await markPlaidItemSyncFailed(item.id, code, message);
      log.warn('Plaid transaction sync failed with Plaid error', {
        userId: item.userId,
        plaidItemId: item.plaidItemId,
        code,
      });
    } else {
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
    throw err;
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
