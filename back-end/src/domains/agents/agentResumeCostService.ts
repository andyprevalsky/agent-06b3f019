/**
 * A resume run's spend (agents/workflows/resume_billing.py):
 * POST /api/agents/:id/resume-cost {key, total_cents}: the run's ABSOLUTE total.
 *
 *   one transaction: ledger[key] = max(ledger, total); the owner's and every
 *     ancestor's treeCostCents += growth (never ownCostCents). A resend or a
 *     reordered older total changes nothing: idempotent by construction.
 *   → { limit_reached }: the owner root's status or tree cost against its limit
 *
 * The ledger is the single source of resume spend: no workflow is signalled it;
 * every tree-cost write adds the ledger's totals (resumeReportedSpend.ts).
 * 10k agents: one ancestor walk (≤16 indexed reads) and one transaction per report.
 */
import { z } from 'zod';
import { ownerChainIds, raiseResumeTotal, rootCostLimitReached } from './repoMessageResume';

/** POST /:id/resume-cost body: a resume run's key and its absolute total spend. */
export const resumeCostBodySchema = z.object({
  key: z.string().startsWith('resume:').max(300),
  total_cents: z.number().finite().min(0),
});

export async function applyResumeCost(
  agentId: string,
  body: unknown
): Promise<{ limit_reached: boolean } | { error: string; status: number }> {
  const parsed = resumeCostBodySchema.safeParse(body);
  if (!parsed.success) {
    return { error: `Invalid body: ${parsed.error.issues[0]?.message ?? 'invalid'}`, status: 400 };
  }
  const { key, total_cents: total } = parsed.data;
  const chain = await ownerChainIds(agentId);
  if (chain.length > 0 && total > 0) await raiseResumeTotal(chain, key, total);
  return { limit_reached: await rootCostLimitReached(agentId) };
}
