/* eslint-disable max-lines */
/**
 * Repository for Plaid-related rows.
 *
 * All Prisma access for the Plaid flow lives here so the service layer stays
 * DB-agnostic and the structural Prisma-boundary invariant holds.
 */

import {
  IntegrationStatus,
  IntegrationType,
  PlaidItemStatus,
  Prisma,
  TransactionDirection,
  type PlaidAccount,
  type PlaidItem,
} from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { PLAID_DEFAULT_PRODUCTS } from '../../providers/plaid';

export type PlaidItemWithAccounts = PlaidItem & { accounts: PlaidAccount[] };
export { PlaidItemStatus };
export const REDACTED_PLAID_ACCESS_TOKEN = 'REDACTED_AFTER_DISCONNECT';

export interface PlaidAccountTransactionStats {
  plaidItemId: string;
  plaidAccountId: string;
  transactionCount: number;
  postedTransactionCount: number;
  pendingTransactionCount: number;
  removedTransactionCount: number;
  minDate: Date | null;
  maxDate: Date | null;
}

type AccountUpsertInput = {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  verification_status?: string | null;
};

export type PlaidTransactionUpsertInput = {
  plaidTransactionId: string;
  plaidAccountExternalId: string;
  date: Date;
  authorizedDate?: Date | null;
  datetime?: Date | null;
  authorizedDatetime?: Date | null;
  name: string;
  merchantName?: string | null;
  originalDescription?: string | null;
  amount: number;
  isoCurrencyCode?: string | null;
  unofficialCurrencyCode?: string | null;
  category?: string[];
  categoryId?: string | null;
  personalFinanceCategory?: string | null;
  personalFinanceDetailed?: string | null;
  paymentChannel?: string | null;
  locationSummary?: string | null;
  pending: boolean;
  pendingTransactionId?: string | null;
  accountOwner?: string | null;
  checkNumber?: string | null;
};

type PlaidTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface PersistPlaidItemInput {
  plaidItemId: string;
  encryptedAccessToken: string;
  institutionId?: string;
  institutionName?: string;
}

async function upsertIntegrationRow(tx: PlaidTx, userId: string): Promise<{ id: string }> {
  return tx.integration.upsert({
    where: { userId_name_accountId: { userId, name: 'plaid', accountId: '' } },
    create: {
      userId,
      type: IntegrationType.DATA_SOURCE,
      name: 'plaid',
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      lastSyncAt: new Date(),
    },
    update: {
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      lastSyncAt: new Date(),
      failureReason: null,
    },
  });
}

async function upsertPlaidItemRow(
  tx: PlaidTx,
  args: PersistPlaidItemInput & { userId: string; integrationId: string }
): Promise<{ id: string }> {
  const { userId, integrationId, plaidItemId, encryptedAccessToken } = args;
  return tx.plaidItem.upsert({
    where: { plaidItemId },
    create: {
      userId,
      integrationId,
      plaidItemId,
      plaidInstitutionId: args.institutionId ?? null,
      institutionName: args.institutionName ?? null,
      encryptedAccessToken,
      status: PlaidItemStatus.ACTIVE,
      products: PLAID_DEFAULT_PRODUCTS,
      lastSyncAt: new Date(),
    },
    update: {
      encryptedAccessToken,
      plaidInstitutionId: args.institutionId ?? null,
      institutionName: args.institutionName ?? null,
      status: PlaidItemStatus.ACTIVE,
      disconnectedAt: null,
      errorCode: null,
      errorMessage: null,
      lastSyncAt: new Date(),
    },
  });
}

async function upsertPlaidAccounts(
  tx: PlaidTx,
  userId: string,
  plaidItemRowId: string,
  accounts: AccountUpsertInput[]
): Promise<void> {
  await Promise.all(
    accounts.map((acct) =>
      tx.plaidAccount.upsert({
        where: { plaidAccountId: acct.account_id },
        create: {
          userId,
          plaidItemId: plaidItemRowId,
          plaidAccountId: acct.account_id,
          name: acct.name,
          officialName: acct.official_name ?? null,
          mask: acct.mask ?? null,
          type: acct.type,
          subtype: acct.subtype ?? null,
          verificationStatus: acct.verification_status ?? null,
        },
        update: {
          name: acct.name,
          officialName: acct.official_name ?? null,
          mask: acct.mask ?? null,
          type: acct.type,
          subtype: acct.subtype ?? null,
          verificationStatus: acct.verification_status ?? null,
          disconnectedAt: null,
        },
      })
    )
  );
}

