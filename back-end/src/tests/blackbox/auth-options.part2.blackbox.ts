#!/usr/bin/env tsx
/* eslint-disable no-console */

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

test('disabled user credentials do not suppress minted fallback', async () => {
  const userId = await createUser();
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  delete process.env.AGENTPHONE_API_KEY;
  try {
    await createBundleWithCookie({
      userId,
      authRealm: 'instagram.com',
      browserProfile: 'DisabledProfile',
      cookieDomain: '.instagram.com',
      creationUtc: 1000n,
      disabled: true,
    });
    await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://instagram.com',
        username: 'disabled@example.com',
        encryptedPassword: 'encrypted-disabled',
        browserSource: 'chrome',
        dateLastUsed: chromiumMicrosDaysAgo(2),
        disabledAt: new Date('2026-01-03T00:00:00Z'),
        disabledReason: 'previous auth failure',
      },
    });
    const minted = await prisma.mintedAccount.create({
      data: {
        userId,
        authRealm: 'instagram.com',
        accountLabel: 'agent+instagram@example.com',
      },
    });

    const options = await getAuthOptions(userId, 'https://instagram.com/accounts/emailsignup/');

    assert(options.cookie_bundles.length === 1, 'expected disabled cookie bundle returned');
    assert(options.cookie_bundles[0].disabled === true, 'expected disabled cookie marker');
    assert(options.passwords.length === 1, 'expected disabled password returned');
    assert(options.passwords[0].disabled === true, 'expected disabled password marker');
    assert(
      options.minted?.id === minted.id,
      'expected disabled credentials not to suppress minted'
    );
    assert(
      options.minted?.email === 'agent+instagram@example.com',
      'expected minted identity from existing account'
    );
  } finally {
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    await cleanup(userId);
  }
});

test('missing minted account mints a primitive inbox before returning fallback', async () => {
  const userId = await createUser('Rose Pilot');
  const previousApiKey = process.env.PRIMITIVE_API_KEY;
  const previousDomain = process.env.PRIMITIVE_DOMAIN;
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  process.env.PRIMITIVE_API_KEY = 'test-primitive-key';
  process.env.PRIMITIVE_DOMAIN = 'mail.roselabs.test';
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, method, body });
    if (url === 'https://agentphone.test/v1/agents') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'agt-test-1' }),
        text: async () => '',
      } as Response;
    }
    if (url === 'https://agentphone.test/v1/numbers') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'num-test-1', phoneNumber: '+19125550199' }),
        text: async () => '',
      } as Response;
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const options = await getAuthOptions(userId, 'https://m.uber.com/go');
    const persisted = await prisma.mintedAccount.findUniqueOrThrow({
      where: { userId_authRealm: { userId, authRealm: 'uber.com' } },
    });
    const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
    const mintedEmail = options.minted?.email;

    // Primitive mints addresses locally under the catch-all domain — there is no
    // inbox-provisioning API call, only AgentPhone provisioning hits the network.
    assert(
      calls.every((call) => call.url.startsWith('https://agentphone.test/')),
      'expected no primitive inbox HTTP calls — addresses are minted locally'
    );
    assert(options.realm === 'uber.com', 'expected canonical Uber realm');
    assert(
      typeof mintedEmail === 'string' && mintedEmail.startsWith('rose.pilot.'),
      `expected minted address to start with agent name, got ${String(mintedEmail)}`
    );
    assert(
      mintedEmail.endsWith('@mail.roselabs.test'),
      'expected minted email on the configured primitive domain'
    );
    assert(options.minted?.accountLabel === mintedEmail, 'expected minted email');
    assert(identity.email === mintedEmail, 'expected persisted agent identity');
    assert(options.minted?.phone === '+19125550199', 'expected minted phone alias');
    assert(options.minted?.provider === 'primitive', 'expected primitive provider marker');
    assert(options.minted?.phoneProvider === 'agentphone', 'expected AgentPhone provider marker');
    assert(persisted.accountLabel === mintedEmail, 'expected persisted minted email');
    assert(identity.phone === '+19125550199', 'expected persisted agent phone');
    assert(identity.phoneProvider === 'agentphone', 'expected persisted phone provider');
    assert(
      identity.phoneProviderAgentId === 'agt-test-1',
      'expected persisted AgentPhone agent id'
    );
    assert(
      identity.phoneProviderNumberId === 'num-test-1',
      'expected persisted AgentPhone number id'
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.PRIMITIVE_API_KEY;
    else process.env.PRIMITIVE_API_KEY = previousApiKey;
    if (previousDomain === undefined) delete process.env.PRIMITIVE_DOMAIN;
    else process.env.PRIMITIVE_DOMAIN = previousDomain;
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    if (previousAgentPhoneBaseUrl === undefined) delete process.env.AGENTPHONE_BASE_URL;
    else process.env.AGENTPHONE_BASE_URL = previousAgentPhoneBaseUrl;
    await cleanup(userId);
  }
});

