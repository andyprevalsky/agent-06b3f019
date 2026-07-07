/**
 * Wall-clock profiler for a mass-agent-run tree (prod).
 *
 * For each sub-agent, measures from DB timestamps:
 *   - spin_up_ms : createdAt -> first Message (time "stuck spinning up" before any work)
 *   - work_ms    : first Message -> last Message (actual working span)
 *   - total_ms   : createdAt -> last Message (full wall-clock)
 * And the whole-run wall-clock: root.createdAt -> max(last message across tree).
 *
 * Speed optimization barometer: each optimization must strictly decrease (or hold)
 * avg spin_up_ms and avg total_ms per sub-agent AND the total run wall-clock, with
 * the e2e trajectory (message counts) unchanged.
 *
 * Usage: npx tsx scripts/mass-walltime.ts <rootAgentId>
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';

const url = readFileSync('/tmp/prod_db_url.txt', 'utf8').trim();
const prisma = new PrismaClient({ datasources: { db: { url } } });

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const root = process.argv[2];
  if (!root) throw new Error('usage: mass-walltime.ts <rootAgentId>');

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      is_main: boolean;
      status: string;
      created_ms: number;
      first_msg_ms: number | null;
      last_msg_ms: number | null;
      msgs: number;
    }>
  >(
    `SELECT a.id,
            (a."parentAgentId" = a."busId") AS is_main,
            a.status,
            EXTRACT(EPOCH FROM a."createdAt") * 1000 AS created_ms,
            EXTRACT(EPOCH FROM mc.first_ts) * 1000 AS first_msg_ms,
            EXTRACT(EPOCH FROM mc.last_ts) * 1000 AS last_msg_ms,
            COALESCE(mc.n, 0)::int AS msgs
     FROM "Agent" a
     LEFT JOIN LATERAL (
       SELECT min(m."createdAt") AS first_ts, max(m."createdAt") AS last_ts, count(*)::int AS n
       FROM "Message" m WHERE m."agentId" = a.id
     ) mc ON true
     WHERE a."busId" = $1 AND a."parentAgentId" IS NOT NULL`,
    root
  );

  const rootRow = await prisma.$queryRawUnsafe<Array<{ created_ms: number; last_ms: number | null }>>(
    `SELECT EXTRACT(EPOCH FROM a."createdAt") * 1000 AS created_ms,
            EXTRACT(EPOCH FROM (SELECT max(m."createdAt") FROM "Message" m
              JOIN "Agent" c ON c.id = m."agentId" WHERE c."busId" = $1)) * 1000 AS last_ms
     FROM "Agent" a WHERE a.id = $1`,
    root
  );

  const spinUps: number[] = [];
  const totals: number[] = [];
  const works: number[] = [];
  const mainSpinUps: number[] = [];
  const mainTotals: number[] = [];
  let stuckSpinUp = 0; // agents with spin_up > 10s

  for (const r of rows) {
    if (r.first_msg_ms == null || r.last_msg_ms == null) continue;
    const spin = Math.max(0, r.first_msg_ms - r.created_ms);
    const total = Math.max(0, r.last_msg_ms - r.created_ms);
    const work = Math.max(0, r.last_msg_ms - r.first_msg_ms);
    spinUps.push(spin);
    totals.push(total);
    works.push(work);
    if (spin > 10000) stuckSpinUp++;
    if (r.is_main) {
      mainSpinUps.push(spin);
      mainTotals.push(total);
    }
  }

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const s = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const fmt = (ms: number) => (ms / 1000).toFixed(1) + 's';

  const runWall = rootRow[0]?.last_ms && rootRow[0]?.created_ms ? rootRow[0].last_ms - rootRow[0].created_ms : 0;

  console.log(`\n=== WALL-CLOCK PROFILE — root ${root.slice(0, 8)} ===`);
  console.log(`sub-agents measured: ${spinUps.length} (main: ${mainSpinUps.length})`);
  console.log(`\n-- SPIN-UP (createdAt -> first work) --`);
  console.log(`  ALL   avg=${fmt(avg(spinUps))}  p50=${fmt(pct(s(spinUps), 50))}  p95=${fmt(pct(s(spinUps), 95))}  max=${fmt(pct(s(spinUps), 100))}`);
  console.log(`  MAIN  avg=${fmt(avg(mainSpinUps))}  p50=${fmt(pct(s(mainSpinUps), 50))}  p95=${fmt(pct(s(mainSpinUps), 95))}`);
  console.log(`  🐌 agents stuck spinning up >10s: ${stuckSpinUp} / ${spinUps.length}`);
  console.log(`\n-- TOTAL WALL-CLOCK (createdAt -> last work) --`);
  console.log(`  ALL   avg=${fmt(avg(totals))}  p50=${fmt(pct(s(totals), 50))}  p95=${fmt(pct(s(totals), 95))}  max=${fmt(pct(s(totals), 100))}`);
  console.log(`  MAIN  avg=${fmt(avg(mainTotals))}  p50=${fmt(pct(s(mainTotals), 50))}  p95=${fmt(pct(s(mainTotals), 95))}`);
  console.log(`\n-- WORK SPAN (first -> last work) --`);
  console.log(`  ALL   avg=${fmt(avg(works))}  p50=${fmt(pct(s(works), 50))}`);
  console.log(`\n== TOTAL RUN WALL-CLOCK: ${fmt(runWall)} ==`);
  console.log(
    JSON.stringify({
      root: root.slice(0, 8),
      n: spinUps.length,
      avg_spinup_ms: Math.round(avg(spinUps)),
      avg_total_ms: Math.round(avg(totals)),
      main_avg_total_ms: Math.round(avg(mainTotals)),
      stuck_spinup_gt10s: stuckSpinUp,
      run_wall_ms: Math.round(runWall),
    })
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
