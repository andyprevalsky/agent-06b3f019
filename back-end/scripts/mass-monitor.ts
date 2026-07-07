/**
 * Poll a mass-agent-run root on PROD: status, treeCostCents, child completion counts.
 * Emits one compact line per poll; exits when the root reaches a terminal status.
 * Prints a final "### TERMINAL ###" line. Safety: prints "### BUDGET WARN ###" if
 * treeCostCents exceeds argv[3] (default 4000c) so the caller can kill.
 *
 * Usage: npx tsx scripts/mass-monitor.ts <rootId> [pollSec=20] [warnCents=4000]
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';

const url = readFileSync('/tmp/prod_db_url.txt', 'utf8').trim();
const p = new PrismaClient({ datasources: { db: { url } } });

const root = process.argv[2];
const pollSec = Number(process.argv[3] ?? 20);
const warnCents = Number(process.argv[4] ?? 4000);
const TERMINAL = new Set(['COMPLETED', 'COST_LIMIT_REACHED', 'FAILED', 'OUT_OF_CREDITS', 'STOPPED']);

async function poll(): Promise<boolean> {
  const r = await p.$queryRawUnsafe<Array<{ status: string; cost: number; bus: string }>>(
    `SELECT status, "treeCostCents" AS cost, "busId" AS bus FROM "Agent" WHERE id=$1`,
    root
  );
  if (r.length === 0) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] root not found`);
    return true;
  }
  const { status, cost, bus } = r[0];
  const kids = await p.$queryRawUnsafe<Array<{ status: string; n: number }>>(
    `SELECT status, count(*)::int AS n FROM "Agent" WHERE "busId"=$1 AND "parentAgentId" IS NOT NULL GROUP BY status`,
    bus
  );
  const byStatus: Record<string, number> = {};
  let totalKids = 0;
  for (const k of kids) {
    byStatus[k.status] = k.n;
    totalKids += k.n;
  }
  const done = byStatus['COMPLETED'] ?? 0;
  const active = byStatus['ACTIVE'] ?? 0;
  const capped = byStatus['COST_LIMIT_REACHED'] ?? 0;
  const t = new Date().toISOString().slice(11, 19);
  console.log(
    `[${t}] ${status} cost=${cost}c kids=${totalKids} done=${done} active=${active} capped=${capped}`
  );
  if (cost > warnCents) console.log(`### BUDGET WARN ### cost=${cost}c > ${warnCents}c`);
  if (TERMINAL.has(status)) {
    console.log(`### TERMINAL: ${status} cost=${cost}c done=${done}/${totalKids} ###`);
    return true;
  }
  return false;
}

async function main() {
  if (!root) throw new Error('usage: mass-monitor.ts <rootId> [pollSec] [warnCents]');
  let stop = false;
  while (!stop) {
    try {
      stop = await poll();
    } catch (e) {
      console.log(`[poll-error] ${(e as Error).message.slice(0, 120)}`);
    }
    if (!stop) await new Promise((res) => setTimeout(res, pollSec * 1000));
  }
  await p.$disconnect();
}

main().catch((e) => {
  console.error('ERR', (e as Error).message);
  process.exit(1);
});
