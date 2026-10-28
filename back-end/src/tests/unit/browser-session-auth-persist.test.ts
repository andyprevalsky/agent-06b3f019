#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import { prisma } from '../../providers/database';
import {
  CLOUD_PERSISTENT_BROWSER_PROFILE,
  collectHarvestableLocalStorage,
  httpOriginFromUrl,
  persistSignedInBrowserState,
  persistSignedInBrowserStateTimeoutMs,
  remoteWsUrlLooksPersistable,
  shouldPersistSignedInBrowserState,
  signedInRealmsForBrowserSession,
} from '../../providers/browser/sessionAuthPersist';
import {
  completeCloudBrowserSignIn,
  deleteCloudBrowserSignInEvidence,
  holdSiblingCloseLock,
  waitForAbandonedWrite,
} from '../helpers/browser-sign-in-evidence';

type FakeCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
};
type FakePage = {
  url: () => string;
  evaluate: (script: unknown) => Promise<unknown>;
};

const LIVE_EXPIRY = () => Math.floor(Date.now() / 1000) + 3600;

function fakeBrowser(state: {
  cookies: FakeCookie[];
  pages?: FakePage[];
  newPage?: () => Promise<unknown>;
  newCDPSession?: () => Promise<unknown>;
}): Browser {
  return {
    contexts: () => [
      {
        cookies: async () =>
          state.cookies.map((cookie) => ({
            path: '/',
            expires: -1,
            secure: false,
            httpOnly: false,
            sameSite: 'Lax' as const,
            ...cookie,
          })),
        pages: () => state.pages ?? [],
        newPage:
          state.newPage ??
          (async () => {
            throw new Error('open pages already supplied every origin; no probe expected');
          }),
        newCDPSession: state.newCDPSession ?? (async () => ({ send: async () => undefined })),
      },
    ],
    close: async () => undefined,
  } as unknown as Browser;
}

function openPage(url: string, entries: Array<{ name: string; value: string }>): FakePage {
  return { url: () => url, evaluate: async () => entries };
}

