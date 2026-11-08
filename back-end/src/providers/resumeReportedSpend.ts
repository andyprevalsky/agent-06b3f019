/**
 * The resume spend ledger: the single source of a resume run's spend.
 *
 *   SharedEphemeralState `resume-reported:<ownerId>` / `resume:<wf>` → { cents }:
 *     the run's monotonic total (dedupe), on its owner only
 *   SharedEphemeralState `resume-total` / `<agentId>` → { cents }: ONE aggregate per
 *     agent, the whole cents of every resume total in its subtree
 *   Equality lookups on the (namespace, key) index: any collation, O(1) per read.
 *   Both never expire (expiresAt = infinity: the reaper's `expiresAt <= now()` never
 *   matches them), so a total is never reset by an expiry and re-added by a report.
 *
 *   run reports its absolute total ─▶ applyResumeTotal (one transaction): lock the
 *     chain's Agent rows (ids sorted) ─▶ prev = owner's row; total > prev ─▶ owner's
 *     row = total; every chain agent's aggregate and treeCostCents += growth
 *     total <= prev (a resend, a reordered older report) ─▶ nothing
 *   no workflow's in-memory cost ever includes resume spend, so a tree-cost write for
 *     agent A locks A's row and stores its value + A's aggregate, in the same
 *     transaction (addResumeSpendLocked): writes and raises serialize on Agent rows
 *   deployment restore ─▶ each agent's tree minus its aggregate, read in ONE
 *     statement (a raise grows both equally, so that view is snapshot-stable)
 *
 * Persisted tree spend never decreases and settles at own subtree + resume totals.
 * 10k agents: O(1) rows read per write and per restored agent; O(chain) per raise.
 */
import { Prisma } from '@prisma/client';
import { prisma } from './database';

const RUN_NAMESPACE_PREFIX = 'resume-reported:';
const TOTAL_NAMESPACE = 'resume-total';

type Db = Prisma.TransactionClient | typeof prisma;

/** The namespace of the per-run totals an owner holds. */
export function resumeLedgerNamespace(ownerId: string): string {
  return `${RUN_NAMESPACE_PREFIX}${ownerId}`;
}

/**
 * Raise a run's total to `total` (monotonic) in one transaction with the matching
 * aggregate and treeCostCents increments of `chain` (owner first). Returns the
 * whole-cent growth.
 */
export async function applyResumeTotal(
  tx: Prisma.TransactionClient,
  chain: string[],
  key: string,
  total: number
): Promise<number> {
  // The chain's Agent rows first, in one consistent order: a tree-cost write (which
  // locks its own row) and other raises serialize with this one, never deadlock.
  // Deduplicated (a parent-pointer cycle must never add the growth twice).
  const sorted = [...new Set(chain)].sort();
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ANY(${sorted}::text[]) ORDER BY id FOR UPDATE`;
  const ownerNamespace = resumeLedgerNamespace(chain[0]);
  const current = await tx.$queryRaw<Array<{ value: { cents?: unknown } }>>`
    SELECT value FROM "SharedEphemeralState"
    WHERE namespace = ${ownerNamespace} AND key = ${key}
  `;
  const previous = typeof current[0]?.value?.cents === 'number' ? current[0].value.cents : 0;
  if (!(total > previous)) return 0;
  await tx.$executeRaw`
    INSERT INTO "SharedEphemeralState" (namespace, key, value, "expiresAt")
    VALUES (${ownerNamespace}, ${key}, ${JSON.stringify({ cents: total })}::jsonb,
            'infinity'::timestamptz)
    ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value
  `;
  // Whole cents of the totals (never a rounded per-report delta: no drift).
  const growth = Math.round(total) - Math.round(previous);
  if (growth > 0) {
    for (const agentId of sorted) {
      await tx.$executeRaw`
        INSERT INTO "SharedEphemeralState" (namespace, key, value, "expiresAt")
        VALUES (${TOTAL_NAMESPACE}, ${agentId}, ${JSON.stringify({ cents: growth })}::jsonb,
                'infinity'::timestamptz)
        ON CONFLICT (namespace, key) DO UPDATE
          SET value = jsonb_build_object(
                'cents', COALESCE(("SharedEphemeralState".value->>'cents')::numeric, 0) + ${growth}
              )
      `;
    }
    await tx.agent.updateMany({
      where: { id: { in: sorted } },
      data: { treeCostCents: { increment: growth } },
    });
  }
  return growth;
}

/** Whole cents of resume spend under one agent: its aggregate row (one equality read). */
export async function resumeSpendOf(agentId: string, db: Db = prisma): Promise<number> {
  const rows = await db.$queryRaw<Array<{ cents: number | null }>>`
    SELECT (value->>'cents')::float8 AS cents FROM "SharedEphemeralState"
    WHERE namespace = ${TOTAL_NAMESPACE} AND key = ${agentId}
  `;
  return Number(rows[0]?.cents ?? 0) || 0;
}

/**
 * A tree-cost write's stored value: its in-memory value plus the resume spend under
 * the agent, with the Agent row locked first so a concurrent raise either commits
 * before (and is summed) or waits (and increments after): never lost.
 */
export async function addResumeSpendLocked(
  tx: Prisma.TransactionClient,
  agentId: string,
  treeCostCents: number
): Promise<number> {
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${agentId} FOR UPDATE`;
  return treeCostCents + (await resumeSpendOf(agentId, tx));
}

/**
 * Each agent's stored tree cost without its resume spend (a restore's in-memory
 * view), tree and aggregate read in ONE statement.
 */
export async function resumeFreeTrees(
  agents: Array<{ id: string }>,
  db: Db = prisma
): Promise<Map<string, number>> {
  if (agents.length === 0) return new Map();
  const agentIds = agents.map((agent) => agent.id);
  const rows = await db.$queryRaw<Array<{ id: string; tree: number }>>`
    SELECT a.id,
           (a."treeCostCents" - COALESCE((s.value->>'cents')::numeric, 0))::float8 AS tree
    FROM "Agent" a
    LEFT JOIN "SharedEphemeralState" s
      ON s.namespace = ${TOTAL_NAMESPACE} AND s.key = a.id
    WHERE a.id = ANY(${agentIds}::text[])
  `;
  return new Map(rows.map((row) => [row.id, Number(row.tree)]));
}
