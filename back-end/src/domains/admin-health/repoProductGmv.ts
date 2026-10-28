import { Prisma } from '@prisma/client';

import { prisma } from '../../providers/database';
import { realWaitlistPersonSql } from '../../providers/waitlistIdentity';
import type { GmvRecord } from './repo';
import { coreTeamSql } from './repoProductUsage';

/**
 * Platform GMV = real purchases agents made for the counted population.
 *
 * CLEARED PurchaseSpend rows from the two purchase sources, then only:
 *   - AgentCard charges on live Stripe (test-mode charges move no money);
 *   - order confirmations whose captured amount is a single checkout total, not
 *     one entry of a multi-entry list (items.N.order_total over several orders
 *     = an order-history lookup; prod 2026-09-28 harvested ~$2.1k of past Amazon
 *     orders that way; the producer now rejects these too), and whose root task
 *     is no longer running (a running task's captures are unverified);
 *   - from a real (non-benchmark, real-world-model) agent when the agent row
 *     still exists;
 *   - owned by the core team or a real person. series.ts then keeps only the
 *     core team and that period's Stripe subscribers, matching completion rate.
 * One indexed date-window query; no per-purchase lookups.
 */
export async function findProductGmvBetween(start: Date, end: Date): Promise<GmvRecord[]> {
  const coreTeam = coreTeamSql(Prisma.sql`spend."userId"`, 'person');
  return prisma.$queryRaw<GmvRecord[]>(Prisma.sql`
    SELECT spend."userId", spend."agentId", spend."totalCents", spend."createdAt",
           spend.provider, ${coreTeam} AS "coreTeam"
    FROM "PurchaseSpend" spend
    INNER JOIN "User" person ON person."userId" = spend."userId"
    LEFT JOIN "Agent" agent ON agent.id = spend."agentId"
    LEFT JOIN "Agent" root ON root.id = COALESCE(agent."busId", agent.id)
    WHERE spend.status = 'CLEARED'
      AND spend."createdAt" >= ${start} AND spend."createdAt" < ${end}
      AND spend.provider IN ('agentcard', 'order_confirmation')
      AND (agent.id IS NULL OR (agent."isBenchmark" = false AND agent."worldModelMode" = 'real'))
      AND (spend.provider <> 'agentcard' OR spend."stripeLivemode" = true)
      AND (spend.provider <> 'order_confirmation' OR (
            COALESCE(jsonb_array_length(CASE jsonb_typeof(spend."lineItemsJson"->'sourceFields'
                  -> substring(spend."lineItemsJson"->>'amountKey' from '^([^.]+)\.[0-9]+\.'))
                WHEN 'array' THEN spend."lineItemsJson"->'sourceFields'
                  -> substring(spend."lineItemsJson"->>'amountKey' from '^([^.]+)\.[0-9]+\.')
              END), 1) <= 1
            AND COALESCE(root.status::text, 'COMPLETED')
                NOT IN ('STARTING_UP', 'ACTIVE', 'PAUSED')))
      AND (${coreTeam} OR ${realWaitlistPersonSql('person')})
  `);
}
