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
  type PlaidAccount,
  type PlaidItem,
} from '@prisma/client';
import { prisma } from '../../providers/database';
import { PLAID_DEFAULT_PRODUCTS } from '../../providers/plaid';

export type PlaidItemWithAccounts = PlaidItem & { accounts: PlaidAccount[] };
export { PlaidItemStatus };

type AccountUpsertInput = {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  verification_status?: string | null;
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
    where: { userId_name: { userId, name: 'plaid' } },
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
  return prisma.$transaction(async (tx) => {
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

export async function findPlaidItemForUser(
  userId: string,
  itemRowId: string
): Promise<PlaidItem | null> {
  return prisma.plaidItem.findFirst({
    where: { id: itemRowId, userId },
  });
}

export async function markPlaidItemDisconnected(itemRowId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    prisma.plaidAccount.updateMany({
      where: { plaidItemId: itemRowId, disconnectedAt: null },
      data: { disconnectedAt: now },
    }),
    prisma.plaidItem.update({
      where: { id: itemRowId },
      data: { status: PlaidItemStatus.DISCONNECTED, disconnectedAt: now },
    }),
  ]);
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
