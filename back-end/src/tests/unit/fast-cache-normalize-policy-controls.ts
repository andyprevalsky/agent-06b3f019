/** Policy controls invoked by the existing Fast Cache normalization unit runner. */
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { worldModelCacheScope } from '../../providers/fastCacheNormalizeConstants';
import {
  llmKey,
  browserHttpKey,
  buildGlobalKey,
  anthropicKeyFromHash,
  codexKeyFromHash,
} from '../../domains/fast-cache/normalize';

export function testRegisteredWmhExecutionPolicy(): void {
  const keys = [
    'BENCHMARK_WORLD_MODEL_MODE',
    'WMH_MODEL_NAME',
    'WORLD_MODEL_NAME',
    'WMH_EXECUTION_POLICY',
  ];
  const saved = keys.map((key) => process.env[key]);
  try {
    // Read the canonical registry as data: backend-only tests need no Python runtime.
    const registry = readFileSync(
      join(process.cwd(), '..', 'agents', 'benchmarks', 'wmh_execution_policy.py'),
      'utf8'
    );
    const constant = (name: string): string => {
      const match = registry.match(new RegExp(`^${name} = "([^"\\n]+)"$`, 'm'));
      assert.ok(match, `missing canonical Python metadata: ${name}`);
      return match[1];
    };
    const policy = constant('PUBLIC_AFFORDANCES_POLICY');
    const version = constant('PUBLIC_AFFORDANCES_VERSION');
    const digest = constant('PUBLIC_AFFORDANCES_SHA256');
    const text = registry.match(/PUBLIC_AFFORDANCES_TEXT = "{3}([\s\S]*?)"{3}/);
    assert.ok(text, 'canonical policy text must remain available');
    assert.strictEqual(createHash('sha256').update(text[1], 'utf8').digest('hex'), digest);

    process.env.BENCHMARK_WORLD_MODEL_MODE = 'real';
    process.env.WMH_MODEL_NAME = 'rose archive/v2';
    process.env.WMH_EXECUTION_POLICY = 'upstream';
    const keySet = (): string[] => [
      llmKey('goal', 'site', { messages: [] }),
      browserHttpKey('goal', 'GET', 'https://example.com/contact'),
      buildGlobalKey('web_fetch', 'same-resource'),
      anthropicKeyFromHash('root-goal-hash', { messages: [] }),
      codexKeyFromHash('root-goal-hash', { messages: [] }),
    ];
    const real = keySet();
    process.env.WMH_EXECUTION_POLICY = policy;
    assert.deepStrictEqual(keySet(), real);
    process.env.BENCHMARK_WORLD_MODEL_MODE = 'shadow';
    assert.deepStrictEqual(keySet(), real);

    process.env.BENCHMARK_WORLD_MODEL_MODE = 'simulate';
    delete process.env.WMH_EXECUTION_POLICY;
    const baseline = keySet();
    assert.strictEqual(worldModelCacheScope(), 'sim.rose-archive-v2:');
    process.env.WMH_EXECUTION_POLICY = 'upstream';
    assert.deepStrictEqual(keySet(), baseline);
    const stale = new Map(baseline.map((key) => [key, 'baseline observation']));
    process.env.WMH_EXECUTION_POLICY = policy;
    assert.strictEqual(
      worldModelCacheScope(),
      `sim.rose-archive-v2.policy.${policy}.${version}.${digest.slice(0, 16)}:`
    );
    const activated = keySet();
    assert.deepStrictEqual(keySet(), activated);
    assert.ok(activated.every((key, i) => key !== baseline[i] && !stale.has(key)));
    process.env.WMH_EXECUTION_POLICY = 'unregistered';
    assert.throws(keySet, /Unknown WMH execution policy/);
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
}
