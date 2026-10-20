#!/usr/bin/env tsx
/**
 * Black-box tests for Steel fingerprint injection script generation.
 *
 * Invariant covered:
 *   - inner viewport dimensions are not spoofed; the live browser must expose
 *     its real Steel content viewport so page layout, screenshots, and click
 *     coordinates agree.
 */

import { buildFingerprintScript } from '../../providers/steel/injectionScripts';
import { prisma } from '../../providers/database';
import {
  SteelSessionCleanupError,
  buildSteelProxySettings,
  isInvalidSteelProxyConfiguration,
} from '../../providers/steel/session';
import { STEEL_CDP_TIMEOUT_MESSAGE } from '../../providers/steel/sessionConnection';
import { recreateSession } from '../../providers/steel/sessionResume';
import type { FingerprintData } from '../../providers/steel/types';
import {
  testSavedUrlNavigationAlwaysClosesBrowser,
  testConnectionErrorRetriesOnReplacement,
  testRawCdpFailureClassification,
  withReleasedFixtureLifecycleClaim,
  fixtureCandidateCleanup,
} from './steel-fingerprint.connection-retry.behavior';
import {
  testSavedSteelProfileIsReadOnlyDuringBenchmarkIsolation,
  testSavedSteelProfilePersistenceByEnvironment,
  testSavedSteelResolutionDoesNotContaminateAnonymousProfiles,
} from './steel-fingerprint.saved-profile.behavior';
import { testFingerprintTimezoneFormatUsesUserLocation as runTimezoneFormatUsesUserLocation } from './steel-fingerprint.timezone.behavior';
import { testWorkerHardwareConcurrencyMatchesPage as runWorkerHardwareConcurrencyMatchesPage } from './steel-fingerprint.worker-concurrency.behavior';
import {
  testSteelAlreadyReleasedWriterIsIdempotent,
  testSteelWriterProfileHandoff,
} from './steel-fingerprint.profile-readiness.behavior';
import { testWritableSteelProfileHandoffRetainsRecoveryCustody } from './steel-fingerprint.profile-handoff.behavior';

