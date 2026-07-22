#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { isIsolatedBenchmarkResource } from '../../utils/benchmarkResources';

function main(): void {
  // These are the task-queue names emitted by scripts/run-bench-fleet. Deploy
  // cleanup must never treat a live fleet queue as an archived workspace.
  assert.equal(
    isIsolatedBenchmarkResource('navi-agent-tasks-flt-browser-agent-amazon-cookie-payment-63510-0'),
    true,
    'the observed Epoch 8 fleet queue must remain owned by the benchmark'
  );
  assert.equal(
    isIsolatedBenchmarkResource('navi-agent-tasks-flt-browser-agent-google-flights-63510-9'),
    true,
    'sibling fleet queues must remain owned by the benchmark'
  );
  assert.equal(
    isIsolatedBenchmarkResource(
      'navi-agent-tasks-flt-browser-agent-an-extremely-long-benchmark-ta'
    ),
    true,
    'fleet queues remain protected when the 48-character workspace limit removes the run suffix'
  );

  assert.equal(
    isIsolatedBenchmarkResource('navi-agent-tasks-agent-card-bench-1783798065-5388-24089'),
    true,
    'legacy isolated benchmark queues remain protected'
  );
  assert.equal(
    isIsolatedBenchmarkResource('navi-agent-tasks-archived-workspace'),
    false,
    'archived workspace queues remain eligible for cleanup'
  );
  assert.equal(
    isIsolatedBenchmarkResource('victoria-db-flt-browser-agent-amazon-cookie-payment-63510-0'),
    false,
    'the reserved fleet ownership rule applies only to Temporal task queues'
  );

  process.stdout.write('PASS benchmark resource ownership boundary\n');
}

main();
