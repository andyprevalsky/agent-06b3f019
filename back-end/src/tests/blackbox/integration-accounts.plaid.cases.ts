/**
 * integration-accounts blackbox: per-item Plaid sync progress (plan row I5).
 *
 *   fake /transactions/sync pages ─► syncPlaidItemTransactions (test process)
 *        │ between pages: GET /api/integrations (backend) ─► the item's chip
 *        ▼
 *   IntegrationSyncProgress (provider 'plaid', accountId = PlaidItem.id)
 *
 * Plaid reports no up-front total, so a running sync is indeterminate
 * (`total: null`) with `done` = transactions saved so far; it ends `synced` with
 * its final counts. Items progress independently, ITEM_LOGIN_REQUIRED makes only
 * its item `needs_reconnect`, and a webhook re-sync reuses the item's account.
 * The live-sandbox counterpart lives in plaid.blackbox.ts.
 * Registered by integration-accounts.blackbox.ts.
 */
import { randomUUID } from 'node:crypto';
import type { RemovedTransaction, Transaction, TransactionsSyncResponse } from 'plaid';
import { prisma } from '../../providers/database';
import { encryptPlaidAccessToken } from '../../providers/plaidCredentials';
import { persistPlaidItem } from '../../domains/integrations/repo.plaid';
import {
  syncPlaidItemTransactions,
  syncPlaidTransactionsByPlaidItemId,
} from '../../domains/integrations/service.plaidTransactions';
import { handlePlaidWebhook } from '../../domains/integrations/service.plaidWebhooks';
import {
  accountsOf,
  anonymousSession,
  assert,
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

/** A clock that moves past the 1 s coalescing window on every read. */
function steppingClock(stepMs = 1_500): () => Date {
  let at = Date.now();
  return () => {
    at += stepMs;
    return new Date(at);
  };
}

async function chip(session: Session, itemId: string): Promise<Account> {
  const account = (await accountsOf(session.token, 'plaid')).find((x) => x.accountId === itemId);
  assert(account !== undefined, `Plaid item ${itemId} is listed as an account`);
  return account;
}

function progressRow(userId: string, itemId: string) {
  return prisma.integrationSyncProgress.findUniqueOrThrow({
    where: { userId_provider_accountId: { userId, provider: 'plaid', accountId: itemId } },
  });
}

async function syncOnce(bank: Bank, count: number): Promise<void> {
  const added = Array.from({ length: count }, (_, i) => tx(bank, `seed-${i}`));
  await syncPlaidItemTransactions(bank.itemId, {
    now: steppingClock(),
    syncPage: fakePlaid([page({ added })]),
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
  assert(account.progress.done === done, `${label}: done ${done}, got ${account.progress.done}`);
  assert(
    account.progress.total === null && account.progress.pct === null,
    `${label}: Plaid gives no total, so total and pct stay null: ${JSON.stringify(account.progress)}`
  );
  assert(account.progress.unit === 'transactions', `${label}: unit transactions`);
}

function expectSynced(account: Account, count: number, label: string): void {
  assert(account.state === 'synced', `${label}: synced, got ${account.state}`);
  assert(
    account.progress.done === count && account.progress.total === count,
    `${label}: final counts ${count}/${count}, got ${JSON.stringify(account.progress)}`
  );
  assert(account.progress.pct === 100, `${label}: synced reads 100%`);
  assert(account.lastSyncAt !== null, `${label}: lastSyncAt set`);
}

async function indeterminateThenFinalCounts(): Promise<void> {
  await withPlaidUser(async (s) => {
    const bank = await connectBank(s.userId, 'Chase');
    const seen: Account[] = [];
    const result = await syncPlaidItemTransactions(bank.itemId, {
      now: steppingClock(),
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
          seen.push(await chip(s, bank.itemId));
        }
      ),
    });
    assert(
      result.added === 5 && result.modified === 1 && result.removed === 1,
      `sync result ${JSON.stringify(result)}`
    );
    [0, 3, 6].forEach((done, i) => expectSyncing(seen[i], done, `before page ${i + 1}`));
    const finished = await chip(s, bank.itemId);
    expectSynced(finished, 7, 'after the last page');
    assert(finished.label === 'Chase', 'the institution labels the account');
  });
}

const updateStatus = (status: string) =>
  status as TransactionsSyncResponse['transactions_update_status'];

async function waitingForPlaidStaysOpen(): Promise<void> {
  await withPlaidUser(async (s) => {
    const bank = await connectBank(s.userId, 'Chase');
    const run = (fields: Partial<TransactionsSyncResponse>) =>
      syncPlaidItemTransactions(bank.itemId, {
        now: steppingClock(),
        syncPage: fakePlaid([page(fields)]),
      });
    const expectWaiting = async (done: number, label: string) => {
      const account = await chip(s, bank.itemId);
      expectSyncing(account, done, label);
      assert(
        account.progress.phase === 'waiting_for_plaid',
        `${label}: phase waiting_for_plaid, got ${account.progress.phase}`
      );
      const row = await progressRow(s.userId, bank.itemId);
      assert(row.finishedAt === null, `${label}: the run is not reported finished`);
    };
    await run({ next_cursor: '', transactions_update_status: updateStatus('NOT_READY') });
    await expectWaiting(0, 'Plaid NOT_READY right after Link');
    await run({
      added: [tx(bank, 'recent-1')],
      transactions_update_status: updateStatus('INITIAL_UPDATE_COMPLETE'),
    });
    await expectWaiting(1, 'recent days ready, history still coming');
    await run({ added: [tx(bank, 'old-1'), tx(bank, 'old-2')] });
    const done = await chip(s, bank.itemId);
    expectSynced(done, 2, 'history complete');
    assert(done.progress.phase === null, 'a finished run carries no waiting phase');
  });
}

async function burstCoalesces(): Promise<void> {
  await withPlaidUser(async (s) => {
    const bank = await connectBank(s.userId, 'Burst Bank');
    const frozen = new Date();
    const midRun: Array<{ done: bigint | null; seq: number }> = [];
    const pages = Array.from({ length: 5 }, (_, i) =>
      page({ added: [tx(bank, `b${i}`)], has_more: i < 4 })
    );
    await syncPlaidItemTransactions(bank.itemId, {
      now: () => frozen,
      syncPage: fakePlaid(pages, async (index) => {
        if (index === 0) return;
        const row = await progressRow(s.userId, bank.itemId);
        midRun.push({ done: row.done, seq: row.seq });
      }),
    });
    assert(midRun.length === 4, `four mid-run observations, got ${midRun.length}`);
    assert(
      midRun.every((row) => row.done === 0n && row.seq === 1),
      `pages inside 1 s of the start write are coalesced, not written: ${JSON.stringify(
        midRun.map((row) => ({ done: String(row.done), seq: row.seq }))
      )}`
    );
    expectSynced(await chip(s, bank.itemId), 5, 'the terminal write is never coalesced');
  });
}

async function itemsProgressIndependently(): Promise<void> {
  await withPlaidUser(async (s) => {
    const chase = await connectBank(s.userId, 'Chase');
    const amex = await connectBank(s.userId, 'Amex');
    let during: { chase: Account; amex: Account } | null = null;
    await syncPlaidItemTransactions(chase.itemId, {
      now: steppingClock(),
      syncPage: fakePlaid(
        [
          page({ added: [tx(chase, 'c1'), tx(chase, 'c2'), tx(chase, 'c3')], has_more: true }),
          page({ added: [tx(chase, 'c4')] }),
        ],
        async (index) => {
          if (index !== 1) return;
          await syncOnce(amex, 2);
          during = { chase: await chip(s, chase.itemId), amex: await chip(s, amex.itemId) };
        }
      ),
    });
    const mid = during as { chase: Account; amex: Account } | null;
    assert(mid !== null, 'observed both items while Chase was mid-sync');
    expectSyncing(mid.chase, 3, 'Chase mid-sync');
    expectSynced(mid.amex, 2, 'Amex finished while Chase ran');
    expectSynced(await chip(s, chase.itemId), 4, 'Chase after its last page');
    const amexAfter = await chip(s, amex.itemId);
    expectSynced(amexAfter, 2, 'Amex after Chase finished');
    assert(
      amexAfter.progress.updatedAt === mid.amex.progress.updatedAt,
      "Chase's writes never touched Amex's row"
    );
    const rows = await prisma.integrationSyncProgress.findMany({
      where: { userId: s.userId, provider: 'plaid' },
    });
    assert(
      rows.length === 2 && new Set(rows.map((r) => r.accountId)).size === 2,
      `one progress row per item, got ${rows.map((r) => r.accountId).join(',')}`
    );
  });
}

async function loginRequiredOnlyAffectsItsItem(): Promise<void> {
  await withPlaidUser(async (s) => {
    const chase = await connectBank(s.userId, 'Chase');
    const amex = await connectBank(s.userId, 'Amex');
    await syncOnce(chase, 1);
    await syncOnce(amex, 1);
    let rejected: unknown = null;
    await syncPlaidItemTransactions(amex.itemId, {
      now: steppingClock(),
      syncPage: fakePlaid([
        page({ added: [tx(amex, 'late-1')], has_more: true }),
        plaidError('ITEM_LOGIN_REQUIRED', 'the login details of this item have changed'),
      ]),
    }).catch((error: unknown) => {
      rejected = error;
    });
    assert(rejected !== null, 'the Plaid error still fails the sync');
    const amexChip = await chip(s, amex.itemId);
    assert(amexChip.state === 'needs_reconnect', `Amex needs_reconnect, got ${amexChip.state}`);
    assert(
      amexChip.lastError === 'the login details of this item have changed',
      `reconnect reason shown, got ${amexChip.lastError}`
    );
    assert(amexChip.progress.done === 1, 'what was saved before the error is still reported');
    const amexRow = await progressRow(s.userId, amex.itemId);
    assert(
      amexRow.state === 'needs_reconnect',
      `the writer recorded needs_reconnect: ${amexRow.state}`
    );
    expectSynced(await chip(s, chase.itemId), 1, 'Chase is unaffected');

    await syncPlaidItemTransactions(amex.itemId, {
      now: steppingClock(),
      syncPage: fakePlaid([page({ added: [tx(amex, 'repaired-1')] })]),
    });
    expectSynced(await chip(s, amex.itemId), 1, 'a repaired sync supersedes needs_reconnect');

    await syncPlaidItemTransactions(chase.itemId, {
      now: steppingClock(),
      syncPage: fakePlaid([plaidError('INSTITUTION_DOWN', 'the institution is not responding')]),
    }).catch(() => undefined);
    const chaseChip = await chip(s, chase.itemId);
    assert(chaseChip.state === 'failed', `any other Plaid error is failed, got ${chaseChip.state}`);
    assert(chaseChip.lastError === 'the institution is not responding', 'failure reason shown');
    expectSynced(await chip(s, amex.itemId), 1, 'Amex is unaffected by the Chase failure');
  });
}

async function webhookResyncReusesAccount(): Promise<void> {
  await withPlaidUser(async (s) => {
    const bank = await connectBank(s.userId, 'Chase');
    await syncPlaidItemTransactions(bank.itemId, {
      now: steppingClock(),
      syncPage: fakePlaid([page({ added: [tx(bank, 'w1'), tx(bank, 'w2')], next_cursor: 'c-0' })]),
    });
    const first = await progressRow(s.userId, bank.itemId);
    const cursors: Array<string | null> = [];
    await syncPlaidTransactionsByPlaidItemId(bank.plaidItemId, {
      webhookAt: new Date(),
      now: steppingClock(),
      syncPage: fakePlaid(
        [page({ added: [tx(bank, 'w3')], modified: [tx(bank, 'w1')], next_cursor: 'c-1' })],
        async (_index, cursor) => {
          cursors.push(cursor);
        }
      ),
    });
    assert(
      cursors[0] === 'c-0',
      `the webhook sync continues from the stored cursor: ${cursors[0]}`
    );
    const rows = await prisma.integrationSyncProgress.findMany({
      where: { userId: s.userId, provider: 'plaid' },
    });
    assert(rows.length === 1 && rows[0].accountId === bank.itemId, 'still one progress row');
    assert(rows[0].runId !== first.runId, 'the webhook sync is a new run');
    assert(rows[0].retiredRunIds.includes(first.runId), 'the previous run is retired');
    const accounts = await accountsOf(s.token, 'plaid');
    assert(accounts.length === 1, `no duplicate account, got ${accounts.length}`);
    expectSynced(accounts[0], 2, 'the incremental run counts only its own changes');
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: bank.itemId } });
    assert(item.lastWebhookAt !== null && item.cursor === 'c-1', 'the same item advanced');
    const integrations = await prisma.integration.count({
      where: { userId: s.userId, name: 'plaid' },
    });
    assert(integrations === 1, 'one Plaid container row');
  });
}

