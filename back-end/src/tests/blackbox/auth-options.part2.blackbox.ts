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

test('missing minted account provisions a real AgentMail inbox before returning fallback', async () => {
  const userId = await createUser('Rose Pilot');
  const previousApiKey = process.env.AGENTMAIL_API_KEY;
  const previousBaseUrl = process.env.AGENTMAIL_BASE_URL;
  const previousDomain = process.env.AGENTMAIL_DOMAIN;
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  let createdEmail = '';
  process.env.AGENTMAIL_API_KEY = 'test-agentmail-key';
  process.env.AGENTMAIL_BASE_URL = 'https://agentmail.test';
  process.env.AGENTMAIL_DOMAIN = 'agentmail.test';
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({
      url,
      method,
      body,
    });
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
    if (method === 'GET') {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as Response;
    }
    const email = `${String(body.username)}@${String(body.domain)}`;
    createdEmail = email;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        inbox_id: email,
        email,
        client_id: 'client-id',
      }),
      text: async () => '',
    } as Response;
  }) as typeof fetch;

  try {
    const options = await getAuthOptions(userId, 'https://m.uber.com/go');
    const persisted = await prisma.mintedAccount.findUniqueOrThrow({
      where: { userId_authRealm: { userId, authRealm: 'uber.com' } },
    });
    const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });

    const createCall = calls.find((call) => call.method === 'POST');
    assert(
      calls.some((call) => call.method === 'GET'),
      'expected AgentMail inbox lookup request'
    );
    assert(createCall !== undefined, 'expected AgentMail inbox creation request');
    assert(
      createCall.url === 'https://agentmail.test/v0/inboxes',
      'expected AgentMail create endpoint'
    );
    assert(createCall.body.domain === 'agentmail.test', 'expected configured AgentMail domain');
    assert(
      typeof createCall.body.client_id === 'string' && createCall.body.client_id !== '',
      'expected idempotent client_id'
    );
    assert(
      createCall.body.display_name === 'Rose Pilot',
      'expected user-created agent name as display name'
    );
    assert(
      typeof createCall.body.username === 'string' &&
        createCall.body.username.startsWith('rose.pilot.'),
      `expected minted username to start with agent name, got ${String(createCall.body.username)}`
    );
    assert(options.realm === 'uber.com', 'expected canonical Uber realm');
    assert(options.minted?.accountLabel === createdEmail, 'expected minted email');
    assert(options.minted?.email === createdEmail, 'expected minted email alias');
    assert(options.minted?.phone === '+19125550199', 'expected minted phone alias');
    assert(options.minted?.provider === 'agentmail', 'expected AgentMail provider marker');
    assert(options.minted?.phoneProvider === 'agentphone', 'expected AgentPhone provider marker');
    assert(persisted.accountLabel === createdEmail, 'expected persisted minted email');
    assert(identity.email === createdEmail, 'expected persisted agent identity');
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
    if (previousApiKey === undefined) delete process.env.AGENTMAIL_API_KEY;
    else process.env.AGENTMAIL_API_KEY = previousApiKey;
    if (previousBaseUrl === undefined) delete process.env.AGENTMAIL_BASE_URL;
    else process.env.AGENTMAIL_BASE_URL = previousBaseUrl;
    if (previousDomain === undefined) delete process.env.AGENTMAIL_DOMAIN;
    else process.env.AGENTMAIL_DOMAIN = previousDomain;
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    if (previousAgentPhoneBaseUrl === undefined) delete process.env.AGENTPHONE_BASE_URL;
    else process.env.AGENTPHONE_BASE_URL = previousAgentPhoneBaseUrl;
    await cleanup(userId);
  }
});

