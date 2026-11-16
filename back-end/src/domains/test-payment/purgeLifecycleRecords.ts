/**
 * Remove the owner's live production lifecycle-probe purchase records once the probe has settled.
 *
 * The production AgentCard lifecycle probe runs as the owner admin account
 * (providers/ownerLifecycleBilling.ts). After its assertions pass, its $1 probe purchase must not
 * stay in the owner's purchase history. Only a benchmark agent's purchases are purged, and only
 * when every one is terminal with its company-wallet funding reclaimed, consumed by a cleared
 * purchase, or never funded: money still in flight keeps its records for reconciliation.
 */
import { isBenchmarkAgent } from '../../providers/benchmarkAgent';
import { createLogger } from '../../providers/logger';
import { BENCHMARK_PAYMENT_LIFECYCLE_OWNER_USER_ID } from '../../providers/benchmarkPaymentIdentity';
import { TestPaymentError } from './errors';
import * as repo from './repo';

const log = createLogger('TestPaymentPurgeLifecycle');

// An abandoned probe settles refunded/voided with its funding reclaimed; a completed purchase probe
// settles CLEARED with its funding CONSUMED by the card spend.
const SETTLED = new Set<string>(['REFUNDED', 'VOIDED', 'FAILED', 'FUNDING_ABANDONED', 'CLEARED']);
const FUNDING_SETTLED = new Set<string>(['RECLAIMED', 'CONSUMED']);

export function isSettledProbePurchase(row: {
  status: string;
  walletFunding: { status: string } | null;
}): boolean {
  return (
    SETTLED.has(row.status) &&
    (row.walletFunding === null || FUNDING_SETTLED.has(row.walletFunding.status))
  );
}

export type PurgeLifecycleResult = { agentId: string; purged: number };

export async function purgeOwnerLifecycleProbeRecords(
  agentId: string
): Promise<PurgeLifecycleResult> {
  const id = agentId.trim();
  if (id === '') throw new TestPaymentError('agentId is required', 400);
  const record = await repo.findAgentOwnerAndProbePurchases(id);
  if (record === null) throw new TestPaymentError('Agent not found', 404);
  if (
    record.userId !== BENCHMARK_PAYMENT_LIFECYCLE_OWNER_USER_ID ||
    !(await isBenchmarkAgent(id))
  ) {
    throw new TestPaymentError(
      'purge is limited to the owner lifecycle probe benchmark agent',
      403
    );
  }
  const { purchases } = record;
  const unsettled = purchases.filter((row) => !isSettledProbePurchase(row));
  if (unsettled.length > 0) {
    throw new TestPaymentError(
      `lifecycle probe purchases are not settled: ${unsettled
        .map((row) => `${row.id}=${row.status}/${row.walletFunding?.status ?? 'unfunded'}`)
        .join(', ')}`,
      409
    );
  }
  const count = await repo.deleteAgentPurchases(
    id,
    purchases.map((row) => row.id)
  );
  log.info('Purged settled owner lifecycle-probe purchase records', {
    agent_id: id,
    purged: count,
  });
  return { agentId: id, purged: count };
}
