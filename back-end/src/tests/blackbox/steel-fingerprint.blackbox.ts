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
import { recreateSession } from '../../providers/steel/sessionResume';
import type { FingerprintData } from '../../providers/steel/types';

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

    const result = await recreateSession(
      'replacement-city-retry-task',
      { forceManagedRotation: true },
      {
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
            id: 'steel-after-city-fallback',
            debugUrl: 'https://steel.example/debug',
            profileId: null,
            proxySource: 'steel',
          };
        },
        validateConnection: async () => true,
      }
    );

    assert(result.sessionId === 'steel-after-city-fallback', 'replacement retry did not succeed');
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

    let cleanupCreateAttempts = 0;
    let cleanupFailure: unknown;
    try {
      await recreateSession(
        'replacement-city-retry-task',
        { forceManagedRotation: true },
        {
          createSession: async () => {
            cleanupCreateAttempts += 1;
            return {
              id: 'steel-invalid-and-unreleasable',
              debugUrl: 'https://steel.example/debug',
              profileId: null,
            };
          },
          validateConnection: async () => false,
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
      name: 'inner viewport dimensions are not spoofed',
      fn: testInnerViewportDimensionsAreNotSpoofed,
    },
    {
      name: 'fingerprint script does not reference backend logger',
      fn: testFingerprintScriptDoesNotReferenceBackendLogger,
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
      name: 'Steel replacement retries rejected cities and stops after cleanup failure',
      fn: testReplacementRetryDropsRejectedCity,
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
