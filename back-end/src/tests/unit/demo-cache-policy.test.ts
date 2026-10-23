#!/usr/bin/env tsx
/**
 * DEMO-tag cache policy: replay gates on DEMO prompt match, not the Fast Mode button.
 *
 * Run: npx tsx src/tests/unit/demo-cache-policy.test.ts
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  demoCacheAllowed,
  demoCacheGoalHashes,
  demoGoalHash,
  OAI_DEMO_ROOT_GOAL_HASH,
  resetDemoCacheGoalHashes,
} from '../../providers/demoCachePolicy';
import {
  OAI_DEMO_CHILD_GOAL_PREFIX,
  OAI_DEMO_ROOT_GOAL_PREFIX,
} from '../../providers/demoCacheNormalizeOaiDemo';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

test('test-mass-agent-run-0 is tagged DEMO in the catalog', () => {
  const tasks = JSON.parse(
    readFileSync(join(process.cwd(), '..', 'agents', 'benchmarks', 'tasks.json'), 'utf8')
  ) as Array<{ name?: string; tags?: string[] }>;
  const mass = tasks.find((t) => t.name === 'test-mass-agent-run-0');
  assert.ok(mass, 'test-mass-agent-run-0 must exist');
  assert.ok(
    (mass.tags ?? []).some((tag) => String(tag).toUpperCase() === 'DEMO'),
    'test-mass-agent-run-0 must include DEMO tag'
  );
});

test('DEMO catalog prompt hashes into the allowlist', () => {
  resetDemoCacheGoalHashes();
  const hashes = demoCacheGoalHashes();
  assert.ok(hashes.has(OAI_DEMO_ROOT_GOAL_HASH));
  const tasks = JSON.parse(
    readFileSync(join(process.cwd(), '..', 'agents', 'benchmarks', 'tasks.json'), 'utf8')
  ) as Array<{ name?: string; prompt?: string }>;
  const mass = tasks.find((t) => t.name === 'test-mass-agent-run-0');
  assert.ok(mass?.prompt);
  assert.ok(hashes.has(demoGoalHash(mass!.prompt!)));
});

test('demoCacheAllowed is true for DEMO root / bound child without a button flag', () => {
  assert.equal(demoCacheAllowed(`${OAI_DEMO_ROOT_GOAL_PREFIX} rest of prompt`), true);
  assert.equal(
    demoCacheAllowed(`${OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky — Huberman`),
    true
  );
  assert.equal(demoCacheAllowed(`${OAI_DEMO_CHILD_GOAL_PREFIX} Huberman`), false);
  assert.equal(demoCacheAllowed('Buy socks'), false);
  assert.equal(demoCacheAllowed('Buy socks', `${OAI_DEMO_ROOT_GOAL_PREFIX} x`), true);
});

test('agentFastMode source uses demoCacheAllowed not the button column', () => {
  const store = readFileSync(join(process.cwd(), 'src', 'providers', 'demoCacheStore.ts'), 'utf8');
  assert.ok(
    store.includes('demoCacheAllowed'),
    'agentFastMode must gate enabled via demoCacheAllowed'
  );
  assert.ok(
    store.includes('providerFastMode'),
    'agentFastMode must expose providerFastMode from button'
  );
  assert.ok(
    /const providerFastMode = agent\?\.fastModeCacheEnabled/.test(store),
    'button column maps to providerFastMode'
  );
  assert.ok(
    /const enabled = demoCacheAllowed\(/.test(store),
    'cache enabled must come from demoCacheAllowed'
  );
});

if (failures.length > 0) {
  process.stderr.write(
    `\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`
  );
  process.exit(1);
}
process.stdout.write(`\n✅ demo-cache-policy: ${passed}/${passed} passed\n`);