export async function persistPlaidItem(
  userId: string,
  input: PersistPlaidItemInput,
  accounts: AccountUpsertInput[]
): Promise<PlaidItemWithAccounts> {
  return runTransactionWithRetry(
    async (tx) => {
      const integration = await upsertIntegrationRow(tx, userId);
      const plaidItem = await upsertPlaidItemRow(tx, {
        userId,
        integrationId: integration.id,
        ...input,
      });
      await upsertPlaidAccounts(tx, userId, plaidItem.id, accounts);
      const updated = await tx.plaidItem.findUnique({
        where: { id: plaidItem.id },
        include: { accounts: true },
      });
      if (!updated) throw new Error('PlaidItem disappeared mid-transaction');
      return updated;
    },
    // Coverage + multi-worker blackbox load routinely exceeds the 10s default;
    // an expired commit surfaces as 500 on /exchange-public-token.
    { maxWait: 10_000, timeout: 30_000 }
  );
}

export async function findActivePlaidItemsWithTokens(): Promise<PlaidItem[]> {
  return prisma.plaidItem.findMany({
    where: {
      status: {
        in: [PlaidItemStatus.ACTIVE, PlaidItemStatus.ERROR, PlaidItemStatus.REQUIRES_REAUTH],
      },
      encryptedAccessToken: { not: REDACTED_PLAID_ACCESS_TOKEN },
    },
    orderBy: { lastSyncAt: 'asc' },
  });
}

export async function findActivePlaidItemsForUser(
  userId: string
): Promise<PlaidItemWithAccounts[]> {
  return prisma.plaidItem.findMany({
    where: { userId, status: { not: PlaidItemStatus.DISCONNECTED } },
    include: { accounts: { where: { disconnectedAt: null } } },
    orderBy: { createdAt: 'asc' },
  });
}

export async function findActivePlaidItemsWithAccountsForUser(
  userId: string
): Promise<PlaidItemWithAccounts[]> {
  return prisma.plaidItem.findMany({
    where: { userId, status: { not: PlaidItemStatus.DISCONNECTED } },
    include: { accounts: { where: { disconnectedAt: null } } },
    orderBy: { createdAt: 'asc' },
  });
}

function statsKey(plaidItemId: string, plaidAccountId: string): string {
  return `${plaidItemId}:${plaidAccountId}`;
}

function ensureStats(
  stats: Map<string, PlaidAccountTransactionStats>,
  plaidItemId: string,
  plaidAccountId: string
): PlaidAccountTransactionStats {
  const key = statsKey(plaidItemId, plaidAccountId);
  const existing = stats.get(key);
  if (existing !== undefined) return existing;
  const created: PlaidAccountTransactionStats = {
    plaidItemId,
    plaidAccountId,
    transactionCount: 0,
    postedTransactionCount: 0,
    pendingTransactionCount: 0,
    removedTransactionCount: 0,
    minDate: null,
    maxDate: null,
  };
  stats.set(key, created);
  return created;
}

export async function getPlaidAccountTransactionStatsForItems(
  userId: string,
  plaidItemIds: string[]
): Promise<PlaidAccountTransactionStats[]> {
  if (plaidItemIds.length === 0) return [];

  const [activeRows, pendingRows, removedRows] = await Promise.all([
    prisma.plaidTransaction.groupBy({
      by: ['plaidItemId', 'plaidAccountId'],
      where: { userId, plaidItemId: { in: plaidItemIds }, removedAt: null },
      _count: { id: true },
      _min: { date: true },
      _max: { date: true },
    }),
    prisma.plaidTransaction.groupBy({
      by: ['plaidItemId', 'plaidAccountId', 'pending'],
      where: { userId, plaidItemId: { in: plaidItemIds }, removedAt: null },
      _count: { id: true },
    }),
    prisma.plaidTransaction.groupBy({
      by: ['plaidItemId', 'plaidAccountId'],
      where: { userId, plaidItemId: { in: plaidItemIds }, removedAt: { not: null } },
      _count: { id: true },
    }),
  ]);

  const stats = new Map<string, PlaidAccountTransactionStats>();

  for (const row of activeRows) {
    const stat = ensureStats(stats, row.plaidItemId, row.plaidAccountId);
    stat.transactionCount = row._count.id;
    stat.minDate = row._min.date;
    stat.maxDate = row._max.date;
  }

  for (const row of pendingRows) {
    const stat = ensureStats(stats, row.plaidItemId, row.plaidAccountId);
    if (row.pending) {
      stat.pendingTransactionCount = row._count.id;
    } else {
      stat.postedTransactionCount = row._count.id;
    }
  }

  for (const row of removedRows) {
    const stat = ensureStats(stats, row.plaidItemId, row.plaidAccountId);
    stat.removedTransactionCount = row._count.id;
  }

  return Array.from(stats.values());
}

