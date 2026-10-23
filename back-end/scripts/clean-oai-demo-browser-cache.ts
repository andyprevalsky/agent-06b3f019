/**
 * Remove browser- or nested-agent-bearing rows from the saved OAI mass-agent
 * demo trajectory. The legacy filename is retained for operator compatibility.
 *
 * Dry-run by default. With --apply, each target row is archived in place under
 * a non-runtime key/kind. This removes the no-longer-valid trajectory slot
 * without copying the row's potentially sensitive provider accounting fields.
 * Reversal takes two steps, because the archival rewrites both columns: strip
 * the archive-key prefix from `key` AND restore `kind` to 'llm'. Runtime
 * lookups filter on kind = 'llm', so a prefix-strip alone leaves the row
 * archived and invisible.
 *
 * Usage:
 *   npx tsx scripts/clean-oai-demo-browser-cache.ts
 *   npx tsx scripts/clean-oai-demo-browser-cache.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  containsBrowserToolCall,
  containsNestedAgentToolCall,
  rewriteOaiDemoCacheValue,
} from '../src/domains/demo-cache/oaiDemoCacheCleaner';
import { OAI_DEMO_JULY_GP_GOAL_HASHES } from '../src/providers/demoCacheNormalizeOaiDemo';

const CLEANUP_VERSION = 'oai-demo-no-disallowed-agent-v4';
const PREVIOUS_CLEANUP_VERSIONS = [
  'oai-demo-no-browser-v1',
  'oai-demo-no-browser-v2',
  'oai-demo-no-browser-v3',
] as const;
const ARCHIVE_KEY_PREFIX = `maintenance:${CLEANUP_VERSION}:`;
const TARGET_GOAL_HASHES = [...new Set(Object.values(OAI_DEMO_JULY_GP_GOAL_HASHES))];

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
  /** Exact bytes read during the scan; pins the UPDATE against a racing writer. */
  current_value: unknown;
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
    if (!originalKey || !originalFields) continue;
    // Earliest-wins: v1 holds the pristine value, v2 holds one v1 already
    // rewrote. Paired with the query's ORDER BY, the restored original is
    // stable across runs instead of depending on row order.
    if (!originals.has(originalKey)) originals.set(originalKey, originalFields);
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
): {
  patches: ArchivePatch[];
  browserCallsRemoved: number;
  nestedAgentCallsRemoved: number;
  restoredRows: number;
} {
  const patches: ArchivePatch[] = [];
  let browserCallsRemoved = 0;
  let nestedAgentCallsRemoved = 0;
  let restoredRows = 0;
  for (const row of rows) {
    const priorOriginal = priorOriginals.get(row.key);
    const sourceValue = priorOriginal ? restoreChangedFields(row.value, priorOriginal) : row.value;
    if (priorOriginal) restoredRows += 1;
    const result = rewriteOaiDemoCacheValue(sourceValue);
    if (!result.deleteEntry) continue;
    if (!containsBrowserToolCall(sourceValue) && !containsNestedAgentToolCall(sourceValue)) {
      throw new Error(`Archive invariant failed for ${row.goalHash}`);
    }
    browserCallsRemoved += result.browserCallsRemoved;
    nestedAgentCallsRemoved += result.nestedAgentCallsRemoved;
    patches.push({
      original_key: row.key,
      archive_key: `${ARCHIVE_KEY_PREFIX}${row.key}`,
      goal_hash: row.goalHash,
      original_value: sourceValue,
      current_value: row.value,
    });
  }
  return { patches, browserCallsRemoved, nestedAgentCallsRemoved, restoredRows };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const databaseUrl =
    (process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DEMO_CACHE_DATABASE_URL) ||
    process.env.DATABASE_URL;
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
         AND value->>'cleanup' = ANY($2::text[])
       ORDER BY array_position($2::text[], value->>'cleanup'), key`,
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
      `Would archive ${result.patches.length} rows containing ` +
        `${result.browserCallsRemoved} browser calls and ` +
        `${result.nestedAgentCallsRemoved} nested agent calls.`
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

    // The read above, the in-memory patch build, and this UPDATE must be one
    // atomic unit: `current_value` pins each row to the exact bytes that were
    // read, so a cache writer racing us fails the match instead of losing its
    // fresh write, and a count mismatch rolls the whole archival back rather
    // than throwing after a partial commit.
    const archived = await prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRawUnsafe(
        `UPDATE "FastModeCacheEntry" AS entry
         SET key = patch.archive_key,
             kind = 'oai_demo_backup',
             value = patch.original_value
         FROM jsonb_to_recordset($1::jsonb)
           AS patch(original_key text, archive_key text, goal_hash text,
                    original_value jsonb, current_value jsonb)
         WHERE entry.key = patch.original_key
           AND entry.kind = 'llm'
           AND entry."goalHash" = patch.goal_hash
           AND entry.value = patch.current_value`,
        JSON.stringify(result.patches)
      );
      if (updated !== result.patches.length) {
        throw new Error(
          `Expected to archive ${result.patches.length} rows, archived ${updated}. ` +
            'The cache changed under the scan; no rows were archived. Re-run the script.'
        );
      }
      return updated;
    });
    console.log(
      `Archived ${archived} disallowed-agent rows outside the runtime namespace; no rows were copied.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
