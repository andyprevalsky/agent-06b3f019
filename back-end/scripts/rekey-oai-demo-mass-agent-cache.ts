/**
 * Rekey Jul 2026 OAi-demo / test-mass-agent-run-0 *general-purpose* child Fast
 * Mode cache namespaces onto today's `build_for_each_goal` goal hashes.
 *
 * Prefer namespaces whose LLM keys include `execute_loop` (for_each GP children).
 * Explore-agent-heavy namespaces are excluded — they are a different harness path.
 *
 * Usage (prod DATABASE_URL):
 *   npx tsx scripts/rekey-oai-demo-mass-agent-cache.ts           # dry run
 *   npx tsx scripts/rekey-oai-demo-mass-agent-cache.ts --apply   # replace+copy
 *   npx tsx scripts/rekey-oai-demo-mass-agent-cache.ts --apply --purge-dest
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { PrismaClient } from '@prisma/client';

const REF_RE =
  /@ref:message:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const canon = (g: string) => sha16(g.replace(REF_RE, '@ref:message:<uuid>'));

const ROOT_GOAL_HASH = '4ae3193053ac1d8f';
const APPLY = process.argv.includes('--apply');
const PURGE_DEST = process.argv.includes('--purge-dest');

type CreatorItem = {
  rank: number;
  name: string;
  primary_niche_angle?: string;
  platforms?: unknown;
};

/**
 * Match Python `json.dumps(obj, ensure_ascii=True, sort_keys=True)` spacing
 * (`, ` / `: `) — required because Fast Mode JSONB round-trips reorder keys
 * and `build_for_each_goal` now dumps with sort_keys=True.
 */
