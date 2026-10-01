/**
 * Planner memory embeddings — the write + query side of semantic retrieval.
 *
 * Each PlannerMemory row gets one voyage-4 vector of its goal. Search scores a
 * query by cosine similarity; the agents-side judge then decides which
 * candidate (if any) is the same task. Chosen by
 * agents/benchmarks/memory_retrieval_bench.py (an index-time LLM "retrieval
 * card" measured slightly better on paraphrases but was dropped for cost).
 *
 * 10k-agent shape: one embedding call per planner search, one single-text
 * embedding call per finalized run (idempotent on index version + goal hash),
 * and a bounded, batched pending-drain that heals rows whose detached embed was
 * lost (deploy restart, provider outage). No LLM calls, no shared in-memory state.
 */

import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './database';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';

const log = createLogger('PlannerMemoryEmbedding');

export const PLANNER_MEMORY_EMBEDDING_MODEL = 'voyageai/voyage-4';
export const PLANNER_MEMORY_EMBEDDING_DIM = 1024;
/**
 * Stored in PlannerMemoryEmbedding.model: every input that shapes the vector.
 * Changing it re-embeds every row (pending drain / backfill) and search only
 * compares rows of the current index.
 */
export const PLANNER_MEMORY_INDEX_VERSION = `${PLANNER_MEMORY_EMBEDDING_MODEL}|goal-v1`;
const EMBEDDING_URL = 'https://openrouter.ai/api/v1/embeddings';
const EMBEDDING_TIMEOUT_MS = 30_000;
const EMBEDDING_ATTEMPTS = 3;
const MAX_EMBED_INPUT_CHARS = 24_000;
/** Inputs per embedding request in the pending drain. */
export const PLANNER_MEMORY_EMBED_BATCH = 64;

export function plannerMemoryGoalHash(goal: string): string {
  return createHash('sha256').update(goal.trim()).digest('hex');
}

/** pgvector text literal; values are finite floats validated by embedTexts. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function parseVectors(data: { data?: Array<{ embedding?: unknown }> }, count: number): number[][] {
  const vectors = (data.data ?? []).map((item) => item.embedding);
  if (vectors.length !== count) {
    throw new Error(`expected ${count} embeddings, got ${vectors.length}`);
  }
  return vectors.map((vector) => {
    if (
      !Array.isArray(vector) ||
      vector.length !== PLANNER_MEMORY_EMBEDDING_DIM ||
      !vector.every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new Error(`embedding has invalid shape (want ${PLANNER_MEMORY_EMBEDDING_DIM})`);
    }
    return vector as number[];
  });
}

/** Embed texts with the pinned model. Throws on any provider or shape error. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for planner memory embeddings');
  const body = JSON.stringify({
    model: PLANNER_MEMORY_EMBEDDING_MODEL,
    input: texts.map((text) => text.slice(0, MAX_EMBED_INPUT_CHARS)),
  });
  const started = Date.now();
  const response = await retryWithBackoff(
    () =>
      fetch(EMBEDDING_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      }),
    {
      maxRetries: EMBEDDING_ATTEMPTS,
      initialBackoffMs: 500,
      isRetryable: () => true,
      shouldRetryResult: (res) => res.status === 429 || res.status >= 500,
      beforeRetryResult: async (res) => {
        await res.text();
      },
      component: 'PlannerMemoryEmbedding',
    }
  );
  if (!response.ok) {
    throw new Error(
      `planner memory embedding failed: HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`
    );
  }
  const vectors = parseVectors(
    (await response.json()) as { data?: Array<{ embedding?: unknown }> },
    texts.length
  );
  log.info('embedded', {
    model: PLANNER_MEMORY_EMBEDDING_MODEL,
    count: texts.length,
    duration_ms: Date.now() - started,
  });
  return vectors;
}

async function upsertEmbedding(id: string, goalHash: string, vector: number[]): Promise<void> {
  const literal = toVectorLiteral(vector);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "PlannerMemoryEmbedding"
      ("plannerMemoryId", "model", "goalHash", "goalVector", "updatedAt")
    VALUES (${id}, ${PLANNER_MEMORY_INDEX_VERSION}, ${goalHash}, ${literal}::vector, NOW())
    ON CONFLICT ("plannerMemoryId") DO UPDATE SET
      "model" = EXCLUDED."model",
      "goalHash" = EXCLUDED."goalHash",
      "goalVector" = EXCLUDED."goalVector",
      "updatedAt" = NOW()
  `);
}

export type PlannerMemoryEmbedOutcome = 'embedded' | 'current' | 'missing';

/**
 * Idempotent: a row whose embedding matches the current index version and goal
 * is left alone; otherwise its goal vector is (re)built and upserted.
 */