async function withUser<T>(fn: (userId: string) => Promise<T>): Promise<T> {
  const userId = `auth-persist-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    return await fn(userId);
  } finally {
    await deleteCloudBrowserSignInEvidence(userId);
    await prisma.browserSession.deleteMany({ where: { context: { userId } } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.localStorageOrigin.deleteMany({ where: { userId } });
    await prisma.cookie.deleteMany({ where: { userId } });
    await prisma.cookieBundle.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function createKernelSession(userId: string) {
  const agentId = randomUUID();
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'Capture signed-in browser state',
      status: 'ACTIVE',
      temporalWorkflowId: agentId,
    },
  });
  const context = await prisma.browserContext.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  return prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId,
      sessionId: `kernel-${randomUUID()}`,
      wsUrl: 'ws://example/not-a-provider',
      provider: 'kernel',
      status: 'ACTIVE',
      providerProfileSource: 'user_persistent',
    },
  });
}

async function signedInKernelSession(userId: string, authRealm = 'https://example.com/login') {
  const session = await createKernelSession(userId);
  await completeCloudBrowserSignIn({
    userId,
    agentId: session.agentId,
    browserSessionId: session.id,
    steelSessionId: session.sessionId,
    authRealm,
  });
  return session;
}

async function withPersistTimeoutMs<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.BROWSER_SESSION_AUTH_PERSIST_TIMEOUT_MS;
  process.env.BROWSER_SESSION_AUTH_PERSIST_TIMEOUT_MS = String(timeoutMs);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BROWSER_SESSION_AUTH_PERSIST_TIMEOUT_MS;
    else process.env.BROWSER_SESSION_AUTH_PERSIST_TIMEOUT_MS = previous;
  }
}

async function realmRows(userId: string, authRealm: string) {
  const [bundle, cookies] = await Promise.all([
    prisma.cookieBundle.findUnique({
      where: {
        userId_authRealm_browserSource_browserProfile: {
          userId,
          authRealm,
          browserSource: 'kernel',
          browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
        },
      },
    }),
    prisma.cookie.findMany({
      where: {
        userId,
        browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
        domain: { endsWith: authRealm },
      },
    }),
  ]);
  return { bundle, cookies };
}

async function skipGates(): Promise<void> {
  assert.equal(shouldPersistSignedInBrowserState({ provider: 'kernel' }).persist, true);
  assert.equal(shouldPersistSignedInBrowserState({ provider: 'tilion' }).persist, true);
  assert.equal(
    shouldPersistSignedInBrowserState({ provider: 'browser-use' }).reason,
    'unsupported_provider'
  );
  assert.equal(
    shouldPersistSignedInBrowserState({
      provider: 'steel',
      providerProfileSource: 'benchmark_anon_fresh',
    }).reason,
    'benchmark_anon_profile'
  );
  const previous = process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH;
  process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH = '1';
  try {
    assert.equal(
      shouldPersistSignedInBrowserState({ provider: 'kernel' }).reason,
      'saved_browser_auth_disabled'
    );
  } finally {
    if (previous === undefined) delete process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH;
    else process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH = previous;
  }
}

async function persistableUrlAllowlist(): Promise<void> {
  assert.equal(remoteWsUrlLooksPersistable('wss://proxy.usw.onkernel.com/cdp'), true);
  assert.equal(remoteWsUrlLooksPersistable('wss://connect.steel.dev/?sessionId=abc'), true);
  assert.equal(remoteWsUrlLooksPersistable('ws://example/first'), false);
  assert.equal(remoteWsUrlLooksPersistable('wss://example.com/cdp'), false);
  assert.equal(remoteWsUrlLooksPersistable('not-a-url'), false);
  assert.ok(persistSignedInBrowserStateTimeoutMs() > 0);
  assert.ok(persistSignedInBrowserStateTimeoutMs() < 10_000, 'must fit the worker close timeout');
}

async function noSignInEvidenceSkipsWithoutConnecting(): Promise<void> {
  await withUser(async (userId) => {
    const session = await createKernelSession(userId);
    const result = await persistSignedInBrowserState(session.sessionId, {
      browser: {
        contexts: () => {
          throw new Error('an anonymous session must not be read');
        },
        close: async () => undefined,
      } as unknown as Browser,
    });
    assert.equal(result.persisted, false);
    assert.equal(result.reason, 'no_signed_in_realm');
    assert.equal(await prisma.cookieBundle.count({ where: { userId } }), 0);
  });
}

async function onlyCompletedCloudBrowserSignInsCount(): Promise<void> {
  await withUser(async (userId) => {
    const session = await createKernelSession(userId);
    const base = {
      userId,
      agentId: session.agentId,
      browserSessionId: session.id,
      steelSessionId: session.sessionId,
    };
    await completeCloudBrowserSignIn({ ...base, authRealm: 'pending.com', complete: false });
    await completeCloudBrowserSignIn({ ...base, authRealm: 'mac-only.com', mode: 'local_browser' });
    await completeCloudBrowserSignIn({ ...base, authRealm: 'https://www.example.com/login' });
    await completeCloudBrowserSignIn({ ...base, authRealm: 'otp.com', mode: 'manual_otp' });
    const other = await createKernelSession(userId);
    await completeCloudBrowserSignIn({
      ...base,
      browserSessionId: other.id,
      steelSessionId: other.sessionId,
      authRealm: 'other-session.com',
    });
    assert.deepEqual(
      (await signedInRealmsForBrowserSession({ browserSessionId: session.id, userId })).sort(),
      ['example.com', 'otp.com']
    );
  });
}

async function harvestKeepsOnlySignedInRealm(): Promise<void> {
  await withUser(async (userId) => {
    const session = await signedInKernelSession(userId);
    await prisma.localStorageOrigin.create({
      data: {
        userId,
        origin: 'https://example.com',
        entries: [{ key: 'kept', value: 'mac' }],
        hash: 'old',
      },
    });
    const probed: string[] = [];
    const result = await persistSignedInBrowserState(session.sessionId, {
      browser: fakeBrowser({
        cookies: [
          { name: 'session', value: 'kernel-auth', domain: '.example.com', expires: LIVE_EXPIRY() },
          { name: '_ga', value: 'tracking', domain: '.example.com' },
          { name: 'session-id', value: 'anonymous', domain: '.amazon.com', expires: LIVE_EXPIRY() },
        ],
        pages: [
          openPage('https://www.example.com/account', [
            { name: 'rose_handoff', value: 'signed-in' },
          ]),
          openPage('https://www.amazon.com/', [{ name: 'anon', value: 'cart' }]),
        ],
        newPage: async () => {
          let current = 'about:blank';
          return {
            url: () => current,
            mainFrame: () => ({}),
            route: async () => undefined,
            goto: async (url: string) => {
              probed.push(new URL(url).origin);
              current = url;
            },
            evaluate: async () => [],
            close: async () => undefined,
          };
        },
      }),
    });
    assert.deepEqual(probed, ['https://example.com'], 'only signed-in realm origins are probed');
    assert.equal(result.warning, undefined);
    assert.equal(result.persisted, true);
    assert.equal(result.realmCount, 1);
    assert.equal(result.cookieCount, 2);
    const signedIn = await realmRows(userId, 'example.com');
    assert.equal(signedIn.bundle?.disabledAt, null);
    assert.deepEqual(signedIn.cookies.map((cookie) => cookie.name).sort(), ['_ga', 'session']);
    const anonymous = await realmRows(userId, 'amazon.com');
    assert.equal(anonymous.bundle, null, 'an anonymous realm must not outrank a real bundle');
    assert.equal(anonymous.cookies.length, 0);
    assert.equal(
      await prisma.localStorageOrigin.count({
        where: { userId, origin: 'https://www.amazon.com' },
      }),
      0
    );
    const storage = await prisma.localStorageOrigin.findUniqueOrThrow({
      where: { userId_origin: { userId, origin: 'https://www.example.com' } },
    });
    assert.deepEqual(storage.entries, [{ key: 'rose_handoff', value: 'signed-in' }]);
    const kept = await prisma.localStorageOrigin.findUniqueOrThrow({
      where: { userId_origin: { userId, origin: 'https://example.com' } },
    });
    assert.deepEqual(kept.entries, [{ key: 'kept', value: 'mac' }]);
  });
}

async function realmWithoutAuthCookieWritesNoBundle(): Promise<void> {
  await withUser(async (userId) => {
    const session = await signedInKernelSession(userId);
    const result = await persistSignedInBrowserState(session.sessionId, {
      browser: fakeBrowser({
        cookies: [{ name: '_ga', value: 'tracking', domain: '.example.com' }],
        pages: [openPage('https://example.com/app', [{ name: 'token', value: 'spa-auth' }])],
      }),
    });
    assert.equal(result.persisted, true);
    assert.equal(result.realmCount, 0);
    assert.equal(result.localStorageOriginCount, 1);
    const rows = await realmRows(userId, 'example.com');
    assert.equal(rows.bundle, null, 'a non-injectable bundle would hide minted accounts');
    assert.equal(rows.cookies.length, 0);
  });
}

async function mergesExistingKeysAndReEnablesBundle(): Promise<void> {
  await withUser(async (userId) => {
    const session = await signedInKernelSession(userId);
    await prisma.cookieBundle.create({
      data: {
        userId,
        authRealm: 'example.com',
        browserSource: 'kernel',
        browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
        disabledAt: new Date(),
        disabledReason: 'auth_failed',
      },
    });
    await prisma.localStorageOrigin.create({
      data: {
        userId,
        origin: 'https://example.com',
        entries: [{ key: 'kept', value: 'mac' }],
        hash: 'old',
      },
    });
    const result = await persistSignedInBrowserState(session.sessionId, {
      browser: fakeBrowser({
        cookies: [
          { name: 'session', value: 'fresh', domain: 'example.com', expires: LIVE_EXPIRY() },
        ],
        pages: [openPage('https://example.com/', [{ name: 'rose_handoff', value: 'signed-in' }])],
      }),
    });
    assert.equal(result.persisted, true);
    const rows = await realmRows(userId, 'example.com');
    assert.equal(rows.bundle?.disabledAt, null, 'a new sign-in re-enables the cloud bundle');
    assert.equal(rows.bundle?.disabledReason, null);
    const storage = await prisma.localStorageOrigin.findUniqueOrThrow({
      where: { userId_origin: { userId, origin: 'https://example.com' } },
    });
    assert.deepEqual(
      new Map(
        (storage.entries as Array<{ key: string; value: string }>).map((e) => [e.key, e.value])
      ),
      new Map([
        ['kept', 'mac'],
        ['rose_handoff', 'signed-in'],
      ])
    );
  });
}

async function partitionedDuplicatesAndConcurrentClosesPersist(): Promise<void> {
  await withUser(async (userId) => {
    const first = await signedInKernelSession(userId);
    const second = await signedInKernelSession(userId);
    const browserFor = (value: string) =>
      fakeBrowser({
        cookies: [
          { name: 'session', value, domain: '.example.com', expires: LIVE_EXPIRY() },
          { name: 'session', value: `${value}-partitioned`, domain: '.example.com' },
        ],
      });
    const results = await Promise.all([
      persistSignedInBrowserState(first.sessionId, { browser: browserFor('first') }),
      persistSignedInBrowserState(second.sessionId, { browser: browserFor('second') }),
    ]);
    assert.deepEqual(
      results.map((result) => result.persisted),
      [true, true]
    );
    const rows = await realmRows(userId, 'example.com');
    assert.equal(rows.cookies.length, 1, 'one close must fully replace the other');
    assert.ok(['first', 'second'].includes(rows.cookies[0]?.value ?? ''));
  });
}

async function localStorageTimeoutKeepsCookiesAndClosesProbe(): Promise<void> {
  await withPersistTimeoutMs(600, () =>
    withUser(async (userId) => {
      const session = await signedInKernelSession(userId);
      let probeClosed = false;
      const bypass: unknown[] = [];
      const result = await persistSignedInBrowserState(session.sessionId, {
        currentUrl: 'https://example.com/checkout',
        browser: fakeBrowser({
          cookies: [
            {
              name: 'session',
              value: 'kernel-auth',
              domain: '.example.com',
              expires: LIVE_EXPIRY(),
            },
          ],
          newPage: async () => ({
            url: () => 'about:blank',
            mainFrame: () => ({}),
            route: async () => undefined,
            goto: () => new Promise(() => undefined),
            evaluate: async () => [],
            close: async () => {
              probeClosed = true;
            },
          }),
          newCDPSession: async () => ({
            send: async (method: string, params: unknown) => {
              bypass.push({ method, params });
            },
          }),
        }),
      });
      assert.equal(result.persisted, true);
      assert.equal(result.realmCount, 1);
      assert.equal(result.localStorageOriginCount, 0);
      assert.match(result.warning ?? '', /localStorage/);
      assert.equal((await realmRows(userId, 'example.com')).cookies.length, 1);
      assert.equal(probeClosed, true, 'a timed-out probe page must be closed');
      assert.deepEqual(bypass, [
        { method: 'Network.setBypassServiceWorker', params: { bypass: true } },
      ]);
    })
  );
}

const SIGNED_IN_EXAMPLE_TAB = () =>
  fakeBrowser({
    cookies: [
      { name: 'session', value: 'kernel-auth', domain: '.example.com', expires: LIVE_EXPIRY() },
    ],
    pages: [openPage('https://example.com/app', [{ name: 'rose_handoff', value: 'signed-in' }])],
  });

async function heldCookieLockCannotStallClose(): Promise<void> {
  await withPersistTimeoutMs(800, () =>
    withUser(async (userId) => {
      const session = await signedInKernelSession(userId);
      const lock = await holdSiblingCloseLock(
        `browser-auth-persist:cookies:${userId}:kernel:example.com`
      );
      try {
        await assert.rejects(
          persistSignedInBrowserState(session.sessionId, { browser: SIGNED_IN_EXAMPLE_TAB() }),
          /Timed out persisting signed-in browser cookies/
        );
        assert.equal(lock.valveFired(), false, 'close waited on a sibling cookie lock');
      } finally {
        await lock.release();
      }
      await waitForAbandonedWrite(
        async () => (await realmRows(userId, 'example.com')).bundle !== null,
        'the abandoned cookie write never committed'
      );
      assert.equal(
        await prisma.localStorageOrigin.count({ where: { userId } }),
        0,
        'no write may start once the budget is spent'
      );
    })
  );
}

async function heldStorageLockKeepsCookiesWithinBudget(): Promise<void> {
  await withPersistTimeoutMs(800, () =>
    withUser(async (userId) => {
      const session = await signedInKernelSession(userId);
      const lock = await holdSiblingCloseLock(
        `browser-auth-persist:storage:${userId}:https://example.com`
      );
      let result: Awaited<ReturnType<typeof persistSignedInBrowserState>>;
      try {
        result = await persistSignedInBrowserState(session.sessionId, {
          browser: SIGNED_IN_EXAMPLE_TAB(),
        });
        assert.equal(lock.valveFired(), false, 'close waited on a sibling storage lock');
      } finally {
        await lock.release();
      }
      assert.equal(result.persisted, true);
      assert.equal(result.realmCount, 1);
      assert.equal(result.localStorageOriginCount, 0);
      assert.match(result.warning ?? '', /Timed out persisting signed-in browser localStorage/);
      assert.equal((await realmRows(userId, 'example.com')).cookies.length, 1);
      await waitForAbandonedWrite(
        async () => (await prisma.localStorageOrigin.count({ where: { userId } })) === 1,
        'the abandoned localStorage write never committed'
      );
    })
  );
}

