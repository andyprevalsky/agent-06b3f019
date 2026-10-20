#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { processCookiesUpload } from '../../domains/integrations/uploadService.browser';
import { processPasswordsUpload } from '../../domains/integrations/uploadService.passwords';

config();

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function createUser() {
  const userId = `credential-sync-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  return userId;
}

async function cleanup(userId: string) {
  await prisma.cookie.deleteMany({ where: { userId } });
  await prisma.cookieBundle.deleteMany({ where: { userId } });
  await prisma.browserPassword.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

function cookie(params: {
  name: string;
  value: string;
  domain?: string;
  browserProfile?: string;
  creationUtc?: number;
  expiresUtc?: number;
}) {
  return {
    name: params.name,
    value: params.value,
    domain: params.domain ?? '.amazon.com',
    host_key: params.domain ?? '.amazon.com',
    path: '/',
    top_frame_site_key: '',
    browserProfile: params.browserProfile ?? 'Default',
    creation_utc: params.creationUtc ?? 1000,
    expires_utc: params.expiresUtc ?? 999999999999999,
    is_secure: true,
    is_httponly: true,
    has_expires: true,
    is_persistent: true,
    priority: 1,
    samesite: -1,
    source_scheme: 2,
    source_port: 443,
    last_update_utc: params.creationUtc ?? 1000,
  };
}

test('cookie upload creates profile-scoped CookieBundle rows and snapshots cookies', async () => {
  const userId = await createUser();
  try {
    await processCookiesUpload(
      userId,
      [
        cookie({ name: 'session', value: 'default', browserProfile: 'Default', creationUtc: 1000 }),
        cookie({
          name: 'session',
          value: 'profile1',
          browserProfile: 'Profile 1',
          creationUtc: 2000,
        }),
      ],
      'chrome'
    );

    const bundles = await prisma.cookieBundle.findMany({
      where: { userId, authRealm: 'amazon.com' },
      orderBy: { browserProfile: 'asc' },
    });
    assert(bundles.length === 2, 'expected one CookieBundle per browser profile');
    assert(bundles[0].browserProfile === 'Default', 'expected Default profile bundle');
    assert(bundles[1].browserProfile === 'Profile 1', 'expected Profile 1 bundle');

    await processCookiesUpload(
      userId,
      [cookie({ name: 'session', value: 'default', browserProfile: 'Default', creationUtc: 3000 })],
      'chrome'
    );

    const defaultCookies = await prisma.cookie.findMany({
      where: { userId, browserSource: 'chrome', browserProfile: 'Default' },
    });
    const profileCookies = await prisma.cookie.findMany({
      where: { userId, browserSource: 'chrome', browserProfile: 'Profile 1' },
    });
    assert(defaultCookies.length === 1, 'expected Default snapshot to keep its cookie');
    assert(profileCookies.length === 1, 'expected Profile 1 snapshot to remain isolated');
  } finally {
    await cleanup(userId);
  }
});

test('cookie snapshot replacement removes browser-deleted cookies and bumps bundle updatedAt', async () => {
  const userId = await createUser();
  try {
    await processCookiesUpload(
      userId,
      [
        cookie({ name: 'session', value: 'value-1', browserProfile: 'Default', creationUtc: 1000 }),
        cookie({ name: 'csrf', value: 'csrf-1', browserProfile: 'Default', creationUtc: 1100 }),
      ],
      'chrome'
    );
    const before = await prisma.cookieBundle.findUniqueOrThrow({
      where: {
        userId_authRealm_browserSource_browserProfile: {
          userId,
          authRealm: 'amazon.com',
          browserSource: 'chrome',
          browserProfile: 'Default',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await processCookiesUpload(
      userId,
      [cookie({ name: 'session', value: 'value-1', browserProfile: 'Default', creationUtc: 1000 })],
      'chrome'
    );

    const names = (
      await prisma.cookie.findMany({
        where: { userId, browserSource: 'chrome', browserProfile: 'Default' },
        select: { name: true },
        orderBy: { name: 'asc' },
      })
    ).map((row) => row.name);
    const after = await prisma.cookieBundle.findUniqueOrThrow({ where: { id: before.id } });

    assert(names.join(',') === 'session', 'expected browser-deleted cookie to be removed');
    assert(
      after.updatedAt.getTime() > before.updatedAt.getTime(),
      'expected bundle updatedAt bump'
    );
  } finally {
    await cleanup(userId);
  }
});

test('cookie snapshot replacement removes disappeared realms for a profile', async () => {
  const userId = await createUser();
  try {
    await processCookiesUpload(
      userId,
      [
        cookie({
          name: 'session',
          value: 'amazon',
          domain: '.amazon.com',
          browserProfile: 'Default',
        }),
        cookie({
          name: 'session',
          value: 'github',
          domain: '.github.com',
          browserProfile: 'Default',
        }),
      ],
      'chrome'
    );

    await processCookiesUpload(
      userId,
      [
        cookie({
          name: 'session',
          value: 'github',
          domain: '.github.com',
          browserProfile: 'Default',
        }),
      ],
      'chrome'
    );

    const amazonCookies = await prisma.cookie.count({
      where: { userId, browserSource: 'chrome', browserProfile: 'Default', domain: '.amazon.com' },
    });
    const amazonBundles = await prisma.cookieBundle.count({
      where: {
        userId,
        browserSource: 'chrome',
        browserProfile: 'Default',
        authRealm: 'amazon.com',
      },
    });
    const githubBundles = await prisma.cookieBundle.count({
      where: {
        userId,
        browserSource: 'chrome',
        browserProfile: 'Default',
        authRealm: 'github.com',
      },
    });

    assert(amazonCookies === 0, 'expected disappeared-realm cookies to be removed');
    assert(amazonBundles === 0, 'expected disappeared-realm CookieBundle to be removed');
    assert(githubBundles === 1, 'expected still-present realm CookieBundle to remain');
  } finally {
    await cleanup(userId);
  }
});

test('explicit empty cookie snapshot removes browser cookies and bundles', async () => {
  const userId = await createUser();
  try {
    await processCookiesUpload(
      userId,
      [
        cookie({
          name: 'session',
          value: 'amazon',
          domain: '.amazon.com',
          browserProfile: 'Default',
        }),
        cookie({
          name: 'session',
          value: 'github',
          domain: '.github.com',
          browserProfile: 'Profile 1',
        }),
      ],
      'chrome'
    );

    await processCookiesUpload(userId, [], 'chrome');

    const cookieCount = await prisma.cookie.count({ where: { userId, browserSource: 'chrome' } });
    const bundleCount = await prisma.cookieBundle.count({
      where: { userId, browserSource: 'chrome' },
    });
    const integration = await prisma.integration.findFirstOrThrow({
      where: { userId, name: 'chrome' },
    });

    assert(cookieCount === 0, 'expected empty snapshot to remove all browser cookies');
    assert(bundleCount === 0, 'expected empty snapshot to remove all browser bundles');
    assert(
      (integration.config as { cookieCount?: number }).cookieCount === 0,
      'expected integration cookieCount to record empty snapshot'
    );
  } finally {
    await cleanup(userId);
  }
});

test('changed cookie content clears disabled CookieBundle state', async () => {
  const userId = await createUser();
  try {
    await processCookiesUpload(
      userId,
      [
        cookie({
          name: 'session',
          value: 'old-value',
          browserProfile: 'Default',
          creationUtc: 1000,
        }),
      ],
      'chrome'
    );
    await prisma.cookieBundle.update({
      where: {
        userId_authRealm_browserSource_browserProfile: {
          userId,
          authRealm: 'amazon.com',
          browserSource: 'chrome',
          browserProfile: 'Default',
        },
      },
      data: { disabledAt: new Date(), disabledReason: 'auth failed' },
    });

    await processCookiesUpload(
      userId,
      [
        cookie({
          name: 'session',
          value: 'new-value',
          browserProfile: 'Default',
          creationUtc: 1000,
        }),
      ],
      'chrome'
    );

    const bundle = await prisma.cookieBundle.findUniqueOrThrow({
      where: {
        userId_authRealm_browserSource_browserProfile: {
          userId,
          authRealm: 'amazon.com',
          browserSource: 'chrome',
          browserProfile: 'Default',
        },
      },
    });
    assert(bundle.disabledAt === null, 'expected changed cookie content to clear disabledAt');
    assert(
      bundle.disabledReason === null,
      'expected changed cookie content to clear disabledReason'
    );
  } finally {
    await cleanup(userId);
  }
});

test('password upload persists browserProfile and clears disabled state', async () => {
  const userId = await createUser();
  try {
    await processPasswordsUpload(userId, {
      passwords: [
        {
          origin: 'https://www.amazon.com',
          username: 'shopper@example.com',
          encryptedPassword: 'encrypted-old',
          dateLastUsed: 100,
          dateCreated: 50,
          browserSource: 'chrome',
          browserProfile: 'Profile 1',
        },
      ],
    });
    await prisma.browserPassword.update({
      where: {
        userId_origin_username_browserSource_browserProfile: {
          userId,
          origin: 'https://www.amazon.com',
          username: 'shopper@example.com',
          browserSource: 'chrome',
          browserProfile: 'Profile 1',
        },
      },
      data: { disabledAt: new Date(), disabledReason: 'bad password' },
    });

    await processPasswordsUpload(userId, {
      passwords: [
        {
          origin: 'https://www.amazon.com',
          username: 'shopper@example.com',
          encryptedPassword: 'encrypted-new',
          dateLastUsed: 200,
          dateCreated: 50,
          browserSource: 'chrome',
          browserProfile: 'Profile 1',
        },
      ],
    });

    const password = await prisma.browserPassword.findUniqueOrThrow({
      where: {
        userId_origin_username_browserSource_browserProfile: {
          userId,
          origin: 'https://www.amazon.com',
          username: 'shopper@example.com',
          browserSource: 'chrome',
          browserProfile: 'Profile 1',
        },
      },
    });
    assert(password.browserProfile === 'Profile 1', 'expected browserProfile to persist');
    assert(password.disabledAt === null, 'expected password sync to clear disabledAt');
    assert(password.disabledReason === null, 'expected password sync to clear disabledReason');
  } finally {
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