test('minted identity reuses one primitive inbox and one AgentPhone number per user', async () => {
  const userId = await createUser('Rose Pilot');
  const previousApiKey = process.env.PRIMITIVE_API_KEY;
  const previousDomain = process.env.PRIMITIVE_DOMAIN;
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  process.env.PRIMITIVE_API_KEY = 'test-primitive-key';
  process.env.PRIMITIVE_DOMAIN = 'mail.roselabs.test';
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, method, body });
    if (url === 'https://agentphone.test/v1/agents') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'agt-one-user' }),
        text: async () => '',
      } as Response;
    }
    if (url === 'https://agentphone.test/v1/numbers') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'num-one-user', phoneNumber: '+19125550199' }),
        text: async () => '',
      } as Response;
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const uberOptions = await getAuthOptions(userId, 'https://uber.com');
    const lyftOptions = await getAuthOptions(userId, 'https://lyft.com');
    const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
    const mintedAccounts = await prisma.mintedAccount.findMany({
      where: { userId },
      orderBy: { authRealm: 'asc' },
    });

    assert(uberOptions.minted?.email === identity.email, 'expected Uber to use shared email');
    assert(lyftOptions.minted?.email === identity.email, 'expected Lyft to use shared email');
    assert(uberOptions.minted?.phone === identity.phone, 'expected Uber to use shared phone');
    assert(lyftOptions.minted?.phone === identity.phone, 'expected Lyft to use shared phone');
    assert(
      identity.email.endsWith('@mail.roselabs.test'),
      'expected shared email on primitive domain'
    );
    assert(mintedAccounts.length === 2, 'expected per-realm minted account rows');
    assert(
      mintedAccounts.every((account) => account.accountLabel === identity.email),
      'expected each realm row to point at shared identity email'
    );
    // No inbox-provisioning API exists for primitive; the shared address is reused
    // purely from the persisted identity, so the only network call is AgentPhone.
    assert(
      calls.every((call) => call.url.startsWith('https://agentphone.test/')),
      'expected no primitive inbox HTTP calls'
    );
    assert(
      calls.filter((call) => call.url === 'https://agentphone.test/v1/numbers').length === 1,
      'expected exactly one AgentPhone number create'
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.PRIMITIVE_API_KEY;
    else process.env.PRIMITIVE_API_KEY = previousApiKey;
    if (previousDomain === undefined) delete process.env.PRIMITIVE_DOMAIN;
    else process.env.PRIMITIVE_DOMAIN = previousDomain;
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    if (previousAgentPhoneBaseUrl === undefined) delete process.env.AGENTPHONE_BASE_URL;
    else process.env.AGENTPHONE_BASE_URL = previousAgentPhoneBaseUrl;
    await cleanup(userId);
  }
});

test('minted identity migrates a legacy-domain inbox onto primitive without reprovisioning AgentPhone', async () => {
  const userId = await createUser('Rose Pilot');
  const previousApiKey = process.env.PRIMITIVE_API_KEY;
  const previousDomain = process.env.PRIMITIVE_DOMAIN;
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  process.env.PRIMITIVE_API_KEY = 'test-primitive-key';
  process.env.PRIMITIVE_DOMAIN = 'mail.roselabs.test';
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';

  // Pre-existing identity is on the legacy AgentMail domain — the migration must
  // re-mint it onto the primitive domain while preserving the phone number.
  await prisma.agentIdentity.create({
    data: {
      userId,
      email: 'old.legacy@agentmail.to',
      phone: '+19125550199',
      phoneProvider: 'agentphone',
      phoneProviderAgentId: 'agt-existing',
      phoneProviderNumberId: 'num-existing',
    },
  });
  await prisma.mintedAccount.create({
    data: {
      userId,
      authRealm: 'uber.com',
      accountLabel: 'old.legacy@agentmail.to',
    },
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, method, body });
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const options = await getAuthOptions(userId, 'https://uber.com');
    const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
    const minted = await prisma.mintedAccount.findUniqueOrThrow({
      where: { userId_authRealm: { userId, authRealm: 'uber.com' } },
    });
    const mintedEmail = options.minted?.email;

    assert(mintedEmail !== 'old.legacy@agentmail.to', 'expected replacement email');
    assert(
      typeof mintedEmail === 'string' && mintedEmail.endsWith('@mail.roselabs.test'),
      'expected replacement email on primitive domain'
    );
    assert(mintedEmail.startsWith('rose.pilot.'), 'expected replacement to keep agent-name prefix');
    assert(options.minted?.phone === '+19125550199', 'expected cached phone in auth options');
    assert(identity.email === mintedEmail, 'expected identity email replaced');
    assert(identity.phone === '+19125550199', 'expected identity phone preserved');
    assert(
      identity.phoneProviderAgentId === 'agt-existing',
      'expected AgentPhone agent id preserved'
    );
    assert(
      identity.phoneProviderNumberId === 'num-existing',
      'expected AgentPhone number id preserved'
    );
    assert(minted.accountLabel === mintedEmail, 'expected minted row to point at new email');
    // Re-minting is local and the cached phone short-circuits AgentPhone, so nothing
    // should hit the network at all.
    assert(calls.length === 0, 'expected no network calls during local re-mint');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.PRIMITIVE_API_KEY;
    else process.env.PRIMITIVE_API_KEY = previousApiKey;
    if (previousDomain === undefined) delete process.env.PRIMITIVE_DOMAIN;
    else process.env.PRIMITIVE_DOMAIN = previousDomain;
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    if (previousAgentPhoneBaseUrl === undefined) delete process.env.AGENTPHONE_BASE_URL;
    else process.env.AGENTPHONE_BASE_URL = previousAgentPhoneBaseUrl;
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
