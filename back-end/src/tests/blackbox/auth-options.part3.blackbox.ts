#!/usr/bin/env tsx
/* eslint-disable no-console */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { getAuthOptions } from '../../domains/auth-options/service';
import { fetchEmailsSince } from '../../domains/integrations/service';
import { createMintedInbox, mintedInboxUsername } from '../../providers/agentMail';

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

test('minted identity migrates to configured AgentMail domain without reprovisioning AgentPhone', async () => {
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
  process.env.AGENTMAIL_DOMAIN = 'mail.roselabs.ai';
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';

  await prisma.agentIdentity.create({
    data: {
      userId,
      email: 'rose.pilot.river07@agentmail.to',
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
      accountLabel: 'rose.pilot.river07@agentmail.to',
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
      if (!url.includes('rose.pilot.river07%40agentmail.to')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => '',
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          inbox_id: 'rose.pilot.river07@agentmail.to',
          email: 'rose.pilot.river07@agentmail.to',
          client_id: 'old-client-id',
        }),
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

    assert(
      options.minted?.email.endsWith('@mail.roselabs.ai'),
      `expected configured AgentMail domain, got ${options.minted?.email}`
    );
    assert(options.minted?.phone === '+19125550199', 'expected cached phone in auth options');
    assert(identity.email === options.minted?.email, 'expected identity email migrated');
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
      calls.every((call) => !call.url.includes('rose.pilot.river07%40agentmail.to')),
      'expected old-domain inbox lookup to be skipped'
    );
    assert(
      calls.filter(
        (call) => call.method === 'POST' && call.url === 'https://agentmail.test/v0/inboxes'
      ).length === 1,
      'expected exactly one replacement AgentMail inbox'
    );
    assert(
      calls.find((call) => call.method === 'POST')?.body.domain === 'mail.roselabs.ai',
      'expected replacement on configured AgentMail domain'
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

test('minted AgentMail username uses agent name plus keyword and two digits', async () => {
  const username = mintedInboxUsername('Rose Pilot', 'river', 7);
  const fallbackUsername = mintedInboxUsername(null, 'maple', 42);

  assert(username === 'rose.pilot.river07', `expected agent-name username, got ${username}`);
  assert(
    fallbackUsername === 'rose.maple42',
    `expected fallback agent-name username, got ${fallbackUsername}`
  );
  assert(!username.includes('navi'), 'username should not advertise agent infrastructure');
  assert(!username.includes('uber'), 'username should not advertise target site');
});

test('minted AgentMail inbox generation retries local-part collisions', async () => {
  const previousApiKey = process.env.AGENTMAIL_API_KEY;
  const previousBaseUrl = process.env.AGENTMAIL_BASE_URL;
  const previousDomain = process.env.AGENTMAIL_DOMAIN;
  const previousFetch = globalThis.fetch;
  const generated = ['rose.river07', 'rose.maple42'];
  const posts: Record<string, unknown>[] = [];
  process.env.AGENTMAIL_API_KEY = 'test-agentmail-key';
  process.env.AGENTMAIL_BASE_URL = 'https://agentmail.test';
  process.env.AGENTMAIL_DOMAIN = 'agentmail.test';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith(`/${encodeURIComponent('rose.river07@agentmail.test')}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          inbox_id: 'rose.river07@agentmail.test',
          email: 'rose.river07@agentmail.test',
        }),
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
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    posts.push(body);
    const email = `${String(body.username)}@${String(body.domain)}`;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        inbox_id: email,
        email,
        client_id: String(body.client_id),
      }),
      text: async () => '',
    } as Response;
  }) as typeof fetch;

  try {
    const inbox = await createMintedInbox({
      userId: 'user-1',
      authRealm: 'uber.com',
      agentName: 'Rose',
      usernameGenerator: () => generated.shift() ?? 'rose.cedar99',
    });

    assert(inbox?.email === 'rose.maple42@agentmail.test', 'expected second generated username');
    assert(posts.length === 1, 'expected one create call after collision lookup');
    assert(posts[0].username === 'rose.maple42', 'expected collided username to be skipped');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.AGENTMAIL_API_KEY;
    else process.env.AGENTMAIL_API_KEY = previousApiKey;
    if (previousBaseUrl === undefined) delete process.env.AGENTMAIL_BASE_URL;
    else process.env.AGENTMAIL_BASE_URL = previousBaseUrl;
    if (previousDomain === undefined) delete process.env.AGENTMAIL_DOMAIN;
    else process.env.AGENTMAIL_DOMAIN = previousDomain;
  }
});

test('existing user credentials suppress AgentMail minted inbox provisioning', async () => {
  const userId = await createUser();
  const previousApiKey = process.env.AGENTMAIL_API_KEY;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.AGENTMAIL_API_KEY = 'test-agentmail-key';
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('AgentMail should not be called when a password exists');
  }) as typeof fetch;

  try {
    await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://m.uber.com',
        username: 'rider@example.com',
        encryptedPassword: 'encrypted',
        browserSource: 'chrome',
        dateLastUsed: chromiumMicrosDaysAgo(2),
      },
    });

    const options = await getAuthOptions(userId, 'https://m.uber.com/go');
    const mintedCount = await prisma.mintedAccount.count({ where: { userId } });

    assert(options.passwords.length === 1, 'expected existing password option');
    assert(options.realm === 'uber.com', 'expected canonical Uber realm');
    assert(options.minted === null, 'expected minted fallback suppressed');
    assert(mintedCount === 0, 'expected no minted account row');
    assert(calls === 0, 'expected no AgentMail call');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.AGENTMAIL_API_KEY;
    else process.env.AGENTMAIL_API_KEY = previousApiKey;
    await cleanup(userId);
  }
});

test('email fetch includes AgentMail messages from minted inboxes', async () => {
  const userId = await createUser();
  const previousApiKey = process.env.AGENTMAIL_API_KEY;
  const previousBaseUrl = process.env.AGENTMAIL_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.AGENTMAIL_API_KEY = 'test-agentmail-key';
  process.env.AGENTMAIL_BASE_URL = 'https://agentmail.test';
  const since = new Date('2026-05-25T12:00:00Z');
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/messages?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          count: 1,
          messages: [{ message_id: 'msg-1', timestamp: '2026-05-25T12:01:00Z' }],
        }),
        text: async () => '',
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        message_id: 'msg-1',
        timestamp: '2026-05-25T12:01:00Z',
        from: 'Uber <noreply@uber.com>',
        to: ['navi-created@agentmail.test'],
        subject: 'Your Uber code',
        text: 'Your verification code is 123456.',
        html: '<p>Your verification code is 123456.</p>',
      }),
      text: async () => '',
    } as Response;
  }) as typeof fetch;

  try {
    await prisma.mintedAccount.create({
      data: {
        userId,
        authRealm: 'uber.com',
        accountLabel: 'navi-created@agentmail.test',
      },
    });

    const emails = await fetchEmailsSince(userId, since, 10);

    assert(calls.length === 2, 'expected AgentMail list and message fetch calls');
    assert(emails.length === 1, 'expected one AgentMail email');
    assert(
      emails[0].credentialEmail === 'navi-created@agentmail.test',
      'expected minted inbox source'
    );
    assert(emails[0].from === 'noreply@uber.com', 'expected parsed sender email');
    assert(emails[0].bodyText.includes('123456'), 'expected verification body text');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.AGENTMAIL_API_KEY;
    else process.env.AGENTMAIL_API_KEY = previousApiKey;
    if (previousBaseUrl === undefined) delete process.env.AGENTMAIL_BASE_URL;
    else process.env.AGENTMAIL_BASE_URL = previousBaseUrl;
    await cleanup(userId);
  }
});

test('AgentPhone OTP polling reads provider conversations without local webhook rows', async () => {
  const userId = await createUser();
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
  const previousFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';

  try {
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: 'rose.pilot.agent@agentmail.test',
        phone: '+18159823405',
        phoneProvider: 'agentphone',
        phoneProviderAgentId: 'agt-provider-1',
        phoneProviderNumberId: 'num-provider-1',
      },
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url === 'https://agentphone.test/v1/conversations?limit=100&offset=0') {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'conv-provider-1',
                phoneNumberId: 'num-provider-1',
                phoneNumber: '+18159823405',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'https://agentphone.test/v1/conversations/conv-provider-1/messages?limit=200') {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'msg-provider-1',
                body: '[Uber] Your code: 4122. Never share this code with anyone.',
                fromNumber: '+12053363503',
                toNumber: '+18159823405',
                direction: 'inbound',
                channel: 'sms',
                receivedAt: '2026-05-27T16:48:07.477Z',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected AgentPhone fetch: ${url}`);
    }) as typeof fetch;

    const { fetchAgentPhoneMessagesSince } = await import('../../domains/agent-phone/service');
    const messages = await fetchAgentPhoneMessagesSince(
      userId,
      new Date('2026-05-27T16:47:00Z'),
      10
    );

    assert(fetchCalls.length === 2, 'expected AgentPhone conversations and messages fetches');
    assert(messages.length === 1, 'expected one provider-polled AgentPhone message');
    assert(messages[0].body.includes('4122'), 'expected provider SMS body');
    assert(messages[0].credentialPhone === '+18159823405', 'expected credential phone');
  } finally {
    globalThis.fetch = previousFetch;
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
