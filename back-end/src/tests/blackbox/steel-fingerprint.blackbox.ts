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

function main(): void {
  const tests = [
    {
      name: 'inner viewport dimensions are not spoofed',
      fn: testInnerViewportDimensionsAreNotSpoofed,
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
