#!/usr/bin/env tsx
/**
 * Tilion rotate_ip ladder: Tilion residential (in place) → Tilion datacenter
 * (direct) → Kernel mobile → Steel/Browser Use (Steel when disabled). Tilion
 * mobile replaces Kernel mobile only behind TILION_MOBILE_ENABLED (not served on
 * our account: 409 proxy_type_unavailable).
 * Kill-switch path, same-request fallback rung, labels and agent-facing messages.
 * The Kernel, Steel and Browser Use ladders are covered (unchanged) in
 * browser-proxy-rotation.test.ts.
 */
import assert from 'node:assert';
import { buildRotationMessage } from '../../providers/browserSessionResume';
import {
  isTilionExitUnavailableError,
  ROTATION_CAP,
  rotationStepLabel,
  rungAfterTilionUnavailable,
  selectRotationStep,
  tilionMobileEnabled,
  type RotationStep,
} from '../../providers/browser/rotation';
import { TilionApiError } from '../../providers/browser/tilionClient';

function testTilionLadder(): void {
  const ladder = [1, 2, 3, 4].map((position) => selectRotationStep(position, 'tilion'));
  assert.deepStrictEqual(ladder, [
    { provider: 'tilion', proxyType: 'residential', recoveryAction: 'ip_rotated' },
    { provider: 'tilion', proxyType: 'direct', recoveryAction: 'ip_rotated' },
    { provider: 'kernel', proxyType: 'mobile', recoveryAction: 'provider_switched' },
    { provider: 'browser-use', proxyType: 'residential', recoveryAction: 'provider_switched' },
  ]);
  assert.deepStrictEqual(ladder.map(rotationStepLabel), [
    'rotate_tilion_residential_ip',
    'rotate_tilion_datacenter_ip',
    'switch_provider_to_kernel',
    'switch_provider_to_browser_use',
  ]);
  // Both Tilion exit classes are tried before the run leaves Tilion.
  assert.deepStrictEqual(
    ladder.filter((step) => step.provider === 'tilion').map((step) => step.proxyType),
    ['residential', 'direct']
  );
  // Browser Use disabled: step 4 is Steel.
  assert.deepStrictEqual(selectRotationStep(4, 'tilion', false), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  });
  assert.throws(() => selectRotationStep(0, 'tilion'), RangeError);
  assert.throws(() => selectRotationStep(ROTATION_CAP + 1, 'tilion'), RangeError);
}

function testTilionMobileOnlyBehindFlag(): void {
  const previous = process.env.TILION_MOBILE_ENABLED;
  try {
    delete process.env.TILION_MOBILE_ENABLED;
    assert.strictEqual(tilionMobileEnabled(), false, 'Tilion mobile defaults off');
    process.env.TILION_MOBILE_ENABLED = 'true';
    assert.strictEqual(tilionMobileEnabled(), true);
    assert.deepStrictEqual(selectRotationStep(3, 'tilion'), {
      provider: 'tilion',
      proxyType: 'mobile',
      recoveryAction: 'ip_rotated',
    });
    // The datacenter rung is not displaced by the flag.
    assert.deepStrictEqual(selectRotationStep(2, 'tilion'), {
      provider: 'tilion',
      proxyType: 'direct',
      recoveryAction: 'ip_rotated',
    });
    // The kill switch still wins over the mobile flag.
    assert.strictEqual(selectRotationStep(3, 'tilion', true, false).provider, 'steel');
  } finally {
    if (previous === undefined) delete process.env.TILION_MOBILE_ENABLED;
    else process.env.TILION_MOBILE_ENABLED = previous;
  }
}

function tilionError(status: number, slug: string | null): TilionApiError {
  return new TilionApiError({
    status,
    slug,
    message: slug ?? 'x',
    retryable: false,
    requestId: null,
    retryAfterMs: null,
    detail: null,
    method: 'POST',
    path: '/v1/session',
  });
}

