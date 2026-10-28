#!/usr/bin/env tsx
/**
 * `releaseBrowserUseRemoteSession` must forget a session's initial storage hash
 * once the remote browser is gone -- after a successful stop AND after a 404 --
 * and must keep it when the stop itself failed.
 *
 * The hash is module-private, so it is observed through its only reader:
 * `closeBrowserUseSession` skips the provider profile reads (and the profile-save
 * wait) only while it still holds a baseline equal to the current storage. A
 * stale baseline therefore shows up as zero profile reads on close; a forgotten
 * one shows up as the unknown-baseline profile reads.
 *
 * Module mocks need `--experimental-test-module-mocks`, which only the unit
 * runner passes, so this lives here rather than in browser-provider.blackbox.ts.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const PROFILE_ID = 'profile-1';
const CDP_URL = 'ws://browser-use.invalid/cdp';
const ENV_KEYS = [
  'BROWSER_USE_API_KEY',
  'BROWSER_USE_API_BASE_URL',
  'BROWSER_AGENT_BROWSER_USE_ENABLED',
  'BENCHMARK_ISOLATED_BROWSER_PROFILES',
] as const;

function fakeBrowser() {
  return {
    contexts: () => [
      {
        storageState: async () => ({
          cookies: [{ name: 'sid', value: 'v', domain: 'example.com', path: '/' }],
          origins: [],
        }),
        // Storage capture also reads open page/frame origins; none here.
        pages: () => [],
      },
    ],
    close: async () => undefined,
  };
}

async function main(): Promise<void> {
  await mock.module('../../providers/database', {
    namedExports: {
      prisma: {
        browserSession: {
          findUnique: async () => ({ providerProfileId: PROFILE_ID, wsUrl: CDP_URL }),
          update: async () => ({}),
        },
      },
    },
  });
  await mock.module('../../providers/steel/sessionConnection', {
    namedExports: { connectValidatedBrowser: async () => fakeBrowser() },
  });
  await mock.module('../../providers/browser/sessionPersist', {
    namedExports: { persistBrowserSessionRow: async () => ({ id: 'task-1' }) },
  });
  await mock.module('playwright', {
    namedExports: { chromium: { connectOverCDP: async () => fakeBrowser() } },
  });

  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  process.env.BROWSER_USE_API_KEY = 'test-browser-use-key';
  process.env.BROWSER_USE_API_BASE_URL = 'https://browser-use.invalid/api/v4';
  process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'true';
  process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES = '1';

  let created = 0;
  let stopStatus = 200;
  let profileReads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.pathname.endsWith('/profiles')) {
      return Response.json({ id: PROFILE_ID });
    }
    if (method === 'POST' && url.pathname.endsWith('/browsers')) {
      created += 1;
      return Response.json(
        {
          id: `browser-use-session-${created}`,
          status: 'active',
          cdpUrl: CDP_URL,
          liveUrl: 'https://live.browser-use.invalid',
          startedAt: '2026-10-01T00:00:00Z',
          timeoutAt: '2026-10-01T04:00:00Z',
        },
        { status: 201 }
      );
    }
    if (method === 'PATCH') {
      return stopStatus === 200
        ? Response.json({ status: 'stopped' })
        : new Response('stop rejected', { status: stopStatus });
    }
    if (method === 'GET' && url.pathname.endsWith(`/profiles/${PROFILE_ID}`)) {
      profileReads += 1;
      // A fresh updatedAt on every read lets waitForProfileSave return at once.
      return Response.json({ updatedAt: `save-${profileReads}` });
    }
    throw new Error(`unexpected Browser Use request ${method} ${url.pathname}`);
  }) as typeof fetch;

  try {
    const browserUse = await import('../../providers/browser/browserUse');
    const createSession = async () =>
      (
        await browserUse.createBrowserUseSessionWithContext('context-1', 'agent-1', {
          country: 'US',
        })
      ).sessionId;
    const profileReadsOnClose = async (sessionId: string) => {
      stopStatus = 200;
      const before = profileReads;
      await browserUse.closeBrowserUseSession(sessionId);
      return profileReads - before;
    };

    // Control: an unchanged browser with a remembered baseline needs no profile reads,
    // so a non-zero count below can only mean the baseline was forgotten.
    const remembered = await createSession();
    assert.equal(await profileReadsOnClose(remembered), 0, 'remembered baseline was not used');

    const stopped = await createSession();
    stopStatus = 200;
    await browserUse.releaseBrowserUseRemoteSession(stopped);
    assert(
      (await profileReadsOnClose(stopped)) > 0,
      'a successful stop kept the stopped session storage baseline'
    );

    const missing = await createSession();
    stopStatus = 404;
    await browserUse.releaseBrowserUseRemoteSession(missing);
    assert(
      (await profileReadsOnClose(missing)) > 0,
      'a 404 stop kept the vanished session storage baseline'
    );

    const rejected = await createSession();
    stopStatus = 400;
    await assert.rejects(
      browserUse.releaseBrowserUseRemoteSession(rejected),
      /Browser Use HTTP 400/
    );
    assert.equal(
      await profileReadsOnClose(rejected),
      0,
      'a failed stop must keep the baseline of the still-running session'
    );
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

void main();
