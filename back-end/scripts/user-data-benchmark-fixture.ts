/**
 * Deterministic data fixture for the `user-data-prod-grep` benchmark.
 *
 * The benchmark greps the user's normalized user-data documents (sources:
 * apple_notes, chatgpt, claude, obsidian) and must cite prod-derived evidence
 * per provider. Rather than a live prod sync (non-deterministic — prod changes
 * between runs) we FREEZE the real prod documents to a gitignored fixture file
 * ONCE, then deterministically APPLY that frozen file into the isolated
 * benchmark DB on every run. This mirrors the frozen-snapshot approach used by
 * grep-explore-stress (grep-base-snapshot.sql) and the real-data import used by
 * the Plaid fixture — real (non-synthetic) data, made reproducible.
 *
 * Actions:
 *   freeze  — read real docs from BENCHMARK_USER_DATA_SOURCE_DATABASE_URL and
 *             write the frozen fixture JSON (idempotent: no-op if it exists).
 *   apply   — ensure the frozen file exists (freeze if a source URL is set),
 *             then upsert its rows into DATABASE_URL (the benchmark DB).
 *   cleanup — delete the fixture's documents + provider sync-state rows.
 *   summary — print counts from the frozen file.
 *
 * Usage: npx tsx scripts/user-data-benchmark-fixture.ts <action>
 */

import { PrismaClient } from '@prisma/client';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient(); // target = process.env.DATABASE_URL (benchmark DB)
const USER_ID = process.env.BENCHMARK_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const SOURCE_DATABASE_URL = process.env.BENCHMARK_USER_DATA_SOURCE_DATABASE_URL;

// Providers the benchmark's provider_validation_checklist must cover. Keep in
// sync with USER_DATA_PROD_DOCUMENT_SOURCES in agents/benchmarks/run_benchmark.py.
const FIXTURE_SOURCES = ['apple_notes', 'chatgpt', 'claude', 'obsidian'];

const REPO_ROOT = resolve(__dirname, '..', '..');
const FROZEN_PATH =
  process.env.BENCHMARK_USER_DATA_FIXTURE?.trim() ||
  resolve(REPO_ROOT, '.context', 'benchmarks', 'user-data-grep-fixture.json');

type FrozenFixture = {
  user_id: string;
  frozen_from: string;
  sources: string[];
  documents: any[];
  provider_sync_states: any[];
};

function prismaPooledPostgresUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return trimmed;
    if (!url.searchParams.has('pgbouncer')) url.searchParams.set('pgbouncer', 'true');
    if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '1');
    return url.toString();
  } catch {
    return trimmed;
  }
}

function sourcePrismaClient(): PrismaClient | null {
  if (!SOURCE_DATABASE_URL || SOURCE_DATABASE_URL.trim() === '') return null;
  if (SOURCE_DATABASE_URL === process.env.DATABASE_URL) return null;
  return new PrismaClient({
    datasources: { db: { url: prismaPooledPostgresUrl(SOURCE_DATABASE_URL) } },
  });
}

async function freeze(): Promise<FrozenFixture> {
  if (existsSync(FROZEN_PATH) && statSync(FROZEN_PATH).size > 0) {
    return JSON.parse(readFileSync(FROZEN_PATH, 'utf8')) as FrozenFixture;
  }
  const source = sourcePrismaClient();
  if (!source) {
    throw new Error(
      `Frozen user-data fixture missing at ${FROZEN_PATH} and no ` +
        'BENCHMARK_USER_DATA_SOURCE_DATABASE_URL set to derive it from prod. ' +
        'Run once with the source URL to freeze it.'
    );
  }
  try {
    const documents = await source.userDataDocument.findMany({
      where: { userId: USER_ID, source: { in: FIXTURE_SOURCES }, deletedAt: null },
      orderBy: [{ source: 'asc' }, { externalId: 'asc' }],
    });
    const providerSyncStates = await source.userDataProviderSyncState.findMany({
      where: { userId: USER_ID, source: { in: FIXTURE_SOURCES } },
      orderBy: [{ source: 'asc' }],
    });
    const frozen: FrozenFixture = {
      user_id: USER_ID,
      frozen_from: 'prod',
      sources: FIXTURE_SOURCES,
      documents,
      provider_sync_states: providerSyncStates,
    };
    mkdirSync(dirname(FROZEN_PATH), { recursive: true });
    writeFileSync(FROZEN_PATH, JSON.stringify(frozen, null, 0));
    console.error(
      `  🧊 Froze ${documents.length} user-data documents + ` +
        `${providerSyncStates.length} sync states to ${FROZEN_PATH}`
    );
    return frozen;
  } finally {
    await source.$disconnect();
  }
}

async function cleanup(): Promise<void> {
  await prisma.userDataDocument.deleteMany({
    where: { userId: USER_ID, source: { in: FIXTURE_SOURCES } },
  });
  await prisma.userDataProviderSyncState.deleteMany({
    where: { userId: USER_ID, source: { in: FIXTURE_SOURCES } },
  });
}

async function apply(): Promise<{ document_count: number; provider_count: number }> {
  const frozen = await freeze();
  // Reset to the frozen set so the benchmark DB is deterministic regardless of
  // any base-image drift.
  await cleanup();

  for (const state of frozen.provider_sync_states) {
    const { id, ...rest } = state;
    await prisma.userDataProviderSyncState.upsert({
      where: { userId_source: { userId: USER_ID, source: state.source } },
      create: { ...state, userId: USER_ID },
      update: { ...rest, userId: USER_ID },
    });
  }

  for (let i = 0; i < frozen.documents.length; i += 500) {
    const batch = frozen.documents.slice(i, i + 500);
    await Promise.all(
      batch.map((doc) => {
        const { id, ...rest } = doc;
        return prisma.userDataDocument.upsert({
          where: {
            userId_source_externalId: {
              userId: USER_ID,
              source: doc.source,
              externalId: doc.externalId,
            },
          },
          create: { ...doc, userId: USER_ID },
          update: { ...rest, userId: USER_ID },
        });
      })
    );
  }
  return {
    document_count: frozen.documents.length,
    provider_count: frozen.provider_sync_states.length,
  };
}

async function main(): Promise<void> {
  const action = process.argv[2] || 'apply';
  try {
    if (action === 'freeze') {
      const frozen = await freeze();
      process.stdout.write(
        JSON.stringify({
          document_count: frozen.documents.length,
          provider_count: frozen.provider_sync_states.length,
          frozen_path: FROZEN_PATH,
        })
      );
    } else if (action === 'apply') {
      const manifest = await apply();
      process.stdout.write(JSON.stringify(manifest));
    } else if (action === 'cleanup') {
      await cleanup();
      process.stdout.write(JSON.stringify({ cleaned: true }));
    } else if (action === 'summary') {
      const frozen = existsSync(FROZEN_PATH)
        ? (JSON.parse(readFileSync(FROZEN_PATH, 'utf8')) as FrozenFixture)
        : null;
      process.stdout.write(
        JSON.stringify({
          exists: Boolean(frozen),
          document_count: frozen?.documents.length ?? 0,
          provider_count: frozen?.provider_sync_states.length ?? 0,
          frozen_path: FROZEN_PATH,
        })
      );
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
