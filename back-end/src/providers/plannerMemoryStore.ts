/**
 * Planner memory store — the durable "history table" behind planner RAG.
 *
 * One row per finalized root trace bundle. Rows are written by the same
 * finalize path that publishes the bundle manifest (traceArchiveLifecycle), so
 * the table is always in sync with the archive. `criticalPath` is a lazily
 * filled cache (no TTL): the first planner that retrieves a row without one
 * reads the bundle, compresses the trajectory, and stores the result here.
 *
 * 10k-agent shape: one indexed FTS query over pre-tokenized goals per planner
 * call, one upsert per finalized run, and one atomically leased cache fill per
 * bundle/version. No per-agent fan-in, in-memory corpus, or scheduled rebuild.
 */

import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from './database';

export const PLANNER_MEMORY_SEARCH_MAX_LIMIT = 50;
export const PLANNER_MEMORY_SEARCH_DEFAULT_LIMIT = 20;
export const PLANNER_MEMORY_COMPRESSION_LEASE_MS = 30 * 60 * 1000;

const TOKEN_RE = /[a-z0-9]+/g;
const STOPWORDS = new Set(
  `a an the and or but if then else of to in on at by for with from as is are was were be been being am
   do does did done doing have has had having will would shall should can could may might must i me my we our
   you your he she it its they them their this that these those there here what which who whom whose when where
   why how all any each every some such no nor not only own same so than too very just also into over under
   again further once about above below up down out off through during before after between both while until
   use using used need needs needed please make sure want wants get got go going`
    .split(/\s+/)
    .filter(Boolean)
);

function stemToken(token: string): string {
  if (token.length <= 4 || /^\d+$/.test(token)) return token;
  for (const [suffix, replacement] of [
    ['ies', 'y'],
    ['ing', ''],
    ['ed', ''],
    ['es', ''],
    ['s', ''],
  ] as const) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, -suffix.length) + replacement;
    }
  }
  return token;
}

/** Must stay byte-for-byte equivalent to agents planner-memory tokenize(). */
export function tokenizePlannerMemoryGoal(goal: string): string[] {
  return [
    ...new Set(
      (goal.toLowerCase().match(TOKEN_RE) ?? [])
        .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
        .map(stemToken)
    ),
  ];
}

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
  fts_rank: number;
  trgm_similarity: number;
  lexical_coverage: number;
}

export interface PlannerMemorySearchInput {
  goal: string;
  userId?: string | null;
  excludeRootAgentId?: string | null;
  limit?: number;
  passedOnly?: boolean;
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
    goalTokens: tokenizePlannerMemoryGoal(goal),
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
    update: data,
  });
}

/**
 * One-query OR-of-token retrieval. The bounded candidate stage is ordered
 * by the same query-token coverage used by the runtime scorer, so a concise
 * goal contained in a stored goal with appended constraints cannot be evicted
 * by high-trigram or repeated-term partial matches. Visibility: benchmark runs
 * are shared; private runs are visible only to their own user. Only real-world
 * runs (never simulator rollouts) are eligible.
 */
export async function searchPlannerMemories(
  input: PlannerMemorySearchInput
): Promise<PlannerMemoryCandidate[]> {
  const goal = input.goal.trim();
  if (goal.length === 0) return [];
  const queryTokens = tokenizePlannerMemoryGoal(goal);
  if (queryTokens.length === 0) return [];
  const queryTokenArray = Prisma.sql`ARRAY[${Prisma.join(queryTokens)}]::text[]`;
  const tsquery = queryTokens.join(' | ');
  const limit = Math.max(
    1,
    Math.min(PLANNER_MEMORY_SEARCH_MAX_LIMIT, input.limit ?? PLANNER_MEMORY_SEARCH_DEFAULT_LIMIT)
  );
  const exclude = input.excludeRootAgentId ?? '';
  const userId = input.userId ?? '';
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
      fts_rank: number;
      trgm_similarity: number;
      lexical_coverage: number;
    }>
  >(Prisma.sql`
    WITH ranked AS MATERIALIZED (
      SELECT m."id", m."userId", m."goal", m."benchmarkTaskName", m."rootStatus", m."passed",
             m."worldModelMode", m."agentCreatedAt", m."criticalPath", m."compressorVersion",
             0::float8 AS fts_rank,
             overlap.count / ${queryTokens.length}::float8 AS lexical_coverage,
             overlap.count / GREATEST(cardinality(m."goalTokens"), 1)::float8 AS reverse_coverage
      FROM "PlannerMemory" m
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::float8 AS count
        FROM unnest(${queryTokenArray}) AS query_terms(query_token)
        WHERE query_token = ANY(m."goalTokens")
      ) overlap
      WHERE m."id" <> ${exclude}
        AND m."worldModelMode" = 'real'
        AND (m."benchmarkTaskName" IS NOT NULL OR m."userId" = ${userId})
        AND to_tsvector('english', m."goal") @@ to_tsquery('english', ${tsquery})
        ${passedFilter}
      ORDER BY lexical_coverage DESC, reverse_coverage DESC,
               m."agentCreatedAt" DESC NULLS LAST, m."id" ASC
      LIMIT ${limit}
    )
    SELECT ranked.*, similarity(ranked."goal", ${goal})::float8 AS trgm_similarity
    FROM ranked
    ORDER BY ranked.lexical_coverage DESC, ranked.reverse_coverage DESC,
             ranked."agentCreatedAt" DESC NULLS LAST, ranked."id" ASC
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
    fts_rank: Number(row.fts_rank),
    trgm_similarity: Number(row.trgm_similarity),
    lexical_coverage: Number(row.lexical_coverage),
  }));
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
  compressed: number;
  passed: number;
  benchmark: number;
  private: number;
  distinct_tasks: number;
}

/** Corpus size counters (the "how many history items are embedded" answer). */
export async function plannerMemoryStats(): Promise<PlannerMemoryStats> {
  const [total, compressed, passed, benchmark, distinct] = await Promise.all([
    prisma.plannerMemory.count(),
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
    compressed,
    passed,
    benchmark,
    private: total - benchmark,
    distinct_tasks: distinct.length,
  };
}