async function probeReadsBlankTabOriginsThroughSyntheticDocument(): Promise<void> {
  await withUser(async (userId) => {
    const session = await signedInKernelSession(userId);
    const visited: string[] = [];
    const result = await persistSignedInBrowserState(session.sessionId, {
      currentUrl: 'https://example.com/checkout',
      browser: fakeBrowser({
        cookies: [
          { name: 'session', value: 'kernel-auth', domain: '.example.com', expires: LIVE_EXPIRY() },
          { name: 'ad', value: 'x', domain: '.tracker.test' },
        ],
        pages: [openPage('about:blank', [])],
        newPage: async () => {
          let current = 'about:blank';
          return {
            url: () => current,
            mainFrame: () => ({}),
            route: async () => undefined,
            goto: async (url: string) => {
              visited.push(url);
              current = url;
            },
            evaluate: async () => [{ name: 'rose_handoff', value: 'from-probe' }],
            close: async () => undefined,
          };
        },
      }),
    });
    assert.equal(result.persisted, true);
    assert.equal(result.localStorageOriginCount, 1);
    assert.equal(visited.length, 1, `probed ${JSON.stringify(visited)}`);
    assert.match(visited[0] ?? '', /^https:\/\/example\.com\/\.rose-storage-/);
    const storage = await prisma.localStorageOrigin.findUniqueOrThrow({
      where: { userId_origin: { userId, origin: 'https://example.com' } },
    });
    assert.deepEqual(storage.entries, [{ key: 'rose_handoff', value: 'from-probe' }]);
  });
}