async function itemWebhooksNeedReconnect(): Promise<void> {
  await withPlaidUser(async (s) => {
    const chase = await connectBank(s.userId, 'Chase');
    const amex = await connectBank(s.userId, 'Amex');
    await syncOnce(chase, 1);
    await syncOnce(amex, 1);
    await handlePlaidWebhook({
      webhook_type: 'ITEM',
      webhook_code: 'PENDING_EXPIRATION',
      item_id: chase.plaidItemId,
    });
    const chaseChip = await chip(s, chase.itemId);
    assert(
      chaseChip.state === 'needs_reconnect',
      `an update-mode webhook outranks the last synced run, got ${chaseChip.state}`
    );
    assert(chaseChip.lastError === 'Plaid Item requires user update mode', 'reason shown');
    expectSynced(await chip(s, amex.itemId), 1, 'Amex is unaffected by the Chase webhook');
  });
}

export function cases(): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'Plaid sync: indeterminate total while syncing, then synced with final counts',
      fn: indeterminateThenFinalCounts,
    },
    {
      name: 'Plaid sync: while Plaid prepares history the run stays syncing',
      fn: waitingForPlaidStaysOpen,
    },
    { name: 'Plaid sync: page writes inside 1 s coalesce', fn: burstCoalesces },
    { name: 'Plaid sync: two items progress independently', fn: itemsProgressIndependently },
    {
      name: 'Plaid sync: ITEM_LOGIN_REQUIRED makes only its item needs_reconnect',
      fn: loginRequiredOnlyAffectsItsItem,
    },
    {
      name: 'Plaid sync: a webhook re-sync reuses the same account row',
      fn: webhookResyncReusesAccount,
    },
    {
      name: 'Plaid item webhooks: update mode needed reads needs_reconnect',
      fn: itemWebhooksNeedReconnect,
    },
  ];
}
