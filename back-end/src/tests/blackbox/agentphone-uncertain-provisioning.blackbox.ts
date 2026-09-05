#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { getAuthOptions } from '../../domains/auth-options/service';
import { prisma } from '../../providers/database';

config();

async function main() {
  const userId = `agentphone-uncertain-${randomUUID()}`;
  const previousApiKey = process.env.PRIMITIVE_API_KEY;
  const previousDomain = process.env.PRIMITIVE_DOMAIN;
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
  const previousFetch = globalThis.fetch;

  await prisma.user.create({
    data: { userId, isAnonymous: true, systemName: 'Rose Uncertain' },
  });
  process.env.PRIMITIVE_API_KEY = 'test-primitive-key';
  process.env.PRIMITIVE_DOMAIN = 'mail.roselabs.test';
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === 'https://agentphone.test/v1/agents' && method === 'POST') {
      throw new DOMException('request outcome unknown', 'AbortError');
    }
    if (url === 'https://agentphone.test/v1/agents?limit=100&offset=0' && method === 'GET') {
      return new Response(JSON.stringify({ error: 'provider unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => getAuthOptions(userId, 'https://uber.com'),
      /AgentPhone.*uncertain/i,
      'unknown provider state must fail closed instead of persisting an email-only identity'
    );
    const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
    assert.equal(identity.phone, null, 'uncertain provider state must not persist a phantom phone');
    console.log('PASS uncertain AgentPhone provisioning fails closed');
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
    await prisma.mintedAccount.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
