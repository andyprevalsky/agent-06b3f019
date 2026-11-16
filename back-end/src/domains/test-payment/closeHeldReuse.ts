/**
 * Close leftover HELD purchase cards for the production lifecycle probe user so
 * `lookupPurchase` cannot skip payment_approval via 24h cart-fingerprint reuse.
 *
 * Scoped to `agent-payment-production-purchase` harness preflight only — other
 * prod Stripe reuse callers never hit this endpoint.
 */

import {
  BENCHMARK_PAYMENT_LIFECYCLE_OWNER_USER_ID,
  BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID,
} from '../../providers/benchmarkPaymentIdentity';
import { isBenchmarkAgent } from '../../providers/benchmarkAgent';
import { createLogger } from '../../providers/logger';
import { cleanupAgentPurchaseCards } from '../../providers/purchaseCleanup';
import { TestPaymentError } from './errors';
import * as repo from './repo';

const log = createLogger('TestPaymentCloseHeldReuse');

/** $1 Agent Card Lifecycle Probe cart — only clear holds for this probe. */
const LIFECYCLE_PROBE_TOTAL_CENTS = 100;

export type CloseHeldReuseResult = {
  userId: string;
  heldFound: number;
  agentsCleaned: number;
  orphanHeldIgnored: number;
};

export type CloseHeldReuseDeps = {
  findHeldProbePurchases?: (
    userId: string
  ) => Promise<Array<{ id: string; agentId: string | null }>>;
  cleanupAgent?: (agentId: string) => Promise<void>;
  isBenchmarkAgent?: (agentId: string | null | undefined) => Promise<boolean>;
};

async function defaultFindHeldProbePurchases(
  userId: string
): Promise<Array<{ id: string; agentId: string | null }>> {
  return repo.findHeldLifecycleProbePurchases(userId, LIFECYCLE_PROBE_TOTAL_CENTS);
}

export async function closeHeldPurchaseReuseForLifecycleProbe(
  userId: string,
  deps: CloseHeldReuseDeps = {}
): Promise<CloseHeldReuseResult> {
  const trimmed = userId.trim();
  if (trimmed === '') {
    throw new TestPaymentError('userId is required', 400);
  }
  const owner = trimmed === BENCHMARK_PAYMENT_LIFECYCLE_OWNER_USER_ID;
  if (trimmed !== BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID && !owner) {
    throw new TestPaymentError(
      'close-held-reuse is limited to the production AgentCard lifecycle probe user',
      403
    );
  }

  const findHeld = deps.findHeldProbePurchases ?? defaultFindHeldProbePurchases;
  const cleanupAgent = deps.cleanupAgent ?? cleanupAgentPurchaseCards;
  const found = await findHeld(trimmed);
  // The owner's real $1 purchases are never touched: only its benchmark agents' probe holds.
  const isBenchmark = deps.isBenchmarkAgent ?? isBenchmarkAgent;
  const held = owner
    ? (
        await Promise.all(found.map(async (row) => ((await isBenchmark(row.agentId)) ? row : null)))
      ).filter((row): row is { id: string; agentId: string | null } => row !== null)
    : found;

  const agentIds = [
    ...new Set(
      held
        .map((row) => row.agentId)
        .filter(
          (agentId): agentId is string => typeof agentId === 'string' && agentId.trim() !== ''
        )
    ),
  ];
  const orphanHeldIgnored = held.filter((row) => row.agentId === null).length;

  for (const agentId of agentIds) {
    log.info('Closing held lifecycle-probe purchase reuse via agent cleanup', {
      user_id: trimmed,
      agent_id: agentId,
    });
    await cleanupAgent(agentId);
  }

  if (orphanHeldIgnored > 0) {
    log.warn('Orphan HELD lifecycle-probe rows lack agentId; left for reconcile', {
      user_id: trimmed,
      count: orphanHeldIgnored,
    });
  }

  return {
    userId: trimmed,
    heldFound: held.length,
    agentsCleaned: agentIds.length,
    orphanHeldIgnored,
  };
}
