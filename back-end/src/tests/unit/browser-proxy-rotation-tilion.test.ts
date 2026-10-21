#!/usr/bin/env tsx
/**
 * Tilion rotate_ip ladder: Tilion residential → Tilion mobile → Kernel
 * residential → Steel, kill-switch path, labels and agent-facing messages.
 * The Kernel, Steel and Browser Use ladders are covered (unchanged) in
 * browser-proxy-rotation.test.ts.
 */
import assert from 'node:assert';
import { buildRotationMessage } from '../../providers/browserSessionResume';
import {
  ROTATION_CAP,
  rotationStepLabel,
  selectRotationStep,
  type RotationStep,
} from '../../providers/browser/rotation';

function testTilionLadder(): void {
  const ladder = [1, 2, 3, 4].map((position) => selectRotationStep(position, 'tilion'));
  assert.deepStrictEqual(ladder, [
    { provider: 'tilion', proxyType: 'residential', recoveryAction: 'ip_rotated' },
    { provider: 'tilion', proxyType: 'mobile', recoveryAction: 'ip_rotated' },
    { provider: 'kernel', proxyType: 'residential', recoveryAction: 'provider_switched' },
    { provider: 'steel', proxyType: 'residential', recoveryAction: 'provider_switched' },
  ]);
  assert.deepStrictEqual(ladder.map(rotationStepLabel), [
    'rotate_tilion_residential_ip',
    'rotate_tilion_mobile_ip',
    'switch_provider_to_kernel',
    'switch_provider_to_steel',
  ]);
  // Browser Use availability never changes the Tilion ladder.
  assert.deepStrictEqual(
    [1, 2, 3, 4].map((position) => selectRotationStep(position, 'tilion', false)),
    ladder
  );
  assert.throws(() => selectRotationStep(0, 'tilion'), RangeError);
  assert.throws(() => selectRotationStep(ROTATION_CAP + 1, 'tilion'), RangeError);
}

function testTilionRunContinuesOnKernelLadderAfterSwitch(): void {
  // Position 3 moved the run to Kernel; position 4 reads the persisted Kernel
  // provider. With Browser Use off (production default) that is Steel, the
  // same step the Tilion ladder names.
  assert.deepStrictEqual(selectRotationStep(4, 'kernel', false, true), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  });
}

function testKillSwitchNeverRotatesIntoTilion(): void {
  for (const current of ['kernel', 'steel', 'browser-use', 'tilion'] as const) {
    for (const browserUse of [true, false]) {
      for (let position = 1; position <= ROTATION_CAP; position += 1) {
        const step = selectRotationStep(position, current, browserUse, false);
        assert.notStrictEqual(
          step.provider,
          'tilion',
          `kill switch off: ${current} position ${position} rotated into Tilion`
        );
      }
    }
  }
  // A Tilion run leaves for Kernel at the same tier when Tilion is disabled.
  assert.deepStrictEqual(selectRotationStep(1, 'tilion', true, false), {
    provider: 'kernel',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  });
  assert.deepStrictEqual(selectRotationStep(2, 'tilion', true, false), {
    provider: 'kernel',
    proxyType: 'mobile',
    recoveryAction: 'provider_switched',
  });
  assert.strictEqual(
    rotationStepLabel(selectRotationStep(2, 'tilion', true, false)),
    'switch_provider_to_kernel'
  );
}

function testOtherLaddersUnchangedByTilionFlag(): void {
  for (const current of ['kernel', 'steel', 'browser-use'] as const) {
    for (const browserUse of [true, false]) {
      for (let position = 1; position <= ROTATION_CAP; position += 1) {
        assert.deepStrictEqual(
          selectRotationStep(position, current, browserUse, false),
          selectRotationStep(position, current, browserUse, true)
        );
        assert.deepStrictEqual(
          selectRotationStep(position, current, browserUse, true),
          selectRotationStep(position, current, browserUse)
        );
      }
    }
  }
}

function testRotationMessages(): void {
  const step = (
    provider: RotationStep['provider'],
    proxyType: RotationStep['proxyType'],
    recoveryAction: RotationStep['recoveryAction']
  ): RotationStep => ({ provider, proxyType, recoveryAction });
  assert.match(
    buildRotationMessage(step('tilion', 'residential', 'ip_rotated'), 1, 3, 'tilion'),
    /^Rotated to a fresh Tilion residential IP \(1\/4\).*3 rotations remaining\.$/
  );
  assert.match(
    buildRotationMessage(step('tilion', 'mobile', 'ip_rotated'), 2, 2, 'tilion'),
    /^Rotated to a fresh Tilion mobile-carrier IP \(2\/4\)/
  );
  assert.match(
    buildRotationMessage(step('kernel', 'residential', 'provider_switched'), 3, 1, 'tilion'),
    /^Switched from Tilion to Kernel with a fresh Kernel residential IP \(3\/4\).*1 rotation remaining\.$/
  );
  assert.match(
    buildRotationMessage(step('kernel', 'mobile', 'provider_switched'), 2, 2, 'tilion'),
    /^Switched from Tilion to Kernel with a fresh Kernel mobile-carrier IP/
  );
  // Existing Kernel → Steel wording is preserved byte for byte.
  assert.strictEqual(
    buildRotationMessage(step('steel', 'residential', 'provider_switched'), 3, 1, 'kernel'),
    'Switched from Kernel to Steel with a fresh Steel residential IP (3/4) — browser and ' +
      'proxy infrastructure changed, same region. Login and cookies preserved. 1 rotation remaining.'
  );
  assert.strictEqual(
    buildRotationMessage(step('kernel', 'mobile', 'ip_rotated'), 2, 2, 'kernel'),
    'Rotated to a fresh Kernel mobile-carrier IP (2/4) — same region. Login and cookies ' +
      'preserved. 2 rotations remaining.'
  );
}

function main(): void {
  testTilionLadder();
  testTilionRunContinuesOnKernelLadderAfterSwitch();
  testKillSwitchNeverRotatesIntoTilion();
  testOtherLaddersUnchangedByTilionFlag();
  testRotationMessages();
  process.stdout.write('PASS Tilion rotate_ip ladder, kill switch, labels and messages\n');
}

main();