function testUnavailableTilionExitAdvancesARung(): void {
  for (const slug of [
    'proxy_type_unavailable',
    'residential_rotation_unavailable',
    'exit_ladder_exhausted',
  ]) {
    assert.ok(isTilionExitUnavailableError(tilionError(409, slug)), slug);
    assert.ok(
      isTilionExitUnavailableError(new AggregateError([tilionError(409, slug)], 'wrapped'))
    );
  }
  // The residential allowance used up (402) means "this exit class, not now"; other 402s do not.
  assert.ok(isTilionExitUnavailableError(tilionError(402, 'premium_egress_exhausted')));
  assert.ok(!isTilionExitUnavailableError(tilionError(402, 'insufficient_credits')));
  assert.ok(!isTilionExitUnavailableError(tilionError(402, null)));
  assert.ok(!isTilionExitUnavailableError(tilionError(409, 'session_busy')));
  assert.ok(!isTilionExitUnavailableError(tilionError(503, 'proxy_type_unavailable')));
  assert.ok(!isTilionExitUnavailableError(new Error('proxy_type_unavailable')));
  // Residential (1) refused → Tilion datacenter in the same request; datacenter (2)
  // refused → Kernel mobile; mobile (3, flag on) refused → Browser Use.
  assert.deepStrictEqual(rungAfterTilionUnavailable(1), {
    provider: 'tilion',
    proxyType: 'direct',
    recoveryAction: 'ip_rotated',
  });
  assert.deepStrictEqual(rungAfterTilionUnavailable(2), {
    provider: 'kernel',
    proxyType: 'mobile',
    recoveryAction: 'provider_switched',
  });
  assert.deepStrictEqual(rungAfterTilionUnavailable(3, false), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  });
  for (let position = 2; position <= ROTATION_CAP; position += 1) {
    for (const browserUse of [true, false]) {
      const next = rungAfterTilionUnavailable(position, browserUse);
      assert.notStrictEqual(next.provider, 'tilion');
      assert.strictEqual(next.recoveryAction, 'provider_switched');
    }
  }
}

function testTilionRunContinuesOnKernelLadderAfterSwitch(): void {
  // Position 3 moved the run to Kernel mobile; position 4 reads the persisted
  // Kernel provider. With Browser Use off (production default) that is Steel,
  // with it on Browser Use: the same step the Tilion ladder names.
  assert.deepStrictEqual(selectRotationStep(4, 'kernel', false, true), {
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  });
  assert.strictEqual(selectRotationStep(4, 'kernel', true, true).provider, 'browser-use');
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
  // A Tilion run keeps the Kernel residential/mobile → Steel → Browser Use ladder when Tilion is disabled.
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
  assert.strictEqual(selectRotationStep(3, 'tilion', true, false).provider, 'steel');
  assert.strictEqual(selectRotationStep(4, 'tilion', true, false).provider, 'browser-use');
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
    buildRotationMessage(step('tilion', 'direct', 'ip_rotated'), 2, 2, 'tilion'),
    /^Rotated to a fresh Tilion datacenter IP \(2\/4\).*2 rotations remaining\.$/
  );
  assert.match(
    buildRotationMessage(step('tilion', 'mobile', 'ip_rotated'), 3, 1, 'tilion'),
    /^Rotated to a fresh Tilion mobile-carrier IP \(3\/4\)/
  );
  assert.match(
    buildRotationMessage(step('kernel', 'residential', 'provider_switched'), 3, 1, 'tilion'),
    /^Switched from Tilion to Kernel with a fresh Kernel residential IP \(3\/4\).*1 rotation remaining\.$/
  );
  assert.match(
    buildRotationMessage(step('kernel', 'mobile', 'provider_switched'), 3, 1, 'tilion'),
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
  testTilionMobileOnlyBehindFlag();
  testUnavailableTilionExitAdvancesARung();
  testTilionRunContinuesOnKernelLadderAfterSwitch();
  testKillSwitchNeverRotatesIntoTilion();
  testOtherLaddersUnchangedByTilionFlag();
  testRotationMessages();
  process.stdout.write('PASS Tilion rotate_ip ladder, kill switch, labels and messages\n');
}

main();
