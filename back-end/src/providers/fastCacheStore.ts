import { PrismaClient } from '@prisma/client';
import { prisma } from './database';
import { shouldWriteFastModeCacheForUser } from './fastCacheAccountPolicy';
import { type CacheKind } from './fastCacheNormalizeConstants';
import { stripSecrets } from './fastCacheNormalizeCore';

const globalForFastCachePrisma = global as unknown as { fastCachePrisma?: PrismaClient };

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
  const row = await fastCachePrisma.fastModeCacheEntry.findUnique({ where: { key } });
  if (row === null) return { hit: false, value: null, blobPath: null };
  return { hit: true, value: row.value, blobPath: row.blobPath };
}

export async function cacheGetMany(keys: string[]): Promise<Record<string, CacheGetResult>> {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return {};

  const rows = await fastCachePrisma.fastModeCacheEntry.findMany({
    where: { key: { in: uniqueKeys } },
    select: { key: true, value: true, blobPath: true },
  });

  const byKey = new Map(rows.map((row) => [row.key, row]));
  const result: Record<string, CacheGetResult> = {};
  for (const key of uniqueKeys) {
    const row = byKey.get(key);
    if (row === undefined) {
      result[key] = { hit: false, value: null, blobPath: null };
    } else {
      result[key] = { hit: true, value: row.value, blobPath: row.blobPath };
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
      return;
    }
    throw error;
  }
}

export async function cachePurge(goalHash: string): Promise<number> {
  const res = await fastCachePrisma.fastModeCacheEntry.deleteMany({ where: { goalHash } });
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
