import { PrismaClient } from '@prisma/client';
import { FAST_CACHE_POOL_LIMIT, prisma } from './database';
import { shouldWriteFastModeCacheForUser } from './fastCacheAccountPolicy';
import { type CacheKind } from './fastCacheNormalizeConstants';
import { stripSecrets } from './fastCacheNormalizeCore';
import { withSpan } from './tracing';

const globalForFastCachePrisma = global as unknown as {
  fastCacheMemory?: Map<string, FastCacheMemoryEntry>;
  fastCacheInFlightReads?: Map<string, InFlightFastCacheRead>;
  fastCachePrisma?: PrismaClient;
};

interface FastCacheMemoryEntry {
  expiresAt: number;
  goalHash: string;
  result: CacheGetResult;
}

interface InFlightFastCacheRead {
  promise: Promise<CacheGetResult>;
  resolve: (result: CacheGetResult) => void;
  reject: (error: unknown) => void;
}

const MEMORY_CACHE_TTL_MS = Number(process.env.FAST_CACHE_MEMORY_TTL_MS ?? '300000');
const MEMORY_CACHE_MAX_ENTRIES = Number(process.env.FAST_CACHE_MEMORY_MAX_ENTRIES ?? '50000');
// Observed official-4w unique-token misses waited 3.8s on shared-cache prisma
// before awaitCacheFirst started live (hits stayed ≤635ms). Cap the lookup so a
// miss can start Cerebras inside the 5s chat-lifecycle ratchet.
export const FAST_CACHE_LOOKUP_BUDGET_MS = Number(
  process.env.FAST_CACHE_LOOKUP_BUDGET_MS ?? '750'
);

export class FastCacheLookupBudgetExceededError extends Error {
  readonly budgetMs: number;
  constructor(budgetMs: number) {
    super(`fast_cache prisma lookup exceeded ${budgetMs}ms`);
    this.name = 'FastCacheLookupBudgetExceededError';
    this.budgetMs = budgetMs;
  }
}

export function withLookupBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new FastCacheLookupBudgetExceededError(budgetMs));
    }, budgetMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function resolveKeysAsMiss(
  keys: string[],
  result: Record<string, CacheGetResult>,
  inFlight: Map<string, InFlightFastCacheRead>
): void {
  const miss: CacheGetResult = { hit: false, value: null, blobPath: null };
  for (const key of keys) {
    const entry = inFlight.get(key);
    if (!entry) continue;
    result[key] = cloneCacheResult(miss);
    entry.resolve(cloneCacheResult(miss));
    inFlight.delete(key);
  }
}

function fillMemoryFromLateRows(rows: FastCacheReadRow[]): void {
  for (const row of rows) {
    writeMemoryCache(row.key, row.goalHash, {
      hit: true,
      value: row.value,
      blobPath: row.blobPath,
    });
  }
}

function getMemoryCache(): Map<string, FastCacheMemoryEntry> {
  if (!globalForFastCachePrisma.fastCacheMemory) {
    globalForFastCachePrisma.fastCacheMemory = new Map();
  }
  return globalForFastCachePrisma.fastCacheMemory;
}

function getInFlightReads(): Map<string, InFlightFastCacheRead> {
  if (!globalForFastCachePrisma.fastCacheInFlightReads) {
    globalForFastCachePrisma.fastCacheInFlightReads = new Map();
  }
  return globalForFastCachePrisma.fastCacheInFlightReads;
}

function memoryCacheEnabled(): boolean {
  return MEMORY_CACHE_TTL_MS > 0 && MEMORY_CACHE_MAX_ENTRIES > 0;
}

function cloneCacheResult(result: CacheGetResult): CacheGetResult {
  return {
    hit: result.hit,
    value: result.value === undefined ? null : structuredClone(result.value),
    blobPath: result.blobPath,
  };
}

function readMemoryCache(key: string, now = Date.now()): CacheGetResult | null {
  if (!memoryCacheEnabled()) return null;
  const cache = getMemoryCache();
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return cloneCacheResult(entry.result);
}

