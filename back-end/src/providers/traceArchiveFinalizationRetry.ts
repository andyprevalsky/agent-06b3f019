import { randomUUID } from 'node:crypto';
import { type Prisma } from '@prisma/client';
import { prisma } from './database';
import { archiveEnabled } from './traceArchive';
import { finalizeAgent } from './traceArchiveLifecycle';

const RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
const LEASE_MS = 10 * 60_000;
export const TRACE_ARCHIVE_DELETION_LEASE_MS = 2 * 60_000;

interface FinalizationObligation {
  rootAgentId: string;
  leaseToken: string;
  attemptCount: number;
}

export interface TraceArchiveDeletionLease {
  rootAgentId: string;
  leaseToken: string;
}

export interface TraceArchiveFinalizationOptions {
  batchSize?: number;
  maxConcurrency?: number;
  rootAgentIds?: string[];
  ignoreGrace?: boolean;
  deadlineAtMs?: number;
}

export interface TraceArchiveFinalizationResult {
  discovered: number;
  finalized: number;
}

/**
 * Persist the root finalization obligation in the same transaction that marks
 * the agent deleted. A retry is therefore never lost between Postgres and R2.
 */
export async function enqueueTraceArchiveFinalization(
  tx: Prisma.TransactionClient,
  rootAgentId: string
): Promise<TraceArchiveDeletionLease> {
  const now = Date.now();
  const leaseToken = randomUUID();
  await tx.traceArchiveFinalization.upsert({
    where: { rootAgentId },
    create: {
      rootAgentId,
      notBefore: new Date(now),
      leaseToken,
      leaseUntil: new Date(now + TRACE_ARCHIVE_DELETION_LEASE_MS),
    },
    update: {
      notBefore: new Date(now),
      leaseToken,
      leaseUntil: new Date(now + TRACE_ARCHIVE_DELETION_LEASE_MS),
      lastError: null,
    },
  });
  return { rootAgentId, leaseToken };
}

/** Keep a live recursive deletion from being mistaken for an abandoned owner. */
export async function heartbeatTraceArchiveDeletion(
  lease: TraceArchiveDeletionLease
): Promise<void> {
  const updated = await prisma.traceArchiveFinalization.updateMany({
    where: lease,
    data: { leaseUntil: new Date(Date.now() + TRACE_ARCHIVE_DELETION_LEASE_MS) },
  });
  if (updated.count !== 1) {
    throw new Error(`Trace archive deletion lease lost for ${lease.rootAgentId}`);
  }
}

/** Make the obligation claimable only after recursive deletion has completed. */
export async function releaseTraceArchiveDeletion(lease: TraceArchiveDeletionLease): Promise<void> {
  const released = await prisma.traceArchiveFinalization.updateMany({
    where: lease,
    data: {
      notBefore: new Date(),
      leaseToken: null,
      leaseUntil: null,
    },
  });
  if (released.count !== 1) {
    throw new Error(`Trace archive deletion lease lost for ${lease.rootAgentId}`);
  }
}

function boundedInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 1_000) {
    throw new Error(`${label} must be an integer between 1 and 1000`);
  }
  return resolved;
}

function assertBeforeDeadline(deadlineAtMs: number | undefined): void {
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    throw new Error('Trace archive finalization retry deadline exceeded');
  }
}

async function candidates(options: TraceArchiveFinalizationOptions, batchSize: number) {
  if (options.rootAgentIds?.length === 0) return [];
  const now = new Date();
  return prisma.traceArchiveFinalization.findMany({
    where: {
      ...(options.rootAgentIds === undefined ? {} : { rootAgentId: { in: options.rootAgentIds } }),
      ...(options.ignoreGrace === true ? {} : { notBefore: { lte: now } }),
      OR: [{ leaseToken: null }, { leaseUntil: { lt: now } }],
    },
    orderBy: [{ notBefore: 'asc' }, { rootAgentId: 'asc' }],
    take: batchSize,
  });
}