test('minted identity reuses one AgentMail inbox and one AgentPhone number per user', async () => {
  const userId = await createUser('Rose Pilot');
  const previousAgentMailApiKey = process.env.AGENTMAIL_API_KEY;
  const previousAgentMailBaseUrl = process.env.AGENTMAIL_BASE_URL;
  const previousAgentMailDomain = process.env.AGENTMAIL_DOMAIN;
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  process.env.AGENTMAIL_API_KEY = 'test-agentmail-key';
  process.env.AGENTMAIL_BASE_URL = 'https://agentmail.test';
  process.env.AGENTMAIL_DOMAIN = 'agentmail.test';
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';
  let createdEmail: string | null = null;

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
    if (method === 'GET') {
      if (
        createdEmail !== null &&
        (url.includes(createdEmail) || url.includes(encodeURIComponent(createdEmail)))
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            inbox_id: createdEmail,
            email: createdEmail,
            client_id: 'client-id',
          }),
          text: async () => '',
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as Response;
    }
    const email = `${String(body.username)}@${String(body.domain)}`;
    createdEmail = email;
    return {
      ok: true,
      status: 200,
      json: async () => ({ inbox_id: email, email, client_id: 'client-id' }),
      text: async () => '',
    } as Response;
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
    assert(mintedAccounts.length === 2, 'expected per-realm minted account rows');
    assert(
      mintedAccounts.every((account) => account.accountLabel === identity.email),
      'expected each realm row to point at shared identity email'
    );
    assert(
      calls.filter(
        (call) => call.url === 'https://agentmail.test/v0/inboxes' && call.method === 'POST'
      ).length === 1,
      'expected exactly one AgentMail inbox create'
    );
    assert(
      calls.filter((call) => call.url === 'https://agentphone.test/v1/numbers').length === 1,
      'expected exactly one AgentPhone number create'
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentMailApiKey === undefined) delete process.env.AGENTMAIL_API_KEY;
    else process.env.AGENTMAIL_API_KEY = previousAgentMailApiKey;
    if (previousAgentMailBaseUrl === undefined) delete process.env.AGENTMAIL_BASE_URL;
    else process.env.AGENTMAIL_BASE_URL = previousAgentMailBaseUrl;
    if (previousAgentMailDomain === undefined) delete process.env.AGENTMAIL_DOMAIN;
    else process.env.AGENTMAIL_DOMAIN = previousAgentMailDomain;
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    if (previousAgentPhoneBaseUrl === undefined) delete process.env.AGENTPHONE_BASE_URL;
    else process.env.AGENTPHONE_BASE_URL = previousAgentPhoneBaseUrl;
    await cleanup(userId);
  }
});

test('minted identity replaces deleted AgentMail inbox without reprovisioning AgentPhone', async () => {
  const userId = await createUser('Rose Pilot');
  const previousAgentMailApiKey = process.env.AGENTMAIL_API_KEY;
  const previousAgentMailBaseUrl = process.env.AGENTMAIL_BASE_URL;
  const previousAgentMailDomain = process.env.AGENTMAIL_DOMAIN;
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  process.env.AGENTMAIL_API_KEY = 'test-agentmail-key';
  process.env.AGENTMAIL_BASE_URL = 'https://agentmail.test';
  process.env.AGENTMAIL_DOMAIN = 'agentmail.test';
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';

  await prisma.agentIdentity.create({
    data: {
      userId,
      email: 'old.deleted@agentmail.test',
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
      accountLabel: 'old.deleted@agentmail.test',
    },
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, method, body });
    if (url.startsWith('https://agentphone.test/')) {
      throw new Error('AgentPhone should not be called when cached phone exists');
    }
    if (method === 'GET') {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as Response;
    }
    const email = `${String(body.username)}@${String(body.domain)}`;
    return {
      ok: true,
      status: 200,
      json: async () => ({ inbox_id: email, email, client_id: String(body.client_id) }),
      text: async () => '',
    } as Response;
  }) as typeof fetch;

  try {
    const options = await getAuthOptions(userId, 'https://uber.com');
    const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
    const minted = await prisma.mintedAccount.findUniqueOrThrow({
      where: { userId_authRealm: { userId, authRealm: 'uber.com' } },
    });

    assert(options.minted?.email !== 'old.deleted@agentmail.test', 'expected replacement email');
    assert(options.minted?.phone === '+19125550199', 'expected cached phone in auth options');
    assert(identity.email === options.minted?.email, 'expected identity email replaced');
    assert(identity.phone === '+19125550199', 'expected identity phone preserved');
    assert(
      identity.phoneProviderAgentId === 'agt-existing',
      'expected AgentPhone agent id preserved'
    );
    assert(
      identity.phoneProviderNumberId === 'num-existing',
      'expected AgentPhone number id preserved'
    );
    assert(
      minted.accountLabel === options.minted?.email,
      'expected minted row to point at new email'
    );
    assert(
      calls.some(
        (call) => call.method === 'GET' && call.url.includes('old.deleted%40agentmail.test')
      ),
      'expected lookup of stored AgentMail inbox'
    );
    assert(
      calls.filter(
        (call) => call.method === 'POST' && call.url === 'https://agentmail.test/v0/inboxes'
      ).length === 1,
      'expected exactly one replacement AgentMail inbox'
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentMailApiKey === undefined) delete process.env.AGENTMAIL_API_KEY;
    else process.env.AGENTMAIL_API_KEY = previousAgentMailApiKey;
    if (previousAgentMailBaseUrl === undefined) delete process.env.AGENTMAIL_BASE_URL;
    else process.env.AGENTMAIL_BASE_URL = previousAgentMailBaseUrl;
    if (previousAgentMailDomain === undefined) delete process.env.AGENTMAIL_DOMAIN;
    else process.env.AGENTMAIL_DOMAIN = previousAgentMailDomain;
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
