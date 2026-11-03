import { PrismaClient } from '@prisma/client';

const p = new PrismaClient({
  datasources: {
    db: { url: (process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DEMO_CACHE_DATABASE_URL)! },
  },
});

async function main() {
  const keyPrefix = process.argv[2]; // e.g. fastmode:v42:llm:917f1178187930be:verifier_execute
  const rows = await p.$queryRaw<Array<{ key: string; val: string }>>`
    SELECT key, value::text AS val FROM "FastModeCacheEntry"
    WHERE key LIKE ${keyPrefix + '%'}
    ORDER BY split_part(key, ':', 7)::int
    LIMIT 1
  `;
  if (!rows.length) {
    console.log('no entry for', keyPrefix);
    return;
  }
  const v = rows[0];
  console.log('KEY:', v.key);
  const parsed = JSON.parse(v.val);
  console.log('top keys:', Object.keys(parsed));
  console.log('content (first 800):', (parsed.content || '').slice(0, 800));
  console.log('reasoning (first 300):', (parsed.reasoning || '').slice(0, 300));
  console.log('tool_calls:', JSON.stringify(parsed.tool_calls || []).slice(0, 800));
  console.log('structured/output keys:', parsed.output ? Object.keys(parsed.output) : 'none');
  await p.$disconnect();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