function makeFingerprint(): FingerprintData {
  return {
    navigator: {
      userAgent: 'Mozilla/5.0 Test',
      platform: 'MacIntel',
      language: 'en-US',
      languages: ['en-US', 'en'],
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      vendor: 'Google Inc.',
      doNotTrack: null,
    },
    userAgentData: null,
    screen: {
      width: 3024,
      height: 1964,
      availWidth: 3024,
      availHeight: 1889,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: 2,
    },
    viewport: {
      innerWidth: 1512,
      innerHeight: 982,
      outerWidth: 1512,
      outerHeight: 982,
    },
    connection: null,
    webgl: {
      vendor: 'Apple',
      renderer: 'Apple M-series',
    },
    canvas: { hash: 'canvas' },
    audio: { hash: 'audio' },
    timezone: 'America/Chicago',
    timezoneOffset: 300,
    fonts: [],
    plugins: [],
    collectedAt: new Date(0).toISOString(),
  };
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function testInnerViewportDimensionsAreNotSpoofed(): void {
  const script = buildFingerprintScript(makeFingerprint());

  assert(
    !script.includes("Object.defineProperty(window, 'innerWidth'"),
    'fingerprint script must not override window.innerWidth'
  );
  assert(
    !script.includes("Object.defineProperty(window, 'innerHeight'"),
    'fingerprint script must not override window.innerHeight'
  );
  assert(
    script.includes("Object.defineProperty(window, 'outerWidth'"),
    'fingerprint script should still spoof window.outerWidth'
  );
  assert(
    script.includes("Object.defineProperty(window, 'outerHeight'"),
    'fingerprint script should still spoof window.outerHeight'
  );
  assert(
    script.includes("Object.defineProperty(window, 'devicePixelRatio'"),
    'fingerprint script should still spoof devicePixelRatio'
  );
}

function testFingerprintScriptDoesNotReferenceBackendLogger(): void {
  const script = buildFingerprintScript(makeFingerprint());

  assert(
    !script.includes('log.info('),
    'fingerprint script runs in the browser and must not reference the backend logger'
  );
  assert(
    !script.includes('console.'),
    'fingerprint script should not write page-console logs; use backend central logging around injection instead'
  );
}

function testProxySettingsDropCityFallsBackToStateLevel(): void {
  const prevServer = process.env.STEEL_PROXY_SERVER;
  const prevEnabled = process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED;
  delete process.env.STEEL_PROXY_SERVER; // ensure the Steel-geolocation path (not BYOP)
  process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED = 'true';
  try {
    const geo = { country: 'US', state: 'CA', city: 'SAN FRANCISCO' };

    const withCity = buildSteelProxySettings(geo) as {
      config: { geolocation: Record<string, string> };
    };
    assert(withCity.config.geolocation.city === 'SAN FRANCISCO', 'city included by default');
    assert(withCity.config.geolocation.state === 'CA', 'state included by default');

    // Steel 400s on cities it can't fulfill; dropCity retries with country+state.
    const dropped = buildSteelProxySettings(geo, true) as {
      config: { geolocation: Record<string, string> };
    };
    assert(!('city' in dropped.config.geolocation), 'city dropped on Steel city rejection');
    assert(dropped.config.geolocation.state === 'CA', 'state retained on city-drop fallback');
    assert(dropped.config.geolocation.country === 'US', 'country retained on city-drop fallback');
  } finally {
    if (prevServer === undefined) delete process.env.STEEL_PROXY_SERVER;
    else process.env.STEEL_PROXY_SERVER = prevServer;
    if (prevEnabled === undefined) delete process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED;
    else process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED = prevEnabled;
  }
}

function testInvalidProxyConfigurationClassification(): void {
  assert(
    isInvalidSteelProxyConfiguration(new Error('400 Invalid proxy configuration')),
    'Steel invalid-proxy errors must trigger the city-drop retry'
  );
  assert(
    !isInvalidSteelProxyConfiguration(new Error('500 upstream unavailable')),
    'unrelated Steel failures must not alter proxy targeting'
  );
}

async function testReplacementRetryDropsRejectedCity(): Promise<void> {
  const browserSessionFindUnique = prisma.browserSession.findUnique;
  const browserSessionUpdateMany = prisma.browserSession.updateMany;
  const agentFindUnique = prisma.agent.findUnique;
  const integrationFindUnique = prisma.integration.findUnique;
  const profileFindUnique = prisma.browserProviderProfile.findUnique;
  const contextFindUnique = prisma.browserContext.findUnique;
  const previousProxyServer = process.env.STEEL_PROXY_SERVER;
  const previousProxyEnabled = process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED;
  const createInputs: Array<Record<string, unknown>> = [];

  try {
    delete process.env.STEEL_PROXY_SERVER;
    process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED = 'true';
    (
      prisma.browserSession as unknown as { findUnique: typeof prisma.browserSession.findUnique }
    ).findUnique = (async () => ({
      id: 'replacement-city-retry-task',
      sessionId: 'kernel-old',
      provider: 'kernel',
      currentUrl: null,
      startUrl: null,
      agentId: 'replacement-city-retry-agent',
      contextId: 'replacement-city-retry-context',
      context: { userId: 'replacement-city-retry-user' },
    })) as typeof prisma.browserSession.findUnique;
    (
      prisma.browserSession as unknown as { updateMany: typeof prisma.browserSession.updateMany }
    ).updateMany = (async () => ({ count: 1 })) as typeof prisma.browserSession.updateMany;
    (prisma.agent as unknown as { findUnique: typeof prisma.agent.findUnique }).findUnique =
      (async () => ({
        proxyCountry: 'US',
        proxyState: 'CA',
        proxyCity: 'RCA TEST CITY',
      })) as typeof prisma.agent.findUnique;
    (
      prisma.integration as unknown as { findUnique: typeof prisma.integration.findUnique }
    ).findUnique = (async () => null) as typeof prisma.integration.findUnique;
    (
      prisma.browserProviderProfile as unknown as {
        findUnique: typeof prisma.browserProviderProfile.findUnique;
      }
    ).findUnique = (async () => null) as typeof prisma.browserProviderProfile.findUnique;
    (
      prisma.browserContext as unknown as { findUnique: typeof prisma.browserContext.findUnique }
    ).findUnique = (async () => ({ contextId: null })) as typeof prisma.browserContext.findUnique;

    // Resume retains the city, so this exercises rejection and retry.
    const result = await recreateSession(
      'replacement-city-retry-task',
      { forceManagedRotation: false },
      {
        withLifecycleClaim: withReleasedFixtureLifecycleClaim,
        inspectSession: async (id) => ({ id, status: 'released' }),
        releaseSession: async () => {},
        ...fixtureCandidateCleanup,
        createSession: async (input) => {
          createInputs.push(input as unknown as Record<string, unknown>);
          if (createInputs.length === 1) {
            const error = new Error('400 Invalid proxy configuration') as Error & {
              status: number;
            };
            error.status = 400;
            throw error;
          }
          return {
            id: input.sessionId!,
            debugUrl: 'https://steel.example/debug',
            profileId: null,
            proxySource: 'steel',
          };
        },
        validateConnection: async () => null,
      }
    );

    assert(result.sessionId === createInputs[1]?.sessionId, 'replacement retry did not succeed');
    assert(
      createInputs.length === 2,
      `expected two Steel create attempts, got ${createInputs.length}`
    );

    const firstGeo = (createInputs[0]?.useProxy as { geolocation?: Record<string, string> })
      ?.geolocation;
    const secondGeo = (createInputs[1]?.useProxy as { geolocation?: Record<string, string> })
      ?.geolocation;
    assert(firstGeo?.city === 'RCA TEST CITY', 'first replacement attempt did not include city');
    assert(secondGeo?.city === undefined, 'replacement retry did not drop rejected city');
    assert(secondGeo?.state === 'CA', 'replacement retry dropped state with city');
    assert(secondGeo?.country === 'US', 'replacement retry dropped country with city');

    (
      prisma.browserSession as unknown as { findUnique: typeof prisma.browserSession.findUnique }
    ).findUnique = (async () => ({
      id: 'replacement-city-retry-task',
      sessionId: 'steel-read-only-old',
      provider: 'steel',
      providerProfileId: 'steel-auth-profile',
      providerProfileSource: 'steel_session_auth_read_only',
      providerProfilePersist: false,
      currentUrl: null,
      startUrl: null,
      agentId: 'replacement-city-retry-agent',
      contextId: 'replacement-city-retry-context',
      context: { userId: 'replacement-city-retry-user' },
    })) as typeof prisma.browserSession.findUnique;
    const replacementWrites: Array<Record<string, unknown>> = [];
    (
      prisma.browserSession as unknown as { updateMany: typeof prisma.browserSession.updateMany }
    ).updateMany = (async (args: { data: Record<string, unknown> }) => {
      replacementWrites.push(args.data);
      return { count: 1 };
    }) as typeof prisma.browserSession.updateMany;
    let readOnlyCreateInput: Record<string, unknown> | undefined;
    await recreateSession(
      'replacement-city-retry-task',
      { forceManagedRotation: true },
      {
        withLifecycleClaim: withReleasedFixtureLifecycleClaim,
        inspectSession: async (id) => ({ id, status: 'released' }),
        releaseSession: async () => {},
        ...fixtureCandidateCleanup,
        createSession: async (input) => {
          readOnlyCreateInput = input as unknown as Record<string, unknown>;
          return {
            id: input.sessionId!,
            debugUrl: 'https://steel.example/debug',
            profileId: 'steel-auth-profile',
          };
        },
        validateConnection: async () => null,
      }
    );
    assert(
      readOnlyCreateInput?.profileId === 'steel-auth-profile',
      'resume did not reload the session-bound profile'
    );
    assert(
      readOnlyCreateInput?.persistProfile === false,
      'resume enabled writes to an isolated saved-auth profile'
    );
    assert(
      replacementWrites[0]?.providerProfileId === 'steel-auth-profile' &&
        replacementWrites[0]?.providerProfileSource === 'steel_session_auth_read_only' &&
        replacementWrites[0]?.providerProfilePersist === false,
      'resume did not preserve the read-only session profile binding'
    );

    const previousIsolatedProfiles = process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES;
    let forceFreshCreateInput: Record<string, unknown> | undefined;
    try {
      process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES = 'true';
      await recreateSession(
        'replacement-city-retry-task',
        { forceManagedRotation: false, forceFreshProfile: true },
        {
          withLifecycleClaim: withReleasedFixtureLifecycleClaim,
          inspectSession: async (id) => ({ id, status: 'released' }),
          releaseSession: async () => {},
          ...fixtureCandidateCleanup,
          createSession: async (input) => {
            forceFreshCreateInput = input as unknown as Record<string, unknown>;
            return {
              id: input.sessionId!,
              debugUrl: 'https://steel.example/debug',
              profileId: 'steel-force-fresh-profile',
            };
          },
          validateConnection: async () => null,
        }
      );
    } finally {
      if (previousIsolatedProfiles === undefined) {
        delete process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES;
      } else {
        process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES = previousIsolatedProfiles;
      }
    }
    assert(
      forceFreshCreateInput?.profileId === undefined,
      'force-fresh resume reused the session-bound failed Steel profile'
    );
    assert(
      forceFreshCreateInput?.persistProfile === true,
      'force-fresh resume did not create a persistent isolated replacement profile'
    );
    const forceFreshWrite = replacementWrites.at(-1);
    assert(
      forceFreshWrite?.providerProfileId === 'steel-force-fresh-profile' &&
        forceFreshWrite?.providerProfileSource === 'benchmark_anon_fresh',
      'force-fresh resume did not commit the isolated replacement profile'
    );

    const replacementWritesBeforeMismatch = replacementWrites.length;
    let mismatchCreateAttempts = 0;
    let mismatchReleaseCount = 0;
    let mismatchFailure: unknown;
    try {
      await recreateSession(
        'replacement-city-retry-task',
        { forceManagedRotation: false },
        {
          withLifecycleClaim: withReleasedFixtureLifecycleClaim,
          inspectSession: async (id) => ({ id, status: 'released' }),
          ...fixtureCandidateCleanup,
          createSession: async (input) => {
            mismatchCreateAttempts += 1;
            assert(
              input.profileId === 'steel-auth-profile' && input.persistProfile === false,
              'mismatch retry changed the bound profile contract'
            );
            return {
              id: input.sessionId!,
              debugUrl: 'https://steel.example/debug',
              profileId: 'wrong-profile',
            };
          },
          validateConnection: async () => null,
          releaseSession: async () => {
            mismatchReleaseCount += 1;
          },
        }
      );
    } catch (error) {
      mismatchFailure = error;
    }
    assert(mismatchFailure instanceof Error, 'profile mismatch did not fail closed');
    assert(
      mismatchReleaseCount === mismatchCreateAttempts && mismatchReleaseCount > 0,
      'profile mismatch did not release every uncommitted remote session'
    );
    assert(
      replacementWrites.length === replacementWritesBeforeMismatch,
      'profile mismatch wrote a replacement BrowserSession binding'
    );

    const replacementWritesBeforeOutage = replacementWrites.length;
    const createdDuringOutage: string[] = [];
    const releasedDuringOutage: string[] = [];
    let outageFailure: unknown;
    try {
      await recreateSession(
        'replacement-city-retry-task',
        { forceManagedRotation: true },
        {
          withLifecycleClaim: withReleasedFixtureLifecycleClaim,
          inspectSession: async (id) => ({ id, status: 'released' }),
          ...fixtureCandidateCleanup,
          createSession: async (input) => {
            const id = input.sessionId!;
            createdDuringOutage.push(id);
            return { id, debugUrl: 'https://steel.example/debug', profileId: 'steel-auth-profile' };
          },
          validateConnection: async () => {
            throw new Error('Steel CDP connection timeout');
          },
          releaseSession: async (id) => {
            releasedDuringOutage.push(id);
          },
        }
      );
    } catch (error) {
      outageFailure = error;
    }
    assert(
      outageFailure instanceof Error &&
        outageFailure.message.includes('Steel CDP connection timeout'),
      'replacement obscured the provider transport cause'
    );
    assert(
      createdDuringOutage.length === 2 &&
        JSON.stringify(releasedDuringOutage) === JSON.stringify(createdDuringOutage),
      'replacement did not stop after two failed sessions and release both'
    );
    assert(
      replacementWrites.length === replacementWritesBeforeOutage,
      'CDP outage replaced the working BrowserSession binding'
    );

    // The production validator reports the timeout as its failure value rather
    // than throwing; replacement must recognize that as the same outage.
    const reportedOutageSessions: string[] = [];
    await recreateSession(
      'replacement-city-retry-task',
      { forceManagedRotation: true },
      {
        withLifecycleClaim: withReleasedFixtureLifecycleClaim,
        inspectSession: async (id) => ({ id, status: 'released' }),
        ...fixtureCandidateCleanup,
        createSession: async (input) => {
          const id = input.sessionId!;
          reportedOutageSessions.push(id);
          return { id, debugUrl: 'https://steel.example/debug', profileId: 'steel-auth-profile' };
        },
        validateConnection: async () => STEEL_CDP_TIMEOUT_MESSAGE,
        releaseSession: async () => {},
      }
    ).catch(() => {});
    assert(
      reportedOutageSessions.length === 2,
      `replacement created ${reportedOutageSessions.length} sessions through a reported CDP timeout outage`
    );

    let cleanupCreateAttempts = 0;
    let cleanupFailure: unknown;
    try {
      await recreateSession(
        'replacement-city-retry-task',
        { forceManagedRotation: true },
        {
          withLifecycleClaim: withReleasedFixtureLifecycleClaim,
          inspectSession: async (id) => ({ id, status: 'released' }),
          ...fixtureCandidateCleanup,
          createSession: async (input) => {
            cleanupCreateAttempts += 1;
            return {
              id: input.sessionId!,
              debugUrl: 'https://steel.example/debug',
              profileId: null,
            };
          },
          validateConnection: async () => 'Connection timeout',
          releaseSession: async () => {
            throw new Error('release unavailable after bounded retries');
          },
        }
      );
    } catch (error) {
      cleanupFailure = error;
    }
    assert(
      cleanupFailure instanceof SteelSessionCleanupError,
      'replacement did not surface a terminal cleanup failure'
    );
    assert(
      cleanupCreateAttempts === 1,
      `replacement created ${cleanupCreateAttempts} sessions after cleanup failed`
    );
  } finally {
    (
      prisma.browserSession as unknown as { findUnique: typeof prisma.browserSession.findUnique }
    ).findUnique = browserSessionFindUnique;
    (
      prisma.browserSession as unknown as { updateMany: typeof prisma.browserSession.updateMany }
    ).updateMany = browserSessionUpdateMany;
    (prisma.agent as unknown as { findUnique: typeof prisma.agent.findUnique }).findUnique =
      agentFindUnique;
    (
      prisma.integration as unknown as { findUnique: typeof prisma.integration.findUnique }
    ).findUnique = integrationFindUnique;
    (
      prisma.browserProviderProfile as unknown as {
        findUnique: typeof prisma.browserProviderProfile.findUnique;
      }
    ).findUnique = profileFindUnique;
    (
      prisma.browserContext as unknown as { findUnique: typeof prisma.browserContext.findUnique }
    ).findUnique = contextFindUnique;
    if (previousProxyServer === undefined) delete process.env.STEEL_PROXY_SERVER;
    else process.env.STEEL_PROXY_SERVER = previousProxyServer;
    if (previousProxyEnabled === undefined) delete process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED;
    else process.env.BROWSER_AGENT_STEEL_PROXY_ENABLED = previousProxyEnabled;
  }
}

async function main(): Promise<void> {
  const tests = [
    {
      name: 'Steel writer releases and reaches native profile readiness before replacement',
      fn: testSteelWriterProfileHandoff,
    },
    ...(
      [
        'failed-profile',
        'failed-release',
        'failed-create',
        'lost-cas',
        'lost-lease-during-profile-read',
      ] as const
    ).map((mode) => ({
      name: `Steel profile handoff preserves custody on ${mode}`,
      fn: () => testSteelWriterProfileHandoff(mode),
    })),
    {
      name: 'Steel already-released writer is idempotent',
      fn: testSteelAlreadyReleasedWriterIsIdempotent,
    },
    {
      name: 'inner viewport dimensions are not spoofed',
      fn: testInnerViewportDimensionsAreNotSpoofed,
    },
    {
      name: 'fingerprint script does not reference backend logger',
      fn: testFingerprintScriptDoesNotReferenceBackendLogger,
    },
    {
      name: 'fingerprint timezone format uses user location not host TZ',
      fn: () => runTimezoneFormatUsesUserLocation(makeFingerprint),
    },
    {
      name: 'Worker hardwareConcurrency matches page spoof (FCaptcha mismatch)',
      fn: () => runWorkerHardwareConcurrencyMatchesPage(makeFingerprint),
    },
    {
      name: 'proxy settings drop unsupported city and fall back to country+state',
      fn: testProxySettingsDropCityFallsBackToStateLevel,
    },
    {
      name: 'invalid Steel proxy configuration triggers location fallback',
      fn: testInvalidProxyConfigurationClassification,
    },
    {
      name: 'isolated saved Steel auth loads a read-only profile snapshot',
      fn: testSavedSteelProfileIsReadOnlyDuringBenchmarkIsolation,
    },
    {
      name: 'normal production saved Steel auth remains persistent',
      fn: testSavedSteelProfilePersistenceByEnvironment,
    },
    {
      name: 'saved Steel auth does not contaminate anonymous profile isolation',
      fn: testSavedSteelResolutionDoesNotContaminateAnonymousProfiles,
    },
    {
      name: 'Steel replacement retries rejected cities and stops after cleanup failure',
      fn: testReplacementRetryDropsRejectedCity,
    },
    {
      name: 'Steel replacement retries transient Connection error',
      fn: testConnectionErrorRetriesOnReplacement,
    },
    {
      name: 'Steel writable profile handoff keeps durable custody across failure and recovery',
      fn: testWritableSteelProfileHandoffRetainsRecoveryCustody,
    },
    {
      name: 'raw Steel CDP failures retain timeout and authentication categories',
      fn: testRawCdpFailureClassification,
    },
    {
      name: 'saved URL navigation closes its browser after failure',
      fn: testSavedUrlNavigationAlwaysClosesBrowser,
    },
  ];
  const failures: string[] = [];

  for (const test of tests) {
    try {
      await test.fn();
      console.log(`✓ ${test.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${test.name}: ${message}`);
      console.error(`✗ ${test.name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    process.exit(1);
  }
  console.log(`\nPassed ${tests.length} Steel fingerprint test(s).`);
}

void main();