async function claim(
  candidate: Awaited<ReturnType<typeof candidates>>[number],
  options: TraceArchiveFinalizationOptions
): Promise<FinalizationObligation | null> {
  const now = new Date();
  const leaseToken = randomUUID();
  const claimed = await prisma.traceArchiveFinalization.updateMany({
    where: {
      rootAgentId: candidate.rootAgentId,
      ...(options.ignoreGrace === true ? {} : { notBefore: { lte: now } }),
      OR: [{ leaseToken: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      leaseToken,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
    },
  });
  return claimed.count === 1
    ? {
        rootAgentId: candidate.rootAgentId,
        leaseToken,
        attemptCount: candidate.attemptCount,
      }
    : null;
}

async function assertDeletedTreeIsTerminal(rootAgentId: string): Promise<void> {
  const seen = new Set<string>();
  let frontier = [rootAgentId];
  while (frontier.length > 0) {
    const agents = await prisma.agent.findMany({
      where: { id: { in: frontier } },
      select: { id: true, deletedAt: true, temporalCleanupPending: true },
    });
    if (agents.length !== frontier.length) {
      throw new Error(`Trace archive deletion tree is incomplete for ${rootAgentId}`);
    }
    for (const agent of agents) {
      seen.add(agent.id);
      if (agent.deletedAt === null) {
        throw new Error(`Trace archive agent ${agent.id} is not deleted`);
      }
      if (agent.temporalCleanupPending) {
        throw new Error(`Trace archive agent ${agent.id} still has Temporal cleanup pending`);
      }
    }
    const children = await prisma.agent.findMany({
      where: { parentAgentId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((child) => child.id).filter((id) => !seen.has(id));
  }
}

async function complete(obligation: FinalizationObligation): Promise<void> {
  const deleted = await prisma.traceArchiveFinalization.deleteMany({
    where: {
      rootAgentId: obligation.rootAgentId,
      leaseToken: obligation.leaseToken,
    },
  });
  if (deleted.count !== 1) {
    throw new Error(`Trace archive finalization lease lost for ${obligation.rootAgentId}`);
  }
}

async function retain(obligation: FinalizationObligation, error: unknown): Promise<void> {
  const attemptNumber = obligation.attemptCount + 1;
  const retryDelayMs = Math.min(
    RETRY_DELAY_MS * 2 ** Math.min(attemptNumber - 1, 16),
    MAX_RETRY_DELAY_MS
  );
  await prisma.traceArchiveFinalization.updateMany({
    where: {
      rootAgentId: obligation.rootAgentId,
      leaseToken: obligation.leaseToken,
    },
    data: {
      leaseToken: null,
      leaseUntil: null,
      notBefore: new Date(Date.now() + retryDelayMs),
      attemptCount: { increment: 1 },
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
    },
  });
}

/** Release a claim when this worker's deadline expires before R2 work starts. */
async function unclaim(obligation: FinalizationObligation): Promise<void> {
  const released = await prisma.traceArchiveFinalization.updateMany({
    where: {
      rootAgentId: obligation.rootAgentId,
      leaseToken: obligation.leaseToken,
    },
    data: {
      leaseToken: null,
      leaseUntil: null,
    },
  });
  if (released.count !== 1) {
    throw new Error(`Trace archive finalization lease lost for ${obligation.rootAgentId}`);
  }
}

async function mapConcurrently<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<unknown[]> {
  let cursor = 0;
  const failures: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        await task(values[index]);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, worker)
  );
  return failures;
}

/**
 * Claim and finalize one bounded batch. Claims are leased across Render
 * replicas; failed rows retain their retry state and successful rows disappear.
 */
export async function runTraceArchiveFinalizationRetries(
  options: TraceArchiveFinalizationOptions = {}
): Promise<TraceArchiveFinalizationResult> {
  if (!archiveEnabled()) return { discovered: 0, finalized: 0 };
  assertBeforeDeadline(options.deadlineAtMs);
  const batchSize = boundedInteger(options.batchSize, 100, 'Trace archive finalization batch size');
  const maxConcurrency = boundedInteger(
    options.maxConcurrency,
    4,
    'Trace archive finalization concurrency'
  );
  const found = await candidates(options, batchSize);
  const claims = (await Promise.all(found.map((candidate) => claim(candidate, options)))).filter(
    (value): value is FinalizationObligation => value !== null
  );
  let finalized = 0;
  const failures = await mapConcurrently(claims, maxConcurrency, async (obligation) => {
    try {
      assertBeforeDeadline(options.deadlineAtMs);
    } catch (error) {
      await unclaim(obligation);
      throw error;
    }
    try {
      await assertDeletedTreeIsTerminal(obligation.rootAgentId);
      await finalizeAgent({ rootAgentId: obligation.rootAgentId, force: true });
      await complete(obligation);
      finalized += 1;
    } catch (error) {
      await retain(obligation, error);
      throw error;
    }
  });
  if (failures.length > 0) {
    // Carry the inner causes in the message: callers log `error.message`, and
    // an AggregateError's own text alone hides why each obligation failed.
    const causes = failures.map((failure) =>
      failure instanceof Error ? failure.message : String(failure)
    );
    throw new AggregateError(
      failures,
      `${failures.length} trace archive finalization obligation(s) failed: ${causes.join('; ')}`
    );
  }
  return { discovered: claims.length, finalized };
}
