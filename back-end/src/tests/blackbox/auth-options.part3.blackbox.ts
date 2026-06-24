#!/usr/bin/env tsx
/* eslint-disable no-console */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { getAuthOptions } from '../../domains/auth-options/service';
import { fetchEmailsSince } from '../../domains/integrations/service';
import {
  createMintedInbox,
  mintedInboxUsername,
  mintedInboxAddress,
} from '../../providers/primitive';

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

test('minted identity migrates to the configured primitive domain without reprovisioning AgentPhone', async () => {
  const userId = await createUser('Rose Pilot');
  const previousApiKey = process.env.PRIMITIVE_API_KEY;
  const previousDomain = process.env.PRIMITIVE_DOMAIN;
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  process.env.PRIMITIVE_API_KEY = 'test-primitive-key';
  process.env.PRIMITIVE_DOMAIN = 'mail.roselabs.ai';
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
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const options = await getAuthOptions(userId, 'https://uber.com');
    const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
    const minted = await prisma.mintedAccount.findUniqueOrThrow({
      where: { userId_authRealm: { userId, authRealm: 'uber.com' } },
    });

    assert(
      options.minted?.email.endsWith('@mail.roselabs.ai'),
      `expected configured primitive domain, got ${options.minted?.email}`
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

test('minted username uses agent name plus keyword and two digits', async () => {
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

test('minted primitive inbox is generated locally with a deterministic per-user suffix', async () => {
  const previousApiKey = process.env.PRIMITIVE_API_KEY;
  const previousDomain = process.env.PRIMITIVE_DOMAIN;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.PRIMITIVE_API_KEY = 'test-primitive-key';
  process.env.PRIMITIVE_DOMAIN = 'mail.roselabs.test';
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('primitive minting must not hit the network — addresses are virtual');
  }) as typeof fetch;

  try {
    const inbox = await createMintedInbox({
      userId: 'user-1',
      authRealm: 'uber.com',
      agentName: 'Rose',
      usernameGenerator: () => 'rose.river07',
    });

    assert(fetchCalls === 0, 'expected no network call when minting a primitive inbox');
    assert(
      inbox?.email === mintedInboxAddress('user-1', 'rose.river07'),
      'expected deterministic per-user address'
    );
    assert(inbox?.email.startsWith('rose.river07.'), 'expected username preserved with suffix');
    assert(inbox?.email.endsWith('@mail.roselabs.test'), 'expected configured primitive domain');

    // The per-user suffix is deterministic, so the same user reusing the same
    // generated username resolves to a stable address across realms.
    const again = await createMintedInbox({
      userId: 'user-1',
      authRealm: 'lyft.com',
      agentName: 'Rose',
      usernameGenerator: () => 'rose.river07',
    });
    assert(again?.email === inbox?.email, 'expected stable per-user address for same username');

    // A different user with an identical generated username must not collide,
    // otherwise two agents would share one inbox and read each other's mail.
    const other = await createMintedInbox({
      userId: 'user-2',
      authRealm: 'uber.com',
      agentName: 'Rose',
      usernameGenerator: () => 'rose.river07',
    });
    assert(other?.email !== inbox?.email, 'expected different users to get distinct addresses');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.PRIMITIVE_API_KEY;
    else process.env.PRIMITIVE_API_KEY = previousApiKey;
    if (previousDomain === undefined) delete process.env.PRIMITIVE_DOMAIN;
    else process.env.PRIMITIVE_DOMAIN = previousDomain;
  }
});

test('existing user credentials suppress primitive minted inbox provisioning', async () => {
  const userId = await createUser();
  const previousApiKey = process.env.PRIMITIVE_API_KEY;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.PRIMITIVE_API_KEY = 'test-primitive-key';
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('primitive should not be called when a password exists');
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
    assert(calls === 0, 'expected no primitive call');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.PRIMITIVE_API_KEY;
    else process.env.PRIMITIVE_API_KEY = previousApiKey;
    await cleanup(userId);
  }
});

test('email fetch includes primitive messages from minted inboxes', async () => {
  const userId = await createUser();
  const previousApiKey = process.env.PRIMITIVE_API_KEY;
  const previousBaseUrl = process.env.PRIMITIVE_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.PRIMITIVE_API_KEY = 'test-primitive-key';
  process.env.PRIMITIVE_BASE_URL = 'https://primitive.test';
  const since = new Date('2026-05-25T12:00:00Z');
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    // List endpoint: GET /emails?search=...&date_from=...
    if (url.includes('/emails?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [
            {
              id: 'em-1',
              recipient: 'navi-created@mail.roselabs.test',
              subject: 'Your Uber code',
              received_at: '2026-05-25T12:01:00Z',
            },
          ],
          meta: { total: 1, limit: 50, cursor: null },
        }),
        text: async () => '',
      } as Response;
    }
    // Detail endpoint: GET /emails/em-1
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          id: 'em-1',
          message_id: '<msg-1@uber.com>',
          recipient: 'navi-created@mail.roselabs.test',
          from_email: 'noreply@uber.com',
          from_header: 'Uber <noreply@uber.com>',
          subject: 'Your Uber code',
          body_text: 'Your verification code is 123456.',
          body_html: '<p>Your verification code is 123456.</p>',
          received_at: '2026-05-25T12:01:00Z',
        },
      }),
      text: async () => '',
    } as Response;
  }) as typeof fetch;

  try {
    await prisma.mintedAccount.create({
      data: {
        userId,
        authRealm: 'uber.com',
        accountLabel: 'navi-created@mail.roselabs.test',
      },
    });

    const emails = await fetchEmailsSince(userId, since, 10);

    assert(calls.length === 2, 'expected primitive list and detail fetch calls');
    assert(emails.length === 1, 'expected one primitive email');
    assert(
      emails[0].credentialEmail === 'navi-created@mail.roselabs.test',
      'expected minted inbox source'
    );
    assert(emails[0].from === 'noreply@uber.com', 'expected parsed sender email');
    assert(emails[0].bodyText.includes('123456'), 'expected verification body text');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.PRIMITIVE_API_KEY;
    else process.env.PRIMITIVE_API_KEY = previousApiKey;
    if (previousBaseUrl === undefined) delete process.env.PRIMITIVE_BASE_URL;
    else process.env.PRIMITIVE_BASE_URL = previousBaseUrl;
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
