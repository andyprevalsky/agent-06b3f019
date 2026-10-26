import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';

const url =
  (process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DEMO_CACHE_DATABASE_URL) ||
  process.env.DATABASE_URL;
const p = new PrismaClient({ datasources: { db: { url } } });

// Collect the explore_agent llm.cache.miss keys for an agent from ClickHouse,
// then for each missed key backfill the value from a sibling entry with the same
// (goalHash, position) but a different fingerprint. The terminal call's response
// is functionally the same attempt_completion regardless of the request-config
// fingerprint, so the sibling value replays correctly.

function missedExploreKeys(agentId: string): string[] {
  const endpoint = process.env.CLICKHOUSE_ENDPOINT!;
  const user = process.env.CLICKHOUSE_USER!;
  const pw = process.env.CLICKHOUSE_PASSWORD!;
  const q =
    `SELECT raw FROM observability.fly_logs WHERE raw LIKE '%${agentId}%' ` +
    `AND raw LIKE '%llm.cache.miss%' AND raw LIKE '%explore_agent:p:%' ` +
    `ORDER BY ingested_at ASC LIMIT 200 FORMAT JSONEachRow`;
  const out = execSync(
    `curl -sS -u "${user}:${pw}" --get "${endpoint}" --data-urlencode ${JSON.stringify('query=' + q)}`,
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
  );
  const keys = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(JSON.parse(line).raw).message;
      const j = JSON.parse(msg);
      const key: string = j.key ?? '';
      if (key.includes('explore_agent:p:') && j.event === 'llm.cache.miss') keys.add(key);
    } catch {
      /* skip */
    }
  }
  return [...keys];
}

function parse(key: string): { goalHash: string; pos: string; prefix: string } | null {
  // fastmode:v42:llm:<goalHash>:explore_agent:p:<pos>:c:<fp>
  const m = key.match(/^(fastmode:v\d+:llm):([0-9a-f]+):explore_agent:p:(\d+):c:/);
  if (!m) return null;
  return { prefix: m[1], goalHash: m[2], pos: m[3] };
}

async function main() {
  const agentId = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!agentId) {
    console.error('usage: backfill-explore-misses.ts <agent_id> [--apply]');
    process.exit(1);
  }

  const missed = missedExploreKeys(agentId);
  console.log(`explore misses found: ${missed.length}`);
  let backfilled = 0;
  let alreadyPresent = 0;
  let noSibling = 0;

  for (const key of missed) {
    const existing = await p.fastModeCacheEntry.findUnique({ where: { key } });
    if (existing) {
      alreadyPresent++;
      continue;
    }
    const parsed = parse(key);
    if (!parsed) {
      console.log(`  ? unparseable key: ${key}`);
      continue;
    }
    // Sibling: same (goalHash, position), any fingerprint.
    const siblingPrefix = `${parsed.prefix}:${parsed.goalHash}:explore_agent:p:${parsed.pos}:c:`;
    const siblings = await p.fastModeCacheEntry.findMany({
      where: { key: { startsWith: siblingPrefix } },
      orderBy: { createdAt: 'desc' },
    });
    const src = siblings.find((s) => (s.value ? JSON.stringify(s.value).length : 0) > 40);
    if (!src) {
      noSibling++;
      console.log(`  ✗ no sibling for goalHash=${parsed.goalHash} p:${parsed.pos}`);
      continue;
    }
    console.log(
      `  → backfill goalHash=${parsed.goalHash} p:${parsed.pos} from sibling (valueLen=${JSON.stringify(src.value).length})`
    );
    if (apply) {
      await p.fastModeCacheEntry.create({
        data: {
          key,
          kind: src.kind,
          goalHash: parsed.goalHash,
          value: src.value === null ? undefined : (src.value as object),
          blobPath: src.blobPath,
        },
      });
      backfilled++;
    }
  }

  console.log(
    `\n${apply ? 'APPLIED' : 'DRY RUN'}: backfilled=${backfilled} alreadyPresent=${alreadyPresent} noSibling=${noSibling}`
  );
  if (!apply) console.log('re-run with --apply to write.');
  await p.$disconnect();
}

main().catch((e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  process.exit(1);
});