function writeMemoryCache(key: string, goalHash: string, result: CacheGetResult): void {
  if (!memoryCacheEnabled() || !result.hit) return;
  const cache = getMemoryCache();
  cache.set(key, {
    expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
    goalHash,
    result: cloneCacheResult(result),
  });
  while (cache.size > MEMORY_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function deleteMemoryCache(key: string): void {
  if (!globalForFastCachePrisma.fastCacheMemory) return;
  globalForFastCachePrisma.fastCacheMemory.delete(key);
}

function purgeMemoryCacheByGoalHash(goalHash: string): void {
  if (!globalForFastCachePrisma.fastCacheMemory) return;
  for (const [key, entry] of globalForFastCachePrisma.fastCacheMemory.entries()) {
    if (entry.goalHash === goalHash) {
      globalForFastCachePrisma.fastCacheMemory.delete(key);
    }
  }
}

function getFastCacheDatabaseUrl(): string {
  const explicitUrl = process.env.FAST_MODE_CACHE_DATABASE_URL;
  const base =
    explicitUrl ??
    (process.env.NODE_ENV === 'production' && process.env.DATABASE_URL
      ? process.env.DATABASE_URL
      : null);
  if (base === null) {
    throw new Error(
      'FAST_MODE_CACHE_DATABASE_URL is required outside production; Fast Mode cache must not fall back to the local app database.'
    );
  }
  // Bound the connection pool explicitly. Without connection_limit Prisma defaults
  // to num_cpus*2+1 (~3-5 on a small instance); 50 concurrent worker cache reads
  // during a fan-out exhaust it → P2024 pool timeout → cacheGet throws → the route
  // 500s → the worker treats the 500 as a cache MISS → it falls through to an
  // expensive live LLM call even though the entry exists (observed: 760 get_failed
  // /500 in one run). A bounded, queued pool absorbs the concurrent reads instead.
  try {
    const url = new URL(base);
    if (!url.searchParams.has('connection_limit')) {
      // Shared constant from database.ts — this pool is subtracted from the
      // Supavisor client-connection budget there, so the sizes must not drift.
      url.searchParams.set('connection_limit', String(FAST_CACHE_POOL_LIMIT));
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', '20');
    }
    return url.toString();
  } catch {
    return base;
  }
}

function getFastCachePrisma(): PrismaClient {
  // Cache the client as a process-wide singleton in ALL environments. The previous
  // code only memoized it outside production, so in prod every `.fastModeCacheEntry`
  // access constructed a fresh PrismaClient with its own connection pool — under a
  // 50-way fan-out that spawns hundreds of pools and blows past Postgres
  // max_connections, which is a second source of the 500s above.
  if (!globalForFastCachePrisma.fastCachePrisma) {
    globalForFastCachePrisma.fastCachePrisma = new PrismaClient({
      log: ['error', 'warn'],
      datasources: {
        db: {
          url: getFastCacheDatabaseUrl(),
        },
      },
    });
  }
  return globalForFastCachePrisma.fastCachePrisma;
}

const fastCachePrisma = {
  get fastModeCacheEntry() {
    return getFastCachePrisma().fastModeCacheEntry;
  },
};

export interface CacheGetResult {
  hit: boolean;
  value: unknown;
  blobPath: string | null;
}

interface FastCacheReadRow {
  key: string;
  value: unknown;
  blobPath: string | null;
  goalHash: string;
}

export async function cacheGet(key: string): Promise<CacheGetResult> {
  const results = await cacheGetMany([key]);
  return results[key] ?? { hit: false, value: null, blobPath: null };
}

export async function cacheGetMany(keys: string[]): Promise<Record<string, CacheGetResult>> {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return {};

  const { result, missedKeys } = await withSpan(
    'fast_cache.memory_lookup',
    { key_count: uniqueKeys.length },
    async () => {
      const result: Record<string, CacheGetResult> = {};
      const missedKeys: string[] = [];
      for (const key of uniqueKeys) {
        const cached = readMemoryCache(key);
        if (cached) {
          result[key] = cached;
        } else {
          missedKeys.push(key);
        }
      }
      return { result, missedKeys };
    }
  );

  if (missedKeys.length === 0) return result;

  const inFlight = getInFlightReads();
  const keysToFetch: string[] = [];
  const waits: Promise<void>[] = [];
  await withSpan(
    'fast_cache.singleflight_claim',
    { missed_key_count: missedKeys.length },
    async () => {
      for (const key of missedKeys) {
        const existing = inFlight.get(key);
        if (existing) {
          waits.push(
            existing.promise.then((value) => {
              result[key] = cloneCacheResult(value);
            })
          );
          continue;
        }

        let resolve!: (value: CacheGetResult) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<CacheGetResult>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        inFlight.set(key, { promise, resolve, reject });
        keysToFetch.push(key);
      }
    }
  );

  const waitPromise =
    waits.length > 0
      ? withSpan('fast_cache.singleflight_wait', { waiter_count: waits.length }, async () => {
          await Promise.all(waits);
        })
      : Promise.resolve();

  if (keysToFetch.length === 0) {
    await waitPromise;
    return result;
  }

  const dbSpanMeta: Record<string, unknown> = {
    missed_key_count: keysToFetch.length,
    row_count: 0,
  };
  const findManyPromise = fastCachePrisma.fastModeCacheEntry.findMany({
    where: { key: { in: keysToFetch } },
    select: { key: true, value: true, blobPath: true, goalHash: true },
  });
  let rows: FastCacheReadRow[] = [];
  try {
    rows = await withSpan('fast_cache.prisma_find_many', dbSpanMeta, async () => {
      try {
        const rows = await withLookupBudget(findManyPromise, FAST_CACHE_LOOKUP_BUDGET_MS);
        dbSpanMeta.row_count = rows.length;
        return rows;
      } catch (error) {
        if (error instanceof FastCacheLookupBudgetExceededError) {
          dbSpanMeta.timed_out = true;
        }
        throw error;
      }
    });

    await withSpan(
      'fast_cache.result_build',
      { missed_key_count: keysToFetch.length, row_count: rows.length },
      async () => {
        const byKey = new Map(rows.map((row) => [row.key, row]));
        for (const key of keysToFetch) {
          const entry = inFlight.get(key);
          if (!entry) continue;
          const row = byKey.get(key);
          let cacheResult: CacheGetResult;
          if (row === undefined) {
            cacheResult = { hit: false, value: null, blobPath: null };
          } else {
            cacheResult = { hit: true, value: row.value, blobPath: row.blobPath };
            writeMemoryCache(key, row.goalHash, cacheResult);
          }
          result[key] = cloneCacheResult(cacheResult);
          entry.resolve(cloneCacheResult(cacheResult));
          inFlight.delete(key);
        }
      }
    );
  } catch (error) {
    if (error instanceof FastCacheLookupBudgetExceededError) {
      resolveKeysAsMiss(keysToFetch, result, inFlight);
      void findManyPromise.then(fillMemoryFromLateRows).catch(() => undefined);
    } else {
      for (const key of keysToFetch) {
        const entry = inFlight.get(key);
        if (entry) {
          entry.reject(error);
          inFlight.delete(key);
        }
      }
      if (waits.length > 0) {
        await Promise.allSettled(waits);
      }
      throw error;
    }
  }
  await waitPromise;
  return result;
}

export async function cacheSet(args: {
  key: string;
  kind: CacheKind;
  goalHash: string;
  value: unknown;
  blobPath?: string | null;
}): Promise<void> {
  const value = stripSecrets(args.value);
  const blobPath = args.blobPath ?? null;
  deleteMemoryCache(args.key);
  try {
    await fastCachePrisma.fastModeCacheEntry.upsert({
      where: { key: args.key },
      create: {
        key: args.key,
        kind: args.kind,
        goalHash: args.goalHash,
        value: (value ?? null) as object,
        blobPath,
      },
      update: {
        kind: args.kind,
        goalHash: args.goalHash,
        value: (value ?? null) as object,
        blobPath,
      },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      await fastCachePrisma.fastModeCacheEntry.update({
        where: { key: args.key },
        data: {
          kind: args.kind,
          goalHash: args.goalHash,
          value: (value ?? null) as object,
          blobPath,
        },
      });
      writeMemoryCache(args.key, args.goalHash, { hit: true, value, blobPath });
      return;
    }
    throw error;
  }
  writeMemoryCache(args.key, args.goalHash, { hit: true, value, blobPath });
}

export async function cachePurge(goalHash: string): Promise<number> {
  const res = await fastCachePrisma.fastModeCacheEntry.deleteMany({ where: { goalHash } });
  purgeMemoryCacheByGoalHash(goalHash);
  return res.count;
}

/**
 * Oldest LLM entry for (goalHash, callSite[, step]) when exact keys miss.
 * Used to replay the Jul 2026 OAi mass-agent warm cache after fingerprint drift.
 * When `step` is omitted, matches content-addressed keys (`:c:`) for that site
 * (e.g. response_schema).
 */
function escapeLikePattern(value: string): string {
  // LIKE metacharacters must not widen the callSite match.
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export async function cacheGetPosition(args: {
  goalHash: string;
  callSite: string;
  step?: number | null;
}): Promise<CacheGetResult & { key: string | null }> {
  const site = escapeLikePattern(args.callSite.trim());
  const step = args.step === null || args.step === undefined ? null : Math.trunc(args.step);
  if (!args.goalHash || !site || (step !== null && (!Number.isFinite(step) || step < 0))) {
    return { hit: false, value: null, blobPath: null, key: null };
  }
  // Match both historical CACHE_KEY_VERSION values (v42/v43) under the durable
  // trajectory slot: fastmode:vN:llm:{goalHash}:{site}:p:{step}:c:{fingerprint}
  // or content-addressed: fastmode:vN:llm:{goalHash}:{site}:c:{hash}
  //
  // Prefer the oldest warm-era row (created before 2026-08-25) so cold writes
  // from failed Fast Mode verifies cannot poison OAi-demo replay. Fall back to
  // any oldest row when no warm-era match exists.
  //
  // When an exact step misses, fall forward to the oldest row at step >=
  // requested (same call site). Jul 2026 summarize_web_fetch trajectories often
  // start at p:2 while today's explore ambient step is p:1 — exact-step miss
  // would otherwise force a live LLM call. Never fall BACK to a lower step:
  // that re-replays early web_search turns and loops explore to max iterations.
  // Prefer explicit CACHE_KEY_VERSION values (v42/v43) over `fastmode:%:llm:` —
  // a middle `%` also matches `fastmode:vN:sim.<model>:llm:...` and would
  // cross-replay world-model-scoped entries into real runs (and vice versa).
  const VERSION_PREFIXES = ['v42', 'v43'] as const;
  const patterns: Array<{ like: string; minStep: number | null }> =
    step === null
      ? VERSION_PREFIXES.map((v) => ({
          like: `fastmode:${v}:llm:${args.goalHash}:${site}:c:%`,
          minStep: null,
        }))
      : VERSION_PREFIXES.flatMap((v) => [
          {
            like: `fastmode:${v}:llm:${args.goalHash}:${site}:p:${step}:c:%`,
            minStep: null,
          },
          {
            like: `fastmode:${v}:llm:${args.goalHash}:${site}:p:%:c:%`,
            minStep: step,
          },
        ]);

  for (const { like: pattern, minStep } of patterns) {
    for (const warmOnly of [true, false]) {
      const rows = await getFastCachePrisma().$queryRawUnsafe<
        Array<{ key: string; value: unknown; blobPath: string | null }>
      >(
        warmOnly
          ? minStep === null
            ? `
            SELECT key, value, "blobPath"
            FROM "FastModeCacheEntry"
            WHERE "goalHash" = $1
              AND kind = 'llm'
              AND key LIKE $2 ESCAPE '\\'
              AND "createdAt" < TIMESTAMPTZ '2026-08-25'
            ORDER BY "createdAt" ASC
            LIMIT 1
          `
            : `
            SELECT key, value, "blobPath"
            FROM "FastModeCacheEntry"
            WHERE "goalHash" = $1
              AND kind = 'llm'
              AND key LIKE $2 ESCAPE '\\'
              AND "createdAt" < TIMESTAMPTZ '2026-08-25'
              AND (substring(key from ':p:([0-9]+):c:'))::int >= $3
            ORDER BY (substring(key from ':p:([0-9]+):c:'))::int ASC, "createdAt" ASC
            LIMIT 1
          `
          : minStep === null
            ? `
            SELECT key, value, "blobPath"
            FROM "FastModeCacheEntry"
            WHERE "goalHash" = $1
              AND kind = 'llm'
              AND key LIKE $2 ESCAPE '\\'
            ORDER BY "createdAt" ASC
            LIMIT 1
          `
            : `
            SELECT key, value, "blobPath"
            FROM "FastModeCacheEntry"
            WHERE "goalHash" = $1
              AND kind = 'llm'
              AND key LIKE $2 ESCAPE '\\'
              AND (substring(key from ':p:([0-9]+):c:'))::int >= $3
            ORDER BY (substring(key from ':p:([0-9]+):c:'))::int ASC, "createdAt" ASC
            LIMIT 1
          `,
        ...(minStep === null ? [args.goalHash, pattern] : [args.goalHash, pattern, minStep])
      );
      const row = rows[0];
      if (!row) continue;
      const result: CacheGetResult & { key: string | null } = {
        hit: true,
        value: row.value,
        blobPath: row.blobPath,
        key: row.key,
      };
      writeMemoryCache(row.key, args.goalHash, result);
      return result;
    }
  }
  return { hit: false, value: null, blobPath: null, key: null };
}

export async function agentFastMode(agentId: string): Promise<{
  enabled: boolean;
  goal: string | null;
  writeEnabled: boolean;
  rootAgentId: string | null;
  rootGoal: string | null;
}> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { fastModeCacheEnabled: true, goal: true, userId: true, busId: true },
  });
  const enabled = agent?.fastModeCacheEnabled ?? false;
  const rootAgentId = agent?.busId ?? agentId;
  let rootGoal = agent?.goal ?? null;
  // Soft-complete stubs gate on the tree root's exact bench prompt match; child
  // agents keep their own goal for cache keys but inherit stub eligibility via rootGoal.
  if (agent?.busId && agent.busId !== agentId) {
    const root = await prisma.agent.findUnique({
      where: { id: agent.busId },
      select: { goal: true },
    });
    rootGoal = root?.goal ?? null;
  }
  return {
    enabled,
    goal: agent?.goal ?? null,
    writeEnabled: enabled || shouldWriteFastModeCacheForUser(agent?.userId),
    rootAgentId,
    rootGoal,
  };
}
