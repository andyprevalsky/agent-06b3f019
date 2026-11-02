#!/usr/bin/env tsx
/**
 * Agent speed: create-body resolution and inheritance (the main-side subset of
 * #1634's agent-speed test; its provider-leg cases land with #1634).
 *
 * Run: npx tsx src/tests/unit/agent-speed.test.ts (via scripts/run-unit-tests.ts)
 */

import assert from 'node:assert/strict';
import { createAgentSchema } from '../../domains/agents/types';
import {
  applyFastModeDefault,
  applySpeedDefault,
  applySpeedInheritance,
  disableFastModeForWorldModel,
  resolvedSpeed,
} from '../../domains/agents/agentExecutionMode';
import {
  agentSpeedFromRow,
  normalizeAgentSpeed,
  type AgentSpeed,
} from '../../providers/rose/speed';

const SPEEDS: AgentSpeed[] = ['standard', 'fast', 'ultrafast'];
const PARENT = '00000000-0000-4000-8000-000000000001';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

function createBody(extra: Record<string, unknown>) {
  return createAgentSchema.parse({ goal: 'x', ...extra });
}

async function main(): Promise<void> {
  await test('speed values normalize; unknown or absent is standard', () => {
    assert.equal(normalizeAgentSpeed(undefined), 'standard');
    assert.equal(normalizeAgentSpeed('turbo'), 'standard');
    for (const speed of SPEEDS) assert.equal(normalizeAgentSpeed(speed), speed);
    assert.equal(agentSpeedFromRow({ speed: null, fastModeCacheEnabled: true }), 'fast');
    assert.equal(agentSpeedFromRow({ speed: null, fastModeCacheEnabled: false }), 'standard');
    assert.equal(
      agentSpeedFromRow({ speed: 'ultrafast', fastModeCacheEnabled: false }),
      'ultrafast'
    );
  });

  await test('create body: explicit speed, legacy boolean, and absent-both resolve', () => {
    const cases: Array<[Record<string, unknown>, AgentSpeed]> = [
      [{ speed: 'fast' }, 'fast'],
      [{ speed: 'ultrafast' }, 'ultrafast'],
      [{ speed: 'standard', fast_mode_cache_enabled: true }, 'standard'],
      [{ fast_mode_cache_enabled: true }, 'fast'],
      [{ fast_mode_cache_enabled: false }, 'standard'],
      [{}, 'standard'],
    ];
    for (const [extra, expected] of cases) {
      const body = createBody(extra);
      applySpeedDefault(body);
      applyFastModeDefault(body, PARENT);
      assert.equal(resolvedSpeed(body), expected, JSON.stringify(extra));
    }
    // The legacy cache-key bit keeps its own default: speed never changes it.
    const absent = createBody({});
    applySpeedDefault(absent);
    applyFastModeDefault(absent, PARENT);
    assert.equal(absent.fast_mode_cache_enabled, true);
  });

  await test('sub-agents inherit the parent speed unless the request sets one', () => {
    const sub = (extra: Record<string, unknown> = {}) =>
      createBody({ parent_agent_id: PARENT, parent_workflow_id: 'wf', ...extra });
    const inherited = sub();
    applySpeedDefault(inherited);
    applySpeedInheritance(inherited, { speed: 'ultrafast', fastModeCacheEnabled: false });
    assert.equal(resolvedSpeed(inherited), 'ultrafast');
    const legacyParent = sub();
    applySpeedDefault(legacyParent);
    applySpeedInheritance(legacyParent, { speed: null, fastModeCacheEnabled: true });
    assert.equal(resolvedSpeed(legacyParent), 'fast');
    const explicit = sub({ speed: 'standard' });
    applySpeedDefault(explicit);
    applySpeedInheritance(explicit, { speed: 'ultrafast', fastModeCacheEnabled: true });
    assert.equal(resolvedSpeed(explicit), 'standard');
    const foreign = sub();
    applySpeedDefault(foreign);
    applySpeedInheritance(foreign, null);
    assert.equal(resolvedSpeed(foreign), 'standard');
  });

  await test('Simulator mode keeps its standard provider contract', () => {
    const body = createBody({ speed: 'ultrafast', world_model_mode: 'simulate' });
    applySpeedDefault(body);
    disableFastModeForWorldModel(body);
    assert.equal(resolvedSpeed(body), 'standard');
  });

  if (failures.length > 0) {
    process.stderr.write(
      `\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`
    );
    process.exit(1);
  }
  process.stdout.write(`\n✅ ${passed} agent-speed tests passed\n`);
}

void main();