function pyAsciiEscape(jsonQuoted: string): string {
  // JSON.stringify keeps non-ASCII; Python ensure_ascii=True emits \\uXXXX.
  return jsonQuoted.replace(/[\u007f-\uffff]/g, (ch) => {
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

function pyJsonDumps(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    // Python json.dumps emits a trailing `.0` for whole-number floats. JS cannot
    // distinguish 1 from 1.0, so keep String(value) (matches Python ints — the
    // common case for rank / counts in creator payloads).
    return String(value);
  }
  if (typeof value === 'string') return pyAsciiEscape(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${pyAsciiEscape(JSON.stringify(k))}: ${pyJsonDumps(v)}`);
    return `{${entries.join(', ')}}`;
  }
  throw new Error(`unsupported json value: ${typeof value}`);
}

function buildForEachGoal(baseGoal: string, item: unknown): string {
  // Must match agents/domains/spawn_agent/service.py:build_for_each_goal
  // (Python json.dumps ensure_ascii=True, sort_keys=True), not JS JSON.stringify.
  return `${baseGoal}\n\nUse this row context for the task below.\nRow item:\n${pyJsonDumps(item)}`;
}

async function loadWarmPayload(prisma: PrismaClient): Promise<{
  baseGoal: string;
  items: CreatorItem[];
}> {
  const snapPath = '/tmp/oai-demo-fast-cache-namespace.json';
  if (existsSync(snapPath)) {
    const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as {
      forEachBaseGoal: string;
      items: CreatorItem[];
    };
    if (snap.forEachBaseGoal && Array.isArray(snap.items) && snap.items.length === 50) {
      return { baseGoal: snap.forEachBaseGoal, items: snap.items };
    }
  }

  const rows = await prisma.$queryRawUnsafe<Array<{ value: unknown }>>(
    `
    SELECT value FROM "FastModeCacheEntry"
    WHERE "goalHash" = $1
      AND kind = 'llm'
      AND key LIKE '%:dag_param_populator:p:1:%'
    ORDER BY "createdAt" ASC
    LIMIT 1
  `,
    ROOT_GOAL_HASH
  );
  const value = rows[0]?.value as {
    tool_calls?: Array<{ function?: { arguments?: string } }>;
  } | null;
  const argsRaw = value?.tool_calls?.[0]?.function?.arguments;
  if (!argsRaw || typeof argsRaw !== 'string') {
    throw new Error('Could not load dag_param_populator:p:1 warm payload');
  }
  const args = JSON.parse(argsRaw) as { goal?: string; items?: CreatorItem[] };
  if (!args.goal || !Array.isArray(args.items) || args.items.length !== 50) {
    throw new Error('Unexpected dag_param_populator args shape');
  }
  return { baseGoal: args.goal, items: args.items };
}

async function gpChildNamespaces(
  prisma: PrismaClient,
  names: string[]
): Promise<Map<string, { goalHash: string; n: number; execN: number; first: string }>> {
  // Only namespaces that actually recorded execute_loop slots — the for_each
  // general-purpose child path used by the OAi demo / mass-agent-0 warm cache.
  const ns = await prisma.$queryRawUnsafe<
    Array<{ goalHash: string; n: number; execN: number; first: Date }>
  >(
    `
    SELECT
      "goalHash",
      count(*)::int AS n,
      count(*) FILTER (WHERE key LIKE '%:execute_loop:%')::int AS "execN",
      min("createdAt") AS first
    FROM "FastModeCacheEntry"
    WHERE kind = 'llm'
      AND "createdAt" >= '2026-07-03T16:20:00Z'
      AND "createdAt" < '2026-07-15T00:00:00Z'
      AND "goalHash" <> $1
      AND key LIKE '%:execute_loop:%'
    GROUP BY 1
    HAVING count(*) FILTER (WHERE key LIKE '%:execute_loop:%') >= 2
    ORDER BY "execN" DESC, n DESC, first ASC
  `,
    ROOT_GOAL_HASH
  );

  const best = new Map<string, { goalHash: string; n: number; execN: number; first: string }>();
  for (const row of ns) {
    // Skip explore-dominant namespaces that also happen to mention a creator.
    const exploreN = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int n FROM "FastModeCacheEntry"
       WHERE "goalHash"=$1 AND kind='llm' AND key LIKE '%:explore_agent:%'`,
      row.goalHash
    );
    if ((exploreN[0]?.n ?? 0) > row.execN) continue;

    const sample = await prisma.$queryRawUnsafe<Array<{ value: unknown }>>(
      `SELECT value FROM "FastModeCacheEntry" WHERE "goalHash"=$1 AND kind='llm'`,
      row.goalHash
    );
    const text = sample.map((s) => JSON.stringify(s.value || '')).join('\n');
    // Prefer an explicit row-item `"name":"..."` match (for_each child goals embed
    // the creator JSON). Fall back to unique free-text mention, then highest count.
    const jsonHits = names.filter(
      (name) =>
        text.includes(`"name":${JSON.stringify(name)}`) ||
        text.includes(`"name": ${JSON.stringify(name)}`)
    );
    const textHits = names.filter((name) => text.includes(name));
    let name: string | null = null;
    if (jsonHits.length === 1) {
      name = jsonHits[0];
    } else if (textHits.length === 1) {
      name = textHits[0];
    } else if (textHits.length > 1) {
      name =
        textHits.map((n) => ({ n, c: text.split(n).length - 1 })).sort((a, b) => b.c - a.c)[0]?.n ??
        null;
    }
    if (!name) continue;
    const prev = best.get(name);
    if (!prev || row.execN > prev.execN || (row.execN === prev.execN && row.n > prev.n)) {
      best.set(name, {
        goalHash: row.goalHash,
        n: row.n,
        execN: row.execN,
        first: row.first.toISOString(),
      });
    }
  }
  return best;
}

async function main() {
  const url =
    (process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DEMO_CACHE_DATABASE_URL) ||
    process.env.DATABASE_URL;
  if (!url) throw new Error('FAST_MODE_CACHE_DATABASE_URL or DATABASE_URL required');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const { baseGoal, items } = await loadWarmPayload(prisma);
    const names = items.map((i) => i.name);
    console.log(`warm base goal hash=${canon(baseGoal)} creators=${names.length}`);

    const best = await gpChildNamespaces(prisma, names);
    console.log(`mapped GP execute_loop namespaces: ${best.size}/50`);

    const pairs: Array<{
      name: string;
      oldHash: string;
      newHash: string;
      sourceEntries: number;
      execN: number;
    }> = [];
    const missing: string[] = [];

    for (const item of items) {
      const src = best.get(item.name);
      if (!src) {
        missing.push(item.name);
        continue;
      }
      const newHash = canon(buildForEachGoal(baseGoal, item));
      pairs.push({
        name: item.name,
        oldHash: src.goalHash,
        newHash,
        sourceEntries: src.n,
        execN: src.execN,
      });
    }

    if (missing.length) {
      console.error('MISSING creators (no execute_loop namespace):', missing);
    }

    let copied = 0;
    let purged = 0;
    for (const p of pairs) {
      if (p.oldHash === p.newHash) {
        console.log(`  ${p.name}: already on target hash ${p.newHash}`);
        continue;
      }
      const existing = await prisma.fastModeCacheEntry.count({
        where: { goalHash: p.newHash },
      });
      const sourceCount = await prisma.fastModeCacheEntry.count({
        where: { goalHash: p.oldHash },
      });
      console.log(
        `  ${p.name}: ${p.oldHash} → ${p.newHash} (src=${sourceCount}, exec=${p.execN}, dest_existing=${existing})${
          APPLY ? '' : ' [dry-run]'
        }`
      );
      if (!APPLY) continue;
      if (PURGE_DEST && existing > 0) {
        const del = await prisma.fastModeCacheEntry.deleteMany({
          where: { goalHash: p.newHash },
        });
        purged += del.count;
      }
      const n = await prisma.$executeRawUnsafe(
        `
        INSERT INTO "FastModeCacheEntry" (key, kind, "goalHash", value, "blobPath", "createdAt")
        SELECT replace(key, ':' || $1 || ':', ':' || $2 || ':'), kind, $2, value, "blobPath", "createdAt"
        FROM "FastModeCacheEntry"
        WHERE "goalHash" = $1
          AND (kind <> 'llm' OR key LIKE '%:execute_loop:%'
               OR key LIKE '%:verifier%'
               OR key LIKE '%:completion_summary%'
               OR key LIKE '%:plan_loop%'
               OR key LIKE '%:planner%'
               OR key LIKE '%:dag_%'
               OR key LIKE '%:response_schema%')
        ON CONFLICT (key) DO NOTHING
      `,
        p.oldHash,
        p.newHash
      );
      copied += Number(n);
    }

    // If a previous mistaken rekey left explore-only junk on target hashes for
    // creators we could not map this pass, optionally purge those targets too.
    if (APPLY && PURGE_DEST) {
      for (const item of items) {
        if (best.has(item.name)) continue;
        const newHash = canon(buildForEachGoal(baseGoal, item));
        const del = await prisma.fastModeCacheEntry.deleteMany({
          where: { goalHash: newHash },
        });
        if (del.count) {
          console.log(`  purged unmapped dest ${item.name} ${newHash} (${del.count})`);
          purged += del.count;
        }
      }
    }

    const report = {
      rootGoalHash: ROOT_GOAL_HASH,
      apply: APPLY,
      purgeDest: PURGE_DEST,
      pairs,
      missing,
      copied,
      purged,
    };
    writeFileSync('/tmp/oai-demo-rekey-report.json', JSON.stringify(report, null, 2));
    console.log(
      `\n${APPLY ? `COPIED ${copied}, PURGED ${purged}` : 'DRY RUN'} — report /tmp/oai-demo-rekey-report.json`
    );
    if (missing.length) process.exitCode = 1;
    if (!APPLY) console.log('Re-run with --apply --purge-dest to replace destinations.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
