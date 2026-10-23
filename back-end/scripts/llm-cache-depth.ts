import { PrismaClient } from '@prisma/client';

const url = (process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DEMO_CACHE_DATABASE_URL)!;
const p = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const rows = await p.$queryRaw<Array<{ step: number; n: number }>>`
    SELECT (regexp_match(key, ':p:([0-9]+):'))[1]::int AS step, count(*)::int AS n
    FROM "FastModeCacheEntry"
    WHERE key LIKE 'fastmode:v42:llm:%'
    GROUP BY step ORDER BY step
  `;
  let total = 0;
  let deep = 0;
  console.log('LLM cache entries by position (step):');
  for (const r of rows) {
    total += r.n;
    if (r.step >= 15) deep += r.n;
    console.log('  p:' + String(r.step).padStart(2) + '  ->  ' + r.n + ' entries');
  }
  console.log('TOTAL llm entries:', total, '| deep (p>=15):', deep);
  await p.$disconnect();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