async function collectHelpersCoverReconnectOrigins(): Promise<void> {
  assert.equal(httpOriginFromUrl('https://example.com/path'), 'https://example.com');
  assert.equal(httpOriginFromUrl('.example.com'), 'https://example.com');
  assert.equal(httpOriginFromUrl('about:blank'), null);
  const collected = await collectHarvestableLocalStorage(
    {
      pages: () => [
        openPage('https://shop.example.com/cart', [{ name: 'rose_handoff', value: 'open-tab' }]),
      ],
      newPage: async () => {
        throw new Error('page origin should not be probed again');
      },
    } as never,
    ['https://shop.example.com']
  );
  assert.deepEqual(collected, [
    {
      origin: 'https://shop.example.com',
      localStorage: [{ name: 'rose_handoff', value: 'open-tab' }],
    },
  ]);
}

async function fixtureWsUrlDoesNotHangClosePath(): Promise<void> {
  await withUser(async (userId) => {
    const session = await signedInKernelSession(userId);
    const result = await persistSignedInBrowserState(session.sessionId);
    assert.equal(result.persisted, false);
    assert.equal(result.reason, 'unpersistable_ws_url');
  });
}

async function main(): Promise<void> {
  await skipGates();
  await persistableUrlAllowlist();
  await noSignInEvidenceSkipsWithoutConnecting();
  await onlyCompletedCloudBrowserSignInsCount();
  await harvestKeepsOnlySignedInRealm();
  await realmWithoutAuthCookieWritesNoBundle();
  await mergesExistingKeysAndReEnablesBundle();
  await partitionedDuplicatesAndConcurrentClosesPersist();
  await localStorageTimeoutKeepsCookiesAndClosesProbe();
  await heldCookieLockCannotStallClose();
  await heldStorageLockKeepsCookiesWithinBudget();
  await probeReadsBlankTabOriginsThroughSyntheticDocument();
  await collectHelpersCoverReconnectOrigins();
  await fixtureWsUrlDoesNotHangClosePath();
  process.stdout.write('browser-session-auth-persist: ok\n');
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