export async function embedPlannerMemory(id: string): Promise<PlannerMemoryEmbedOutcome> {
  const row = await prisma.plannerMemory.findUnique({
    where: { id },
    select: { goal: true, embedding: { select: { model: true, goalHash: true } } },
  });
  if (row === null) return 'missing';
  const goalHash = plannerMemoryGoalHash(row.goal);
  if (
    row.embedding?.model === PLANNER_MEMORY_INDEX_VERSION &&
    row.embedding.goalHash === goalHash
  ) {
    return 'current';
  }
  const started = Date.now();
  const [vector] = await embedTexts([row.goal]);
  await upsertEmbedding(id, goalHash, vector);
  log.info('planner memory embedded', { root_agent_id: id, duration_ms: Date.now() - started });
  return 'embedded';
}

/** Rows with no embedding for the current index version, newest first. */
async function pendingPlannerMemories(limit: number): Promise<Array<{ id: string; goal: string }>> {
  return prisma.$queryRaw<Array<{ id: string; goal: string }>>(Prisma.sql`
    SELECT m."id", m."goal"
    FROM "PlannerMemory" m
    LEFT JOIN "PlannerMemoryEmbedding" e ON e."plannerMemoryId" = m."id"
    WHERE m."worldModelMode" = 'real'
      AND (e."plannerMemoryId" IS NULL OR e."model" <> ${PLANNER_MEMORY_INDEX_VERSION})
    ORDER BY m."createdAt" DESC, m."id" ASC
    LIMIT ${Math.max(1, Math.min(500, limit))}
  `);
}

export interface PlannerMemoryEmbedDrainResult {
  embedded: number;
  failed: number;
  remaining: number;
}

/**
 * Embed up to `limit` pending rows: identical goals are embedded once, the
 * rest go out in PLANNER_MEMORY_EMBED_BATCH-input requests. A failed batch is
 * counted and left pending for the next drain.
 */
export async function embedPendingPlannerMemories(
  limit: number
): Promise<PlannerMemoryEmbedDrainResult> {
  const result: PlannerMemoryEmbedDrainResult = { embedded: 0, failed: 0, remaining: 0 };
  const rows = await pendingPlannerMemories(limit);
  const byHash = new Map<string, { goal: string; ids: string[] }>();
  for (const row of rows) {
    const hash = plannerMemoryGoalHash(row.goal);
    const group = byHash.get(hash) ?? { goal: row.goal, ids: [] };
    group.ids.push(row.id);
    byHash.set(hash, group);
  }
  const groups = [...byHash.entries()];
  for (let start = 0; start < groups.length; start += PLANNER_MEMORY_EMBED_BATCH) {
    const batch = groups.slice(start, start + PLANNER_MEMORY_EMBED_BATCH);
    try {
      const vectors = await embedTexts(batch.map(([, group]) => group.goal));
      for (const [index, [hash, group]] of batch.entries()) {
        for (const id of group.ids) {
          await upsertEmbedding(id, hash, vectors[index]);
          result.embedded += 1;
        }
      }
    } catch (error) {
      result.failed += batch.reduce((sum, [, group]) => sum + group.ids.length, 0);
      log.warn('pending embed batch failed', {
        rows: batch.length,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
  }
  result.remaining = (await pendingPlannerMemories(1)).length;
  return result;
}

/** Rows drained alongside every finalize embed so a lost detached embed self-heals. */
export const PLANNER_MEMORY_FINALIZE_DRAIN_LIMIT = 8;

/**
 * Detached: finalize never waits on the embedding round trip. Embeds the
 * finalized row, then drains a few pending rows. Never throws.
 */
export function scheduleFinalizeEmbedding(id: string): void {
  void (async () => {
    try {
      await embedPlannerMemory(id);
      await embedPendingPlannerMemories(PLANNER_MEMORY_FINALIZE_DRAIN_LIMIT);
    } catch (error) {
      log.warn('finalize embed failed; the next finalize drain retries it', {
        root_agent_id: id,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
  })();
}
