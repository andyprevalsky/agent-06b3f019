#!/usr/bin/env tsx
/* eslint-disable no-console */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { IntegrationStatus, IntegrationType, EmailProvider } from '@prisma/client';
import { prisma } from '../../providers/database';
import { getAuthOptions, markSteelSessionAuthFailed } from '../../domains/auth-options/service';

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

function unixMsDaysAgo(daysAgo: number) {
  return BigInt(Date.now() - daysAgo * DAY_MS);
}

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
  await prisma.passkeyCredential.deleteMany({ where: { userId } });
  await prisma.browserContext.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function createPasskey(params: {
  userId: string;
  authRealm: string;
  rpId?: string;
  disabled?: boolean;
}) {
  return prisma.passkeyCredential.create({
    data: {
      userId: params.userId,
      authRealm: params.authRealm,
      rpId: params.rpId ?? params.authRealm,
      credentialId: `cred-${randomUUID()}`,
      encryptedPrivateKey: 'enc-stub',
      userHandle: 'uh-stub',
      signCount: 0,
      disabledAt: params.disabled === true ? new Date() : null,
    },
  });
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

test('single realm scoping keeps Amazon and AWS auth separate', async () => {
  const userId = await createUser();
  try {
    await createBundleWithCookie({
      userId,
      authRealm: 'amazon.com',
      browserProfile: 'Default',
      cookieDomain: '.amazon.com',
      creationUtc: 1000n,
    });
    await createBundleWithCookie({
      userId,
      authRealm: 'aws.amazon.com',
      browserProfile: 'Work',
      cookieDomain: '.aws.amazon.com',
      creationUtc: 2000n,
    });
    await prisma.browserPassword.createMany({
      data: [
        {
          userId,
          origin: 'https://www.amazon.com',
          username: 'shopper@example.com',
          encryptedPassword: 'encrypted-shop',
          browserSource: 'chrome',
          dateLastUsed: chromiumMicrosDaysAgo(10),
        },
        {
          userId,
          origin: 'https://aws.amazon.com',
          username: 'aws@example.com',
          encryptedPassword: 'encrypted-aws',
          browserSource: 'chrome',
          dateLastUsed: chromiumMicrosDaysAgo(10),
        },
      ],
    });

    const options = await getAuthOptions(userId, 'https://www.amazon.com/ap/signin');

    assert(options.realm === 'amazon.com', 'expected amazon.com canonical realm');
    assert(options.cookie_bundles.length === 1, 'expected one amazon cookie bundle');
    assert(options.cookie_bundles[0].browserProfile === 'Default', 'expected shopper profile');
    assert(options.passwords.length === 1, 'expected one amazon password');
    assert(options.passwords[0].username === 'shopper@example.com', 'expected shopper password');
  } finally {
    await cleanup(userId);
  }
});

test('password refs stay unique for duplicate same-realm usernames without exposing secrets', async () => {
  const userId = await createUser();
  try {
    await prisma.browserPassword.createMany({
      data: [
        {
          userId,
          origin: 'https://www.amazon.com/ap/signin',
          username: 'shopper@example.com',
          encryptedPassword: 'encrypted-shop-1',
          browserSource: 'chrome',
          dateLastUsed: chromiumMicrosDaysAgo(10),
        },
        {
          userId,
          origin: 'https://amazon.com/login',
          username: 'shopper@example.com',
          encryptedPassword: 'encrypted-shop-2',
          browserSource: 'chrome',
          dateLastUsed: chromiumMicrosDaysAgo(20),
        },
      ],
    });

    const options = await getAuthOptions(userId, 'amazon.com');
    const refs = options.passwords.map((password) => password.ref);

    assert(options.passwords.length === 2, 'expected both same-realm passwords');
    assert(
      options.passwords.every((password) => password.origin.includes('amazon.com')),
      'expected origins'
    );
    assert(new Set(refs).size === 2, `expected unique refs, got ${refs.join(', ')}`);
    assert(
      options.passwords.every(
        (password) => password.ref === `pwd:shopper@example.com@amazon#${password.id}`
      ),
      `expected full-id-suffixed amazon refs, got ${refs.join(', ')}`
    );
    assert(
      !('encryptedPassword' in (options.passwords[0] as Record<string, unknown>)),
      'auth_options passwords must stay metadata-only'
    );
  } finally {
    await cleanup(userId);
  }
});

test('cookie bundles rank enabled first, then freshest cookie creation time', async () => {
  const userId = await createUser();
  try {
    await createBundleWithCookie({
      userId,
      authRealm: 'amazon.com',
      browserProfile: 'DisabledFresh',
      cookieDomain: '.amazon.com',
      creationUtc: 9000n,
      disabled: true,
    });
    await createBundleWithCookie({
      userId,
      authRealm: 'amazon.com',
      browserProfile: 'OlderEnabled',
      cookieDomain: '.amazon.com',
      creationUtc: 1000n,
    });
    await createBundleWithCookie({
      userId,
      authRealm: 'amazon.com',
      browserProfile: 'NewerEnabled',
      cookieDomain: '.amazon.com',
      creationUtc: 5000n,
    });

    const options = await getAuthOptions(userId, 'amazon.com');
    const profiles = options.cookie_bundles.map((bundle) => bundle.browserProfile);

    assert(profiles[0] === 'NewerEnabled', 'expected freshest enabled bundle first');
    assert(profiles[1] === 'OlderEnabled', 'expected older enabled bundle second');
    assert(profiles[2] === 'DisabledFresh', 'expected disabled bundle still returned last');
    assert(options.cookie_bundles[2].disabled === true, 'expected disabled marker');
  } finally {
    await cleanup(userId);
  }
});

test('steel session and password ranking prefer enabled credentials before disabled rows', async () => {
  const userId = await createUser();
  try {
    await prisma.steelSessionAuth.createMany({
      data: [
        {
          userId,
          contextId: `disabled-${randomUUID()}`,
          authRealm: 'amazon.com',
          authenticatedAt: new Date('2026-01-02T00:00:00Z'),
          disabledAt: new Date('2026-01-03T00:00:00Z'),
          disabledReason: 'previous auth failure',
        },
        {
          userId,
          contextId: `enabled-${randomUUID()}`,
          authRealm: 'amazon.com',
          authenticatedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    });
    await prisma.browserPassword.createMany({
      data: [
        {
          userId,
          origin: 'https://www.amazon.com',
          username: 'disabled@example.com',
          encryptedPassword: 'encrypted-disabled',
          browserSource: 'chrome',
          dateLastUsed: chromiumMicrosDaysAgo(5),
          disabledAt: new Date('2026-01-03T00:00:00Z'),
          disabledReason: 'previous auth failure',
        },
        {
          userId,
          origin: 'https://www.amazon.com',
          username: 'enabled@example.com',
          encryptedPassword: 'encrypted-enabled',
          browserSource: 'chrome',
          dateLastUsed: chromiumMicrosDaysAgo(30),
        },
      ],
    });

    const options = await getAuthOptions(userId, 'amazon.com');

    assert(options.steel_session?.contextId.startsWith('enabled-'), 'expected enabled Steel row');
    assert(options.steel_session.disabled === false, 'expected enabled Steel row first');
    assert(
      options.passwords[0].username === 'enabled@example.com',
      'expected enabled password first'
    );
    assert(options.passwords[1].disabled === true, 'expected disabled password still returned');
  } finally {
    await cleanup(userId);
  }
});

test('password freshness filter drops stale, unset, and sentinel rows', async () => {
  const userId = await createUser();
  try {
    await prisma.browserPassword.createMany({
      data: [
        {
          userId,
          origin: 'https://www.amazon.com/ap/signin',
          username: 'recent-chromium@example.com',
          encryptedPassword: 'encrypted-recent-chromium',
          browserSource: 'chrome',
          dateLastUsed: chromiumMicrosDaysAgo(10),
        },
        {
          userId,
          origin: 'https://amazon.com',
          username: 'recent-apple@example.com',
          encryptedPassword: 'encrypted-recent-apple',
          browserSource: 'apple_passwords',
          dateLastUsed: unixMsDaysAgo(20),
        },
        {
          userId,
          origin: 'https://www.amazon.com/ap/signin',
          username: 'old-chromium@example.com',
          encryptedPassword: 'encrypted-old-chromium',
          browserSource: 'chrome',
          dateLastUsed: chromiumMicrosDaysAgo(400),
        },
        {
          userId,
          origin: 'https://amazon.com',
          username: 'old-apple@example.com',
          encryptedPassword: 'encrypted-old-apple',
          browserSource: 'apple_passwords',
          dateLastUsed: unixMsDaysAgo(400),
        },
        {
          userId,
          origin: 'https://www.amazon.com/ap/signin',
          username: 'unset-null@example.com',
          encryptedPassword: 'encrypted-unset-null',
          browserSource: 'chrome',
          dateLastUsed: null,
        },
        {
          userId,
          origin: 'https://www.amazon.com/ap/signin',
          username: 'unset-zero@example.com',
          encryptedPassword: 'encrypted-unset-zero',
          browserSource: 'chrome',
          dateLastUsed: 0n,
        },
        {
          userId,
          origin: 'https://www.amazon.com/ap/signin',
          username: 'unset-sentinel@example.com',
          encryptedPassword: 'encrypted-unset-sentinel',
          browserSource: 'chrome',
          dateLastUsed: 86400000000n,
        },
      ],
    });

    const options = await getAuthOptions(userId, 'amazon.com');
    const usernames = options.passwords.map((password) => password.username);

    assert(usernames.length === 2, `expected two fresh passwords, got ${usernames.join(', ')}`);
    assert(usernames[0] === 'recent-chromium@example.com', 'expected freshest Chromium row first');
    assert(usernames[1] === 'recent-apple@example.com', 'expected recent Apple row second');
    assert(!usernames.includes('old-chromium@example.com'), 'expected old Chromium row filtered');
    assert(!usernames.includes('old-apple@example.com'), 'expected old Apple row filtered');
    assert(!usernames.includes('unset-null@example.com'), 'expected null last-used row filtered');
    assert(!usernames.includes('unset-zero@example.com'), 'expected zero last-used row filtered');
    assert(
      !usernames.includes('unset-sentinel@example.com'),
      'expected sentinel last-used row filtered'
    );
  } finally {
    await cleanup(userId);
  }
});

test('email OTP is not exposed from account labels', async () => {
  const userId = await createUser();
  try {
    await createBundleWithCookie({
      userId,
      authRealm: 'amazon.com',
      browserProfile: 'Default',
      cookieDomain: '.amazon.com',
      creationUtc: 1000n,
      accountLabel: 'shopper@example.com',
    });
    const integration = await prisma.integration.create({
      data: {
        userId,
        name: 'gmail',
        type: IntegrationType.TOOL_SETUP,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
      },
    });
    await prisma.emailIntegrationCredential.create({
      data: {
        userId,
        integrationId: integration.id,
        provider: EmailProvider.GMAIL,
        email: 'shopper@example.com',
        accessToken: 'access-token',
      },
    });
    await prisma.mintedAccount.create({
      data: {
        userId,
        authRealm: 'amazon.com',
        accountLabel: 'agent+amazon@example.com',
      },
    });

    const options = await getAuthOptions(userId, 'amazon.com');

    assert(options.email_otp.available === false, 'expected email OTP to stay unavailable');
    assert(
      options.email_otp.connected_emails.length === 0,
      'expected no OTP inboxes to be exposed'
    );
    assert(options.email_otp.match_for_site_account === null, 'expected no site-account match');
    assert(options.minted === null, 'expected minted fallback suppressed by user credentials');
  } finally {
    await cleanup(userId);
  }
});

test('email OTP hides unrelated connected inboxes and allows minted fallback', async () => {
  const userId = await createUser();
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  delete process.env.AGENTPHONE_API_KEY;
  try {
    const integration = await prisma.integration.create({
      data: {
        userId,
        name: 'gmail',
        type: IntegrationType.TOOL_SETUP,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
      },
    });
    await prisma.emailIntegrationCredential.create({
      data: {
        userId,
        integrationId: integration.id,
        provider: EmailProvider.GMAIL,
        email: 'unrelated@example.com',
        accessToken: 'access-token',
      },
    });
    const minted = await prisma.mintedAccount.create({
      data: {
        userId,
        authRealm: 'amazon.com',
        accountLabel: 'agent+amazon@example.com',
      },
    });

    const options = await getAuthOptions(userId, 'amazon.com');

    assert(
      options.email_otp.available === false,
      'expected unrelated inbox not to be OTP-available'
    );
    assert(
      options.email_otp.connected_emails.length === 0,
      'expected unrelated inbox not to be exposed'
    );
    assert(options.email_otp.match_for_site_account === null, 'expected no site-account match');
    assert(
      options.minted?.id === minted.id,
      'expected unrelated inbox not to suppress minted fallback'
    );
  } finally {
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    await cleanup(userId);
  }
});

test('minted account is returned only when no user credentials exist for realm', async () => {
  const userId = await createUser();
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  delete process.env.AGENTPHONE_API_KEY;
  try {
    const minted = await prisma.mintedAccount.create({
      data: {
        userId,
        authRealm: 'example.com',
        accountLabel: 'agent+example@example.com',
      },
    });

    const options = await getAuthOptions(userId, 'example.com');

    assert(options.cookie_bundles.length === 0, 'expected no cookie bundles');
    assert(options.passwords.length === 0, 'expected no passwords');
    assert(options.email_otp.available === false, 'expected no email OTP');
    assert(options.minted?.id === minted.id, 'expected minted fallback');
  } finally {
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    await cleanup(userId);
  }
});

test('enabled passkey is returned for its realm', async () => {
  const userId = await createUser();
  try {
    const pk = await createPasskey({ userId, authRealm: 'amazon.com', rpId: 'amazon.com' });
    const options = await getAuthOptions(userId, 'https://www.amazon.com/ap/signin');
    assert(options.passkeys.length === 1, 'expected one passkey');
    assert(options.passkeys[0].id === pk.id, 'expected matching passkey id');
    assert(options.passkeys[0].rpId === 'amazon.com', 'expected rpId amazon.com');
    assert(options.passkeys[0].credentialId === pk.credentialId, 'expected credentialId echoed');
    assert(options.passkeys[0].disabled === false, 'expected enabled passkey');
  } finally {
    await cleanup(userId);
  }
});

test('disabled passkey is surfaced but marked disabled', async () => {
  const userId = await createUser();
  try {
    await createPasskey({ userId, authRealm: 'amazon.com', disabled: true });
    const options = await getAuthOptions(userId, 'amazon.com');
    assert(options.passkeys.length === 1, 'expected the disabled passkey to be listed');
    assert(options.passkeys[0].disabled === true, 'expected passkey marked disabled');
  } finally {
    await cleanup(userId);
  }
});

test('an enabled passkey suppresses the minted fallback', async () => {
  const userId = await createUser();
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  delete process.env.AGENTPHONE_API_KEY;
  try {
    await createPasskey({ userId, authRealm: 'example.com' });
    const options = await getAuthOptions(userId, 'example.com');
    assert(options.passkeys.length === 1, 'expected the passkey to be present');
    assert(options.minted === null, 'expected minted to be suppressed when a passkey exists');
  } finally {
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    await cleanup(userId);
  }
});

test('markSteelSessionAuthFailed disables the session and resets its browser context', async () => {
  const userId = await createUser();
  try {
    const contextId = `ctx-${randomUUID()}`;
    await prisma.browserContext.create({ data: { userId, contextId } });
    const steel = await prisma.steelSessionAuth.create({
      data: { userId, contextId, authRealm: 'amazon.com' },
    });

    const result = await markSteelSessionAuthFailed(userId, steel.id, 'passkey + cookie rejected');
    assert(result !== null, 'expected a non-null result');
    assert(result?.authRealm === 'amazon.com', 'expected realm echoed');
    assert(result?.disabledReason === 'passkey + cookie rejected', 'expected reason echoed');

    const updatedSteel = await prisma.steelSessionAuth.findUniqueOrThrow({
      where: { id: steel.id },
    });
    assert(updatedSteel.disabledAt !== null, 'expected steel session disabled');
    const updatedContext = await prisma.browserContext.findUniqueOrThrow({ where: { userId } });
    assert(updatedContext.contextId === null, 'expected browser context reset on auth failure');

    // Unknown id resolves to null without throwing.
    const missing = await markSteelSessionAuthFailed(userId, randomUUID(), 'noop');
    assert(missing === null, 'expected null for unknown steel session id');
  } finally {
    await cleanup(userId);
  }
});

test('passwords last used over a year ago are excluded', async () => {
  const userId = await createUser();
  try {
    await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://www.amazon.com',
        username: 'stale@example.com',
        encryptedPassword: 'enc-stale',
        browserSource: 'chrome',
        dateLastUsed: chromiumMicrosDaysAgo(400),
      },
    });
    const options = await getAuthOptions(userId, 'amazon.com');
    assert(
      !options.passwords.some((p) => p.username === 'stale@example.com'),
      'expected stale password to be excluded'
    );
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
