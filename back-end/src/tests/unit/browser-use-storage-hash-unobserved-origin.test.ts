#!/usr/bin/env tsx
/**
 * Browser Use profile change detection must see localStorage on origins the
 * hashing client never watched navigate (ledger T39). Playwright's
 * storageState() lists only origins its own client observed; the agent drove
 * the session through another client, so a change there used to hash as
 * "unchanged" and close skipped the profile-save wait.
 *
 * Observed through the only reader of the module-private hash:
 * `closeBrowserUseSession` reads the provider profile only when storage changed
 * since session create (or the baseline is unknown).
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

let cartValue = 'empty';

function fakeBrowser() {
  // An origin Playwright never reports (storageState origins: []) whose
  // localStorage lives only in an open page frame.
  const frame = {
    url: () => 'https://shop.example.com/cart',
    evaluate: async () => ({
      origin: 'https://shop.example.com',
      localStorage: [{ name: 'cart', value: cartValue }],
      indexedDB: [],
    }),
  };
  return {
    contexts: () => [
      {
        storageState: async () => ({
          cookies: [{ name: 'sid', value: 'v', domain: 'example.com', path: '/' }],
          origins: [],
        }),
        pages: () => [{ frames: () => [frame] }],
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

    // Control: unchanged unobserved-origin storage keeps the baseline (no reads).
    cartValue = 'empty';
    const unchanged = await createSession();
    assert.equal(await profileReadsOnClose(unchanged), 0, 'unchanged storage read the profile');

    // The agent changed localStorage on an origin the hashing client never saw.
    cartValue = 'empty';
    const changed = await createSession();
    cartValue = 'three-items';
    assert(
      (await profileReadsOnClose(changed)) > 0,
      'a localStorage change on an unobserved origin was hashed as unchanged'
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
