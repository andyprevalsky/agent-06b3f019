/**
 * Planner memory store — the durable "history table" behind planner RAG.
 *
 * One row per finalized root trace bundle. Rows are written by the same
 * finalize path that publishes the bundle manifest (traceArchiveLifecycle), so
 * the table is always in sync with the archive. `criticalPath` is a lazily
 * filled cache (no TTL): the first planner that retrieves a row without one
 * reads the bundle, compresses the trajectory, and stores the result here.
 *
 * Retrieval is semantic (plannerMemoryEmbedding.ts): the query goal is
 * embedded once and scored against each visible row's goal vector with exact
 * pgvector cosine distance.
 *
 * 10k-agent shape: one embedding call + one visibility-filtered vector query
 * per planner call, one upsert (+ detached embed) per finalized run, and one
 * atomically leased cache fill per bundle/version. No per-agent fan-in,
 * in-memory corpus, or scheduled rebuild.
 */

import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from './database';
import {
  embedTexts,
  plannerMemoryGoalHash,
  PLANNER_MEMORY_INDEX_VERSION,
  toVectorLiteral,
} from './plannerMemoryEmbedding';

export const PLANNER_MEMORY_SEARCH_MAX_LIMIT = 50;
export const PLANNER_MEMORY_SEARCH_DEFAULT_LIMIT = 20;
export const PLANNER_MEMORY_COMPRESSION_LEASE_MS = 30 * 60 * 1000;

/** Candidates below this cosine similarity never reach the judge. */
export const PLANNER_MEMORY_DEFAULT_MIN_SIMILARITY = 0.7;

export interface PlannerMemoryRunInput {
  rootAgentId: string;
  userId: string | null;
  goal: string;
  benchmarkTaskName?: string | null;
  rootStatus?: string | null;
  passed?: boolean | null;
  worldModelMode?: string | null;
  agentCreatedAt?: Date | string | null;
}

export interface PlannerMemoryCandidate {
  id: string;
  user_id: string | null;
  goal: string;
  benchmark_task_name: string | null;
  root_status: string | null;
  passed: boolean | null;
  world_model_mode: string;
  agent_created_at: string | null;
  critical_path: unknown | null;
  compressor_version: string | null;
  /** cosine(query vector, goal vector). */
  similarity: number;
}

export interface PlannerMemorySearchInput {
  goal: string;
  userId?: string | null;
  excludeRootAgentId?: string | null;
  limit?: number;
  passedOnly?: boolean;
  minSimilarity?: number;
}

export type PlannerMemoryCompressionClaim =
  | { claimed: true; leaseId: string }
  | {
      claimed: false;
      reason: 'cached' | 'busy' | 'missing';
      criticalPath?: unknown;
      compressorVersion?: string | null;
    };

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Idempotent: re-finalizing the same root updates status/outcome in place. */
export async function upsertPlannerMemoryFromRun(input: PlannerMemoryRunInput): Promise<void> {
  const goal = input.goal.trim();
  if (goal.length === 0) return;
  const data = {
    userId: input.userId,
    goal,
    benchmarkTaskName: input.benchmarkTaskName ?? null,
    rootStatus: input.rootStatus ?? null,
    passed: input.passed ?? null,
    worldModelMode: (input.worldModelMode ?? 'real').trim().toLowerCase() || 'real',
    agentCreatedAt: toDate(input.agentCreatedAt),
    archivedAt: new Date(),
  };
  await prisma.plannerMemory.upsert({
    where: { id: input.rootAgentId },
    create: { id: input.rootAgentId, ...data },
    // Re-finalization may change the archived trajectory. Invalidate every
    // derived cache field and any in-flight lease so the next reader rebuilds
    // the critical path from the newly published bundle.
    update: {
      ...data,
      criticalPath: Prisma.DbNull,
      compressorVersion: null,
      compressedAt: null,
      compressionLeaseId: null,
      compressionLeaseUntil: null,
    },
  });
  // A re-finalized goal invalidates its vector; the pending drain re-embeds it.
  await prisma.plannerMemoryEmbedding.deleteMany({
    where: { plannerMemoryId: input.rootAgentId, goalHash: { not: plannerMemoryGoalHash(goal) } },
  });
}

