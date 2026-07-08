/**
 * mass-agent-0 progress score (0 → 1) against the PROD DB.
 * Reads prod DATABASE_URL from /tmp/prod_db_url.txt.
 *
 * Per sub-agent (the 50 for_each children):
 *   - COMPLETES            → 0.02 (full)     [ground truth: DB status COMPLETED OR attempt_completion FINISHED]
 *   - completes EXPLORE    → 0.01 base
 *   - each own turn AFTER explore finishes → +0.001 (capped at 0.02)
 *   - explore not finished  → 0
 * Sum over children → 1.0 when all complete.
 *
 * Usage: npx tsx scripts/mass-score-prod.ts <rootAgentId>
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';

const url = readFileSync('/tmp/prod_db_url.txt', 'utf8').trim();
const p = new PrismaClient({ datasources: { db: { url } } });

function meta(m: { metadata: unknown }): Record<string, unknown> {
  const v = m.metadata;
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  return {};
}

async function main() {
  const root = process.argv[2];
  if (!root) throw new Error('usage: mass-score-prod.ts <rootAgentId>');
  const r = await p.$queryRawUnsafe<{ busId: string }[]>(`SELECT "busId" FROM "Agent" WHERE id=$1`, root);
  const bus = r[0]?.busId;
  const kids = await p.$queryRawUnsafe<{ id: string; status: string }[]>(
    `SELECT id, status FROM "Agent" WHERE "busId"=$1 AND "parentAgentId" IS NOT NULL ORDER BY "createdAt" ASC`,
    bus
  );

  let total = 0;
  let nComplete = 0;
  let nExplore = 0;
  let nZero = 0;

  for (const k of kids) {
    const msgs = await p.$queryRawUnsafe<{ role: string; metadata: unknown; createdAt: Date }[]>(
      `SELECT role, metadata, "createdAt" FROM "Message" WHERE "agentId"=$1 ORDER BY "createdAt" ASC`,
      k.id
    );
    let exploreFinAt: Date | null = null;
    let childCompleted = k.status === 'COMPLETED';
    for (const m of msgs) {
      const md = meta(m);
      const tn = String(md.toolName ?? '');
      const ts = String(md.toolStatus ?? '');
      const title = String(md.title ?? '');
      if (
        exploreFinAt === null &&
        ts === 'FINISHED' &&
        (tn === 'spawn_agent' || tn === 'spawn_explore_agent') &&
        /identify|research|rank|creators|explore|analyz/i.test(title)
      ) {
        exploreFinAt = m.createdAt;
      }
      if (tn === 'attempt_completion' && ts === 'FINISHED') childCompleted = true;
    }
    const assistantTurns = msgs.filter((m) => m.role === 'ASSISTANT');
    const postExploreTurns = exploreFinAt
      ? assistantTurns.filter((m) => m.createdAt.getTime() > exploreFinAt!.getTime()).length
      : 0;

    let score: number;
    if (childCompleted) {
      score = 0.02;
      nComplete++;
    } else if (exploreFinAt) {
      score = Math.min(0.02, 0.01 + 0.001 * postExploreTurns);
      nExplore++;
    } else {
      score = 0;
      nZero++;
    }
    total += score;
  }

  console.log(`root ${root.slice(0, 8)} — ${kids.length} sub-agents`);
  console.log(`  COMPLETED: ${nComplete} (x0.02)   explore-only: ${nExplore}   no-explore: ${nZero}`);
  console.log(`  SCORE: ${total.toFixed(4)}  /  1.0`);
  await p.$disconnect();
}

main().catch((e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  process.exit(1);
});
