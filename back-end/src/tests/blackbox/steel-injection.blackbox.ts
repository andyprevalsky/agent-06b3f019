#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import {
  injectUserData,
  resolveBrowserAuthCredentialSource,
  summarizeSteelCookiesForRealm,
} from '../../providers/steel/injection';

config();

type TestFn = () => Promise<void> | void;
const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function createUser() {
  const userId = `steel-injection-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  return userId;
}

async function cleanup(userId: string) {
  await prisma.agentRunCredentialPropagation.deleteMany({
    where: { agentId: { startsWith: userId } },
  });
  await prisma.steelSessionAuth.deleteMany({ where: { userId } });
  await prisma.cookie.deleteMany({ where: { userId } });
  await prisma.cookieBundle.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function createCookieBundle(params: {
  userId: string;
  id?: string;
  browserProfile: string;
  disabled?: boolean;
  authRealm?: string;
  cookieDomain?: string;
  includeCookie?: boolean;
  creationUtc: bigint;
}) {
  const authRealm = params.authRealm ?? 'amazon.com';
  const bundle = await prisma.cookieBundle.create({
    data: {
      id: params.id ?? randomUUID(),
      userId: params.userId,
      authRealm,
      browserSource: 'chrome',
      browserProfile: params.browserProfile,
      disabledAt: params.disabled ? new Date('2026-01-01T00:00:00Z') : null,
      disabledReason: params.disabled ? 'previous auth failure' : null,
    },
  });
  if (params.includeCookie !== false) {
    await prisma.cookie.create({
      data: {
        userId: params.userId,
        domain: params.cookieDomain ?? `.${authRealm}`,
        name: `session-${params.browserProfile}`,
        path: '/',
        value: `value-${params.browserProfile}`,
        browserSource: 'chrome',
        browserProfile: params.browserProfile,
        creationUtc: params.creationUtc,
        expiresUtc: 999999999999999n,
        isSecure: true,
        isHttpOnly: true,
      },
    });
  }
  return bundle;
}

test('Steel auth source wins only when the current Steel session has live realm cookies', async () => {
  const userId = await createUser();
  try {
    const contextId = `profile-${randomUUID()}`;
    const steelAuth = await prisma.steelSessionAuth.create({
      data: { userId, contextId, authRealm: 'amazon.com', authenticatedAt: new Date() },
    });
    await createCookieBundle({ userId, browserProfile: 'Default', creationUtc: 1000n });

    const source = await resolveBrowserAuthCredentialSource({
      userId,
      authRealm: 'amazon.com',
      steelContextId: contextId,
      steelSessionHasRealmCookies: true,
    });

    assert(source.kind === 'steel_session', 'expected enabled Steel auth to win');
    assert(source.id === steelAuth.id, 'expected selected SteelSessionAuth id');
    assert(
      source.credentialRef?.kind === 'steel_session' && source.credentialRef.id === steelAuth.id,
      'expected Steel credential ref'
    );
  } finally {
    await cleanup(userId);
  }
});

test('Steel marker with no current realm cookies falls through to top CookieBundle', async () => {
  const userId = await createUser();
  try {
    const contextId = `profile-${randomUUID()}`;
    await prisma.steelSessionAuth.create({
      data: { userId, contextId, authRealm: 'amazon.com', authenticatedAt: new Date() },
    });
    const bundle = await createCookieBundle({
      userId,
      browserProfile: 'Default',
      creationUtc: 2000n,
    });

    const source = await resolveBrowserAuthCredentialSource({
      userId,
      authRealm: 'amazon.com',
      steelContextId: contextId,
      steelSessionHasRealmCookies: false,
    });

    assert(source.kind === 'cookie_bundle', 'expected cookie bundle fallthrough');
    assert(source.id === bundle.id, 'expected top CookieBundle id');
    assert(
      source.credentialRef?.kind === 'cookie_bundle' && source.credentialRef.id === bundle.id,
      'expected CookieBundle credential ref'
    );
  } finally {
    await cleanup(userId);
  }
});

test('disabled Steel auth falls through and CookieBundle ranking prefers enabled/freshest', async () => {
  const userId = await createUser();
  try {
    const contextId = `profile-${randomUUID()}`;
    await prisma.steelSessionAuth.create({
      data: {
        userId,
        contextId,
        authRealm: 'amazon.com',
        authenticatedAt: new Date(),
        disabledAt: new Date('2026-01-01T00:00:00Z'),
        disabledReason: 'auth failed',
      },
    });
    await createCookieBundle({
      userId,
      browserProfile: 'DisabledNewer',
      disabled: true,
      creationUtc: 9000n,
    });
    const enabledFresh = await createCookieBundle({
      userId,
      browserProfile: 'EnabledFresh',
      creationUtc: 3000n,
    });
    await createCookieBundle({ userId, browserProfile: 'EnabledOld', creationUtc: 1000n });

    const source = await resolveBrowserAuthCredentialSource({
      userId,
      authRealm: 'amazon.com',
      steelContextId: contextId,
      steelSessionHasRealmCookies: true,
    });

    assert(source.kind === 'cookie_bundle', 'expected disabled Steel auth to fall through');
    assert(source.id === enabledFresh.id, 'expected enabled newest CookieBundle');
  } finally {
    await cleanup(userId);
  }
});

test('disabled CookieBundles are not selected when no enabled bundle exists', async () => {
  const userId = await createUser();
  try {
    await createCookieBundle({
      userId,
      browserProfile: 'DisabledOnly',
      disabled: true,
      creationUtc: 9000n,
    });

    const source = await resolveBrowserAuthCredentialSource({
      userId,
      authRealm: 'amazon.com',
      steelContextId: null,
      steelSessionHasRealmCookies: false,
    });

    assert(source.kind === 'none', 'expected disabled CookieBundle to be ignored');
    assert(source.credentialRef === null, 'expected no credential ref');
  } finally {
    await cleanup(userId);
  }
});

test('CookieBundle selection includes parent-domain cookies for www auth realms', async () => {
  const userId = await createUser();
  try {
    const bundle = await createCookieBundle({
      userId,
      authRealm: 'www.doordash.com',
      cookieDomain: '.doordash.com',
      browserProfile: 'Default',
      creationUtc: 4000n,
    });

    const source = await resolveBrowserAuthCredentialSource({
      userId,
      authRealm: 'www.doordash.com',
      steelContextId: null,
    });

    assert(source.kind === 'cookie_bundle', 'expected parent-domain cookie bundle');
    assert(source.id === bundle.id, 'expected parent-domain CookieBundle id');
    assert(source.freshestCookieUtc === 4000n, 'expected parent-domain cookie freshness');
  } finally {
    await cleanup(userId);
  }
});

test('enabled CookieBundles with no injectable realm cookies are not selected', async () => {
  const userId = await createUser();
  try {
    await createCookieBundle({
      userId,
      authRealm: 'www.doordash.com',
      browserProfile: 'Empty',
      includeCookie: false,
      creationUtc: 5000n,
    });

    const source = await resolveBrowserAuthCredentialSource({
      userId,
      authRealm: 'www.doordash.com',
      steelContextId: null,
    });

    assert(source.kind === 'none', 'expected empty CookieBundle to be ignored');
    assert(source.credentialRef === null, 'expected no credential ref for an empty bundle');
  } finally {
    await cleanup(userId);
  }
});

test('Steel cookie summary is realm scoped and expiry aware without exposing values', () => {
  const summary = summarizeSteelCookiesForRealm(
    [
      { domain: '.amazon.com', expires: 1_900_000_000 },
      { domain: 'www.amazon.com', expires: 1_900_000_000 },
      { domain: '.amazon.com', expires: 1_000_000_000 },
      { domain: '.not-amazon.com', expires: 1_900_000_000 },
    ],
    'amazon.com',
    1_800_000_000
  );

  assert(summary.hasRealmCookies, 'expected live amazon cookies');
  assert(summary.cookieCount === 2, 'expected only live same-realm cookies');
  assert(!('value' in summary), 'expected no cookie values in summary');
});

test('JIT credential injection bounds a CDP endpoint that accepts transport but never upgrades', async () => {
  const userId = await createUser();
  const context = await prisma.browserContext.create({ data: { userId } });
  const sessionId = `steel-cdp-stall-${randomUUID()}`;
  const sockets = new Set<Socket>();
  let markConnectionAccepted: (() => void) | undefined;
  const connectionAccepted = new Promise<void>((resolve) => {
    markConnectionAccepted = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    markConnectionAccepted?.();
    // Reproduce the provider symptom: TCP connects, but the CDP websocket
    // upgrade never returns. The production call stayed here until its outer
    // HTTP client abandoned the request after 180 seconds.
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address !== null && typeof address === 'object', 'stalled CDP fixture did not bind');
  await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId,
      wsUrl: `ws://127.0.0.1:${address.port}/devtools/browser/stalled`,
      provider: 'kernel',
      status: 'ACTIVE',
      startUrl: 'https://www.google.com/search?q=movie+genre',
    },
  });

  const previousTimeout = process.env.BROWSER_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS;
  process.env.BROWSER_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS = '75';
  let injectionSettled: Promise<{ rejected: boolean; message: string }> | undefined;
  try {
    injectionSettled = injectUserData(sessionId, userId, 'https://www.google.com/search?q=movie+genre').then(
      () => ({ rejected: false, message: 'credential injection unexpectedly resolved' }),
      (error: unknown) => ({
        rejected: true,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    await Promise.race([
      connectionAccepted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('CDP fixture did not receive a connection within 5s')), 5_000)
      ),
    ]);
    const outcome = await Promise.race([
      injectionSettled,
      new Promise<{ rejected: false; message: string }>((resolve) =>
        setTimeout(
          () => resolve({ rejected: false, message: 'CDP acquisition exceeded the 500ms test budget' }),
          500
        )
      ),
    ]);

    assert(outcome.rejected, outcome.message);
    assert(/timeout|timed out/i.test(outcome.message), `expected an explicit CDP timeout, got: ${outcome.message}`);
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.BROWSER_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS;
    } else {
      process.env.BROWSER_CREDENTIAL_CDP_CONNECT_TIMEOUT_MS = previousTimeout;
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await injectionSettled?.catch(() => undefined);
    await prisma.browserSession.deleteMany({ where: { sessionId } });
    await prisma.browserContext.deleteMany({ where: { id: context.id } });
    await cleanup(userId);
  }
});

async function main() {
  const results: Array<{ name: string; passed: boolean; error?: string }> = [];
  for (const item of tests) {
    try {
      await item.fn();
      results.push({ name: item.name, passed: true });
      console.log(`PASS ${item.name}`);
    } catch (error) {
      results.push({
        name: item.name,
        passed: false,
        error: error instanceof Error ? error.stack || error.message : String(error),
      });
      console.error(`FAIL ${item.name}`);
      console.error(error instanceof Error ? error.stack || error.message : String(error));
    }
  }

  await prisma.$disconnect();
  const failed = results.filter((result) => !result.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
