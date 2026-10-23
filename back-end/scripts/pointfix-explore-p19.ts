import { PrismaClient } from '@prisma/client';

const url =
  (process.env.FAST_MODE_CACHE_DATABASE_URL ?? process.env.DEMO_CACHE_DATABASE_URL) ||
  process.env.DATABASE_URL;
const p = new PrismaClient({ datasources: { db: { url } } });

// Source: b429f478's successfully-stored final explore call, written under the
// per-run-unique goalHash 0c0be3 (the bug). Target: the STABLE explore goalHash
// e9c4856 that every rerun's replay actually reads at position 19.
const SRC_KEY =
  'fastmode:v42:llm:0c0be37333f21613:explore_agent:p:19:c:7facbe93d4f74e27080d3c953d8f6a90';
const DST_KEY =
  'fastmode:v42:llm:e9c4856dab66c0cc:explore_agent:p:19:c:7facbe93d4f74e27080d3c953d8f6a90';
const DST_GOAL_HASH = 'e9c4856dab66c0cc';

async function main() {
  const dryRun = !process.argv.includes('--apply');

  const src = await p.fastModeCacheEntry.findUnique({ where: { key: SRC_KEY } });
  if (!src) {
    console.error('SRC key not found — aborting.');
    process.exit(1);
  }
  const existing = await p.fastModeCacheEntry.findUnique({ where: { key: DST_KEY } });
  const vlen = src.value ? JSON.stringify(src.value).length : 0;
  console.log(
    `SRC ${SRC_KEY}\n  created=${src.createdAt.toISOString()} kind=${src.kind} valueLen=${vlen} blobPath=${src.blobPath ?? 'none'}`
  );
  console.log(
    `DST ${DST_KEY}\n  currently=${existing ? 'EXISTS (will skip)' : 'MISSING (will backfill)'}`
  );

  // Sanity: the source value should be a real explore completion (tool_calls present).
  const v = src.value as { tool_calls?: unknown[]; content?: string } | null;
  const toolCalls = Array.isArray(v?.tool_calls) ? v!.tool_calls!.length : 0;
  console.log(`  source value: tool_calls=${toolCalls} contentLen=${(v?.content ?? '').length}`);

  if (existing) {
    console.log('DST already present — nothing to do.');
    await p.$disconnect();
    return;
  }
  if (dryRun) {
    console.log('\nDRY RUN — re-run with --apply to write the backfill.');
    await p.$disconnect();
    return;
  }

  await p.fastModeCacheEntry.create({
    data: {
      key: DST_KEY,
      kind: src.kind,
      goalHash: DST_GOAL_HASH,
      value: src.value === null ? undefined : (src.value as object),
      blobPath: src.blobPath,
    },
  });
  const check = await p.fastModeCacheEntry.findUnique({ where: { key: DST_KEY } });
  console.log(
    `\n✅ Backfilled. Read-back: ${check ? 'PRESENT valueLen=' + JSON.stringify(check.value).length : 'STILL MISSING (!)'}`
  );
  await p.$disconnect();
}

main().catch((e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  process.exit(1);
});
