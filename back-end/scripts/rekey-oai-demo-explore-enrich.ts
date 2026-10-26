/**
 * Enrich sparse OAi-demo explore namespaces with rich July explore+swf rows.
 *
 * Runtime mass-agent-0 hits explore goalHashes that often have only 2–5 July
 * explore_agent rows and 0 summarize_web_fetch rows. Position fallback then
 * fails after early turns → live LLM + cold writes. This script:
 *   1. Takes dest hashes from a verify miss list and/or GP execute_loop explores
 *   2. Finds the richest July (explore+swf) source matching the creator hint
 *   3. Purges dest explore/swf (including today's poison) and copies source rows
 *
 * Usage:
 *   npx tsx scripts/rekey-oai-demo-explore-enrich.ts --miss-file /tmp/oai-miss-gh-stats.json
 *   npx tsx scripts/rekey-oai-demo-explore-enrich.ts --miss-file ... --apply
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';

const REF_RE =
  /@ref:message:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const canon = (g: string) => sha16(g.replace(REF_RE, '@ref:message:<uuid>'));

const APPLY = process.argv.includes('--apply');
const missFileIdx = process.argv.indexOf('--miss-file');
const missFileArg = missFileIdx >= 0 ? process.argv[missFileIdx + 1] : '';
if (missFileIdx >= 0 && (!missFileArg || missFileArg.startsWith('--'))) {
  throw new Error('--miss-file requires a file path');
}
const missFile = missFileArg || '';

const MIN_JULY_EX = 10;
const MIN_JULY_SWF = 3;

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

function creatorHintFromGoal(goal: string): string {
  const m =
    goal.match(
      /Research(?: the(?: creator| public content of)?| public data for(?: creator)?| only)?\s+([A-Z][A-Za-z .'-]{1,60}?)(?:'s|\s+\(|\s+content|\s+for|\s+\/|,)/
    ) ||
    goal.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}).{0,40}(?:Huberman Lab|YouTube|Instagram)/);
  return (m?.[1] || goal.slice(0, 48)).trim();
}

async function main() {
  const url =
    (process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DEMO_CACHE_DATABASE_URL) ||
    process.env.DATABASE_URL;
  if (!url) throw new Error('FAST_MODE_CACHE_DATABASE_URL required');
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  type Dest = { destHash: string; creatorHint: string; julyEx?: number; julySwf?: number };
  const dests: Dest[] = [];
  const seen = new Set<string>();

  if (missFile) {
    const parsed: unknown = JSON.parse(readFileSync(missFile, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`--miss-file ${missFile} must contain a JSON array`);
    }
    const miss = parsed as Array<{
      gh: string;
      july_ex?: number;
      july_swf?: number;
    }>;
    for (const row of miss) {
      if (!row.gh || seen.has(row.gh)) continue;
      // Skip already-rich namespaces
      if ((row.july_ex || 0) >= MIN_JULY_EX && (row.july_swf || 0) >= MIN_JULY_SWF) continue;
      seen.add(row.gh);
      dests.push({
        destHash: row.gh,
        creatorHint: '',
        julyEx: row.july_ex,
        julySwf: row.july_swf,
      });
    }
  }

  // Resolve creator hints from July execute_loop explore tool_calls that hash to dest
  const execRows = await prisma.$queryRawUnsafe<
    Array<{
      goalHash: string;
      value: { tool_calls?: Array<{ arguments?: string | Record<string, unknown> }> };
    }>
  >(`
    SELECT "goalHash", value
    FROM "FastModeCacheEntry"
    WHERE kind = 'llm'
      AND key LIKE '%:execute_loop:%'
      AND "createdAt" >= '2026-07-03' AND "createdAt" < '2026-07-09'
      AND value::text ILIKE '%explore%'
  `);

  const hintByDest = new Map<string, string>();
  for (const row of execRows) {
    for (const tc of row.value?.tool_calls || []) {
      let args: Record<string, unknown> | null = null;
      if (typeof tc.arguments === 'string') {
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          args = null;
        }
      } else if (tc.arguments && typeof tc.arguments === 'object') {
        args = tc.arguments as Record<string, unknown>;
      }
      if (!args || args.type !== 'explore') continue;
      const goal = typeof args.goal === 'string' ? args.goal : '';
      if (goal.length < 40) continue;
      const destHash = canon(goal);
      if (!hintByDest.has(destHash)) hintByDest.set(destHash, creatorHintFromGoal(goal));
    }
  }

  // Optionally expand to all sparse execute_loop explore dests (slow).
  const EXPAND_EXEC = process.argv.includes('--expand-exec');
  for (const [destHash, hint] of hintByDest) {
    if (seen.has(destHash)) {
      const d = dests.find((x) => x.destHash === destHash);
      if (d && !d.creatorHint) d.creatorHint = hint;
      continue;
    }
    if (!EXPAND_EXEC) continue;
    const stats = await prisma.$queryRawUnsafe<Array<{ july_ex: number; july_swf: number }>>(
      `
      SELECT
        count(*) FILTER (WHERE key LIKE '%:explore_agent:%' AND "createdAt" < '2026-08-01')::int AS july_ex,
        count(*) FILTER (WHERE key LIKE '%:summarize_web_fetch:%' AND "createdAt" < '2026-08-01')::int AS july_swf
      FROM "FastModeCacheEntry" WHERE "goalHash" = $1
    `,
      destHash
    );
    const julyEx = stats[0]?.july_ex || 0;
    const julySwf = stats[0]?.july_swf || 0;
    if (julyEx >= MIN_JULY_EX && julySwf >= MIN_JULY_SWF) continue;
    seen.add(destHash);
    dests.push({ destHash, creatorHint: hint, julyEx, julySwf });
  }

  // Fill missing hints
  for (const d of dests) {
    if (!d.creatorHint) d.creatorHint = hintByDest.get(d.destHash) || d.destHash.slice(0, 8);
  }

  console.log(`enrich targets: ${dests.length}`);

  const report: Array<Record<string, unknown>> = [];
  let copied = 0;
  let purged = 0;

  for (const d of dests) {
    const tokens = d.creatorHint
      .split(/\s+/)
      .filter(
        (t) =>
          t.length > 2 && !/^(the|and|for|of|as|only|public|research|creator|content)$/i.test(t)
      )
      .slice(0, 3);
    const like = tokens.length > 0 ? `%${tokens.join('%')}%` : `%${d.creatorHint.slice(0, 12)}%`;

    // Prefer richest July namespace with BOTH explore + swf mentioning creator
    const sources = await prisma.$queryRawUnsafe<
      Array<{ goalHash: string; ex: number; swf: number }>
    >(
      `
      SELECT "goalHash",
        count(*) FILTER (WHERE key LIKE '%:explore_agent:%')::int AS ex,
        count(*) FILTER (WHERE key LIKE '%:summarize_web_fetch:%')::int AS swf
      FROM "FastModeCacheEntry"
      WHERE kind = 'llm'
        AND "createdAt" >= '2026-07-01' AND "createdAt" < '2026-07-15'
        AND (key LIKE '%:explore_agent:%' OR key LIKE '%:summarize_web_fetch:%')
        AND value::text ILIKE $1
      GROUP BY 1
      HAVING count(*) FILTER (WHERE key LIKE '%:explore_agent:%') >= $2
         AND count(*) FILTER (WHERE key LIKE '%:summarize_web_fetch:%') >= $3
      ORDER BY swf DESC, ex DESC
      LIMIT 5
    `,
      like,
      MIN_JULY_EX,
      MIN_JULY_SWF
    );

    const sourceGh = sources.find((s) => s.goalHash !== d.destHash)?.goalHash;

    if (!sourceGh || sourceGh === d.destHash) {
      report.push({ ...d, status: 'no_rich_source', like, sources });
      continue;
    }

    // Rich explore already present → only backfill swf (preserve creator explore).
    // Sparse explore → replace explore+swf from rich source.
    const swfOnly = (d.julyEx || 0) >= MIN_JULY_EX;
    const srcFilter = swfOnly
      ? `key LIKE '%:summarize_web_fetch:%'`
      : `(key LIKE '%:explore_agent:%' OR key LIKE '%:summarize_web_fetch:%')`;

    const srcRows = await prisma.$queryRawUnsafe<
      Array<{ key: string; kind: string; value: unknown; blobPath: string | null; createdAt: Date }>
    >(
      `
      SELECT key, kind, value, "blobPath", "createdAt"
      FROM "FastModeCacheEntry"
      WHERE "goalHash" = $1
        AND "createdAt" < '2026-08-01'
        AND ${srcFilter}
      ORDER BY "createdAt" ASC
    `,
      sourceGh
    );

    report.push({
      destHash: d.destHash,
      creatorHint: d.creatorHint,
      julyEx: d.julyEx,
      julySwf: d.julySwf,
      sourceGh,
      sourceN: srcRows.length,
      mode: swfOnly ? 'swf_only' : 'full_replace',
      like,
      status: APPLY ? 'copying' : 'dry_run',
    });

    if (!APPLY) continue;

    await prisma.$transaction(async (tx) => {
      if (swfOnly) {
        const del = await tx.$executeRawUnsafe(
          `DELETE FROM "FastModeCacheEntry" WHERE "goalHash" = $1 AND (
            key LIKE '%:summarize_web_fetch:%'
            OR (key LIKE '%:explore_agent:%' AND "createdAt" >= '2026-08-25')
          )`,
          d.destHash
        );
        purged += Number(del) || 0;
      } else {
        const del = await tx.$executeRawUnsafe(
          `DELETE FROM "FastModeCacheEntry" WHERE "goalHash" = $1 AND (
            key LIKE '%:explore_agent:%' OR key LIKE '%:summarize_web_fetch:%'
          )`,
          d.destHash
        );
        purged += Number(del) || 0;
      }

      for (const src of srcRows) {
        const newKey = rewriteKey(src.key, sourceGh, d.destHash);
        await tx.$executeRawUnsafe(
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
          d.destHash,
          JSON.stringify(src.value),
          src.blobPath,
          src.createdAt
        );
        copied++;
      }
    });
  }

  // Always purge today's poison under ALL miss hashes (even rich ones)
  let poisonPurged = 0;
  if (APPLY && missFile) {
    const parsed: unknown = JSON.parse(readFileSync(missFile, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`--miss-file ${missFile} must contain a JSON array`);
    }
    const miss = parsed as Array<{ gh: string }>;
    for (const row of miss) {
      const del = await prisma.$executeRawUnsafe(
        `DELETE FROM "FastModeCacheEntry"
         WHERE "goalHash" = $1
           AND "createdAt" >= '2026-08-25'
           AND (key LIKE '%:explore_agent:%' OR key LIKE '%:summarize_web_fetch:%')`,
        row.gh
      );
      poisonPurged += Number(del) || 0;
    }
  }

  const out = {
    apply: APPLY,
    targets: dests.length,
    copied,
    purged,
    poisonPurged,
    report,
  };
  writeFileSync('/tmp/oai-demo-explore-enrich-report.json', JSON.stringify(out, null, 2));
  console.log(
    JSON.stringify(
      { apply: APPLY, targets: dests.length, copied, purged, poisonPurged, reportN: report.length },
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
