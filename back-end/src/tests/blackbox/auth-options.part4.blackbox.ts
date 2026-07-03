#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { getAuthOptions } from '../../domains/auth-options/service';

config();

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CHROMIUM_UNIX_EPOCH_OFFSET_MS = 11644473600000n;

function chromiumMicrosDaysAgo(daysAgo: number) {
  return (BigInt(Date.now() - daysAgo * DAY_MS) + CHROMIUM_UNIX_EPOCH_OFFSET_MS) * 1000n;
}

async function createUser(systemName?: string) {
  const userId = `auth-options-${randomUUID()}`;
  await prisma.user.create({
    data: {
      userId,
      isAnonymous: true,
      systemName,
    },
  });
  return userId;
}

async function cleanup(userId: string) {
  await prisma.emailIntegrationCredential.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { userId } });
  await prisma.cookie.deleteMany({ where: { userId } });
  await prisma.cookieBundle.deleteMany({ where: { userId } });
  await prisma.browserPassword.deleteMany({ where: { userId } });
  await prisma.steelSessionAuth.deleteMany({ where: { userId } });
  await prisma.mintedAccount.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function createBundleWithCookie(params: {
  userId: string;
  authRealm: string;
  browserProfile: string;
  cookieDomain: string;
  creationUtc: bigint;
  disabled?: boolean;
  accountLabel?: string;
}) {
  const bundle = await prisma.cookieBundle.create({
    data: {
      userId: params.userId,
      authRealm: params.authRealm,
      browserSource: 'chrome',
      browserProfile: params.browserProfile,
      accountLabel: params.accountLabel,
      disabledAt: params.disabled === true ? new Date() : null,
      disabledReason: params.disabled === true ? 'previous auth failure' : null,
    },
  });
  await prisma.cookie.create({
    data: {
      userId: params.userId,
      domain: params.cookieDomain,
      name: `session-${params.browserProfile}`,
      path: '/',
      value: 'cookie-value',
      browserSource: 'chrome',
      browserProfile: params.browserProfile,
      topFrameSiteKey: '',
      creationUtc: params.creationUtc,
    },
  });
  return bundle;
}

test('benchmark anon auth options hide saved auth and expose minted identity', async () => {
  const userId = await createUser('Rose Harbor');
  const previousDisableSaved = process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH;
  const previousPrimitiveKey = process.env.PRIMITIVE_API_KEY;
  const previousAgentPhoneKey = process.env.AGENTPHONE_API_KEY;
  try {
    process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH = 'true';
    delete process.env.PRIMITIVE_API_KEY;
    delete process.env.AGENTPHONE_API_KEY;

    await prisma.agentIdentity.create({
      data: {
        userId,
        email: 'rose.harbor47@mail.roselabs.ai',
        phone: '+18159823405',
        phoneProvider: 'agentphone',
      },
    });
    await prisma.browserContext.create({
      data: { userId, contextId: `ctx-${randomUUID()}` },
    });
    await prisma.steelSessionAuth.create({
      data: {
        userId,
        contextId: `ctx-${randomUUID()}`,
        authRealm: 'x.com',
      },
    });
    await createBundleWithCookie({
      userId,
      authRealm: 'x.com',
      browserProfile: 'Default',
      cookieDomain: '.x.com',
      creationUtc: chromiumMicrosDaysAgo(1),
    });
    await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://x.com',
        username: 'saved@example.com',
        encryptedPassword: 'encrypted',
        browserSource: 'chrome',
        dateLastUsed: chromiumMicrosDaysAgo(1),
      },
    });

    const options = await getAuthOptions(userId, 'https://x.com');

    assert(options.steel_session === null, 'expected Steel session auth hidden in anon mode');
    assert(options.cookie_bundles.length === 0, 'expected cookie bundles hidden in anon mode');
    assert(options.passwords.length === 0, 'expected passwords hidden in anon mode');
    assert(
      options.minted?.email === 'rose.harbor47@mail.roselabs.ai',
      'expected minted email exposed'
    );
    assert(options.minted?.phone === '+18159823405', 'expected minted phone exposed');
  } finally {
    if (previousDisableSaved === undefined) delete process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH;
    else process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH = previousDisableSaved;
    if (previousPrimitiveKey === undefined) delete process.env.PRIMITIVE_API_KEY;
    else process.env.PRIMITIVE_API_KEY = previousPrimitiveKey;
    if (previousAgentPhoneKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneKey;
    await cleanup(userId);
  }
});

test('mark Steel session auth failed disables only owner row and resets context', async () => {
  const userId = await createUser();
  const otherUserId = await createUser();
  try {
    const contextId = `ctx-${randomUUID()}`;
    await prisma.browserContext.create({
      data: { userId, contextId },
    });
    const steelAuth = await prisma.steelSessionAuth.create({
      data: {
        userId,
        contextId,
        authRealm: 'amazon.com',
      },
    });

    const { markSteelSessionAuthFailed } = await import('../../domains/auth-options/service');
    const unauthorized = await markSteelSessionAuthFailed(
      otherUserId,
      steelAuth.id,
      'other user attempt'
    );
    const updated = await markSteelSessionAuthFailed(userId, steelAuth.id, 'login page displayed');

    assert(unauthorized === null, 'expected cross-user Steel auth update to be rejected');
    assert(updated?.disabledReason === 'login page displayed', 'expected disabled reason');

    const persisted = await prisma.steelSessionAuth.findUniqueOrThrow({
      where: { id: steelAuth.id },
    });
    const context = await prisma.browserContext.findUniqueOrThrow({ where: { userId } });
    assert(persisted.disabledAt !== null, 'expected Steel auth disabledAt');
    assert(context.contextId === null, 'expected persistent context reset');
  } finally {
    await cleanup(userId);
    await cleanup(otherUserId);
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
