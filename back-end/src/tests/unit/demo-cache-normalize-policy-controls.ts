/** Policy controls invoked by the existing Fast Cache normalization unit runner. */
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { worldModelCacheScope } from '../../providers/demoCacheNormalizeConstants';
import {
  llmKey,
  browserHttpKey,
  buildGlobalKey,
  anthropicKeyFromHash,
  codexKeyFromHash,
} from '../../domains/demo-cache/normalize';

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
    const baseText = registry.match(/PUBLIC_AFFORDANCES_TEXT = "{3}([\s\S]*?)"{3}/);
    assert.ok(baseText, 'canonical v1 text must remain available');
    const policies = ['PUBLIC_AFFORDANCES', 'PUBLIC_AFFORDANCES_V2'].map((prefix, i) => {
      const policy = constant(`${prefix}_POLICY`);
      const version = constant(`${prefix}_VERSION`);
      const digest = constant(`${prefix}_SHA256`);
      const text = registry.match(
        new RegExp(
          `${prefix}_TEXT = \\(?\\s*(?:(PUBLIC_AFFORDANCES_TEXT)\\s*\\+\\s*)?"{3}([\\s\\S]*?)"{3}`
        )
      );
      assert.ok(text, 'canonical policy text must remain available');
      const policyText = (text[1] ? baseText[1] : '') + text[2];
      assert.strictEqual(createHash('sha256').update(policyText, 'utf8').digest('hex'), digest);
      assert.strictEqual(policy, `rose-virtual-public-affordances-v${i + 1}`);
      assert.strictEqual(version, String(i + 1));
      return { policy, version, digest };
    });
    const outcomesSource = readFileSync(
      join(__dirname, '../../../../agents/benchmarks/wmh_outcomes.py'),
      'utf8'
    );
    const distributionText = outcomesSource.match(/DISTRIBUTION_TEXT = "{3}([\s\S]*?)"{3}/);
    assert.ok(distributionText, 'canonical distribution text must remain available');
    const distributionPolicy = constant('OUTCOME_DISTRIBUTION_POLICY');
    const distributionVersion = constant('OUTCOME_DISTRIBUTION_VERSION');
    const distributionDigest = constant('OUTCOME_DISTRIBUTION_SHA256');
    assert.strictEqual(distributionPolicy, 'rose-outcome-distribution-v1');
    assert.strictEqual(distributionVersion, '1');
    assert.strictEqual(
      createHash('sha256').update(distributionText[1], 'utf8').digest('hex'),
      distributionDigest
    );
    policies.push({
      policy: distributionPolicy,
      version: distributionVersion,
      digest: distributionDigest,
    });

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
    // Registered timed policies (v3, v4) must leave production (real/shadow) keys byte-identical.
    const timedPolicies = ['rose-outcome-distribution-v3', 'rose-outcome-distribution-v4'];
    for (const mode of ['real', 'shadow']) {
      process.env.BENCHMARK_WORLD_MODEL_MODE = mode;
      for (const policy of [...policies.map(({ policy }) => policy), ...timedPolicies]) {
        process.env.WMH_EXECUTION_POLICY = policy;
        assert.strictEqual(worldModelCacheScope(), '');
        assert.deepStrictEqual(keySet(), real);
      }
    }

    process.env.BENCHMARK_WORLD_MODEL_MODE = 'simulate';
    delete process.env.WMH_EXECUTION_POLICY;
    const baseline = keySet();
    assert.strictEqual(worldModelCacheScope(), 'sim.rose-archive-v2:');
    process.env.WMH_EXECUTION_POLICY = 'upstream';
    assert.deepStrictEqual(keySet(), baseline);
    const stale = new Map(baseline.map((key) => [key, 'baseline observation']));
    const choices = [
      undefined,
      'auto',
      'none',
      'required',
      { type: 'function', function: { name: 'set_plan' } },
    ];
    for (const { policy, version, digest } of policies) {
      process.env.WMH_EXECUTION_POLICY = policy;
      assert.strictEqual(
        worldModelCacheScope(),
        `sim.rose-archive-v2.policy.${policy}.${version}.${digest.slice(0, 16)}:`
      );
      const activated = keySet();
      assert.deepStrictEqual(keySet(), activated);
      assert.ok(activated.every((key, i) => key !== baseline[i] && !stale.has(key)));
      for (const key of activated) stale.set(key, policy);
      const choiceKeys = choices.map((tool_choice) =>
        llmKey('goal', 'site', { messages: [], tool_choice })
      );
      assert.strictEqual(new Set(choiceKeys).size, choices.length);
    }
    process.env.WMH_EXECUTION_POLICY = 'rose-outcome-distribution-v4';
    assert.strictEqual(
      worldModelCacheScope(),
      'sim.rose-archive-v2.policy.rose-outcome-distribution-v4.4.dc3c757c601515ff:'
    );
    for (const policy of ['unregistered', 'rose-virtual-public-affordances-v3', '__proto__']) {
      process.env.WMH_EXECUTION_POLICY = policy;
      assert.throws(keySet, /Unknown WMH execution policy/);
    }
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
}
