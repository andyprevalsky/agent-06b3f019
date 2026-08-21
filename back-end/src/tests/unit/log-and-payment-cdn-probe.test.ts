#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Deterministic coverage for logging helpers and payment CDN probe control
 * flow that blackbox runs do not stably exercise.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import {
  blockedResourceRequiresPaymentCdn,
  probePaymentCdnReachable,
  resourceUrlLooksLikeScriptCdn,
  targetLooksLikePaymentDocument,
} from '../../providers/browser/paymentCdnProbe';
import { logJson, logTruncate } from '../../utils/log';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}`);
    throw error;
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}`);
    throw error;
  }
}

async function main(): Promise<void> {
  test('logJson stringifies objects and returns undefined for undefined', () => {
    assert.match(logJson({ a: 1 }), /"a": 1/);
    assert.equal(logJson(undefined), 'undefined');
  });

  test('logJson returns unserializable marker for circular objects', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.equal(logJson(circular), '[unserializable]');
  });

  test('logTruncate returns the full string when under the limit', () => {
    assert.equal(logTruncate('short'), 'short');
  });

  test('targetLooksLikePaymentDocument is a deprecated always-false helper', () => {
    assert.equal(targetLooksLikePaymentDocument('https://pay.example/checkout'), false);
  });

  test('resourceUrlLooksLikeScriptCdn classifies js hosts and script paths', () => {
    assert.equal(resourceUrlLooksLikeScriptCdn(undefined), false);
    assert.equal(resourceUrlLooksLikeScriptCdn(null), false);
    assert.equal(resourceUrlLooksLikeScriptCdn('https://js.stripe.com/v3'), true);
    assert.equal(resourceUrlLooksLikeScriptCdn('https://cdn.example/widget.js'), true);
    assert.equal(resourceUrlLooksLikeScriptCdn('https://cdn.example/js/app'), true);
    assert.equal(resourceUrlLooksLikeScriptCdn('https://cdn.example/v3/'), true);
    assert.equal(resourceUrlLooksLikeScriptCdn('https://cdn.example/img/logo.png'), false);
    assert.equal(resourceUrlLooksLikeScriptCdn('not a url'), false);
  });

  test('blockedResourceRequiresPaymentCdn requires absolute http(s)', () => {
    assert.equal(blockedResourceRequiresPaymentCdn('https://js.cdn.example/v3'), true);
    assert.equal(blockedResourceRequiresPaymentCdn('http://cdn.example/x'), true);
    assert.equal(blockedResourceRequiresPaymentCdn('not-a-url'), false);
    assert.equal(blockedResourceRequiresPaymentCdn(''), false);
  });

  await testAsync('probePaymentCdnReachable passes when no blocked URL is provided', async () => {
    const page = {} as Page;
    const result = await probePaymentCdnReachable(page, null);
    assert.deepEqual(result, { paymentCdnOk: true, paymentCdnHosts: {} });
  });

  await testAsync(
    'probePaymentCdnReachable marks fetch+script success for script CDNs',
    async () => {
      const page = {
        evaluate: async <T, A>(fn: (arg: A) => Promise<T> | T, arg: A): Promise<T> => fn(arg),
      } as unknown as Page;

      const originalFetch = globalThis.fetch;
      const originalDocument = (globalThis as { document?: unknown }).document;
      globalThis.fetch = (async () => ({ ok: true })) as typeof fetch;
      (globalThis as { document: unknown }).document = {
        createElement: () => {
          const script: {
            src: string;
            async: boolean;
            remove: () => void;
            onload: (() => void) | null;
            onerror: (() => void) | null;
          } = {
            src: '',
            async: false,
            remove: () => undefined,
            onload: null,
            onerror: null,
          };
          queueMicrotask(() => {
            script.onload?.();
          });
          return script;
        },
        head: {
          appendChild: () => undefined,
        },
      };

      try {
        const result = await probePaymentCdnReachable(page, 'https://js.cdn.example/v3');
        assert.equal(result.paymentCdnOk, true);
        assert.equal(result.paymentCdnHosts['js.cdn.example'], true);
        assert.equal(result.paymentCdnHosts['script.load'], true);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalDocument === undefined) {
          delete (globalThis as { document?: unknown }).document;
        } else {
          (globalThis as { document: unknown }).document = originalDocument;
        }
      }
    }
  );

  await testAsync('probePaymentCdnReachable treats evaluate rejection as unreachable', async () => {
    const page = {
      evaluate: async () => {
        throw new Error('browser gone');
      },
    } as unknown as Page;
    const result = await probePaymentCdnReachable(page, 'https://cdn.example/asset.bin');
    assert.equal(result.paymentCdnOk, false);
    assert.equal(result.paymentCdnHosts['cdn.example'], false);
  });

  await testAsync(
    'probePaymentCdnReachable does not require script.load for non-script URLs',
    async () => {
      const page = {
        evaluate: async <T, A>(fn: (arg: A) => Promise<T> | T, arg: A): Promise<T> => fn(arg),
      } as unknown as Page;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({ ok: true })) as typeof fetch;
      try {
        const result = await probePaymentCdnReachable(page, 'https://cdn.example/asset.bin');
        assert.equal(result.paymentCdnOk, true);
        assert.equal(result.paymentCdnHosts['cdn.example'], true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );

  await testAsync('probePaymentCdnReachable marks fetch failure for unreachable hosts', async () => {
    const page = {
      evaluate: async <T, A>(fn: (arg: A) => Promise<T> | T, arg: A): Promise<T> => fn(arg),
    } as unknown as Page;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    try {
      const result = await probePaymentCdnReachable(page, 'https://cdn.example/asset.bin');
      assert.equal(result.paymentCdnOk, false);
      assert.equal(result.paymentCdnHosts['cdn.example'], false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log('log-and-payment-cdn-probe: all tests passed');
}

void main();
