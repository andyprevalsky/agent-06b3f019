/**
 * integration-accounts blackbox: Plaid sync progress on the user's one `plaid` row.
 *
 *   fake /transactions/sync pages ─► syncPlaidItemTransactions (test process)
 *        │ between pages: GET /api/integrations (backend) ─► the plaid row's bar
 *        ▼
 *   IntegrationSyncProgress (provider 'plaid', accountId '' = the plaid row)
 *
 * Plaid reports no up-front total, so a running sync is indeterminate
 * (`total: null`, `pct: null`) with `done` = transactions saved so far; it ends
 * `synced` (100%) with its count, or `sync_failed` with Plaid's error. A re-sync
 * is a new run on the same row. The live-sandbox counterpart is plaid.blackbox.ts.
 * Registered by integration-accounts.blackbox.ts.
 */
import { randomUUID } from 'node:crypto';
import type { RemovedTransaction, Transaction, TransactionsSyncResponse } from 'plaid';
import { prisma } from '../../providers/database';
import { encryptPlaidAccessToken } from '../../providers/plaidCredentials';
import { persistPlaidItem } from '../../domains/integrations/repo.plaid';
import { syncPlaidItemTransactions } from '../../domains/integrations/service.plaidTransactions';
import {
  anonymousSession,
  assert,
  defaultAccountOf,
  type Account,
  type Session,
} from './integration-accounts.support';

interface Bank {
  itemId: string;
  plaidItemId: string;
  accountExternalId: string;
}

type PageOrError = TransactionsSyncResponse | Error;

async function connectBank(userId: string, institutionName: string): Promise<Bank> {
  const accountExternalId = `acct-${randomUUID()}`;
  const item = await persistPlaidItem(
    userId,
    {
      plaidItemId: `item-${randomUUID()}`,
      encryptedAccessToken: encryptPlaidAccessToken('access-sandbox-progress'),
      institutionId: 'ins_progress',
      institutionName,
    },
    [{ account_id: accountExternalId, name: `${institutionName} Checking`, type: 'depository' }]
  );
  return { itemId: item.id, plaidItemId: item.plaidItemId, accountExternalId };
}

function tx(bank: Bank, id: string): Transaction {
  return {
    account_id: bank.accountExternalId,
    transaction_id: `${bank.itemId}-${id}`,
    date: '2026-01-02',
    authorized_date: null,
    datetime: null,
    authorized_datetime: null,
    name: `Charge ${id}`,
    merchant_name: null,
    original_description: null,
    amount: 9.5,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    category: null,
    category_id: null,
    payment_channel: 'online',
    location: {
      address: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      lat: null,
      lon: null,
      store_number: null,
    },
    pending: false,
    pending_transaction_id: null,
    account_owner: null,
    check_number: null,
  } as unknown as Transaction;
}

function removed(bank: Bank, id: string): RemovedTransaction {
  return { transaction_id: `${bank.itemId}-${id}` } as RemovedTransaction;
}

function page(fields: Partial<TransactionsSyncResponse>): TransactionsSyncResponse {
  return {
    added: [],
    modified: [],
    removed: [],
    accounts: [],
    next_cursor: `cursor-${randomUUID()}`,
    has_more: false,
    request_id: `req-${randomUUID()}`,
    transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
    ...fields,
  } as TransactionsSyncResponse;
}

/** A Plaid SDK error as `isPlaidError` sees it (error body under `response.data`). */
function plaidError(code: string, message: string): Error {
  return Object.assign(new Error(`Plaid ${code}`), {
    response: {
      status: 400,
      data: { error_code: code, error_message: message, error_type: 'ITEM_ERROR' },
    },
  });
}

/** Fake /transactions/sync: serves `pages` in order, calling `beforePage` first. */
function fakePlaid(
  pages: PageOrError[],
  beforePage: (index: number, cursor: string | null) => Promise<void> = async () => {}
) {
  let index = 0;
  return async (_accessToken: string, cursor?: string | null) => {
    const current = index;
    index += 1;
    await beforePage(current, cursor ?? null);
    const next = pages[current];
    assert(next !== undefined, `fake Plaid has no page ${current}`);
    if (next instanceof Error) throw next;
    return next;
  };
}

/** Past the backend's 1 s coalescing window, so each page's write is stored. */
const pastCoalescingWindow = () => new Promise((resolve) => setTimeout(resolve, 1_100));

async function plaidBar(session: Session): Promise<Account> {
  const account = await defaultAccountOf(session.token, 'plaid');
  assert(account !== undefined, 'the plaid row is listed as one account');
  return account;
}

function progressRow(userId: string) {
  return prisma.integrationSyncProgress.findUniqueOrThrow({
    where: { userId_provider_accountId: { userId, provider: 'plaid', accountId: '' } },
  });
}

