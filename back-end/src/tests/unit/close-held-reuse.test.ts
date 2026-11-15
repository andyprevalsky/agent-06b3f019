#!/usr/bin/env tsx
/**
 * closeHeldPurchaseReuseForLifecycleProbe must only touch the production lifecycle
 * probe user and only clean agent-scoped HELD $1 rows (cart-reuse gate for
 * agent-payment-production-purchase).
 */

import assert from 'node:assert/strict';
import {
  BENCHMARK_PAYMENT_LIFECYCLE_OWNER_USER_ID,
  BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID,
} from '../../providers/benchmarkPaymentIdentity';
import { closeHeldPurchaseReuseForLifecycleProbe } from '../../domains/test-payment/closeHeldReuse';
import { TestPaymentError } from '../../domains/test-payment/errors';

async function main(): Promise<void> {
  await assert.rejects(
    () => closeHeldPurchaseReuseForLifecycleProbe('someone-else'),
    (error: unknown) =>
      error instanceof TestPaymentError &&
      error.statusCode === 403 &&
      /lifecycle probe user/.test(error.message)
  );

  const cleanedAgentIds: string[] = [];
  const result = await closeHeldPurchaseReuseForLifecycleProbe(
    BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID,
    {
      findHeldProbePurchases: async () => [
        { id: 'p1', agentId: 'agent-a' },
        { id: 'p2', agentId: 'agent-a' },
        { id: 'p3', agentId: null },
        { id: 'p4', agentId: 'agent-b' },
      ],
      cleanupAgent: async (agentId) => {
        cleanedAgentIds.push(agentId);
      },
    }
  );

  assert.equal(result.heldFound, 4);
  assert.equal(result.agentsCleaned, 2);
  assert.equal(result.orphanHeldIgnored, 1);
  assert.deepEqual(cleanedAgentIds.sort(), ['agent-a', 'agent-b']);

  // The owner probe account: only its benchmark agents' held probe cards are closed; its real
  // $1 purchases (non-benchmark agents) are never touched.
  const ownerCleaned: string[] = [];
  const owner = await closeHeldPurchaseReuseForLifecycleProbe(
    BENCHMARK_PAYMENT_LIFECYCLE_OWNER_USER_ID,
    {
      findHeldProbePurchases: async () => [
        { id: 'o1', agentId: 'bench-agent' },
        { id: 'o2', agentId: 'real-agent' },
      ],
      isBenchmarkAgent: async (agentId) => agentId === 'bench-agent',
      cleanupAgent: async (agentId) => {
        ownerCleaned.push(agentId);
      },
    }
  );
  assert.equal(owner.heldFound, 1);
  assert.deepEqual(ownerCleaned, ['bench-agent']);

  process.stdout.write('PASS close-held-reuse\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
