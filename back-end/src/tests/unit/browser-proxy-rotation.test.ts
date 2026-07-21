#!/usr/bin/env tsx
/**
 * Unit tests for the rotate_ip building blocks that need no DB or Kernel SDK:
 *  - the mobile proxy-candidate builder (geo relaxation + type-prefixed keys)
 *  - the escalation-ladder tier selector (2× residential → mobile, gate-aware)
 */
import assert from 'node:assert';
import { kernelProxyCandidates } from '../../providers/browser/kernelProxy';
import {
  selectRotationTier,
  ROTATION_CAP,
  RESIDENTIAL_ROTATIONS,
} from '../../providers/browserSessionResume';

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
  assert.strictEqual(RESIDENTIAL_ROTATIONS, 2);

  // Mobile enabled: calls 1-2 residential, 3-4 mobile.
  assert.strictEqual(selectRotationTier(1, true), 'residential');
  assert.strictEqual(selectRotationTier(2, true), 'residential');
  assert.strictEqual(selectRotationTier(3, true), 'mobile');
  assert.strictEqual(selectRotationTier(4, true), 'mobile');

  // Mobile disabled: later rotations stay residential (still a fresh IP).
  assert.strictEqual(selectRotationTier(3, false), 'residential');
  assert.strictEqual(selectRotationTier(4, false), 'residential');
}

function main(): void {
  testMobileCandidates();
  testResidentialUnchanged();
  testRotationTierLadder();
  process.stdout.write('PASS rotate_ip mobile candidates + escalation ladder\n');
}

main();
