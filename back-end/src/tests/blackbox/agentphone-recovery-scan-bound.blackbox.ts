#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAgentPhoneNumber } from '../../providers/agentPhone';
import { prisma } from '../../providers/database';

const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
const previousFetch = globalThis.fetch;

function markerForUser(userId: string) {
  return `rose-provisioning:${createHash('sha256').update(userId).digest('hex')}`;
}

function restoreEnv() {
  globalThis.fetch = previousFetch;
  if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
  else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
  if (previousAgentPhoneBaseUrl === undefined) delete process.env.AGENTPHONE_BASE_URL;
  else process.env.AGENTPHONE_BASE_URL = previousAgentPhoneBaseUrl;
}

async function withUser<T>(run: (userId: string) => Promise<T>): Promise<T> {
  const userId = `agentphone-scan-bound-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    return await run(userId);
  } finally {
    await prisma.user.deleteMany({ where: { userId } });
  }
}

function installProvider(handler: (url: string, method: string, init?: RequestInit) => Response) {
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    return handler(url, method, init);
  }) as typeof fetch;
  return calls;
}

function oversizedAccountPage(offset: number) {
  return new Response(
    JSON.stringify({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `decoy-${offset + index}`,
        description: `other-${offset + index}`,
        numbers: [],
      })),
      total: 12_529,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

async function testStoredIdsSkipOversizedAccountScan() {
  await withUser(async (userId) => {
    const existingAgentId = 'cmpn4bii60355wxj97vp6i3t8';
    const releasedNumberId = 'cmpn4bk7i0357wxj9llzfzd77';
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phone: null,
        phoneProvider: `agentphone:recovery:${Date.now()}:d1cbc0be-c87c-4c95-8f34-c478a474b387`,
        phoneProviderAgentId: existingAgentId,
        phoneProviderNumberId: releasedNumberId,
      },
    });

    let numberCreates = 0;
    const calls = installProvider((url, method, init) => {
      if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
        const offset = Number(new URL(url).searchParams.get('offset'));
        return oversizedAccountPage(offset);
      }
      if (method === 'GET' && url === `https://agentphone.test/v1/agents/${existingAgentId}`) {
        return Response.json({
          id: existingAgentId,
          name: 'Rose',
          description: null,
          numbers: [],
        });
      }
      if (method === 'GET' && url === `https://agentphone.test/v1/numbers/${releasedNumberId}`) {
        return Response.json({
          id: releasedNumberId,
          phoneNumber: '+19129142430',
          status: 'released',
          agentId: existingAgentId,
        });
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/numbers') {
        numberCreates += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        assert.equal(
          body.agentId,
          existingAgentId,
          'must attach the new number to the stored agent'
        );
        return Response.json({ id: 'num-reattached', phoneNumber: '+19125550123' });
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    const provisioned = await createAgentPhoneNumber({ userId });
    const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
    const listCalls = calls.filter((call) => call.url.includes('/agents?limit=100&offset='));

    assert.equal(provisioned?.agentId, existingAgentId, 'must reuse the stored provider agent');
    assert.equal(provisioned?.numberId, 'num-reattached', 'must persist the newly created number');
    assert.equal(provisioned?.phoneNumber, '+19125550123', 'must return the active phone number');
    assert.equal(numberCreates, 1, 'must create exactly one replacement number');
    assert.equal(listCalls.length, 0, 'stored provider IDs must not scan the shared account');
    assert.equal(identity.phone, '+19125550123', 'must persist the recovered phone');
    assert.equal(identity.phoneProviderAgentId, existingAgentId, 'must keep the stored agent id');
    assert.equal(
      identity.phoneProviderNumberId,
      'num-reattached',
      'must persist the new number id'
    );
  });
}

async function testUniqueMarkerHitDoesNotRequireCompletenessScan() {
  await withUser(async (userId) => {
    const marker = markerForUser(userId);
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phoneProvider: `agentphone:recovery:${Date.now()}:${randomUUID()}`,
      },
    });

    const calls = installProvider((url, method) => {
      if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
        const offset = Number(new URL(url).searchParams.get('offset'));
        if (offset === 100) {
          return Response.json({
            data: [
              {
                id: 'agt-marked',
                description: marker,
                numbers: [{ id: 'num-marked', phoneNumber: '+19125550188', status: 'active' }],
              },
              ...Array.from({ length: 99 }, (_, index) => ({
                id: `decoy-${offset + index}`,
                description: `other-${offset + index}`,
              })),
            ],
            total: 12_529,
          });
        }
        return oversizedAccountPage(offset);
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    const provisioned = await createAgentPhoneNumber({ userId });
    const listCalls = calls.filter((call) => call.url.includes('/agents?limit=100&offset='));

    assert.equal(provisioned?.agentId, 'agt-marked', 'unique marker hit must recover the agent');
    assert.equal(
      provisioned?.phoneNumber,
      '+19125550188',
      'unique marker hit must recover the number'
    );
    assert.ok(
      listCalls.length < 20,
      `unique marker hit must not walk the 10k-agent bound, got ${listCalls.length} pages`
    );
  });
}

async function testIncompleteScanWithoutHitStillFailsClosed() {
  await withUser(async (userId) => {
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phoneProvider: `agentphone:recovery:${Date.now()}:${randomUUID()}`,
      },
    });

    let agentCreates = 0;
    installProvider((url, method) => {
      if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
        const offset = Number(new URL(url).searchParams.get('offset'));
        return oversizedAccountPage(offset);
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/agents') {
        agentCreates += 1;
        throw new Error('must not create after an incomplete shared-account scan');
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    await assert.rejects(
      () => createAgentPhoneNumber({ userId }),
      /AgentPhone recovery scan failed: AgentPhone reconciliation exceeded the 10000-agent scan bound/,
      'an incomplete shared-account scan must still fail closed when no keyed handle exists'
    );
    assert.equal(agentCreates, 0, 'must not create a successor agent without an absence proof');
  });
}

async function main(): Promise<void> {
  const results: Array<{ name: string; error?: string }> = [];
  for (const [name, fn] of [
    [
      'stored provider IDs recover without scanning an oversized AgentPhone account',
      testStoredIdsSkipOversizedAccountScan,
    ],
    [
      'unique marker hit does not require a complete account scan',
      testUniqueMarkerHitDoesNotRequireCompletenessScan,
    ],
    [
      'incomplete oversized scan without a keyed handle still fails closed',
      testIncompleteScanWithoutHitStillFailsClosed,
    ],
  ] as const) {
    try {
      await fn();
      results.push({ name });
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      results.push({
        name,
        error: error instanceof Error ? error.stack || error.message : String(error),
      });
      process.stderr.write(`FAIL ${name}\n`);
      process.stderr.write(
        `${error instanceof Error ? error.stack || error.message : String(error)}\n`
      );
    }
  }

  const failed = results.filter((result) => result.error);
  process.stdout.write(
    `\nResults: ${results.length - failed.length} passed, ${failed.length} failed\n`
  );
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    restoreEnv();
    await prisma.$disconnect();
  });
