import { PrismaClient } from '@prisma/client';
import { prisma } from './database';
import { shouldWriteFastModeCacheForUser } from './fastCacheAccountPolicy';
import { type CacheKind } from './fastCacheNormalizeConstants';
import { stripSecrets } from './fastCacheNormalizeCore';

const globalForFastCachePrisma = global as unknown as { fastCachePrisma?: PrismaClient };

function getFastCacheDatabaseUrl(): string {
  return process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
}

const fastCachePrisma =
  globalForFastCachePrisma.fastCachePrisma ??
  new PrismaClient({
    log: ['error', 'warn'],
    datasources: {
      db: {
        url: getFastCacheDatabaseUrl(),
      },
    },
  });

if (process.env.NODE_ENV !== 'production') {
  globalForFastCachePrisma.fastCachePrisma = fastCachePrisma;
}

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

export async function agentFastMode(
  agentId: string
): Promise<{ enabled: boolean; goal: string | null; writeEnabled: boolean }> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { fastModeCacheEnabled: true, goal: true, userId: true },
  });
  const enabled = agent?.fastModeCacheEnabled ?? false;
  return {
    enabled,
    goal: agent?.goal ?? null,
    writeEnabled: enabled || shouldWriteFastModeCacheForUser(agent?.userId),
  };
}
