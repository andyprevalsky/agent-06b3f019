#!/usr/bin/env tsx
/**
 * Steel marks a session whose browser never boots `failed` (`startup_failed`)
 * seconds after creation. Validation must stop retrying CDP against that
 * session and report Steel's verdict; before this, every replacement attempt
 * waited out three 10s connect timeouts and surfaced only "Session validation
 * failed", which the live parity gate could not tell apart from a defect.
 *
 * Run: npx tsx src/tests/unit/steel-session-startup-failure.test.ts
 */

import assert from 'node:assert';
import type { Browser } from 'playwright';
import {
  steelStartupProbe,
  validateBrowserConnection,
} from '../../providers/steel/sessionConnection';
import { createSteelRecoverySession } from '../../providers/steel/sessionRecovery';
import {
  isSteelProvisioningOutage,
  isSteelSessionValidationFailure,
  shouldSkipSteelLegs,
} from '../blackbox/browser-provider-rotation.support';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

function fakeBrowser(): Browser {
  return {
    contexts: () => [{ pages: () => [{}] }],
    close: async () => {},
  } as unknown as Browser;
}

const STARTUP_FAILED = 'Steel reported session s-1 failed (startup_failed)';
const replacementFailure = (cause: string) =>
  new Error(
    `/rotate-proxy 500: {"error":"Failed to create Steel replacement after 5 attempts: ${cause}"}`
  );

async function main(): Promise<void> {
  await test('validation stops at the first retry once Steel declares startup failure', async () => {
    let connects = 0;
    let probes = 0;
    const result = await validateBrowserConnection('wss://steel.example/s-1', {
      connect: async () => {
        connects += 1;
        throw new Error('Connection timeout');
      },
      startupProbe: async () => {
        probes += 1;
        return STARTUP_FAILED;
      },
    });
    assert.strictEqual(result.browser, null);
    assert.strictEqual(result.failure, STARTUP_FAILED);
    assert.strictEqual(connects, 1, 'kept dialing CDP after Steel declared the session dead');
    assert.strictEqual(probes, 1);
  });

  await test('validation keeps retrying while Steel has not ruled', async () => {
    let connects = 0;
    const result = await validateBrowserConnection('wss://steel.example/s-1', {
      connect: async () => {
        connects += 1;
        throw new Error(`connect failure ${connects}`);
      },
      startupProbe: async () => null,
    });
    assert.strictEqual(connects, 3);
    assert.strictEqual(result.browser, null);
    assert.strictEqual(result.failure, 'connect failure 3');
  });

  await test('a session that accepts CDP never pays for a status lookup', async () => {
    let probes = 0;
    const browser = fakeBrowser();
    const result = await validateBrowserConnection('wss://steel.example/s-1', {
      connect: async () => browser,
      startupProbe: async () => {
        probes += 1;
        return null;
      },
    });
    assert.strictEqual(result.browser, browser);
    assert.strictEqual(result.failure, null);
    assert.strictEqual(probes, 0);
  });

  await test('challenge-recovery candidates stop validating once Steel declares startup failure', async () => {
    let created = 0;
    let connects = 0;
    const probed: string[] = [];
    const released: string[] = [];
    await assert.rejects(
      createSteelRecoverySession(
        {
          proxyLocation: { country: 'US', state: 'CA', city: 'SAN FRANCISCO' },
          proxyMode: 'fixed',
        },
        {
          createSession: async () => {
            created += 1;
            return { id: `dead-${created}`, debugUrl: 'https://steel.example/debug' };
          },
          connect: async () => {
            connects += 1;
            throw new Error('Connection timeout');
          },
          retrieveSession: async (id) => {
            probed.push(id);
            return { status: 'failed', releaseReason: 'startup_failed' };
          },
          releaseRemoteSession: async (id) => {
            released.push(id);
          },
        }
      ),
      /Steel reported session dead-5 failed \(startup_failed\)/
    );
    assert.strictEqual(created, 5);
    assert.strictEqual(connects, 5, 'kept dialing CDP after Steel declared the candidate dead');
    assert.deepStrictEqual(probed, ['dead-1', 'dead-2', 'dead-3', 'dead-4', 'dead-5']);
    assert.deepStrictEqual(released, probed);
  });

  await test('the Steel probe reports only a failed session, with its release reason', async () => {
    const probe = (session: { status: string; releaseReason?: unknown }) =>
      steelStartupProbe('s-1', async () => session)();
    assert.strictEqual(await probe({ status: 'live' }), null);
    assert.strictEqual(await probe({ status: 'released', releaseReason: 'timeout' }), null);
    assert.strictEqual(
      await probe({ status: 'failed', releaseReason: 'startup_failed' }),
      STARTUP_FAILED
    );
    assert.strictEqual(
      await probe({ status: 'failed' }),
      'Steel reported session s-1 failed (no release reason)'
    );
    const unreachable = steelStartupProbe('s-1', async () => {
      throw new Error('fetch failed');
    });
    assert.strictEqual(await unreachable(), null, 'a lookup failure must not end validation');
  });

  await test('validation failures are not classified as outages from their message alone', async () => {
    const startupFailure = replacementFailure(
      `Session validation failed on attempt 5: ${STARTUP_FAILED}`
    );
    const connectTimeout = replacementFailure(
      'Session validation failed on attempt 5: Connection timeout'
    );
    for (const error of [startupFailure, connectTimeout]) {
      assert.strictEqual(isSteelProvisioningOutage(error), false);
      assert.strictEqual(isSteelSessionValidationFailure(error), true);
    }
    assert.strictEqual(
      isSteelProvisioningOutage(replacementFailure('Connection error.')),
      true,
      'SDK connectivity failures still count as an outage'
    );
  });

  await test('Steel legs skip on a validation failure only when a default session fails too', async () => {
    const error = replacementFailure(`Session validation failed on attempt 5: ${STARTUP_FAILED}`);
    assert.strictEqual(await shouldSkipSteelLegs(error, async () => false), true);
    assert.strictEqual(await shouldSkipSteelLegs(error, async () => true), false);
    assert.strictEqual(await shouldSkipSteelLegs(error), false, 'no control means fail closed');
    let controlRuns = 0;
    const control = async () => {
      controlRuns += 1;
      return false;
    };
    assert.strictEqual(
      await shouldSkipSteelLegs(new Error('call 3 expected Steel residential'), control),
      false
    );
    assert.strictEqual(controlRuns, 0, 'non-Steel failures must not consult the control');
  });

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} failure(s):\n${failures.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n${passed} passed\n`);
}

void main();
