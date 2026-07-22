#!/usr/bin/env tsx
/**
 * Unit tests for the rotate_ip building blocks that need no DB or Kernel SDK:
 *  - the mobile proxy-candidate builder (geo relaxation + type-prefixed keys)
 *  - the deterministic Kernel residential → mobile → Steel ladder
 */
import assert from 'node:assert';
import { rotateProxySchema } from '../../domains/browser-session/types';
import { kernelProxyCandidates } from '../../providers/browser/kernelProxy';
import { ROTATION_CAP, selectRotationStep } from '../../providers/browser/rotation';

function testMobileCandidates(): void {
  const candidates = kernelProxyCandidates(
    { country: 'US', state: 'TX', city: 'DALLAS' },
    'mobile'
  );

  // City → state → country relaxation, all tagged mobile.
  assert.strictEqual(candidates.length, 3, 'expected city/state/country candidates');
  assert.deepStrictEqual(
    candidates.map((c) => c.proxyKey),
    ['mobile:US:TX:dallas', 'mobile:US:TX', 'mobile:US'],
    'mobile proxyKeys must be type-prefixed and geo-relaxed'
  );
  assert.ok(
    candidates.every((c) => c.type === 'mobile'),
    'every mobile candidate must carry type=mobile'
  );
  assert.deepStrictEqual(
    candidates.map((c) => c.source),
    ['kernel_mobile_city', 'kernel_mobile_state', 'kernel_mobile_country'],
    'mobile sources must reflect the tier'
  );
  assert.strictEqual(candidates[0].name, 'rose-mobile-us-tx-dallas');
}

function testResidentialUnchanged(): void {
  // Default tier stays residential — no regression from the mobile generalization.
  const candidates = kernelProxyCandidates({ country: 'US', state: 'CA', city: 'SAN FRANCISCO' });
  assert.strictEqual(candidates[0].proxyKey, 'residential:US:CA:san_francisco');
  assert.strictEqual(candidates[0].type, 'residential');
  assert.strictEqual(candidates[0].source, 'kernel_residential_city');
}

function testRotationTierLadder(): void {
  assert.strictEqual(ROTATION_CAP, 4);
  assert.deepStrictEqual(selectRotationStep(1, 'kernel'), {
    provider: 'kernel',
    proxyType: 'residential',
    recoveryAction: 'ip_rotated',
  });
  assert.deepStrictEqual(selectRotationStep(2, 'kernel'), {
    provider: 'kernel',
    proxyType: 'mobile',
    recoveryAction: 'ip_rotated',
  });
  assert.deepStrictEqual(selectRotationStep(3, 'kernel'), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  });
  assert.deepStrictEqual(selectRotationStep(4, 'steel'), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'ip_rotated',
  });

  // A run that starts on Steel stays on Steel; provider rotation is one-way.
  assert.deepStrictEqual(selectRotationStep(1, 'steel'), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'ip_rotated',
  });
  assert.throws(() => selectRotationStep(0, 'kernel'), RangeError);
  assert.throws(() => selectRotationStep(ROTATION_CAP + 1, 'steel'), RangeError);
}

function testRotationRequestSchema(): void {
  const taskId = '00000000-0000-4000-8000-000000000001';
  assert.deepStrictEqual(rotateProxySchema.parse({ task_id: taskId }), { task_id: taskId });
  assert.deepStrictEqual(
    rotateProxySchema.parse({ task_id: taskId, current_url: 'https://example.com/current' }),
    { task_id: taskId, current_url: 'https://example.com/current' }
  );
  assert.strictEqual(
    rotateProxySchema.safeParse({ task_id: taskId, current_url: '' }).success,
    false
  );
}

function main(): void {
  testMobileCandidates();
  testResidentialUnchanged();
  testRotationTierLadder();
  testRotationRequestSchema();
  process.stdout.write('PASS rotate_ip mobile candidates + escalation ladder\n');
}

main();
