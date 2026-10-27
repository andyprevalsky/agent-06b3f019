import { Prisma, PrismaClient } from '@prisma/client';
import { DEMO_CACHE_POOL_LIMIT, prisma } from './database';
import { demoCacheAllowed } from './demoCachePolicy';
import {
  demoCacheWriteEnabled,
  demoCacheWritesDisabled,
  shouldWriteDemoCacheForUser,
} from './demoCacheAccountPolicy';
import { type CacheKind } from './demoCacheNormalizeConstants';
import { stripSecrets } from './demoCacheNormalizeCore';
import { createLogger } from './logger';
import { withSpan } from './tracing';
import { demoCacheEnv } from './demoCacheEnv';
import {
  OFFLOAD_KINDS,
  offloadPointer,
  prepareOffload,
  rehydrateRows,
  uploadOffload,
} from './demoCacheOffload';

const log = createLogger('DemoCacheStore');

const globalForDemoCachePrisma = global as unknown as {
  demoCacheMemory?: Map<string, DemoCacheMemoryEntry>;
  demoCacheInFlightReads?: Map<string, InFlightDemoCacheRead>;
  demoCachePrisma?: PrismaClient;
};

interface DemoCacheMemoryEntry {
  expiresAt: number;
  goalHash: string;
  result: CacheGetResult;
}

interface InFlightDemoCacheRead {
  promise: Promise<CacheGetResult>;
  resolve: (result: CacheGetResult) => void;
  reject: (error: unknown) => void;
}

const MEMORY_CACHE_TTL_MS = Number(demoCacheEnv('DEMO_CACHE_MEMORY_TTL_MS') ?? '300000');
const MEMORY_CACHE_MAX_ENTRIES = Number(demoCacheEnv('DEMO_CACHE_MEMORY_MAX_ENTRIES') ?? '50000');

function getMemoryCache(): Map<string, DemoCacheMemoryEntry> {
  if (!globalForDemoCachePrisma.demoCacheMemory) {
    globalForDemoCachePrisma.demoCacheMemory = new Map();
  }
  return globalForDemoCachePrisma.demoCacheMemory;
}

function getInFlightReads(): Map<string, InFlightDemoCacheRead> {
  if (!globalForDemoCachePrisma.demoCacheInFlightReads) {
    globalForDemoCachePrisma.demoCacheInFlightReads = new Map();
  }
  return globalForDemoCachePrisma.demoCacheInFlightReads;
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
  if (!globalForDemoCachePrisma.demoCacheMemory) return;
  globalForDemoCachePrisma.demoCacheMemory.delete(key);
}

function purgeMemoryCacheByGoalHash(goalHash: string): void {
  if (!globalForDemoCachePrisma.demoCacheMemory) return;
  for (const [key, entry] of globalForDemoCachePrisma.demoCacheMemory.entries()) {
    if (entry.goalHash === goalHash) {
      globalForDemoCachePrisma.demoCacheMemory.delete(key);
    }
  }
}

function getDemoCacheDatabaseUrl(): string {
  const explicitUrl = demoCacheEnv('DEMO_CACHE_DATABASE_URL');
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
      url.searchParams.set('connection_limit', String(DEMO_CACHE_POOL_LIMIT));
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', '20');
    }
    return url.toString();
  } catch {
    return base;
  }
}

function getDemoCachePrisma(): PrismaClient {
  // Cache the client as a process-wide singleton in ALL environments. The previous
  // code only memoized it outside production, so in prod every `.fastModeCacheEntry`
  // access constructed a fresh PrismaClient with its own connection pool — under a
  // 50-way fan-out that spawns hundreds of pools and blows past Postgres
  // max_connections, which is a second source of the 500s above.
  if (!globalForDemoCachePrisma.demoCachePrisma) {
    globalForDemoCachePrisma.demoCachePrisma = new PrismaClient({
      log: ['error', 'warn'],
      datasources: {
        db: {
          url: getDemoCacheDatabaseUrl(),
        },
      },
    });
  }
  return globalForDemoCachePrisma.demoCachePrisma;
}

const demoCachePrisma = {
  get fastModeCacheEntry() {
    return getDemoCachePrisma().fastModeCacheEntry;
  },
};

export interface CacheGetResult {
  hit: boolean;
  value: unknown;
  blobPath: string | null;
}

