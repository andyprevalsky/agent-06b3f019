/**
 * Identify non-completing children of a mass-agent run, map each to its demo-cache
 * goalHash, BACK UP their cache entries to a JSON file, and (only with --delete)
 * remove them so they re-run fresh. Reversible: the backup restores every deleted row.
 *
 * goalHash = sha256(canonicalize(goal))[:16], where canonicalize collapses
 * `@ref:message:<uuid>` (mirrors agents/providers/demo_cache/normalize.py:goal_hash).
 *
 * Usage:
 *   npx tsx scripts/mass-cull-stuck.ts <rootId>            # dry run: list stuck children + entry counts
 *   npx tsx scripts/mass-cull-stuck.ts <rootId> --delete   # back up, then delete their entries
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';

const url = readFileSync('/tmp/prod_db_url.txt', 'utf8').trim();
const p = new PrismaClient({ datasources: { db: { url } } });

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
function goalHash(goal: string): string {
  const canonical = goal.replace(
    new RegExp('@ref:message:' + UUID.source, 'g'),
    '@ref:message:<uuid>'
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

async function childCompleted(agentId: string, status: string): Promise<boolean> {
  if (status === 'COMPLETED') return true;
  const n = await p.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "Message" WHERE "agentId"=$1 AND metadata->>'toolName'='attempt_completion' AND metadata->>'toolStatus'='FINISHED' AND (metadata->>'title' ILIKE '%100%%' OR metadata->>'title' ILIKE '%Task Complete%')`,
    agentId
  );
  return (n[0]?.n ?? 0) > 0;
}

async function main() {
  const root = process.argv[2];
  const doDelete = process.argv.includes('--delete');
  if (!root) throw new Error('usage: mass-cull-stuck.ts <rootId> [--delete]');
  const r = await p.$queryRawUnsafe<Array<{ busId: string }>>(
    `SELECT "busId" FROM "Agent" WHERE id=$1`,
    root
  );
  const bus = r[0]?.busId;
  const kids = await p.$queryRawUnsafe<Array<{ id: string; status: string; goal: string }>>(
    `SELECT id, status, goal FROM "Agent" WHERE "busId"=$1 AND "parentAgentId" IS NOT NULL`,
    bus
  );

  const stuckHashes = new Set<string>();
  let stuck = 0;
  for (const k of kids) {
    if (await childCompleted(k.id, k.status)) continue;
    stuck++;
    stuckHashes.add(goalHash(k.goal ?? ''));
  }
  console.log(`root ${root.slice(0, 8)}: ${kids.length} children, ${stuck} stuck (non-completing)`);
  console.log(`distinct stuck goalHashes: ${stuckHashes.size}`);
  if (stuckHashes.size === 0) {
    console.log('nothing to cull.');
    await p.$disconnect();
    return;
  }

  const hashes = [...stuckHashes];
  const entries = await p.$queryRawUnsafe<
    Array<{ key: string; kind: string; goalHash: string; value: unknown; blobPath: string | null }>
  >(
    `SELECT key, kind, "goalHash", value, "blobPath" FROM "FastModeCacheEntry" WHERE "goalHash" = ANY($1)`,
    hashes
  );
  console.log(`cache entries under stuck goalHashes: ${entries.length}`);

  const backupPath = `/Users/andyprevalsky/conductor/workspaces/navi-whisper-lux-v2/davis-v1/.context/cache-backups/cull-${root.slice(0, 8)}-${entries.length}entries.json`;
  writeFileSync(
    backupPath,
    JSON.stringify({ root, hashes, entries }, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1)
  );
  console.log(`BACKED UP ${entries.length} entries -> ${backupPath}`);

  if (!doDelete) {
    console.log('DRY RUN — pass --delete to remove these entries (backup already written).');
    await p.$disconnect();
    return;
  }
  const del = await p.$executeRawUnsafe(
    `DELETE FROM "FastModeCacheEntry" WHERE "goalHash" = ANY($1)`,
    hashes
  );
  console.log(`DELETED ${del} cache entries. Restore with the backup JSON if needed.`);
  await p.$disconnect();
}

main().catch((e) => {
  console.error('ERR', (e as Error).message);
  process.exit(1);
});
