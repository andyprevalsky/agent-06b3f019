/**
 * IntegrationSyncProgress persistence: one row per (userId, provider, accountId).
 *
 * Every write runs inside a per-account advisory lock so the read → judge →
 * write sequence is serialized for that account only (10k rule: no lock or row
 * is shared across accounts or users).
 */

import type { IntegrationSyncProgress, Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';

export type ProgressRow = IntegrationSyncProgress;
export type Tx = Prisma.TransactionClient;

export interface ProgressKey {
  userId: string;
  provider: string;
  accountId: string;
}

/**
 * Columns a judged write sets. `updatedAt` is the judging clock, written
 * explicitly so the coalescing window and the delta cursor use one time source.
 */
export type ProgressRowData = Omit<
  Prisma.IntegrationSyncProgressUncheckedCreateInput,
  'id' | 'userId' | 'provider' | 'accountId' | 'createdAt'
> & { updatedAt: Date };

const keyOf = (key: ProgressKey) => ({
  userId_provider_accountId: {
    userId: key.userId,
    provider: key.provider,
    accountId: key.accountId,
  },
});

/** Take the account's progress lock inside `tx` (released at commit). */
export async function lockAccountProgress(tx: Tx, key: ProgressKey): Promise<void> {
  await tx.$queryRaw`
    WITH acquired AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${key.userId}:${key.provider}:${key.accountId}`}, 907311)
      )
    )
    SELECT 1::int AS locked FROM acquired
  `;
}

/** Run `fn` holding the account's progress lock (released at commit). */
export async function withAccountProgressLock<T>(
  key: ProgressKey,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return runTransactionWithRetry(async (tx) => {
    await lockAccountProgress(tx, key);
    return fn(tx);
  });
}

export async function findProgress(tx: Tx, key: ProgressKey): Promise<ProgressRow | null> {
  return tx.integrationSyncProgress.findUnique({ where: keyOf(key) });
}

export async function countProgressRowsForUser(tx: Tx, userId: string): Promise<number> {
  return tx.integrationSyncProgress.count({ where: { userId } });
}

export async function createProgress(
  tx: Tx,
  key: ProgressKey,
  data: ProgressRowData
): Promise<ProgressRow> {
  return tx.integrationSyncProgress.create({ data: { ...key, ...data } });
}

export async function updateProgress(tx: Tx, id: string, data: ProgressRowData) {
  return tx.integrationSyncProgress.update({ where: { id }, data });
}

/** All progress rows of one user: one indexed range read, bounded by accounts. */
export async function listProgressForUser(userId: string): Promise<ProgressRow[]> {
  return prisma.integrationSyncProgress.findMany({
    where: { userId },
    orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function deleteProgress(key: ProgressKey): Promise<number> {
  const { count } = await prisma.integrationSyncProgress.deleteMany({ where: key });
  return count;
}

export async function deleteProviderProgress(userId: string, provider: string): Promise<number> {
  const { count } = await prisma.integrationSyncProgress.deleteMany({
    where: { userId, provider },
  });
  return count;
}

/**
 * True when anything an account chip is derived from changed after `since`.
 * Tiny indexed existence probes; no row bodies are read. Rows named in
 * `settledWhileSyncing` derive their state at read time from other tables
 * (an export agent's lifecycle), so while one is SYNCING it always counts as changed.
 */
export async function accountSourcesChangedSince(
  userId: string,
  since: Date,
  settledWhileSyncing: string[]
): Promise<boolean> {
  const after = { gt: since };
  const probes = await Promise.all([
    prisma.integration.findFirst({
      where: { userId, name: { in: settledWhileSyncing }, status: 'SYNCING' },
      select: { id: true },
    }),
    prisma.integrationSyncProgress.findFirst({
      where: { userId, updatedAt: after },
      select: { id: true },
    }),
    prisma.integration.findFirst({ where: { userId, updatedAt: after }, select: { id: true } }),
    prisma.emailIntegrationCredential.findFirst({
      where: { userId, updatedAt: after },
      select: { id: true },
    }),
    prisma.plaidItem.findFirst({ where: { userId, updatedAt: after }, select: { id: true } }),
  ]);
  return probes.some((probe) => probe !== null);
}