interface DemoCacheReadRow {
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
    'demo_cache.memory_lookup',
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
    'demo_cache.singleflight_claim',
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
      ? withSpan('demo_cache.singleflight_wait', { waiter_count: waits.length }, async () => {
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
  let rows: DemoCacheReadRow[] = [];
  try {
    rows = await withSpan('demo_cache.prisma_find_many', dbSpanMeta, async () => {
      const rows = await demoCachePrisma.fastModeCacheEntry.findMany({
        where: { key: { in: keysToFetch } },
        select: { key: true, value: true, blobPath: true, goalHash: true },
      });
      dbSpanMeta.row_count = rows.length;
      return rows;
    });
    // Large bodies live in Storage behind a pointer; an unreadable one is a miss.
    rows = await withSpan('demo_cache.offload_rehydrate', { row_count: rows.length }, () =>
      rehydrateRows(rows)
    );

    await withSpan(
      'demo_cache.result_build',
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
  await waitPromise;
  return result;
}

export async function cacheSetWithAck(args: {
  key: string;
  kind: CacheKind;
  goalHash: string;
  value: unknown;
  blobPath?: string | null;
}): Promise<boolean> {
  if (demoCacheWritesDisabled()) {
    log.info('demo_cache.write_skipped_read_only', { key: args.key, kind: args.kind });
    return false;
  }
  const value = stripSecrets(args.value);
  const blobPath = args.blobPath ?? null;
  deleteMemoryCache(args.key);
  const prepared = blobPath === null ? prepareOffload(args.kind, value) : null;
  if (prepared) {
    // Re-recording an identical large body: the row already points at it, so
    // skip the upload and the write (each used to rewrite the TOASTed value).
    const existing = await demoCachePrisma.fastModeCacheEntry.findUnique({
      where: { key: args.key },
      select: { kind: true, goalHash: true, value: true, blobPath: true },
    });
    if (
      existing &&
      existing.kind === args.kind &&
      existing.goalHash === args.goalHash &&
      existing.blobPath === null &&
      offloadPointer(existing.value)?.sha256 === prepared.pointer.sha256
    ) {
      writeMemoryCache(args.key, args.goalHash, { hit: true, value, blobPath });
      return true;
    }
    await uploadOffload(prepared);
  }
  const stored = prepared ? prepared.marker : value;
  try {
    await demoCachePrisma.fastModeCacheEntry.upsert({
      where: { key: args.key },
      create: {
        key: args.key,
        kind: args.kind,
        goalHash: args.goalHash,
        value: (stored ?? null) as object,
        blobPath,
      },
      update: {
        kind: args.kind,
        goalHash: args.goalHash,
        value: (stored ?? null) as object,
        blobPath,
      },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      await demoCachePrisma.fastModeCacheEntry.update({
        where: { key: args.key },
        data: {
          kind: args.kind,
          goalHash: args.goalHash,
          value: (stored ?? null) as object,
          blobPath,
        },
      });
      writeMemoryCache(args.key, args.goalHash, { hit: true, value, blobPath });
      return true;
    }
    throw error;
  }
  writeMemoryCache(args.key, args.goalHash, { hit: true, value, blobPath });
  return true;
}
export async function cachePurge(goalHash: string): Promise<number> {
  const res = await demoCachePrisma.fastModeCacheEntry.deleteMany({ where: { goalHash } });
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
  const v42 = `fastmode:v42:llm:${args.goalHash}:${site}:`;
  const v43 = `fastmode:v43:llm:${args.goalHash}:${site}:`;
  let rows: Array<{ key: string; value: unknown; blobPath: string | null }>;
  if (step === null) {
    // One goalHash-indexed scan replaces up to four serial remote DB round
    // trips. The ranking is version, warm-era row, then creation time.
    rows = await getDemoCachePrisma().$queryRawUnsafe(
      `
        SELECT key, value, "blobPath"
        FROM "FastModeCacheEntry"
        WHERE "goalHash" = $1 AND kind = 'llm'
          AND (key LIKE $2 ESCAPE '\\' OR key LIKE $3 ESCAPE '\\')
        ORDER BY
          CASE WHEN key LIKE $2 ESCAPE '\\' THEN 0 ELSE 1 END,
          CASE WHEN "createdAt" < TIMESTAMPTZ '2026-08-25' THEN 0 ELSE 1 END,
          "createdAt" ASC
        LIMIT 1
      `,
      args.goalHash,
      `${v42}c:%`,
      `${v43}c:%`
    );
  } else {
    // Rank exact v42, forward v42, exact v43, forward v43. Within each
    // bucket prefer warm-era entries, then the nearest forward step and
    // oldest write. Filtering to this goalHash keeps the scan bounded.
    rows = await getDemoCachePrisma().$queryRawUnsafe(
      `
        WITH candidates AS (
          SELECT key, value, "blobPath", "createdAt",
            (substring(key from ':p:([0-9]+):c:'))::int AS slot_step
          FROM "FastModeCacheEntry"
          WHERE "goalHash" = $1 AND kind = 'llm'
            AND (key LIKE $2 ESCAPE '\\' OR key LIKE $3 ESCAPE '\\')
        )
        SELECT key, value, "blobPath"
        FROM candidates
        WHERE slot_step >= $6
        ORDER BY
          CASE
            WHEN key LIKE $4 ESCAPE '\\' THEN 0
            WHEN key LIKE $2 ESCAPE '\\' THEN 1
            WHEN key LIKE $5 ESCAPE '\\' THEN 2
            ELSE 3
          END,
          CASE WHEN "createdAt" < TIMESTAMPTZ '2026-08-25' THEN 0 ELSE 1 END,
          CASE
            WHEN key LIKE $4 ESCAPE '\\' OR key LIKE $5 ESCAPE '\\' THEN NULL
            ELSE slot_step
          END ASC,
          "createdAt" ASC
        LIMIT 1
      `,
      args.goalHash,
      `${v42}p:%:c:%`,
      `${v43}p:%:c:%`,
      `${v42}p:${step}:c:%`,
      `${v43}p:${step}:c:%`,
      step
    );
  }
  const row = rows[0];
  if (!row) return { hit: false, value: null, blobPath: null, key: null };
  const result: CacheGetResult & { key: string | null } = {
    hit: true,
    value: row.value,
    blobPath: row.blobPath,
    key: row.key,
  };
  writeMemoryCache(row.key, args.goalHash, result);
  return result;
}

export async function agentFastMode(agentId: string): Promise<{
  enabled: boolean;
  goal: string | null;
  writeEnabled: boolean;
  rootAgentId: string | null;
  rootGoal: string | null;
  /** Fast Mode button — LLM provider speed (independent of DEMO cache replay). */
  providerFastMode: boolean;
}> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { fastModeCacheEnabled: true, goal: true, userId: true, busId: true },
  });
  // Persisted flag is the Fast Mode *button* (LLM provider_fast_mode). Cache
  // replay is DEMO-prompt only and ignores the button.
  const providerFastMode = agent?.fastModeCacheEnabled ?? true;
  const rootAgentId = agent?.busId ?? agentId;
  let rootGoal = agent?.goal ?? null;
  // Soft-complete / DEMO cache gates on the tree root's exact bench prompt;
  // child agents keep their own goal for cache keys but inherit via rootGoal.
  if (agent?.busId && agent.busId !== agentId) {
    const root = await prisma.agent.findUnique({
      where: { id: agent.busId },
      select: { goal: true },
    });
    rootGoal = root?.goal ?? null;
  }
  const goal = agent?.goal ?? null;
  const enabled = demoCacheAllowed(goal, rootGoal);
  return {
    enabled,
    goal,
    writeEnabled: demoCacheWriteEnabled(enabled) && shouldWriteDemoCacheForUser(agent?.userId),
    rootAgentId,
    rootGoal,
    providerFastMode,
  };
}

export async function cacheSet(args: Parameters<typeof cacheSetWithAck>[0]): Promise<void> {
  await cacheSetWithAck(args);
}

/** 89% of production browser_http stored bytes were in values of 32 KB or more. */
const OFFLOAD_SCAN_MIN_STORED_BYTES = 16 * 1024;

export interface FastCacheOffloadBatch {
  /** Highest key scanned; pass back as `afterKey`. */
  lastKey: string | null;
  scanned: number;
  /** Rows moved to Storage (dry run: that would move). */
  offloaded: number;
  /** Serialized bytes moved out of the table. */
  bytes: number;
  /** Exact rows moved, with the verified Storage object that now holds each value. */
  offloadedRows: Array<{ key: string; path: string; sha256: string; bytes: number }>;
}

/**
 * Move existing large values of offloaded kinds into Storage, one
 * primary-key-ordered batch at a time. Each body is uploaded and read back
 * (sha256 verified) before its row is pointed at it, and the row is replaced
 * only if it still holds the value that was uploaded, so a concurrent
 * re-record is never overwritten with a stale pointer. Idempotent: rows that
 * already hold a pointer are skipped.
 */
export async function offloadFastCacheBatch(
  afterKey: string | null,
  limit: number,
  options: { dryRun?: boolean; concurrency?: number } = {}
): Promise<FastCacheOffloadBatch> {
  const client = getDemoCachePrisma();
  // One non-interactive transaction per statement: its timeouts apply to that
  // statement only and nothing holds a pooled connection between statements.
  const bounded = async <T>(statement: Prisma.PrismaPromise<T>): Promise<T> => {
    const settings = [
      ...(options.dryRun ? [client.$executeRawUnsafe('SET TRANSACTION READ ONLY')] : []),
      client.$executeRawUnsafe(`SET LOCAL statement_timeout = '15s'`),
      client.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`),
    ];
    const results = await client.$transaction([...settings, statement]);
    return results[results.length - 1] as T;
  };
  // pg_column_size reads the TOAST pointer, not the value: no detoasting here.
  const rows = await bounded(
    client.$queryRaw<Array<{ key: string; kind: string; size: number }>>(Prisma.sql`
      SELECT key, kind, pg_column_size(value)::int AS size FROM "FastModeCacheEntry"
      WHERE ${afterKey === null ? Prisma.sql`TRUE` : Prisma.sql`key > ${afterKey}`}
        AND "blobPath" IS NULL
      ORDER BY key LIMIT ${limit}
    `)
  );
  const batch: FastCacheOffloadBatch = {
    lastKey: rows.length > 0 ? rows[rows.length - 1].key : afterKey,
    scanned: rows.length,
    offloaded: 0,
    bytes: 0,
    offloadedRows: [],
  };
  // Disk is what matters: only rows whose stored (compressed) value takes at
  // least OFFLOAD_SCAN_MIN_STORED_BYTES are read in full; prepareOffload then
  // applies the same serialized-size rule as the write path.
  const candidates = rows.filter(
    (row) => OFFLOAD_KINDS.has(row.kind) && row.size >= OFFLOAD_SCAN_MIN_STORED_BYTES
  );
  // Each row is independent; a bounded pool overlaps the round trips.
  const moveOne = async (candidate: (typeof candidates)[number]): Promise<void> => {
    const [current] = await bounded(
      client.$queryRaw<Array<{ value: unknown; digest: string }>>(Prisma.sql`
        SELECT value, md5(value::text) AS digest FROM "FastModeCacheEntry"
        WHERE key = ${candidate.key} AND "blobPath" IS NULL
      `)
    );
    const prepared = current ? prepareOffload(candidate.kind, current.value) : null;
    if (!current || !prepared) return;
    if (options.dryRun) {
      batch.offloaded += 1;
      batch.bytes += prepared.pointer.bytes;
      return;
    }
    await uploadOffload(prepared);
    const check = await rehydrateRows([{ key: candidate.key, value: prepared.marker }]);
    if (check.length !== 1) throw new Error(`offloaded body did not read back: ${candidate.key}`);
    const updated = await bounded(
      client.$executeRaw(Prisma.sql`
        UPDATE "FastModeCacheEntry" SET value = ${JSON.stringify(prepared.marker)}::jsonb
        WHERE key = ${candidate.key} AND "blobPath" IS NULL
          AND md5(value::text) = ${current.digest}
      `)
    );
    // A concurrent re-record changed the row: leave it; the write path decides.
    if (updated !== 1) return;
    deleteMemoryCache(candidate.key);
    batch.offloaded += 1;
    batch.bytes += prepared.pointer.bytes;
    batch.offloadedRows.push({ key: candidate.key, ...prepared.pointer });
  };
  const queue = [...candidates];
  const workers = Math.max(1, Math.min(options.concurrency ?? 1, 32));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await moveOne(next);
    })
  );
  batch.offloadedRows.sort((a, b) => a.key.localeCompare(b.key));
  return batch;
}
