#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAgentPhoneNumber, isAgentPhoneEmailFallbackSafe } from '../../providers/agentPhone';
import { prisma } from '../../providers/database';
import { boundedReconcileCases } from './agentphone-recovery-scan-bound.bounded.cases';

const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
const previousAgentPhoneTestApiKey = process.env.AGENTPHONE_TEST_API_KEY;
const previousCaptureOutbound = process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND;
const previousFetch = globalThis.fetch;

function markerForUser(userId: string) {
  return `rose-provisioning:${createHash('sha256').update(userId).digest('hex')}`;
}

function restoreOptional(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnv() {
  globalThis.fetch = previousFetch;
  restoreOptional('AGENTPHONE_TEST_API_KEY', previousAgentPhoneTestApiKey);
  restoreOptional('BLACKBOX_TEST_CAPTURE_OUTBOUND', previousCaptureOutbound);
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

async function testMismatchedStoredNumberOwnerIsNotReused() {
  await withUser(async (userId) => {
    const existingAgentId = 'agt-owned';
    const foreignNumberId = 'num-foreign';
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phone: null,
        phoneProvider: `agentphone:recovery:${Date.now()}:${randomUUID()}`,
        phoneProviderAgentId: existingAgentId,
        phoneProviderNumberId: foreignNumberId,
      },
    });

    let numberCreates = 0;
    installProvider((url, method, init) => {
      if (method === 'GET' && url === `https://agentphone.test/v1/agents/${existingAgentId}`) {
        return Response.json({ id: existingAgentId, name: 'Rose', numbers: [] });
      }
      if (method === 'GET' && url === `https://agentphone.test/v1/numbers/${foreignNumberId}`) {
        return Response.json({
          id: foreignNumberId,
          phoneNumber: '+19125550999',
          status: 'active',
          agentId: 'agt-someone-else',
        });
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/numbers') {
        numberCreates += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        assert.equal(body.agentId, existingAgentId);
        return Response.json({ id: 'num-owned', phoneNumber: '+19125550111' });
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    const provisioned = await createAgentPhoneNumber({ userId });
    assert.equal(provisioned?.numberId, 'num-owned');
    assert.equal(provisioned?.phoneNumber, '+19125550111');
    assert.equal(numberCreates, 1, 'a number owned by another agent must not be reused');
  });
}

async function testStoredAgentLookup500DoesNotCreateSuccessor() {
  await withUser(async (userId) => {
    const existingAgentId = 'agt-transient';
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phone: null,
        phoneProvider: `agentphone:recovery:${Date.now()}:${randomUUID()}`,
        phoneProviderAgentId: existingAgentId,
        phoneProviderNumberId: 'num-transient',
      },
    });

    let agentCreates = 0;
    installProvider((url, method) => {
      if (method === 'GET' && url === `https://agentphone.test/v1/agents/${existingAgentId}`) {
        return new Response(JSON.stringify({ detail: 'upstream unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/agents') {
        agentCreates += 1;
        throw new Error('must not create a successor after an unconfirmed stored-agent lookup');
      }
      if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
        throw new Error(
          'must not scan the shared account after an unconfirmed stored-agent lookup'
        );
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    try {
      await createAgentPhoneNumber({ userId });
      assert.fail('expected stored-agent lookup uncertainty to fail closed');
    } catch (error) {
      assert.equal(
        isAgentPhoneEmailFallbackSafe(error),
        false,
        'an unconfirmed stored-agent GET must not allow email fallback or a successor create'
      );
      assert.match(String(error), /Stored AgentPhone agent lookup is uncertain/);
    }
    assert.equal(agentCreates, 0, 'a 500 on the stored agent must never POST /agents');
  });
}

async function testStoredNumberLookup500DoesNotCreateNumber() {
  await withUser(async (userId) => {
    const existingAgentId = 'agt-number-uncertain';
    const existingNumberId = 'num-uncertain';
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phone: null,
        phoneProvider: `agentphone:recovery:${Date.now()}:${randomUUID()}`,
        phoneProviderAgentId: existingAgentId,
        phoneProviderNumberId: existingNumberId,
      },
    });

    let numberCreates = 0;
    installProvider((url, method) => {
      if (method === 'GET' && url === `https://agentphone.test/v1/agents/${existingAgentId}`) {
        return Response.json({ id: existingAgentId, name: 'Rose', numbers: [] });
      }
      if (method === 'GET' && url === `https://agentphone.test/v1/numbers/${existingNumberId}`) {
        return new Response(JSON.stringify({ detail: 'upstream unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/numbers') {
        numberCreates += 1;
        throw new Error('must not create a number after an unconfirmed stored-number lookup');
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    try {
      await createAgentPhoneNumber({ userId });
      assert.fail('expected stored-number lookup uncertainty to fail closed');
    } catch (error) {
      assert.equal(
        isAgentPhoneEmailFallbackSafe(error),
        false,
        'an unconfirmed stored-number GET must not allow email fallback or a successor create'
      );
      assert.match(String(error), /Stored AgentPhone number lookup is uncertain/);
    }
    assert.equal(numberCreates, 0, 'a 500 on the stored number must never POST /numbers');
  });
}

async function testRecoveredAgentIsNotDeletedWhenNumberCreateFails() {
  await withUser(async (userId) => {
    const existingAgentId = 'agt-recovered';
    const releasedNumberId = 'num-released';
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phone: null,
        phoneProvider: `agentphone:recovery:${Date.now()}:${randomUUID()}`,
        phoneProviderAgentId: existingAgentId,
        phoneProviderNumberId: releasedNumberId,
      },
    });

    const calls = installProvider((url, method) => {
      if (method === 'GET' && url === `https://agentphone.test/v1/agents/${existingAgentId}`) {
        return Response.json({ id: existingAgentId, name: 'Rose', numbers: [] });
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
        return new Response(JSON.stringify({ detail: 'area code unavailable' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'DELETE' && url === `https://agentphone.test/v1/agents/${existingAgentId}`) {
        throw new Error('must not delete a recovered AgentPhone agent after number-create failure');
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    try {
      await createAgentPhoneNumber({ userId });
      assert.fail('expected recovered-agent number creation to fail closed');
    } catch (error) {
      assert.equal(
        isAgentPhoneEmailFallbackSafe(error),
        true,
        'a confirmed number-create failure on a recovered agent must allow email fallback'
      );
      assert.match(String(error), /failed for recovered provider agent/);
    }

    assert.equal(
      calls.filter((call) => call.method === 'DELETE').length,
      0,
      'number-create failure must not delete a recovered provider agent'
    );
    const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
    assert.equal(
      identity.phoneProviderAgentId,
      existingAgentId,
      'must keep the recovered agent id'
    );
  });
}

async function testRecoveryCreateRejectionAllowsEmailFallback() {
  await withUser(async (userId) => {
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phoneProvider: `agentphone:recovery:${Date.now()}:${randomUUID()}`,
      },
    });

    installProvider((url, method) => {
      if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
        return Response.json({ data: [], total: 0 });
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/agents') {
        return new Response(JSON.stringify({ detail: 'agent quota exceeded' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    try {
      await createAgentPhoneNumber({ userId });
      assert.fail('expected a confirmed agent-create rejection');
    } catch (error) {
      assert.equal(
        isAgentPhoneEmailFallbackSafe(error),
        true,
        'a definitive provider 4xx after a complete empty scan must allow email fallback'
      );
      assert.match(String(error), /AgentPhone rejected agent creation/);
    }

    const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
    assert.equal(
      identity.phoneProvider,
      null,
      'a confirmed rejection must clear the recovery marker so the next attempt is not stuck'
    );
  });
}

async function testConfirmedCleanupDoesNotForceRecoveryScan() {
  await withUser(async (userId) => {
    await prisma.agentIdentity.create({
      data: { userId, email: `${userId}@example.test` },
    });

    const liveAgents = new Set<string>();
    let agentCreates = 0;
    const calls = installProvider((url, method) => {
      if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
        return oversizedAccountPage(Number(new URL(url).searchParams.get('offset')));
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/agents') {
        agentCreates += 1;
        const id = `agt-cleaned-${agentCreates}`;
        liveAgents.add(id);
        return Response.json({ id });
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/numbers') {
        return Response.json(
          { detail: 'Number limit reached (50/50). Contact us for more.' },
          { status: 409 }
        );
      }
      const agentId = url.startsWith('https://agentphone.test/v1/agents/')
        ? url.slice('https://agentphone.test/v1/agents/'.length)
        : null;
      if (agentId !== null && method === 'GET') {
        return liveAgents.has(agentId)
          ? Response.json({ id: agentId, numbers: [] })
          : Response.json({ detail: 'not found' }, { status: 404 });
      }
      if (agentId !== null && method === 'DELETE') {
        liveAgents.delete(agentId);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    for (const attempt of [1, 2]) {
      try {
        await createAgentPhoneNumber({ userId });
        assert.fail(`attempt ${attempt}: expected number creation to be rejected`);
      } catch (error) {
        assert.match(String(error), /provider-agent cleanup was confirmed/, `attempt ${attempt}`);
        assert.equal(isAgentPhoneEmailFallbackSafe(error), true, `attempt ${attempt}`);
      }
      const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
      assert.equal(
        identity.phoneProviderAgentId,
        null,
        `attempt ${attempt}: a deleted provider agent id must not turn the next claim into recovery`
      );
    }
    assert.equal(agentCreates, 2, 'each attempt provisions afresh after a confirmed cleanup');
    assert.equal(liveAgents.size, 0, 'every created provider agent is deleted');
    assert.equal(
      calls.filter((call) => call.url.includes('/agents?limit=100&offset=')).length,
      0,
      'a confirmed cleanup must not force a shared-account recovery scan'
    );
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
    [
      'stored number owned by another AgentPhone agent is not reused',
      testMismatchedStoredNumberOwnerIsNotReused,
    ],
    [
      'recovery create 4xx after an empty scan allows email fallback',
      testRecoveryCreateRejectionAllowsEmailFallback,
    ],
    [
      'number-create failure does not delete a recovered AgentPhone agent',
      testRecoveredAgentIsNotDeletedWhenNumberCreateFails,
    ],
    [
      'stored-agent 500 does not create a successor AgentPhone agent',
      testStoredAgentLookup500DoesNotCreateSuccessor,
    ],
    [
      'stored-number 500 does not create a successor AgentPhone number',
      testStoredNumberLookup500DoesNotCreateNumber,
    ],
    [
      'confirmed provider-agent cleanup does not force a recovery scan on the next attempt',
      testConfirmedCleanupDoesNotForceRecoveryScan,
    ],
    ...boundedReconcileCases({ withUser, installProvider, markerForUser }),
  ] satisfies Array<readonly [string, () => Promise<void>]>) {
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
