/**
 * Multi-account Integration rows: one row per (userId, name, accountId).
 *
 * Writers that know the provider-side account (device id, profile, address)
 * call `upsertIntegrationAccount` with it, so connecting a second account
 * creates a second row instead of overwriting the first. `accountId = ''` is
 * the legacy single-account row every pre-multi-account writer produced.
 */

import {
  type Prisma,
  type IntegrationType,
  IntegrationStatus,
  PlaidItemStatus,
} from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';

type Tx = Prisma.TransactionClient;

export interface UpsertIntegrationAccountParams {
  userId: string;
  name: string;
  /** Provider-side account id; must be non-empty (use upsertIntegration for legacy rows). */
  accountId: string;
  type: IntegrationType;
  /**
   * `claim`: when this account has no row yet but the legacy `''` row exists,
   * adopt it (renaming it and its progress) — use when the legacy row provably
   * belongs to this account. `separate`: always keep the legacy row apart.
   */
  legacy: 'claim' | 'separate';
  accountEmail?: string | null;
  status?: IntegrationStatus;
  isActive?: boolean;
  /** Replaces the stored config when provided; omitted keeps it. */
  config?: Prisma.InputJsonValue;
  lastSyncAt?: Date;
  lastSuccessfulSyncAt?: Date;
  failureReason?: string | null;
}

export async function findIntegrationAccount(userId: string, name: string, accountId: string) {
  return prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name, accountId } },
  });
}

async function lockIntegrationName(tx: Tx, userId: string, name: string): Promise<void> {
  // Same key as repo.upsertIntegrationRaw so every multi-account writer of a
  // provider is serialized with the compute credential writers.
  await tx.$queryRaw`
    WITH acquired AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${name}`}, 682451))
    )
    SELECT 1::int AS locked FROM acquired
  `;
}

async function adoptLegacyProgress(tx: Tx, userId: string, name: string, accountId: string) {
  const legacy = { userId, provider: name, accountId: '' };
  const target = await tx.integrationSyncProgress.findUnique({
    where: { userId_provider_accountId: { userId, provider: name, accountId } },
    select: { id: true },
  });
  if (target === null) {
    await tx.integrationSyncProgress.updateMany({ where: legacy, data: { accountId } });
  } else {
    await tx.integrationSyncProgress.deleteMany({ where: legacy });
  }
}

export async function upsertIntegrationAccount(params: UpsertIntegrationAccountParams) {
  const accountId = params.accountId.trim();
  if (accountId === '') throw new Error('upsertIntegrationAccount requires a real accountId');
  const data = {
    type: params.type,
    ...(params.accountEmail !== undefined && { accountEmail: params.accountEmail }),
    ...(params.status !== undefined && { status: params.status }),
    ...(params.isActive !== undefined && { isActive: params.isActive }),
    ...(params.config !== undefined && { config: params.config }),
    ...(params.lastSyncAt !== undefined && { lastSyncAt: params.lastSyncAt }),
    ...(params.lastSuccessfulSyncAt !== undefined && {
      lastSuccessfulSyncAt: params.lastSuccessfulSyncAt,
    }),
    ...(params.failureReason !== undefined && { failureReason: params.failureReason }),
  };
  return runTransactionWithRetry(async (tx) => {
    await lockIntegrationName(tx, params.userId, params.name);
    const where = (id: string) => ({
      userId_name_accountId: { userId: params.userId, name: params.name, accountId: id },
    });
    const exact = await tx.integration.findUnique({ where: where(accountId) });
    if (exact !== null) return tx.integration.update({ where: { id: exact.id }, data });

    const legacy =
      params.legacy === 'claim' ? await tx.integration.findUnique({ where: where('') }) : null;
    if (legacy !== null) {
      await adoptLegacyProgress(tx, params.userId, params.name, accountId);
      return tx.integration.update({ where: { id: legacy.id }, data: { ...data, accountId } });
    }
    return tx.integration.create({
      data: {
        userId: params.userId,
        name: params.name,
        accountId,
        status: IntegrationStatus.NOT_CONNECTED,
        config: {},
        ...data,
      },
    });
  });
}

/** Row fields an account chip is derived from (no secrets, no config). */
export const ACCOUNT_ROW_SELECT = {
  id: true,
  name: true,
  accountId: true,
  accountEmail: true,
  status: true,
  lastSyncAt: true,
  lastSuccessfulSyncAt: true,
  failureReason: true,
} as const;

export type AccountRowSource = Prisma.IntegrationGetPayload<{ select: typeof ACCOUNT_ROW_SELECT }>;

export interface EmailCredentialSource {
  email: string | null;
  state: string;
  lastErrorReason: string | null;
}

/**
 * One synced browser profile: a (browserSource, browserProfile) pair that has
 * at least one stored cookie. `browserProfile === ''` is the legacy
 * pre-profile-detection snapshot (the `default` account).
 */
export interface CookieProfileSource {
  browserSource: string;
  browserProfile: string;
  cookieCount: number;
  lastSyncAt: Date | null;
}

/**
 * Every synced browser profile of one user, one indexed group-by over the
 * `Cookie` table (bounded by browser profiles, not cookie count; served by the
 * `@@index([userId, browserSource, browserProfile])`). 10k rule: O(profiles),
 * never O(agents) or O(cookies), and never fanned in across users.
 */
export async function listCookieProfileSources(userId: string): Promise<CookieProfileSource[]> {
  const groups = await prisma.cookie.groupBy({
    by: ['browserSource', 'browserProfile'],
    where: { userId },
    _count: { _all: true },
    _max: { syncedAt: true },
  });
  return groups.map((group) => ({
    browserSource: group.browserSource,
    browserProfile: group.browserProfile,
    cookieCount: group._count._all,
    lastSyncAt: group._max.syncedAt ?? null,
  }));
}

export interface PlaidItemSource {
  id: string;
  integrationId: string;
  institutionName: string | null;
  status: PlaidItemStatus;
  /** Null until the first transactions sync completes (read only to derive "syncing"). */
  cursor: string | null;
  lastSyncAt: Date | null;
  errorMessage: string | null;
}

/** Connected (not disconnected) Plaid items: the per-item accounts of `plaid`. */
export async function listActivePlaidItemSources(userId: string): Promise<PlaidItemSource[]> {
  return prisma.plaidItem.findMany({
    where: { userId, status: { not: PlaidItemStatus.DISCONNECTED } },
    select: {
      id: true,
      integrationId: true,
      institutionName: true,
      status: true,
      cursor: true,
      lastSyncAt: true,
      errorMessage: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

/** Light read of every row + email address an account list is derived from. */
export async function listAccountRowSources(userId: string) {
  return prisma.integration.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      ...ACCOUNT_ROW_SELECT,
      emailCredentials: {
        where: {
          email: { not: null },
          OR: [{ accessToken: { not: null } }, { state: 'needs_reconnect' }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        // Scopes are read only to derive health (withGoogleScopeHealth strips them).
        select: { email: true, state: true, lastErrorReason: true, scopes: true },
      },
    },
  });
}