/**
 * Semantic retrieval: embed the query goal once, then exact cosine KNN over the
 * visible embedded goal vectors. Visibility: benchmark runs are shared; private runs are
 * visible only to their own user. Only real-world (never simulator) runs.
 */
export async function searchPlannerMemories(
  input: PlannerMemorySearchInput
): Promise<PlannerMemoryCandidate[]> {
  const goal = input.goal.trim();
  if (goal.length === 0) return [];
  const limit = Math.max(
    1,
    Math.min(PLANNER_MEMORY_SEARCH_MAX_LIMIT, input.limit ?? PLANNER_MEMORY_SEARCH_DEFAULT_LIMIT)
  );
  const minSimilarity = input.minSimilarity ?? PLANNER_MEMORY_DEFAULT_MIN_SIMILARITY;
  const exclude = input.excludeRootAgentId ?? '';
  const userId = input.userId ?? '';
  const [queryVector] = await embedTexts([goal]);
  const query = toVectorLiteral(queryVector);
  // Completed-only corpus: a benchmark verdict of passed, or (no verdict) a
  // root that finished COMPLETED. Failed/paused/timed-out runs never surface.
  const passedFilter =
    input.passedOnly === true
      ? Prisma.sql`AND (m."passed" = true OR (m."passed" IS NULL AND m."rootStatus" = 'COMPLETED'))`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      userId: string | null;
      goal: string;
      benchmarkTaskName: string | null;
      rootStatus: string | null;
      passed: boolean | null;
      worldModelMode: string;
      agentCreatedAt: Date | null;
      criticalPath: unknown | null;
      compressorVersion: string | null;
      similarity: number;
    }>
  >(Prisma.sql`
    WITH q AS MATERIALIZED (SELECT ${query}::vector AS v),
    scored AS (
      SELECT m."id", m."userId", m."goal", m."benchmarkTaskName", m."rootStatus", m."passed",
             m."worldModelMode", m."agentCreatedAt", m."criticalPath", m."compressorVersion",
             (1 - (e."goalVector" <=> q.v))::float8 AS similarity
      FROM "PlannerMemory" m
      JOIN "PlannerMemoryEmbedding" e
        ON e."plannerMemoryId" = m."id" AND e."model" = ${PLANNER_MEMORY_INDEX_VERSION}
      CROSS JOIN q
      WHERE m."id" <> ${exclude}
        AND m."worldModelMode" = 'real'
        -- Own runs, plus ownerless curated benchmark fixtures. An owned
        -- benchmark run replays its account's real data; never share it.
        AND (m."userId" = ${userId} OR (m."userId" IS NULL AND m."benchmarkTaskName" IS NOT NULL))
        ${passedFilter}
    )
    SELECT * FROM scored
    WHERE similarity >= ${minSimilarity}
    ORDER BY similarity DESC, "agentCreatedAt" DESC NULLS LAST, "id" ASC
    LIMIT ${limit}
  `);
  return rows.map((row) => ({
    id: row.id,
    user_id: row.userId,
    goal: row.goal,
    benchmark_task_name: row.benchmarkTaskName,
    root_status: row.rootStatus,
    passed: row.passed,
    world_model_mode: row.worldModelMode,
    agent_created_at: row.agentCreatedAt ? row.agentCreatedAt.toISOString() : null,
    critical_path: row.criticalPath ?? null,
    compressor_version: row.compressorVersion,
    similarity: Number(row.similarity),
  }));
}

/** Same visibility as search: the owner, or anyone for an ownerless benchmark fixture. */
export function plannerMemoryVisibleTo(
  row: { userId: string | null; benchmarkTaskName: string | null },
  userId: string | null | undefined
): boolean {
  if (row.userId === null) return row.benchmarkTaskName !== null;
  return row.userId === userId;
}

