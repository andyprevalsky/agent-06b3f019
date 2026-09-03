/**
 * Remove browser-bearing rows from the saved OAI mass-agent demo trajectory.
 *
 * Dry-run by default. With --apply, each target row is archived in place under
 * a non-runtime key/kind. This removes the no-longer-valid trajectory slot
 * without copying the row's potentially sensitive provider accounting fields,
 * and remains exactly reversible by stripping the archive-key prefix.
 *
 * Usage:
 *   npx tsx scripts/clean-oai-demo-browser-cache.ts
 *   npx tsx scripts/clean-oai-demo-browser-cache.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  containsBrowserToolCall,
  rewriteOaiDemoCacheValue,
} from '../src/domains/fast-cache/oaiDemoCacheCleaner';

const CLEANUP_VERSION = 'oai-demo-no-browser-v3';
const PREVIOUS_CLEANUP_VERSIONS = ['oai-demo-no-browser-v1', 'oai-demo-no-browser-v2'] as const;
const ARCHIVE_KEY_PREFIX = `maintenance:${CLEANUP_VERSION}:`;
const TARGET_GOAL_HASHES = [
  '2a5047c41ade580c', // Pieter Levels
  '5872737e678bfc65', // Ali Abdaal
  '5e1731f836723fb1', // Andrew Huberman
  '74732a761f790f81', // Nathaniel Drew
  '870aa798f805d115', // Max Lugavere
  'a33288f6c3a3e484', // Eric Topol
] as const;

type CacheRow = {
  key: string;
  goalHash: string;
  value: unknown;
};

type BackupRow = {
  value: unknown;
};

type ArchivePatch = {
  original_key: string;
  archive_key: string;
  goal_hash: string;
  original_value: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function backupOriginals(rows: BackupRow[]): Map<string, Record<string, unknown>> {
  const originals = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const backup = asRecord(row.value);
    const originalKey = typeof backup?.original_key === 'string' ? backup.original_key : '';
    const originalFields = asRecord(backup?.original_fields);
    if (originalKey && originalFields) originals.set(originalKey, originalFields);
  }
  return originals;
}

function restoreChangedFields(current: unknown, originalFields: Record<string, unknown>): unknown {
  const restored = structuredClone(asRecord(current) ?? {});
  for (const name of ['content', 'reasoning', 'tool_calls'] as const) {
    if (Object.prototype.hasOwnProperty.call(originalFields, name)) {
      restored[name] = structuredClone(originalFields[name]);
    } else {
      delete restored[name];
    }
  }
  return restored;
}

function buildArchivePatches(
  rows: CacheRow[],
  priorOriginals: Map<string, Record<string, unknown>>
): { patches: ArchivePatch[]; browserCallsRemoved: number; restoredRows: number } {
  const patches: ArchivePatch[] = [];
  let browserCallsRemoved = 0;
  let restoredRows = 0;
  for (const row of rows) {
    const priorOriginal = priorOriginals.get(row.key);
    const sourceValue = priorOriginal ? restoreChangedFields(row.value, priorOriginal) : row.value;
    if (priorOriginal) restoredRows += 1;
    const result = rewriteOaiDemoCacheValue(sourceValue);
    if (!result.deleteEntry) continue;
    if (!containsBrowserToolCall(sourceValue)) {
      throw new Error(`Archive invariant failed for ${row.goalHash}`);
    }
    browserCallsRemoved += result.browserCallsRemoved;
    patches.push({
      original_key: row.key,
      archive_key: `${ARCHIVE_KEY_PREFIX}${row.key}`,
      goal_hash: row.goalHash,
      original_value: sourceValue,
    });
  }
  return { patches, browserCallsRemoved, restoredRows };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const databaseUrl = process.env.FAST_MODE_CACHE_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('FAST_MODE_CACHE_DATABASE_URL or DATABASE_URL is required');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  try {
    const rows = await prisma.$queryRawUnsafe<CacheRow[]>(
      `SELECT key, "goalHash", value
       FROM "FastModeCacheEntry"
       WHERE kind = 'llm' AND "goalHash" = ANY($1::text[])
       ORDER BY "createdAt", key`,
      [...TARGET_GOAL_HASHES]
    );
    const backupRows = await prisma.$queryRawUnsafe<BackupRow[]>(
      `SELECT value
       FROM "FastModeCacheEntry"
       WHERE kind = 'oai_demo_backup'
         AND "goalHash" = ANY($1::text[])
         AND value->>'cleanup' = ANY($2::text[])`,
      [...TARGET_GOAL_HASHES],
      [...PREVIOUS_CLEANUP_VERSIONS]
    );
    const result = buildArchivePatches(rows, backupOriginals(backupRows));
    const counts = new Map<string, number>();
    for (const patch of result.patches) {
      counts.set(patch.goal_hash, (counts.get(patch.goal_hash) ?? 0) + 1);
    }

    console.log(
      `Scanned ${rows.length} runtime LLM rows across ${TARGET_GOAL_HASHES.length} goal hashes.`
    );
    if (result.restoredRows > 0) {
      console.log(`Recovered ${result.restoredRows} original rows from prior cleanup backups.`);
    }
    console.log(
      `Would archive ${result.patches.length} rows containing ${result.browserCallsRemoved} browser calls.`
    );
    for (const hash of TARGET_GOAL_HASHES) {
      console.log(`  ${hash}: ${counts.get(hash) ?? 0} row(s)`);
    }

    if (!apply || result.patches.length === 0) {
      console.log(
        apply ? 'Nothing to archive.' : 'DRY RUN — pass --apply to archive these runtime rows.'
      );
      return;
    }

    const archived = await prisma.$executeRawUnsafe(
      `UPDATE "FastModeCacheEntry" AS entry
       SET key = patch.archive_key,
           kind = 'oai_demo_backup',
           value = patch.original_value
       FROM jsonb_to_recordset($1::jsonb)
         AS patch(original_key text, archive_key text, goal_hash text, original_value jsonb)
       WHERE entry.key = patch.original_key
         AND entry.kind = 'llm'
         AND entry."goalHash" = patch.goal_hash`,
      JSON.stringify(result.patches)
    );
    if (archived !== result.patches.length) {
      throw new Error(`Expected to archive ${result.patches.length} rows, archived ${archived}`);
    }
    console.log(
      `Archived ${archived} browser-bearing rows outside the runtime namespace; no rows were copied.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
