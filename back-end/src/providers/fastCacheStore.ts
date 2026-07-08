import { PrismaClient } from '@prisma/client';
import { prisma } from './database';
import { shouldWriteFastModeCacheForUser } from './fastCacheAccountPolicy';
import { type CacheKind } from './fastCacheNormalizeConstants';
import { stripSecrets } from './fastCacheNormalizeCore';

const globalForFastCachePrisma = global as unknown as {
  fastCacheMemory?: Map<string, FastCacheMemoryEntry>;
  fastCachePrisma?: PrismaClient;
};

interface FastCacheMemoryEntry {
  expiresAt: number;
  goalHash: string;
  result: CacheGetResult;
}

const MEMORY_CACHE_TTL_MS = Number(process.env.FAST_CACHE_MEMORY_TTL_MS ?? '300000');
const MEMORY_CACHE_MAX_ENTRIES = Number(process.env.FAST_CACHE_MEMORY_MAX_ENTRIES ?? '50000');

function getMemoryCache(): Map<string, FastCacheMemoryEntry> {
  if (!globalForFastCachePrisma.fastCacheMemory) {
    globalForFastCachePrisma.fastCacheMemory = new Map();
  }
  return globalForFastCachePrisma.fastCacheMemory;
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
      url.searchParams.set('connection_limit', process.env.FAST_CACHE_DB_POOL ?? '25');
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

export async function cacheGet(key: string): Promise<CacheGetResult> {
  const cached = readMemoryCache(key);
  if (cached) return cached;

  const row = await fastCachePrisma.fastModeCacheEntry.findUnique({
    where: { key },
    select: { value: true, blobPath: true, goalHash: true },
  });
  if (row === null) return { hit: false, value: null, blobPath: null };
  const result = { hit: true, value: row.value, blobPath: row.blobPath };
  writeMemoryCache(key, row.goalHash, result);
  return result;
}

export async function cacheGetMany(keys: string[]): Promise<Record<string, CacheGetResult>> {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return {};

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

  if (missedKeys.length === 0) return result;

  const rows = await fastCachePrisma.fastModeCacheEntry.findMany({
    where: { key: { in: missedKeys } },
    select: { key: true, value: true, blobPath: true, goalHash: true },
  });

  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const key of missedKeys) {
    const row = byKey.get(key);
    if (row === undefined) {
      result[key] = { hit: false, value: null, blobPath: null };
    } else {
      const hit = { hit: true, value: row.value, blobPath: row.blobPath };
      result[key] = hit;
      writeMemoryCache(key, row.goalHash, hit);
    }
  }
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

export async function agentFastMode(agentId: string): Promise<{
  enabled: boolean;
  goal: string | null;
  writeEnabled: boolean;
  rootAgentId: string | null;
}> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { fastModeCacheEnabled: true, goal: true, userId: true, busId: true },
  });
  const enabled = agent?.fastModeCacheEnabled ?? false;
  return {
    enabled,
    goal: agent?.goal ?? null,
    writeEnabled: enabled || shouldWriteFastModeCacheForUser(agent?.userId),
    rootAgentId: agent?.busId ?? agentId,
  };
}