export async function findPlaidItemForUser(
  userId: string,
  itemRowId: string
): Promise<PlaidItem | null> {
  return prisma.plaidItem.findFirst({
    where: { id: itemRowId, userId },
  });
}

export async function findPlaidItemWithAccountsForUser(
  userId: string,
  itemRowId: string
): Promise<PlaidItemWithAccounts | null> {
  return prisma.plaidItem.findFirst({
    where: { id: itemRowId, userId },
    include: { accounts: true },
  });
}

export async function findPlaidItemByPlaidItemId(plaidItemId: string): Promise<PlaidItem | null> {
  return prisma.plaidItem.findUnique({ where: { plaidItemId } });
}

export async function getPlaidItemAccountByExternalId(
  plaidItemRowId: string,
  plaidAccountExternalId: string
): Promise<PlaidAccount | null> {
  return prisma.plaidAccount.findFirst({
    where: { plaidItemId: plaidItemRowId, plaidAccountId: plaidAccountExternalId },
  });
}

export async function markPlaidItemDisconnected(itemRowId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    prisma.plaidTransaction.deleteMany({
      where: { plaidItemId: itemRowId },
    }),
    prisma.plaidAccount.updateMany({
      where: { plaidItemId: itemRowId, disconnectedAt: null },
      data: { disconnectedAt: now },
    }),
    prisma.plaidItem.update({
      where: { id: itemRowId },
      data: {
        status: PlaidItemStatus.DISCONNECTED,
        disconnectedAt: now,
        encryptedAccessToken: REDACTED_PLAID_ACCESS_TOKEN,
      },
    }),
  ]);
}

export async function deletePlaidTransactionsForUser(userId: string): Promise<void> {
  await prisma.plaidTransaction.deleteMany({ where: { userId } });
}

export async function markPlaidItemSyncing(itemRowId: string): Promise<void> {
  await prisma.plaidItem.update({
    where: { id: itemRowId },
    data: { lastSyncAt: new Date(), errorCode: null, errorMessage: null },
  });
}

/**
 * Record a finished sync. With `fence`, the cursor is written only while that
 * sync still holds the item's lease (one statement), so a sync that lost its
 * lease cannot overwrite a newer holder's cursor. Returns false when fenced out.
 */
export async function markPlaidItemSyncSucceeded(
  itemRowId: string,
  cursor: string | null,
  lastWebhookAt?: Date,
  fence?: Prisma.Sql
): Promise<boolean> {
  if (fence !== undefined) {
    const updated = await prisma.$executeRaw`
      UPDATE "PlaidItem"
      SET cursor = ${cursor}, status = 'ACTIVE'::"PlaidItemStatus", "lastSyncAt" = now(),
          "lastWebhookAt" = COALESCE(${lastWebhookAt ?? null}::timestamp, "lastWebhookAt"),
          "errorCode" = NULL, "errorMessage" = NULL, "updatedAt" = now()
      WHERE id = ${itemRowId} AND ${fence}
    `;
    return updated === 1;
  }
  await prisma.plaidItem.update({
    where: { id: itemRowId },
    data: {
      cursor,
      status: PlaidItemStatus.ACTIVE,
      lastSyncAt: new Date(),
      ...(lastWebhookAt ? { lastWebhookAt } : {}),
      errorCode: null,
      errorMessage: null,
    },
  });
  return true;
}

