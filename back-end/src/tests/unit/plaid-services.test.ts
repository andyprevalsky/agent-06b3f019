#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { RemovedTransaction, Transaction, TransactionsSyncResponse } from 'plaid';
import { PlaidItemStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { encryptPlaidAccessToken } from '../../providers/plaidCredentials';
import {
  countActivePlaidItems,
  deletePlaidTransactionsForUser,
  findActivePlaidItemsForUser,
  findActivePlaidItemsWithAccountsForUser,
  findActivePlaidItemsWithTokens,
  findPlaidItemForUser,
  findPlaidItemWithAccountsForUser,
  getPlaidItemAccountByExternalId,
  markIntegrationDisconnected,
  markPlaidItemDisconnected,
  markPlaidItemSyncFailed,
  markPlaidItemSyncSucceeded,
  persistPlaidItem,
  REDACTED_PLAID_ACCESS_TOKEN,
  upsertPlaidTransaction,
} from '../../domains/integrations/repo.plaid';
import { syncPlaidItemTransactions } from '../../domains/integrations/service.plaidTransactions';
import {
  handlePlaidWebhook,
  PlaidWebhookVerificationError,
  verifyPlaidWebhook,
} from '../../domains/integrations/service.plaidWebhooks';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

async function cleanup(userId: string): Promise<void> {
  // Every sync reports per-Item progress (plan row I5); the row has no FK to User.
  await prisma.integrationSyncProgress.deleteMany({ where: { userId, provider: 'plaid' } });
  await prisma.plaidTransaction.deleteMany({ where: { userId } });
  await prisma.plaidAccount.deleteMany({ where: { userId } });
  await prisma.plaidItem.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { userId, name: 'plaid' } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function seedUser(): Promise<string> {
  const userId = `plaid-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  return userId;
}

function plaidTransaction(overrides: Partial<Transaction>): Transaction {
  return {
    account_id: 'acct-external-1',
    transaction_id: `tx-${randomUUID()}`,
    date: '2026-01-02',
    authorized_date: '2026-01-01',
    datetime: null,
    authorized_datetime: null,
    name: 'Coffee Shop',
    merchant_name: 'Coffee Shop',
    original_description: 'COFFEE SHOP POS',
    amount: 12.34,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    category: ['Food and Drink', 'Coffee'],
    category_id: '13005043',
    personal_finance_category: {
      primary: 'FOOD_AND_DRINK',
      detailed: 'FOOD_AND_DRINK_COFFEE',
      confidence_level: 'HIGH',
    },
    payment_channel: 'in store',
    location: {
      address: '1 Market St',
      city: 'San Francisco',
      region: 'CA',
      postal_code: '94105',
      country: 'US',
      lat: null,
      lon: null,
      store_number: null,
    },
    pending: false,
    pending_transaction_id: null,
    account_owner: null,
    check_number: null,
    transaction_code: null,
    transaction_type: 'place',
    website: null,
    logo_url: null,
    ...overrides,
  } as Transaction;
}

function syncPage(page: Partial<TransactionsSyncResponse>): TransactionsSyncResponse {
  return {
    added: [],
    modified: [],
    removed: [],
    next_cursor: null,
    has_more: false,
    request_id: `req-${randomUUID()}`,
    accounts: [],
    transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
    ...page,
  } as TransactionsSyncResponse;
}

async function seedPlaidItem(userId: string) {
  const accountExternalId = `acct-external-${randomUUID()}`;
  return persistPlaidItem(
    userId,
    {
      plaidItemId: `item-${randomUUID()}`,
      encryptedAccessToken: encryptPlaidAccessToken('access-sandbox-unit'),
      institutionId: 'ins_unit',
      institutionName: 'Unit Test Bank',
    },
    [
      {
        account_id: accountExternalId,
        name: 'Unit Checking',
        official_name: 'Unit Checking Official',
        mask: '4242',
        type: 'depository',
        subtype: 'checking',
      },
    ]
  );
}

async function testRepoLifecycle(): Promise<void> {
  const userId = await seedUser();
  try {
    const item = await seedPlaidItem(userId);
    assert.strictEqual(item.accounts.length, 1);
    const account = item.accounts[0];
    assert.ok(account);

    const listed = await findActivePlaidItemsForUser(userId);
    assert.strictEqual(listed.length, 1);
    assert.strictEqual((await findActivePlaidItemsWithAccountsForUser(userId)).length, 1);
    assert.ok((await findActivePlaidItemsWithTokens()).some((row) => row.id === item.id));
    assert.strictEqual((await findPlaidItemForUser(userId, item.id))?.id, item.id);
    assert.strictEqual(
      (await findPlaidItemWithAccountsForUser(userId, item.id))?.accounts.length,
      1
    );
    assert.strictEqual(
      (await getPlaidItemAccountByExternalId(item.id, account.plaidAccountId))?.plaidAccountId,
      account.plaidAccountId
    );

    await markPlaidItemSyncSucceeded(item.id, 'cursor-1', new Date('2026-01-02T00:00:00Z'));
    await markPlaidItemSyncFailed(item.id, 'ITEM_LOGIN_REQUIRED', 'login required');
    assert.strictEqual(
      (await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } })).status,
      PlaidItemStatus.REQUIRES_REAUTH
    );
    await markPlaidItemSyncFailed(item.id, 'RATE_LIMIT', 'retry later');
    assert.strictEqual(
      (await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } })).status,
      PlaidItemStatus.ERROR
    );

    await markPlaidItemDisconnected(item.id);
    const disconnected = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.strictEqual(disconnected.status, PlaidItemStatus.DISCONNECTED);
    assert.strictEqual(disconnected.encryptedAccessToken, REDACTED_PLAID_ACCESS_TOKEN);

    const integration = await prisma.integration.findFirstOrThrow({
      where: { userId, name: 'plaid' },
    });
    await markIntegrationDisconnected(integration.id);
    assert.strictEqual(await countActivePlaidItems(userId, integration.id), 0);
  } finally {
    await cleanup(userId);
  }
}

async function testTransactionSyncPages(): Promise<void> {
  const userId = await seedUser();
  try {
    const item = await seedPlaidItem(userId);
    const account = item.accounts[0];
    assert.ok(account);
    await upsertPlaidTransaction(userId, item.id, account.id, {
      plaidTransactionId: 'tx-removed-unit',
      plaidAccountExternalId: account.plaidAccountId,
      date: new Date('2026-01-01T00:00:00Z'),
      name: 'Old Charge',
      amount: 3,
      pending: false,
    });

    const pages = [
      syncPage({
        added: [
          plaidTransaction({
            account_id: account.plaidAccountId,
            transaction_id: 'tx-added-unit',
            amount: 7.25,
          }),
          plaidTransaction({ transaction_id: 'tx-unknown-account', account_id: 'missing-account' }),
        ],
        modified: [
          plaidTransaction({
            account_id: account.plaidAccountId,
            transaction_id: 'tx-modified-unit',
            amount: -25,
          }),
        ],
        removed: [{ transaction_id: 'tx-removed-unit' } as RemovedTransaction],
        next_cursor: 'cursor-1',
        has_more: true,
      }),
      syncPage({
        modified: [
          plaidTransaction({
            account_id: account.plaidAccountId,
            transaction_id: 'tx-added-unit',
            name: 'Coffee Shop Updated',
          }),
        ],
        next_cursor: 'cursor-2',
      }),
    ];
    let pageIndex = 0;
    const result = await syncPlaidItemTransactions(item.id, {
      webhookAt: new Date('2026-01-03T00:00:00Z'),
      syncPage: async () => {
        const page = pages[pageIndex];
        pageIndex += 1;
        assert.ok(page);
        return page;
      },
    });

    assert.deepStrictEqual(result, { added: 1, modified: 2, removed: 1, cursor: 'cursor-2' });
    const added = await prisma.plaidTransaction.findUniqueOrThrow({
      where: { plaidTransactionId: 'tx-added-unit' },
    });
    assert.strictEqual(added.name, 'Coffee Shop Updated');
    assert.strictEqual(added.direction, 'OUTFLOW');
    const modified = await prisma.plaidTransaction.findUniqueOrThrow({
      where: { plaidTransactionId: 'tx-modified-unit' },
    });
    assert.strictEqual(modified.direction, 'INFLOW');
    assert.notStrictEqual(
      (
        await prisma.plaidTransaction.findUniqueOrThrow({
          where: { plaidTransactionId: 'tx-removed-unit' },
        })
      ).removedAt,
      null
    );
    assert.strictEqual(
      (await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } })).cursor,
      'cursor-2'
    );

    await deletePlaidTransactionsForUser(userId);
    assert.strictEqual(await prisma.plaidTransaction.count({ where: { userId } }), 0);
  } finally {
    await cleanup(userId);
  }
}

async function testTransactionSyncFailure(): Promise<void> {
  const userId = await seedUser();
  try {
    const item = await seedPlaidItem(userId);
    await assert.rejects(
      () =>
        syncPlaidItemTransactions(item.id, {
          syncPage: async () => {
            throw new Error('unit sync failure');
          },
        }),
      /unit sync failure/
    );
    const failed = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.strictEqual(failed.status, PlaidItemStatus.ERROR);
    assert.strictEqual(failed.errorCode, 'SYNC_FAILED');
  } finally {
    await cleanup(userId);
  }
}

async function testWebhooks(): Promise<void> {
  await assert.rejects(() => verifyPlaidWebhook('{}', undefined), PlaidWebhookVerificationError);
  await assert.rejects(() => verifyPlaidWebhook('{}', 'not-a-jwt'), PlaidWebhookVerificationError);
  assert.deepStrictEqual(await handlePlaidWebhook({ webhook_type: 'ITEM' }), { ok: true });

  const userId = await seedUser();
  try {
    const item = await seedPlaidItem(userId);
    await handlePlaidWebhook({
      webhook_type: 'ITEM',
      webhook_code: 'ERROR',
      item_id: item.plaidItemId,
      error: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'repair me' },
    });
    const updated = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.strictEqual(updated.status, PlaidItemStatus.REQUIRES_REAUTH);

    assert.deepStrictEqual(
      await handlePlaidWebhook({
        webhook_type: 'TRANSACTIONS',
        webhook_code: 'SYNC_UPDATES_AVAILABLE',
        item_id: 'missing-item',
      }),
      { ok: true }
    );
    assert.deepStrictEqual(
      await handlePlaidWebhook({
        webhook_type: 'ITEM',
        webhook_code: 'LOGIN_REPAIRED',
        item_id: 'missing-item',
      }),
      { ok: true }
    );
  } finally {
    await cleanup(userId);
  }
}

async function main(): Promise<void> {
  await test('repo lifecycle', testRepoLifecycle);
  await test('transaction sync pages', testTransactionSyncPages);
  await test('transaction sync failure', testTransactionSyncFailure);
  await test('webhook handling', testWebhooks);
  await prisma.$disconnect();

  if (failures.length > 0) {
    process.stderr.write('\nFailures:\n');
    for (const failure of failures) process.stderr.write(`- ${failure}\n`);
    process.exit(1);
  }

  process.stdout.write(`\n${passed}/4 Plaid service tests passed\n`);
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await prisma.$disconnect();
  process.exit(1);
});