export async function setPlannerMemoryCriticalPath(
  id: string,
  criticalPath: Prisma.InputJsonValue,
  compressorVersion: string,
  leaseId?: string
): Promise<boolean> {
  if (leaseId) {
    const updated = await prisma.plannerMemory.updateMany({
      where: { id, compressionLeaseId: leaseId },
      data: {
        criticalPath,
        compressorVersion,
        compressedAt: new Date(),
        compressionLeaseId: null,
        compressionLeaseUntil: null,
      },
    });
    return updated.count > 0;
  }
  const updated = await prisma.plannerMemory.updateMany({
    where: { id },
    data: {
      criticalPath,
      compressorVersion,
      compressedAt: new Date(),
      compressionLeaseId: null,
      compressionLeaseUntil: null,
    },
  });
  return updated.count > 0;
}

/**
 * Atomically elect one compressor for a missing/stale cache entry. The lease
 * bounds crash recovery; all concurrent losers skip the R2 read and LLM call.
 */
export async function claimPlannerMemoryCompression(
  id: string,
  compressorVersion: string
): Promise<PlannerMemoryCompressionClaim> {
  const leaseId = randomUUID();
  const leaseUntil = new Date(Date.now() + PLANNER_MEMORY_COMPRESSION_LEASE_MS);
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "PlannerMemory"
    SET "compressionLeaseId" = ${leaseId}, "compressionLeaseUntil" = ${leaseUntil}
    WHERE "id" = ${id}
      AND ("criticalPath" IS NULL OR "compressorVersion" IS DISTINCT FROM ${compressorVersion})
      AND ("compressionLeaseUntil" IS NULL OR "compressionLeaseUntil" < NOW())
    RETURNING "id"
  `);
  if (claimed.length > 0) return { claimed: true, leaseId };

  const row = await prisma.plannerMemory.findUnique({ where: { id } });
  if (row === null) return { claimed: false, reason: 'missing' };
  if (row.criticalPath !== null && row.compressorVersion === compressorVersion) {
    return {
      claimed: false,
      reason: 'cached',
      criticalPath: row.criticalPath,
      compressorVersion: row.compressorVersion,
    };
  }
  return { claimed: false, reason: 'busy' };
}

/** Release a failed owner's lease immediately instead of waiting for expiry. */
export async function releasePlannerMemoryCompression(
  id: string,
  leaseId: string
): Promise<boolean> {
  const updated = await prisma.plannerMemory.updateMany({
    where: { id, compressionLeaseId: leaseId },
    data: { compressionLeaseId: null, compressionLeaseUntil: null },
  });
  return updated.count > 0;
}

export async function deletePlannerMemory(id: string): Promise<boolean> {
  const deleted = await prisma.plannerMemory.deleteMany({ where: { id } });
  return deleted.count > 0;
}

export async function findPlannerMemory(id: string) {
  return prisma.plannerMemory.findUnique({ where: { id } });
}

export interface PlannerMemoryStats {
  total: number;
  embedded: number;
  compressed: number;
  passed: number;
  benchmark: number;
  private: number;
  distinct_tasks: number;
}

/** Corpus size counters, including how many rows carry a current-model embedding. */
export async function plannerMemoryStats(): Promise<PlannerMemoryStats> {
  const [total, embedded, compressed, passed, benchmark, distinct] = await Promise.all([
    prisma.plannerMemory.count(),
    prisma.plannerMemoryEmbedding.count({ where: { model: PLANNER_MEMORY_INDEX_VERSION } }),
    prisma.plannerMemory.count({ where: { criticalPath: { not: Prisma.DbNull } } }),
    prisma.plannerMemory.count({ where: { passed: true } }),
    prisma.plannerMemory.count({ where: { benchmarkTaskName: { not: null } } }),
    prisma.plannerMemory.findMany({
      where: { benchmarkTaskName: { not: null } },
      distinct: ['benchmarkTaskName'],
      select: { benchmarkTaskName: true },
    }),
  ]);
  return {
    total,
    embedded,
    compressed,
    passed,
    benchmark,
    private: total - benchmark,
    distinct_tasks: distinct.length,
  };
}
