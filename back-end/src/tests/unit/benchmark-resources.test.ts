#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { isIsolatedBenchmarkResource } from '../../utils/benchmarkResources';

assert.equal(
  isIsolatedBenchmarkResource('navi-agent-tasks-agent-card-bench-1783798065-5388-24089'),
  true
);
assert.equal(
  isIsolatedBenchmarkResource('victoria-db-agent-card-bench-1783798065-5388-24089'),
  true
);
assert.equal(isIsolatedBenchmarkResource('navi-agent-tasks-archived-workspace'), false);
assert.equal(isIsolatedBenchmarkResource('victoria-db-archived-workspace'), false);

process.stdout.write('benchmark resource ownership tests passed\n');
