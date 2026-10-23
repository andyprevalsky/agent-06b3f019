import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

const appDb = new PrismaClient();
const url = (process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DEMO_CACHE_DATABASE_URL)!;
const cacheDb = new PrismaClient({ datasources: { db: { url } } });

// goal_hash = sha256(canonical(goal))[:16], canonical collapses @ref:message:<uuid>
function goalHash(goal: string): string {
  const UUID =
    /@ref:message:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  const canon = goal.replace(UUID, '@ref:message:<uuid>');
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

async function main() {
  const badSeedIds = process.argv.slice(2);
  for (const shortId of badSeedIds) {
    const agent = await appDb.$queryRawUnsafe<Array<{ id: string; goal: string }>>(
      `SELECT id, goal FROM "Agent" WHERE id LIKE $1 LIMIT 1`,
      shortId + '%'
    );
    if (!agent.length) {
      console.log(`  ${shortId}: not found`);
      continue;
    }
    const gh = goalHash(agent[0].goal);
    const creator = agent[0].goal.match(/"creator_name"\s*:\s*"([^"]+)"/)?.[1] ?? '?';
    // Find all verifier cache entries for this goal_hash
    const rows = await cacheDb.$queryRawUnsafe<
      Array<{ callsite: string; pos: string; fp: string; score: unknown }>
    >(
      `SELECT split_part(key,':',5) AS callsite, split_part(key,':',7) AS pos, split_part(key,':',9) AS fp,
              (value::jsonb) AS score
       FROM "FastModeCacheEntry"
       WHERE key LIKE 'fastmode:v42:llm:' || $1 || ':verifier%'
       ORDER BY split_part(key,':',7)::int NULLS LAST`,
      gh
    );
    console.log(
      `\n=== ${shortId} "${creator}" goal_hash=${gh} — ${rows.length} verifier entries ===`
    );
    for (const r of rows) {
      // Extract the score from the cached verifier LLM response value
      let sc = '?';
      try {
        const v = r.score as any;
        const raw = typeof v === 'string' ? v : JSON.stringify(v);
        const m = raw.match(/"score"\s*:\s*([0-9.]+)/);
        if (m) sc = m[1];
      } catch {}
      console.log(`  ${r.callsite} p:${r.pos} score=${sc} fp=${(r.fp || '').slice(0, 12)}`);
    }
  }
  await appDb.$disconnect();
  await cacheDb.$disconnect();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
