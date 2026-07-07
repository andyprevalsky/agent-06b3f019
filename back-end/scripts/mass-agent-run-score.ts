/**
 * mass-agent-0 progress score (0 → 1).
 *
 * Per sub-agent (the 50 for_each children), derived from LLM-call / completion state:
 *   - sub-agent COMPLETES            → 0.02 (full)
 *   - sub-agent completes its EXPLORE → 0.01 base
 *   - each of the sub-agent's own turns AFTER explore finishes → +0.001 (capped at 0.02)
 *   - explore not finished            → 0
 * Sum over 50 children → 1.0 when all complete. Each rerun (more cache populated →
 * children get further) should push this number up.
 *
 * Usage: npx tsx scripts/mass-agent-run-score.ts <rootAgentId>
 */
import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

function meta(m: { metadata: unknown }): Record<string, unknown> {
  const v = m.metadata;
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  return {};
}

async function main() {
  const root = process.argv[2];
  if (!root) throw new Error('usage: mass-agent-run-score.ts <rootAgentId>');
  const r = await p.$queryRawUnsafe<{ busId: string }[]>(`SELECT "busId" FROM "Agent" WHERE id=$1`, root);
  const bus = r[0]?.busId;
  const kids = await p.$queryRawUnsafe<{ id: string; status: string }[]>(
    `SELECT id, status FROM "Agent" WHERE "busId"=$1 AND "parentAgentId" IS NOT NULL ORDER BY "createdAt" ASC`,
    bus
  );

  let total = 0;
  let nComplete = 0,
    nExplore = 0,
    nZero = 0;
  const rows: string[] = [];

  for (const k of kids) {
    const msgs = await p.$queryRawUnsafe<{ role: string; metadata: unknown; createdAt: Date }[]>(
      `SELECT role, metadata, "createdAt" FROM "Message" WHERE "agentId"=$1 ORDER BY "createdAt" ASC`,
      k.id
    );
    // explore finished = the child's spawn_agent explore reaching FINISHED
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
        /identify|research|rank|creators/i.test(title)
      ) {
        exploreFinAt = m.createdAt;
      }
      if (tn === 'attempt_completion' && ts === 'FINISHED') childCompleted = true;
    }
    // child's OWN turns = ASSISTANT-role messages (its execute-loop model responses;
    // the explore's internal turns surface as TOOL "thinking" rows, not ASSISTANT)
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
    rows.push(`  ${k.id.slice(0, 8)} status=${k.status.padEnd(18)} explore=${exploreFinAt ? 'Y' : 'N'} postTurns=${postExploreTurns} → ${score.toFixed(3)}`);
  }

  console.log(`root ${root.slice(0, 8)} — ${kids.length} sub-agents`);
  console.log(`  COMPLETED: ${nComplete} (×0.02)   explore-only: ${nExplore}   no-explore: ${nZero}`);
  console.log(rows.slice(0, 12).join('\n'));
  if (rows.length > 12) console.log(`  … (${rows.length - 12} more)`);
  console.log(`\n  SCORE: ${total.toFixed(4)}  /  1.0`);
  await p.$disconnect();
}

main().catch((e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  process.exit(1);
});
