#!/usr/bin/env tsx

/**
 * Hub agent resolution must stay O(1) on an unknown in-flight UUID.
 * Official 4w creates a client-side agent-id and GETs /agents/:id before
 * POST /api/agents commits; scanning every hub bundle on that miss starves
 * Prisma and blows the 5s lifecycle ratchet.
 *
 * Run: npx tsx src/tests/unit/hub-resolve-run-id.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveHubRunIdFromIndexes } from '../../providers/benchmarkHubStore';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  fail ${name}\n`);
  }
}

const runs = [
  {
    run_id: 'run-root',
    timestamp: '2026-09-01T00:00:00Z',
    suite: null,
    live: false,
    tasks: [
      {
        name: 'mass-agent',
        passed: true,
        status: 'passed',
        agent_id: 'root-agent',
        duration_seconds: 1,
        cost_cents: 0,
        world_model_mode: null,
        fast_mode: true,
        tree_agent_count: 2,
        failure_reason: null,
      },
    ],
  },
];

test('root ids resolve from the run index without a child map', () => {
  const resolved = resolveHubRunIdFromIndexes('root-agent', runs, null);
  assert.deepEqual(resolved, { kind: 'hit', runId: 'run-root' });
});

test('unknown ids are pending while the child index is still building', () => {
  const resolved = resolveHubRunIdFromIndexes('brand-new-4w-uuid', runs, null);
  assert.deepEqual(resolved, { kind: 'pending' });
});

test('unknown ids miss in O(1) once the child index exists', () => {
  const childIndex = new Map<string, string>([['gp-child', 'run-root']]);
  const resolved = resolveHubRunIdFromIndexes('brand-new-4w-uuid', runs, childIndex);
  assert.deepEqual(resolved, { kind: 'miss' });
});

test('child ids resolve from the child index after it is built', () => {
  const childIndex = new Map<string, string>([['gp-child', 'run-root']]);
  const resolved = resolveHubRunIdFromIndexes('gp-child', runs, childIndex);
  assert.deepEqual(resolved, { kind: 'hit', runId: 'run-root' });
});

test('findAgentAcrossRuns does not scan every bundle on the request path', () => {
  const src = readFileSync(join(process.cwd(), 'src/providers/benchmarkHubStore.ts'), 'utf8');
  const start = src.indexOf('export async function findAgentAcrossRuns');
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf('export function ancestorsFromHubTree'));
  assert.equal(
    /for \(const run of index\) \{\s*const view = await getRunAgent/.test(body),
    false,
    'Pass-2 per-request bundle scan must not return'
  );
});

test('GET /ancestors does not walk the hub archive on an empty live CTE', () => {
  const src = readFileSync(join(process.cwd(), 'src/domains/agents/routes.ts'), 'utf8');
  assert.match(src, /getAncestors\(req\.params\.id\)/);
  assert.equal(
    /getAncestors\(req\.params\.id,\s*canReadBenchmarkArchive/.test(src),
    false,
    'ancestors hub walk re-opens the official 4w create race'
  );
});

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`\nhub resolve run id: ${passed} passed\n`);
