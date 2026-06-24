#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for Steel fingerprint injection script generation.
 *
 * Invariant covered:
 *   - inner viewport dimensions are not spoofed; the live browser must expose
 *     its real Steel content viewport so page layout, screenshots, and click
 *     coordinates agree.
 */

import { buildFingerprintScript } from '../../providers/steel/injectionScripts';
import { buildSteelProxySettings } from '../../providers/steel/session';
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

function main(): void {
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
  ];
  const failures: string[] = [];

  for (const test of tests) {
    try {
      test.fn();
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

main();