async function withPlaidUser(fn: (session: Session) => Promise<void>): Promise<void> {
  const session = await anonymousSession();
  try {
    await fn(session);
  } finally {
    const where = { userId: session.userId };
    await prisma.integrationSyncProgress.deleteMany({ where });
    await prisma.plaidTransaction.deleteMany({ where });
    await prisma.plaidAccount.deleteMany({ where });
    await prisma.plaidItem.deleteMany({ where });
    await prisma.integration.deleteMany({ where });
  }
}

function expectSyncing(account: Account, done: number, label: string): void {
  assert(account.state === 'syncing', `${label}: syncing, got ${account.state}`);
  assert(account.progress?.done === done, `${label}: done ${done}, got ${account.progress?.done}`);
  assert(
    account.progress.total === null && account.progress.pct === null,
    `${label}: Plaid gives no total, so total and pct stay null: ${JSON.stringify(account.progress)}`
  );
  assert(account.progress.unit === 'transactions', `${label}: unit transactions`);
}

async function indeterminateThenFinalCount(): Promise<void> {
  await withPlaidUser(async (s) => {
    const bank = await connectBank(s.userId, 'Chase');
    const seen: Account[] = [];
    const result = await syncPlaidItemTransactions(bank.itemId, {
      syncPage: fakePlaid(
        [
          page({ added: [tx(bank, 'a1'), tx(bank, 'a2'), tx(bank, 'a3')], has_more: true }),
          page({
            added: [tx(bank, 'a4'), tx(bank, 'a5')],
            modified: [tx(bank, 'a1')],
            has_more: true,
          }),
          page({ removed: [removed(bank, 'a2')] }),
        ],
        async () => {
          seen.push(await plaidBar(s));
          await pastCoalescingWindow();
        }
      ),
    });
    assert(
      result.added === 5 && result.modified === 1 && result.removed === 1,
      `sync result ${JSON.stringify(result)}`
    );
    [0, 3, 6].forEach((done, i) => expectSyncing(seen[i], done, `before page ${i + 1}`));
    const finished = await plaidBar(s);
    assert(finished.state === 'synced', `synced, got ${finished.state}`);
    assert(
      finished.progress?.pct === 100 && finished.progress.done === 7,
      `synced at 100% with 7 transactions saved, got ${JSON.stringify(finished.progress)}`
    );
    assert(finished.progress.total === null, 'the total was never guessed');
    assert(finished.lastSyncAt !== null, 'lastSyncAt set');
  });
}

async function plaidErrorEndsFailed(): Promise<void> {
  await withPlaidUser(async (s) => {
    const bank = await connectBank(s.userId, 'Chase');
    let threw = false;
    try {
      await syncPlaidItemTransactions(bank.itemId, {
        syncPage: fakePlaid([plaidError('INSTITUTION_DOWN', 'the institution is not responding')]),
      });
    } catch {
      threw = true;
    }
    assert(threw, 'the sync still fails exactly as before');
    const account = await plaidBar(s);
    assert(account.state === 'sync_failed', `a failed run reads sync_failed, got ${account.state}`);
    assert(account.lastError === 'the institution is not responding', 'Plaid error shown');
    const row = await progressRow(s.userId);
    assert(row.state === 'failed' && row.finishedAt !== null, 'the run is terminal');
  });
}

async function resyncIsANewRunOnTheSameRow(): Promise<void> {
  await withPlaidUser(async (s) => {
    const bank = await connectBank(s.userId, 'Chase');
    const once = (id: string) =>
      syncPlaidItemTransactions(bank.itemId, {
        syncPage: fakePlaid([page({ added: [tx(bank, id)] })]),
      });
    await once('first');
    const first = await progressRow(s.userId);
    await once('second');
    const second = await progressRow(s.userId);
    assert(second.id === first.id, 'one progress row for the plaid Integration row');
    assert(second.runId !== first.runId, 'a re-sync is a new run');
    assert(second.retiredRunIds.includes(first.runId), 'the previous run is retired');
    assert(
      second.state === 'synced' && second.done === 1n,
      'the new run counts only its own saves'
    );
    const rows = await prisma.integrationSyncProgress.count({
      where: { userId: s.userId, provider: 'plaid' },
    });
    assert(rows === 1, `exactly one plaid progress row, got ${rows}`);
  });
}

export function cases(): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'Plaid: indeterminate while pages arrive, synced with the saved count',
      fn: indeterminateThenFinalCount,
    },
    { name: 'Plaid: a Plaid error ends the run sync_failed', fn: plaidErrorEndsFailed },
    { name: 'Plaid: a re-sync is a new run on the same row', fn: resyncIsANewRunOnTheSameRow },
  ];
}
