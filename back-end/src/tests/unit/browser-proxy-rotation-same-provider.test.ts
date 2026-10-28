#!/usr/bin/env tsx
/**
 * BROWSER_RECOVERY_SAME_PROVIDER_ONLY (experiment knob, default off): recovery
 * candidates and the rotate_ip ladder never leave the session's current provider.
 */
import assert from 'node:assert';
import { browserRecoveryCandidates } from '../../providers/browser/challengeRecovery';
import { lockCandidatesToProvider } from '../../providers/browser/challengeRecoveryCandidates';
import {
  nextRecoveryLabel,
  recoverySameProviderOnly,
  ROTATION_CAP,
  rotationStepLabel,
  sameProviderRotationStep,
  selectRotationStep,
} from '../../providers/browser/rotation';

const ALL = { browserUse: true, tilion: true };

function withKnob<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.BROWSER_RECOVERY_SAME_PROVIDER_ONLY;
  if (value === undefined) delete process.env.BROWSER_RECOVERY_SAME_PROVIDER_ONLY;
  else process.env.BROWSER_RECOVERY_SAME_PROVIDER_ONLY = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.BROWSER_RECOVERY_SAME_PROVIDER_ONLY;
    else process.env.BROWSER_RECOVERY_SAME_PROVIDER_ONLY = previous;
  }
}

function testKnobParsing(): void {
  assert.strictEqual(withKnob(undefined, recoverySameProviderOnly), false, 'default must be off');
  for (const on of ['true', '1', 'yes', 'ON'])
    assert.strictEqual(withKnob(on, recoverySameProviderOnly), true);
  for (const off of ['false', '0', '', 'no'])
    assert.strictEqual(withKnob(off, recoverySameProviderOnly), false);
}

function testLockedLadderNeverSwitchesProvider(): void {
  for (const provider of ['tilion', 'kernel', 'steel', 'browser-use'] as const) {
    for (let position = 1; position <= ROTATION_CAP; position += 1) {
      const ladder = selectRotationStep(position, provider, true, true, false);
      const locked = sameProviderRotationStep(ladder, provider, ALL);
      assert.ok(locked, `${provider} position ${position} has a same-provider rung`);
      assert.strictEqual(locked.provider, provider, `${provider} position ${position} switched`);
      if (ladder.provider === provider)
        assert.deepStrictEqual(locked, ladder, 'same-provider rungs are kept');
      else
        assert.deepStrictEqual(locked, {
          provider,
          proxyType: 'residential',
          recoveryAction: 'ip_rotated',
        });
    }
  }
  // Tilion: positions 3/4 would switch to Kernel/Steel; locked they are Tilion residential replacements.
  const tilionLocked = [1, 2, 3, 4].map((position) =>
    sameProviderRotationStep(
      selectRotationStep(position, 'tilion', false, true, false),
      'tilion',
      ALL
    )!
  );
  assert.ok(
    tilionLocked.every((step) => step.provider === 'tilion' && step.proxyType === 'residential')
  );
  // Kernel keeps its residential -> mobile rungs, then fresh Kernel residential instead of Steel.
  assert.deepStrictEqual(
    [1, 2, 3, 4].map(
      (position) =>
        sameProviderRotationStep(
          selectRotationStep(position, 'kernel', false, true),
          'kernel',
          ALL
        )!.proxyType
    ),
    ['residential', 'mobile', 'residential', 'residential']
  );
  // A disabled current provider leaves no same-provider rung: typed result, never a switch.
  assert.strictEqual(
    sameProviderRotationStep(selectRotationStep(1, 'tilion', true, false), 'tilion', {
      browserUse: true,
      tilion: false,
    }),
    null
  );
  assert.strictEqual(
    sameProviderRotationStep(selectRotationStep(1, 'browser-use', false), 'browser-use', {
      browserUse: false,
      tilion: true,
    }),
    null
  );
}

function testNextRecoveryLabel(): void {
  assert.strictEqual(
    nextRecoveryLabel(3, 'tilion', false, ALL),
    rotationStepLabel(selectRotationStep(3, 'tilion', true, true)),
    'knob off: the normal ladder label'
  );
  assert.match(nextRecoveryLabel(3, 'tilion', false, ALL), /^switch_provider_to_/);
  assert.strictEqual(nextRecoveryLabel(3, 'tilion', true, ALL), 'rotate_tilion_residential_ip');
  assert.strictEqual(
    nextRecoveryLabel(1, 'tilion', true, { browserUse: true, tilion: false }),
    'no_same_provider_rung_left'
  );
}

function testCandidatesLockedToCurrentProvider(): void {
  const location = { country: 'US', state: 'CA', city: 'SAN FRANCISCO' };
  const all = browserRecoveryCandidates(location);
  const context = { taskId: 'task-1', phase: 'unit' };
  // Knob off: nothing filtered.
  assert.deepStrictEqual(
    withKnob(undefined, () => lockCandidatesToProvider(all, 'tilion', context)),
    all
  );
  // Knob on, Tilion session: only Tilion candidates (residential, direct; mobile is gated elsewhere).
  const tilion = withKnob('true', () => lockCandidatesToProvider(all, 'tilion', context));
  assert.ok(tilion.length > 0 && tilion.every((config) => config.provider === 'tilion'));
  assert.ok(
    tilion.some((c) => c.key === 'tilion_residential') &&
      tilion.some((c) => c.key === 'tilion_direct')
  );
  assert.ok(!tilion.some((c) => c.key === 'kernel_mobile' || c.key === 'steel_fixed'));
  // Knob on, Kernel session: only Kernel candidates.
  const kernel = withKnob('true', () => lockCandidatesToProvider(all, 'kernel', context));
  assert.ok(kernel.length > 0 && kernel.every((config) => config.provider === 'kernel'));
}

testKnobParsing();
testLockedLadderNeverSwitchesProvider();
testNextRecoveryLabel();
testCandidatesLockedToCurrentProvider();
process.stdout.write('PASS same-provider recovery knob: candidates and rotate_ip ladder\n');
