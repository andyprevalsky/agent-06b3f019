#!/usr/bin/env tsx
/**
 * Dev and benchmark backends must not start in the production Temporal
 * namespace (S18, 2026-10-27: 4,094 orphaned dev/bench workflows there).
 *
 * Run: npx tsx src/tests/unit/temporal-namespace-isolation.test.ts
 */

import assert from 'node:assert';
import {
  PRODUCTION_TEMPORAL_NAMESPACE,
  assertTemporalNamespaceIsolation,
  isProductionTaskQueue,
} from '../../providers/temporalNamespaceIsolation';

const prod = PRODUCTION_TEMPORAL_NAMESPACE;

for (const queue of [
  'navi-agent-tasks',
  'navi-agent-tasks@abc123def456',
  'navi-agent-tasks-pool-265ecf9120a6@ed23d1ef8e13',
]) {
  assert.ok(isProductionTaskQueue(queue), `${queue} is a production queue`);
  assert.doesNotThrow(() =>
    assertTemporalNamespaceIsolation({ TEMPORAL_NAMESPACE: prod, TEMPORAL_TASK_QUEUE: queue })
  );
}

for (const queue of [
  'navi-agent-tasks-cloud-b024f5c1',
  'navi-agent-tasks-cloud-44cb5599-bench-1788386110-890355-24983',
  'navi-agent-tasks-test',
  '',
]) {
  assert.ok(!isProductionTaskQueue(queue), `${queue} is not a production queue`);
  assert.throws(
    () =>
      assertTemporalNamespaceIsolation({ TEMPORAL_NAMESPACE: prod, TEMPORAL_TASK_QUEUE: queue }),
    /production namespace/,
    `${queue} must be refused in ${prod}`
  );
  assert.doesNotThrow(() =>
    assertTemporalNamespaceIsolation({
      TEMPORAL_NAMESPACE: 'rose-labs-bench.tch2n',
      TEMPORAL_TASK_QUEUE: queue,
    })
  );
  assert.doesNotThrow(() =>
    assertTemporalNamespaceIsolation({
      TEMPORAL_NAMESPACE: prod,
      TEMPORAL_TASK_QUEUE: queue,
      BLACKBOX_TEST_FAKE_TEMPORAL: '1',
    })
  );
}

process.stdout.write('temporal namespace isolation tests passed\n');
