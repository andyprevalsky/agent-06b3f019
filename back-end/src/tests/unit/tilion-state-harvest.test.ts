#!/usr/bin/env tsx
/**
 * Tilion pause/resume and replacement harvests lost localStorage: the harvest
 * is a fresh Playwright client, and storageState() lists only origins that
 * client watched navigate (lane E live: cookies=1 origins=0 while the tab still
 * read the key). captureContextStorage must read every open page/frame origin.
 */
import assert from 'node:assert/strict';
import {
  captureContextStorage,
  FRAME_STORAGE_SCRIPT,
  type StorageState,
} from '../../providers/browser/tilionState';

type FakeFrame = { url(): string; evaluate(script: string): Promise<unknown> };

function frame(url: string, read: () => Promise<unknown>): FakeFrame & { calls: number } {
  const fake = {
    calls: 0,
    url: () => url,
    evaluate: async (script: string) => {
      assert.equal(script, FRAME_STORAGE_SCRIPT);
      fake.calls += 1;
      return read();
    },
  };
  return fake;
}

const COOKIE = {
  name: 'sid',
  value: 'v',
  domain: '.example.com',
  path: '/',
  expires: -1,
  httpOnly: false,
  secure: true,
  sameSite: 'Lax' as const,
};

function context(base: StorageState, pages: FakeFrame[][]) {
  return {
    storageState: async () => base,
    pages: () => pages.map((frames) => ({ frames: () => frames })),
  };
}

async function testUnobservedOriginsAreCaptured(): Promise<void> {
  const idb = [
    {
      name: 'app',
      version: 1,
      stores: [{ name: 'kv', keyPath: null, records: [{ key: 'a', value: 1 }] }],
    },
  ];
  const top = frame('https://example.com/account', async () => ({
    origin: 'https://example.com',
    localStorage: [{ name: 'rose_probe', value: 'set' }],
    indexedDB: idb,
  }));
  const sameOriginChild = frame('https://example.com/widget', async () => {
    throw new Error('one read per origin');
  });
  const iframe = frame('https://auth.example.net/frame', async () => ({
    origin: 'https://auth.example.net',
    localStorage: [{ name: 'token', value: 't' }],
    indexedDB: [],
  }));
  const blank = frame('about:blank', async () => {
    throw new Error('non-http frames are not read');
  });
  // The fresh harvest client never observed a navigation: Playwright reports no origins.
  const state = await captureContextStorage(
    context({ cookies: [COOKIE], origins: [] }, [[top, sameOriginChild, iframe, blank]])
  );
  assert.deepEqual(state.cookies, [COOKIE]);
  assert.deepEqual(state.origins, [
    {
      origin: 'https://example.com',
      localStorage: [{ name: 'rose_probe', value: 'set' }],
      indexedDB: idb,
    },
    { origin: 'https://auth.example.net', localStorage: [{ name: 'token', value: 't' }] },
  ]);
  assert.equal(sameOriginChild.calls, 0);
  assert.equal(blank.calls, 0);
}

async function testPlaywrightOriginsKeepTheirDataAndEmptyOriginsAreDropped(): Promise<void> {
  const known = {
    origin: 'https://example.com',
    localStorage: [{ name: 'k', value: 'from-playwright' }],
  };
  const state = await captureContextStorage(
    context({ cookies: [], origins: [known] }, [
      [
        frame('https://example.com/', async () => ({
          origin: 'https://example.com',
          localStorage: [{ name: 'k', value: 'from-page' }],
          indexedDB: [],
        })),
        frame('https://empty.example.org/', async () => ({
          origin: 'https://empty.example.org',
          localStorage: [],
          indexedDB: [],
        })),
      ],
    ])
  );
  assert.deepEqual(state.origins, [known]);
}

async function testAHungFrameIsBoundedAndSkipped(): Promise<void> {
  const started = Date.now();
  const state = await captureContextStorage(
    context({ cookies: [], origins: [] }, [
      [
        frame('https://hung.example.com/', () => new Promise(() => undefined)),
        frame('https://ok.example.com/', async () => ({
          origin: 'https://ok.example.com',
          localStorage: [{ name: 'k', value: 'v' }],
        })),
        frame('https://throws.example.com/', async () => {
          throw new Error('Execution context was destroyed');
        }),
      ],
    ])
  );
  assert.ok(Date.now() - started < 5_000, 'per-frame reads are bounded');
  assert.deepEqual(
    state.origins.map((origin) => origin.origin),
    ['https://ok.example.com']
  );
}

async function run(): Promise<void> {
  await testUnobservedOriginsAreCaptured();
  await testPlaywrightOriginsKeepTheirDataAndEmptyOriginsAreDropped();
  await testAHungFrameIsBoundedAndSkipped();
  process.stdout.write('PASS tilion state harvest unit (3 cases)\n');
}

run().catch((error) => {
  process.stderr.write(`FAIL tilion state harvest unit ${String(error)}\n`);
  process.exit(1);
});
