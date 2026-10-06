#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import { prisma } from '../../providers/database';
import {
  CLOUD_PERSISTENT_BROWSER_PROFILE,
  persistSignedInBrowserState,
  persistSignedInBrowserStateTimeoutMs,
  remoteWsUrlLooksPersistable,
  shouldPersistSignedInBrowserState,
} from '../../providers/browser/sessionAuthPersist';

function fakeBrowser(state: {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None';
  }>;
  origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}): Browser {
  return {
    contexts: () => [
      {
        storageState: async () => ({
          cookies: state.cookies.map((cookie) => ({
            path: '/',
            secure: false,
            httpOnly: false,
            sameSite: 'Lax' as const,
            ...cookie,
          })),
          origins: state.origins ?? [],
        }),
      },
    ],
    close: async () => undefined,
  } as unknown as Browser;
}

async function withUser<T>(fn: (userId: string) => Promise<T>): Promise<T> {
  const userId = `auth-persist-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    return await fn(userId);
  } finally {
    await prisma.browserSession.deleteMany({ where: { context: { userId } } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.localStorageOrigin.deleteMany({ where: { userId } });
    await prisma.cookie.deleteMany({ where: { userId } });
    await prisma.cookieBundle.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function createKernelSession(userId: string, sessionId = `kernel-${randomUUID()}`) {
  const context = await prisma.browserContext.create({ data: { userId } });
  return prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId,
      wsUrl: 'ws://example/not-a-provider',
      provider: 'kernel',
      status: 'ACTIVE',
      providerProfileSource: 'user_persistent',
    },
  });
}

async function skipGates(): Promise<void> {
  assert.equal(shouldPersistSignedInBrowserState({ provider: 'kernel' }).persist, true);
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
}

async function harvestWritesCloudPersistentBundle(): Promise<void> {
  await withUser(async (userId) => {
    const session = await createKernelSession(userId);
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
          {
            name: 'session',
            value: 'kernel-auth',
            domain: '.example.com',
            expires: Math.floor(Date.now() / 1000) + 3600,
          },
        ],
        origins: [
          {
            origin: 'https://example.com',
            localStorage: [{ name: 'rose_handoff', value: 'signed-in' }],
          },
        ],
      }),
    });
    assert.equal(result.persisted, true);
    assert.equal(result.realmCount, 1);
    const bundle = await prisma.cookieBundle.findUniqueOrThrow({
      where: {
        userId_authRealm_browserSource_browserProfile: {
          userId,
          authRealm: 'example.com',
          browserSource: 'kernel',
          browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
        },
      },
    });
    assert.equal(bundle.disabledAt, null);
    const cookie = await prisma.cookie.findFirstOrThrow({
      where: { userId, name: 'session', browserSource: 'kernel' },
    });
    assert.equal(cookie.value, 'kernel-auth');
    assert.equal(cookie.browserProfile, CLOUD_PERSISTENT_BROWSER_PROFILE);
    const storage = await prisma.localStorageOrigin.findUniqueOrThrow({
      where: { userId_origin: { userId, origin: 'https://example.com' } },
    });
    const entries = storage.entries as Array<{ key: string; value: string }>;
    assert.deepEqual(
      new Map(entries.map((entry) => [entry.key, entry.value])),
      new Map([
        ['kept', 'mac'],
        ['rose_handoff', 'signed-in'],
      ])
    );
  });
}

async function fixtureWsUrlDoesNotHangClosePath(): Promise<void> {
  await withUser(async (userId) => {
    const session = await createKernelSession(userId);
    const result = await persistSignedInBrowserState(session.sessionId);
    assert.equal(result.persisted, false);
    assert.equal(result.reason, 'unpersistable_ws_url');
  });
}

async function main(): Promise<void> {
  await skipGates();
  await persistableUrlAllowlist();
  await harvestWritesCloudPersistentBundle();
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
