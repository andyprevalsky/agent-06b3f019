/**
 * Settle archived agents that kept a non-terminal status.
 *
 * Before 2026-10-27 the soft delete set only `deletedAt`, so archived agents
 * stayed STARTING_UP/ACTIVE/PAUSED forever (~16k rows in prod). This applies
 * the same FAILED/"Archived by user" status the delete path now writes.
 *
 * Idempotent and bounded: each batch is its own short transaction with
 * lock_timeout/statement_timeout, touches at most `batchSize` rows selected by
 * primary key, and only rows that are archived AND non-terminal.
 */
import { prisma } from './database';
import { ARCHIVED_AGENT_STATUS_MESSAGE } from './agentKill';

const PREDICATE = `"deletedAt" IS NOT NULL AND status IN ('STARTING_UP', 'ACTIVE', 'PAUSED')`;

export interface ArchivedStatusBackfillOptions {
  execute: boolean;
  batchSize?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxBatches?: number;
}

export interface ArchivedStatusBackfillResult {
  pendingBefore: number;
  updated: number;
  batches: number;
}

async function countPending(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*)::bigint AS count FROM "Agent" WHERE ${PREDICATE}`
  );
  return Number(rows[0]?.count ?? 0);
}

export async function backfillArchivedAgentStatus(
  options: ArchivedStatusBackfillOptions
): Promise<ArchivedStatusBackfillResult> {
  const batchSize = options.batchSize ?? 1000;
  const lockTimeoutMs = options.lockTimeoutMs ?? 2000;
  const statementTimeoutMs = options.statementTimeoutMs ?? 15000;
  const maxBatches = options.maxBatches ?? 1000;
  const pendingBefore = await countPending();
  if (!options.execute || pendingBefore === 0) {
    return { pendingBefore, updated: 0, batches: 0 };
  }
  let updated = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const changed = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
        return tx.$executeRawUnsafe(
          `UPDATE "Agent" SET status = 'FAILED', "statusMessage" = $1, "updatedAt" = now()
         WHERE id IN (SELECT id FROM "Agent" WHERE ${PREDICATE} ORDER BY id LIMIT $2)
           AND ${PREDICATE}`,
          ARCHIVED_AGENT_STATUS_MESSAGE,
          batchSize
        );
      },
      { timeout: statementTimeoutMs + 5000 }
    );
    batches += 1;
    updated += changed;
    if (changed < batchSize) break;
  }
  return { pendingBefore, updated, batches };
}