export async function markPlaidItemSyncFailed(
  itemRowId: string,
  errorCode: string,
  errorMessage: string
): Promise<void> {
  await prisma.plaidItem.update({
    where: { id: itemRowId },
    data: {
      status:
        errorCode === 'ITEM_LOGIN_REQUIRED'
          ? PlaidItemStatus.REQUIRES_REAUTH
          : PlaidItemStatus.ERROR,
      lastSyncAt: new Date(),
      errorCode,
      errorMessage,
    },
  });
}

export async function upsertPlaidTransaction(
  userId: string,
  plaidItemRowId: string,
  plaidAccountRowId: string,
  input: PlaidTransactionUpsertInput
): Promise<void> {
  const amount = new Prisma.Decimal(input.amount);
  const absoluteAmount = new Prisma.Decimal(Math.abs(input.amount));
  const direction = input.amount >= 0 ? TransactionDirection.OUTFLOW : TransactionDirection.INFLOW;

  await prisma.plaidTransaction.upsert({
    where: { plaidTransactionId: input.plaidTransactionId },
    create: {
      userId,
      plaidItemId: plaidItemRowId,
      plaidAccountId: plaidAccountRowId,
      plaidTransactionId: input.plaidTransactionId,
      plaidAccountExternalId: input.plaidAccountExternalId,
      date: input.date,
      authorizedDate: input.authorizedDate ?? null,
      datetime: input.datetime ?? null,
      authorizedDatetime: input.authorizedDatetime ?? null,
      name: input.name,
      merchantName: input.merchantName ?? null,
      originalDescription: input.originalDescription ?? null,
      amount,
      absoluteAmount,
      direction,
      isoCurrencyCode: input.isoCurrencyCode ?? null,
      unofficialCurrencyCode: input.unofficialCurrencyCode ?? null,
      category: input.category ?? [],
      categoryId: input.categoryId ?? null,
      personalFinanceCategory: input.personalFinanceCategory ?? null,
      personalFinanceDetailed: input.personalFinanceDetailed ?? null,
      paymentChannel: input.paymentChannel ?? null,
      locationSummary: input.locationSummary ?? null,
      pending: input.pending,
      pendingTransactionId: input.pendingTransactionId ?? null,
      accountOwner: input.accountOwner ?? null,
      checkNumber: input.checkNumber ?? null,
      removedAt: null,
    },
    update: {
      plaidAccountId: plaidAccountRowId,
      plaidAccountExternalId: input.plaidAccountExternalId,
      date: input.date,
      authorizedDate: input.authorizedDate ?? null,
      datetime: input.datetime ?? null,
      authorizedDatetime: input.authorizedDatetime ?? null,
      name: input.name,
      merchantName: input.merchantName ?? null,
      originalDescription: input.originalDescription ?? null,
      amount,
      absoluteAmount,
      direction,
      isoCurrencyCode: input.isoCurrencyCode ?? null,
      unofficialCurrencyCode: input.unofficialCurrencyCode ?? null,
      category: input.category ?? [],
      categoryId: input.categoryId ?? null,
      personalFinanceCategory: input.personalFinanceCategory ?? null,
      personalFinanceDetailed: input.personalFinanceDetailed ?? null,
      paymentChannel: input.paymentChannel ?? null,
      locationSummary: input.locationSummary ?? null,
      pending: input.pending,
      pendingTransactionId: input.pendingTransactionId ?? null,
      accountOwner: input.accountOwner ?? null,
      checkNumber: input.checkNumber ?? null,
      removedAt: null,
    },
  });
}

export async function markPlaidTransactionRemoved(
  plaidTransactionId: string,
  removedAt = new Date()
): Promise<void> {
  await prisma.plaidTransaction.updateMany({
    where: { plaidTransactionId, removedAt: null },
    data: { removedAt },
  });
}

export async function countActivePlaidItems(
  userId: string,
  integrationId: string
): Promise<number> {
  return prisma.plaidItem.count({
    where: {
      userId,
      integrationId,
      status: { not: PlaidItemStatus.DISCONNECTED },
    },
  });
}

export async function markIntegrationDisconnected(integrationId: string): Promise<void> {
  await prisma.integration.update({
    where: { id: integrationId },
    data: { status: IntegrationStatus.NOT_CONNECTED, isActive: false },
  });
}
