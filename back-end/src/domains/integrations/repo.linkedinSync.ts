/**
 * LinkedIn account rows, run moves and account-scoped message deletion.
 *
 * Every read-judge-write of a LinkedIn row runs under the provider name lock
 * (the same key every multi-account Integration writer takes), so phase
 * reports, uploads and run moves of one user's LinkedIn accounts serialize;
 * other users and providers never share it.
 */

import { MessageChannel, type Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { lockIntegrationName } from './repo.accounts';
import { lockAccountProgress } from './repo.progress';
import { LEGACY_MESSAGE_PREFIX, LINKEDIN_PROVIDER, messageIdPrefix } from './linkedinSyncContract';

export type Tx = Prisma.TransactionClient;

const ROW_SELECT = {
  id: true,
  accountId: true,
  status: true,
  config: true,
  lastSuccessfulSyncAt: true,
} as const;

export type LinkedInRow = Prisma.IntegrationGetPayload<{ select: typeof ROW_SELECT }>;

/** The export agent's lifecycle fields, scoped to its owner. */
export async function findOwnedAgentLifecycle(agentId: string, userId: string) {
  return prisma.agent.findFirst({
    where: { id: agentId, userId },
    select: { status: true, deletedAt: true, temporalWorkflowId: true, createdAt: true },
  });
}

/** Run `fn` holding the user's LinkedIn name lock (released at commit). */
export async function withLinkedInLock<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runTransactionWithRetry(async (tx) => {
    await lockIntegrationName(tx, userId, LINKEDIN_PROVIDER);
    return fn(tx);
  });
}

export async function findAccountRow(
  tx: Tx,
  userId: string,
  accountId: string
): Promise<LinkedInRow | null> {
  return tx.integration.findUnique({
    where: { userId_name_accountId: { userId, name: LINKEDIN_PROVIDER, accountId } },
    select: ROW_SELECT,
  });
}

/** Every LinkedIn account row of one user (bounded by that user's accounts). */
export async function listAccountRows(tx: Tx, userId: string): Promise<LinkedInRow[]> {
  return tx.integration.findMany({
    where: { userId, name: LINKEDIN_PROVIDER },
    select: ROW_SELECT,
    orderBy: { createdAt: 'asc' },
  });
}

export async function createAccountRow(
  tx: Tx,
  userId: string,
  accountId: string,
  data: Omit<Prisma.IntegrationUncheckedCreateInput, 'userId' | 'name' | 'accountId' | 'type'>
): Promise<LinkedInRow> {
  return tx.integration.create({
    data: { userId, name: LINKEDIN_PROVIDER, accountId, type: 'DATA_SOURCE', ...data },
    select: ROW_SELECT,
  });
}

export async function updateAccountRow(
  tx: Tx,
  id: string,
  data: Prisma.IntegrationUncheckedUpdateInput
): Promise<LinkedInRow> {
  return tx.integration.update({ where: { id }, data, select: ROW_SELECT });
}

export async function deleteAccountRowTx(tx: Tx, id: string): Promise<void> {
  await tx.integration.delete({ where: { id } });
}

/**
 * Move a run's progress row from one account to another (both locked). The
 * target's previous progress row, if any, is replaced; its last successful
 * sync time and run id carry over so the account keeps its history.
 */
export async function moveRunProgress(
  tx: Tx,
  userId: string,
  from: string,
  to: string,
  runId: string
): Promise<void> {
  const key = (accountId: string) => ({ userId, provider: LINKEDIN_PROVIDER, accountId });
  for (const accountId of [from, to].sort()) await lockAccountProgress(tx, key(accountId));
  const source = await tx.integrationSyncProgress.findUnique({
    where: { userId_provider_accountId: key(from) },
  });
  if (source === null || source.runId !== runId) return;
  const target = await tx.integrationSyncProgress.findUnique({
    where: { userId_provider_accountId: key(to) },
  });
  if (target !== null) await tx.integrationSyncProgress.delete({ where: { id: target.id } });
  await tx.integrationSyncProgress.update({
    where: { id: source.id },
    data: {
      accountId: to,
      lastSyncedAt: target?.lastSyncedAt ?? source.lastSyncedAt,
      retiredRunIds:
        target === null
          ? source.retiredRunIds
          : [target.runId, ...target.retiredRunIds].slice(0, 8),
    },
  });
}

/** One account's LinkedIn messages: prefixed ids, or every unprefixed id for the default. */
function accountMessageFilter(userId: string, accountId: string): Prisma.MessageRecordWhereInput {
  const base = { channel: MessageChannel.LINKEDIN, person: { userId } };
  if (accountId === '') {
    return {
      ...base,
      OR: [{ externalId: null }, { NOT: { externalId: { startsWith: LEGACY_MESSAGE_PREFIX } } }],
    };
  }
  return { ...base, externalId: { startsWith: messageIdPrefix(accountId) } };
}

const DELETE_BATCH = 5_000;

/** Delete every message this account imported, in bounded batches. Returns rows removed. */
export async function deleteAccountMessages(userId: string, accountId: string): Promise<number> {
  const where = accountMessageFilter(userId, accountId);
  let removed = 0;
  for (;;) {
    const batch = await prisma.messageRecord.findMany({
      where,
      select: { id: true },
      take: DELETE_BATCH,
    });
    if (batch.length === 0) return removed;
    const { count } = await prisma.messageRecord.deleteMany({
      where: { id: { in: batch.map((m) => m.id) } },
    });
    removed += count;
    if (batch.length < DELETE_BATCH) return removed;
  }
}

/** Remove the account's row (its profile, positions and sync history live in its config). */
export async function deleteAccountRow(userId: string, accountId: string): Promise<boolean> {
  const { count } = await prisma.integration.deleteMany({
    where: { userId, name: LINKEDIN_PROVIDER, accountId },
  });
  return count > 0;
}
