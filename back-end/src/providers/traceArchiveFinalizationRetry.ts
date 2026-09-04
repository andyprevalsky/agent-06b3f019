import { randomUUID } from 'node:crypto';
import { type Prisma } from '@prisma/client';
import { prisma } from './database';
import { archiveEnabled } from './traceArchive';
import { finalizeAgent } from './traceArchiveLifecycle';

const INITIAL_GRACE_MS = 120_000;
const RETRY_DELAY_MS = 60_000;
const LEASE_MS = 10 * 60_000;

interface FinalizationObligation {
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
): Promise<void> {
  const notBefore = new Date(Date.now() + INITIAL_GRACE_MS);
  await tx.traceArchiveFinalization.upsert({
    where: { rootAgentId },
    create: { rootAgentId, notBefore },
    update: {
      notBefore,
      leaseToken: null,
      leaseUntil: null,
      lastError: null,
    },
  });
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
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
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
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      leaseToken,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
    },
  });
  return claimed.count === 1 ? { rootAgentId: candidate.rootAgentId, leaseToken } : null;
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
  await prisma.traceArchiveFinalization.updateMany({
    where: {
      rootAgentId: obligation.rootAgentId,
      leaseToken: obligation.leaseToken,
    },
    data: {
      leaseToken: null,
      leaseUntil: null,
      notBefore: new Date(Date.now() + RETRY_DELAY_MS),
      attemptCount: { increment: 1 },
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
    },
  });
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
      await finalizeAgent({ rootAgentId: obligation.rootAgentId, force: true });
      await complete(obligation);
      finalized += 1;
    } catch (error) {
      await retain(obligation, error);
      throw error;
    }
  });
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} trace archive finalization obligation(s) failed`
    );
  }
  return { discovered: claims.length, finalized };
}
