/**
 * Prove a $0 run is REAL (pure demo-cache replay), not "cost hacked to 0 while
 * still issuing paid OpenRouter/Anthropic calls".
 *
 * For every LLM ToolUsage row in the tree, inspects each usageItem:
 *   - from_fast_cache=true  -> replayed from cache, NO network call at all ($0, real)
 *   - from_fast_cache=false -> a LIVE call actually hit a provider. We surface the
 *     actual_model + pool + cost so a "$0" that is really paid traffic can't hide.
 *
 * A genuine 100%-demo-cache run has live_calls=0 and paid_cents=0. Any live call
 * (especially a non-claude/-gpt "-anthropic"/openrouter pool with cost>0) means the
 * run is NOT actually free.
 *
 * Usage: npx tsx scripts/verify-cost-real.ts <rootAgentId>
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const root = process.argv[2];
  if (!root) throw new Error('usage: verify-cost-real.ts <rootAgentId>');

  const rows = await prisma.$queryRawUnsafe<Array<{ tool: string; items: string; cost: number }>>(
    `SELECT t."toolName" AS tool, t."usageItems"::text AS items, t."totalCostCents" AS cost
     FROM "ToolUsage" t
     JOIN "Agent" a ON a.id = t."agentId"
     WHERE a."busId" = $1`,
    root
  );

  let total = 0;
  let cached = 0;
  let live = 0;
  let paidCents = 0;
  const liveCalls: Record<string, number> = {};
  const paidCalls: Array<{ model: string; pool: string; cents: number }> = [];

  for (const r of rows) {
    let items: any[];
    try {
      items = JSON.parse(r.items);
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (typeof it !== 'object' || it == null) continue;
      // only LLM-ish usage items have from_fast_cache / model
      if (!('from_fast_cache' in it) && !('model' in it) && !('actual_model' in it)) continue;
      total++;
      if (it.from_fast_cache === true) {
        cached++;
      } else {
        live++;
        const model = String(it.actual_model || it.model || '?');
        const pool = String(it.pool_name || it.pool || '?');
        liveCalls[`${model} @ ${pool}`] = (liveCalls[`${model} @ ${pool}`] || 0) + 1;
        const cents = Number(it.cost_cents || it.costCents || 0);
        if (cents > 0) {
          paidCents += cents;
          paidCalls.push({ model, pool, cents });
        }
      }
    }
  }

  const pctCached = total ? ((cached / total) * 100).toFixed(2) : 'n/a';
  console.log(`\n=== COST-IS-REAL AUDIT — root ${root.slice(0, 8)} ===`);
  console.log(`LLM usage items: ${total}`);
  console.log(`  from_fast_cache=TRUE  (replayed, $0, no network): ${cached}  (${pctCached}%)`);
  console.log(`  from_fast_cache=FALSE (LIVE provider call):       ${live}`);
  console.log(`  paid cents on live calls: ${paidCents}`);
  if (live > 0) {
    console.log(`\n  ⚠️ LIVE (non-cached) calls by model@pool:`);
    for (const [k, n] of Object.entries(liveCalls).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${n.toString().padStart(4)}×  ${k}`);
    }
  }
  const verdict =
    live === 0 && paidCents === 0
      ? '✅ REAL $0: 100% demo-cache replay, zero live provider calls, zero paid tokens.'
      : `❌ NOT free: ${live} live calls, ${paidCents}c paid — the run is issuing real provider traffic.`;
  console.log(`\n${verdict}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
