/**
 * Rekey Jul 2026 OAi-demo explore_agent + summarize_web_fetch namespaces onto
 * the explore goal hashes implied by warm GP execute_loop tool_calls.
 *
 * GP rekey alone is not enough: explore Fast Mode keys by the explore *goal*
 * text, and those namespaces never landed under today's hashes.
 *
 * Usage:
 *   npx tsx scripts/rekey-oai-demo-explore-cache.ts
 *   npx tsx scripts/rekey-oai-demo-explore-cache.ts --apply --purge-dest
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';

const REF_RE =
  /@ref:message:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const canon = (g: string) => sha16(g.replace(REF_RE, '@ref:message:<uuid>'));

const APPLY = process.argv.includes('--apply');
const PURGE_DEST = process.argv.includes('--purge-dest');

type ExecRow = {
  goalHash: string;
  key: string;
  value: {
    tool_calls?: Array<{ name?: string; arguments?: string | Record<string, unknown> }>;
  };
  createdAt: Date;
};

function parseArgs(
  raw: string | Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rewriteKey(key: string, fromGh: string, toGh: string): string {
  const fromSeg = `:${fromGh}:`;
  const toSeg = `:${toGh}:`;
  const count = key.split(fromSeg).length - 1;
  if (count !== 1) {
    throw new Error(
      `rewriteKey expected exactly one '${fromSeg}' segment in key (found ${count}): ${key}`
    );
  }
  return key.replace(fromSeg, toSeg);
}

async function main() {
  const url =
    (process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DEMO_CACHE_DATABASE_URL) ||
    process.env.DATABASE_URL;
  if (!url) throw new Error('FAST_MODE_CACHE_DATABASE_URL required');
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  // Warm GP execute_loop rows from early July that spawn explore children.
  // Filter explore spawns in JS — JSONB ::text escaping makes SQL ILIKE on
  // nested `"type":"explore"` brittle.
  const execRows = await prisma.$queryRawUnsafe<ExecRow[]>(`
    SELECT "goalHash", key, value, "createdAt"
    FROM "FastModeCacheEntry"
    WHERE kind = 'llm'
      AND key LIKE '%:execute_loop:%'
      AND "createdAt" >= '2026-07-03' AND "createdAt" < '2026-07-09'
      AND value::text ILIKE '%explore%'
    ORDER BY "createdAt" ASC
  `);

  type ExploreTarget = {
    creatorHint: string;
    exploreGoal: string;
    destHash: string;
    sourceGpHash: string;
    execKey: string;
  };
  const targets: ExploreTarget[] = [];
  const seenDest = new Set<string>();

  for (const row of execRows) {
    for (const tc of row.value?.tool_calls || []) {
      const args = parseArgs(tc.arguments);
      if (!args || args.type !== 'explore') continue;
      const goal = typeof args.goal === 'string' ? args.goal : '';
      if (goal.length < 40) continue;
      const destHash = canon(goal);
      if (seenDest.has(destHash)) continue;
      seenDest.add(destHash);
      // Heuristic creator hint from goal text
      const m =
        goal.match(
          /Research(?: the(?: creator| public content of)?| public data for(?: creator)?| only)?\s+([A-Z][A-Za-z .'-]{1,60}?)(?:'s|\s+\(|\s+content|\s+for|\s+\/|,)/
        ) ||
        goal.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}).{0,40}(?:Huberman Lab|YouTube|Instagram)/);
      const creatorHint = (m?.[1] || goal.slice(0, 40)).trim();
      targets.push({
        creatorHint,
        exploreGoal: goal,
        destHash,
        sourceGpHash: row.goalHash,
        execKey: row.key,
      });
    }
  }

  console.log(`explore targets from warm execute_loop: ${targets.length}`);

  const report: Array<Record<string, unknown>> = [];
  let copied = 0;

  for (const t of targets) {
    // Prefer richest July explore namespace mentioning this creator.
    const sources = await prisma.$queryRawUnsafe<
      Array<{ goalHash: string; n: number; oldest: Date }>
    >(
      `
      SELECT "goalHash", count(*)::int AS n, min("createdAt") AS oldest
      FROM "FastModeCacheEntry"
      WHERE kind = 'llm'
        AND key LIKE '%:explore_agent:%'
        AND "createdAt" >= '2026-07-01' AND "createdAt" < '2026-07-15'
        AND value::text ILIKE $1
      GROUP BY 1
      ORDER BY n DESC, oldest ASC
      LIMIT 5
    `,
      `%${t.creatorHint.split(/\s+/).slice(0, 2).join('%')}%`
    );

    // Skip only if dest already has a *rich* warm July explore+swf namespace.
    // Sparse namespaces (2–5 explore, 0 swf) look "warm" but fail after early
    // turns — those must still be enriched from a richer July source.
    const destWarm = await prisma.$queryRawUnsafe<Array<{ explore: number; swf: number }>>(
      `
      SELECT
        count(*) FILTER (WHERE key LIKE '%:explore_agent:%')::int AS explore,
        count(*) FILTER (WHERE key LIKE '%:summarize_web_fetch:%')::int AS swf
      FROM "FastModeCacheEntry"
      WHERE "goalHash" = $1
        AND "createdAt" < '2026-08-01'
        AND (key LIKE '%:explore_agent:%' OR key LIKE '%:summarize_web_fetch:%')
    `,
      t.destHash
    );
    const warmEx = destWarm[0]?.explore || 0;
    const warmSwf = destWarm[0]?.swf || 0;
    if (warmEx >= 10 && warmSwf >= 3) {
      report.push({
        ...t,
        status: 'already_warm',
        destWarmExplore: warmEx,
        destWarmSwf: warmSwf,
      });
      continue;
    }

    const sourceGh = sources[0]?.goalHash;
    if (!sourceGh || sourceGh === t.destHash) {
      report.push({ ...t, status: 'no_source', sources });
      continue;
    }

    const srcRows = await prisma.$queryRawUnsafe<
      Array<{ key: string; kind: string; value: unknown; blobPath: string | null; createdAt: Date }>
    >(
      `
      SELECT key, kind, value, "blobPath", "createdAt"
      FROM "FastModeCacheEntry"
      WHERE "goalHash" = $1
        AND (
          key LIKE '%:explore_agent:%'
          OR key LIKE '%:summarize_web_fetch:%'
        )
      ORDER BY "createdAt" ASC
    `,
      sourceGh
    );

    report.push({
      creatorHint: t.creatorHint,
      destHash: t.destHash,
      sourceGh,
      sourceN: srcRows.length,
      sourceExploreN: sources[0]?.n,
      status: APPLY ? 'copying' : 'dry_run',
    });

    if (!APPLY) continue;

    if (PURGE_DEST) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "FastModeCacheEntry" WHERE "goalHash" = $1 AND (
          key LIKE '%:explore_agent:%' OR key LIKE '%:summarize_web_fetch:%'
        )`,
        t.destHash
      );
    }

    for (const src of srcRows) {
      const newKey = rewriteKey(src.key, sourceGh, t.destHash);
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO "FastModeCacheEntry" (key, kind, "goalHash", value, "blobPath", "createdAt")
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          "blobPath" = EXCLUDED."blobPath",
          kind = EXCLUDED.kind,
          "goalHash" = EXCLUDED."goalHash",
          "createdAt" = EXCLUDED."createdAt"
      `,
        newKey,
        src.kind,
        t.destHash,
        JSON.stringify(src.value),
        src.blobPath,
        src.createdAt
      );
      copied++;
    }
  }

  const out = {
    apply: APPLY,
    purgeDest: PURGE_DEST,
    targets: targets.length,
    copied,
    report,
  };
  writeFileSync('/tmp/oai-demo-explore-rekey-report.json', JSON.stringify(out, null, 2));
  console.log(
    JSON.stringify(
      { apply: APPLY, targets: targets.length, copied, reportN: report.length },
      null,
      2
    )
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
