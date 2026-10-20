#!/usr/bin/env tsx
import { assertSteelSameProfileReplacement } from '../blackbox/browser-provider.helpers';
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
import { recreateSession } from '../../providers/steel/sessionResume';
import { prisma } from '../../providers/database';
import {
  fixtureCandidateCleanup,
  withReleasedFixtureLifecycleClaim,
} from '../blackbox/steel-fingerprint.connection-retry.behavior';
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

// The profile writer is verified natively before its exact source is released.
const recordedWriter = async (id: string) => ({
  id,
  profileId: 'offline-profile',
  persistProfile: true,
  status: 'live',
});

const STARTUP_FAILED = 'Steel reported session s-1 failed (startup_failed)';
const replacementFailure = (cause: string) =>
  new Error(
    `/rotate-proxy 500: {"error":"Failed to create Steel replacement after 5 attempts: ${cause}"}`
  );

async function main(): Promise<void> {
  for (const retryClosed of [false, true]) {
    await test(`successful same-profile rebind ${retryClosed ? 'from PAUSED recovery custody' : 'without duplicate release'}`, () =>
      assertSteelSameProfileReplacement(retryClosed));
  }
  await test('same-profile replacement releases its uploading source before attaching it', async () => {
    const originalFind = prisma.browserSession.findUnique;
    const originalFingerprint = prisma.integration.findUnique;
    const originalUpdate = prisma.browserSession.updateMany;
    let released = false;
    let creates = 0;
    prisma.browserSession.findUnique = (async () => ({
      id: 'offline-task',
      sessionId: 'offline-source',
      provider: 'steel',
      status: 'ACTIVE',
      closedAt: null,
      providerProfileId: 'offline-profile',
      providerProfileSource: 'session_bound',
      providerProfilePersist: true,
      contextId: 'offline-context',
      agentId: null,
      currentUrl: null,
      startUrl: null,
      proxyRotationCount: 4,
      context: { userId: 'offline-user' },
    })) as typeof originalFind;
    prisma.integration.findUnique = (async () => null) as typeof originalFingerprint;
    prisma.browserSession.updateMany = (async (args: unknown) => {
      assert.deepStrictEqual((args as { where: unknown }).where, {
        id: 'offline-task',
        sessionId: 'offline-source',
        provider: 'steel',
        status: 'ACTIVE',
        closedAt: null,
        providerProfileId: 'offline-profile',
        providerProfileSource: 'session_bound',
        providerProfilePersist: true,
      });
      assert.deepStrictEqual((args as { data: unknown }).data, {
        status: 'PAUSED',
        closedAt: null,
      });
      assert.strictEqual(released, false);
      return { count: 1 };
    }) as typeof originalUpdate;
    try {
      await assert.rejects(
        () =>
          recreateSession(
            'offline-task',
            { forceManagedRotation: true },
            {
              ...fixtureCandidateCleanup,
              withLifecycleClaim: withReleasedFixtureLifecycleClaim,
              inspectSession: recordedWriter,
              retrieveProfile: async (profileId) => {
                assert.strictEqual(profileId, 'offline-profile');
                assert.strictEqual(released, true);
                return { status: 'READY' };
              },
              createSession: async () => {
                creates++;
                if (!released)
                  throw Object.assign(new Error('409 profile UPLOADING until source release'), {
                    status: 409,
                  });
                throw Object.assign(new Error('offline terminal sentinel'), { status: 429 });
              },
              releaseSession: async (id) => {
                assert.strictEqual(id, 'offline-source');
                released = true;
              },
              validateConnection: async () => {
                throw new Error('unexpected validation');
              },
            }
          ),
        /offline terminal sentinel/
      );
      assert.strictEqual(released, true);
      assert.strictEqual(creates, 1);
    } finally {
      prisma.browserSession.findUnique = originalFind;
      prisma.integration.findUnique = originalFingerprint;
      prisma.browserSession.updateMany = originalUpdate;
    }
  });
  for (const mode of [
    'release-failure',
    'changed-source',
    'readonly-profile',
    'provider-switch',
  ] as const) {
    await test(`profile replacement preserves custody for ${mode}`, async () => {
      const find = prisma.browserSession.findUnique;
      const fingerprint = prisma.integration.findUnique;
      const update = prisma.browserSession.updateMany;
      const profile = prisma.browserProviderProfile.findUnique;
      let releases = 0;
      let creates = 0;
      let writes = 0;
      prisma.browserSession.findUnique = (async () => ({
        id: 'offline-task',
        sessionId: 'offline-source',
        provider: mode === 'provider-switch' ? 'kernel' : 'steel',
        status: 'ACTIVE',
        closedAt: null,
        providerProfileId: 'offline-profile',
        providerProfileSource: 'session_bound',
        providerProfilePersist: mode !== 'readonly-profile',
        contextId: 'offline-context',
        agentId: null,
        currentUrl: null,
        startUrl: null,
        proxyRotationCount: 4,
        context: { userId: 'offline-user' },
      })) as typeof find;
      prisma.integration.findUnique = (async () => null) as typeof fingerprint;
      prisma.browserProviderProfile.findUnique = (async () => ({
        profileId: 'offline-context-profile',
      })) as typeof profile;
      const writtenStatuses: unknown[] = [];
      prisma.browserSession.updateMany = (async (args: unknown) => {
        writes++;
        writtenStatuses.push((args as { data: { status: unknown } }).data.status);
        return { count: mode === 'changed-source' ? 0 : 1 };
      }) as typeof update;
      try {
        await assert.rejects(
          () =>
            recreateSession(
              'offline-task',
              { forceManagedRotation: true },
              {
                ...fixtureCandidateCleanup,
                withLifecycleClaim: withReleasedFixtureLifecycleClaim,
                inspectSession: recordedWriter,
                createSession: async () => {
                  creates++;
                  throw Object.assign(new Error('offline terminal sentinel'), { status: 429 });
                },
                releaseSession: async (id) => {
                  assert.strictEqual(id, 'offline-source');
                  releases++;
                  if (mode === 'release-failure') throw new Error('offline release refused');
                },
                validateConnection: async () => {
                  throw new Error('unexpected validation');
                },
              }
            ),
          mode === 'release-failure'
            ? /offline release refused/
            : mode === 'changed-source'
              ? /Steel profile writer changed before replacement claim/
              : /offline terminal sentinel/
        );
        assert.strictEqual(releases, mode === 'release-failure' ? 1 : 0);
        assert.strictEqual(
          creates,
          mode === 'release-failure' || mode === 'changed-source' ? 0 : 1
        );
        // An unconfirmed source release retains ERROR custody after the PAUSED claim.
        assert.deepStrictEqual(
          writtenStatuses,
          mode === 'release-failure'
            ? ['PAUSED', 'ERROR']
            : mode === 'changed-source'
              ? ['PAUSED']
              : []
        );
        assert.strictEqual(
          writes,
          mode === 'release-failure' ? 2 : mode === 'changed-source' ? 1 : 0
        );
      } finally {
        prisma.browserSession.findUnique = find;
        prisma.integration.findUnique = fingerprint;
        prisma.browserSession.updateMany = update;
        prisma.browserProviderProfile.findUnique = profile;
      }
    });
  }
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
