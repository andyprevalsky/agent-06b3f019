#!/usr/bin/env tsx
/**
 * A connect setup failure must surface the ORIGINAL setup error even when the
 * best-effort browser release that follows it also throws.
 *
 * Setup runs in a detached `void (async () => ...)()`, so a release error that
 * escapes the catch block is an unhandled rejection (process crash in Node) and
 * the user's poll never learns why the connect failed. The release error must be
 * logged and swallowed instead.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

type Warning = { message: string; extra?: Record<string, unknown> };

async function main(): Promise<void> {
  const warnings: Warning[] = [];
  await mock.module('../../providers/logger', {
    namedExports: {
      createLogger: () => ({
        info: () => undefined,
        warn: (message: string, extra?: Record<string, unknown>) => {
          warnings.push({ message, extra });
        },
        error: () => undefined,
      }),
    },
  });

  let releases = 0;
  await mock.module('../../domains/compute-grants/browserProvider', {
    namedExports: {
      openComputeGrantBrowser: async () => ({
        cdpBase: 'ws://browser.invalid',
        liveViewUrl: 'https://live.example',
        sessionId: 'browser-1',
        release: async () => {
          releases += 1;
          throw new Error('provider release failed');
        },
      }),
    },
  });

  const realCdp = await import('../../domains/compute-grants/cdp');
  await mock.module('../../domains/compute-grants/cdp', {
    namedExports: {
      ...realCdp,
      attachCdp: async () => {
        throw new Error('cdp attach failed');
      },
    },
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    const { pollConnectSession, startConnectSession } =
      await import('../../domains/compute-grants/connectSession');
    const handle = await startConnectSession('user-1', 'claude');

    // Every mocked step settles on the microtask queue; one macrotask later the
    // detached setup task has finished and any escaped rejection has been reported.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      unhandled.map((reason) => (reason instanceof Error ? reason.message : String(reason))),
      [],
      'a failed release escaped the setup task as an unhandled rejection'
    );
    assert.equal(releases, 1, 'setup failure must still release the billing browser');

    const setupFailed = warnings.find((w) => w.message === 'connect.setup_failed');
    assert.equal(setupFailed?.extra?.error, 'cdp attach failed');
    const releaseFailed = warnings.find((w) => w.message === 'connect.setup_release_failed');
    assert(releaseFailed !== undefined, 'the release failure was not logged');
    assert.equal(releaseFailed.extra?.error, 'provider release failed');
    assert.equal(releaseFailed.extra?.connect_id, handle.connectId);

    const polled = await pollConnectSession('user-1', handle.connectId);
    assert.equal(polled.state, 'unknown');
    assert.equal(polled.reason, 'cdp attach failed', 'the release error replaced the setup error');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

void main();
