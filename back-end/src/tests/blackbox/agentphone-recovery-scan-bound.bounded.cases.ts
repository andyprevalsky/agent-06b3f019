import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createAgentPhoneNumber, isAgentPhoneEmailFallbackSafe } from '../../providers/agentPhone';
import {
  AGENT_PHONE_PROVISIONING_LEASE_MS,
  claimAgentPhoneProvisioning,
} from '../../providers/agentPhoneProvisioningLease';
import { prisma } from '../../providers/database';

type ProviderHandler = (url: string, method: string, init?: RequestInit) => Response;

export type ScanBoundHarness = {
  withUser: (run: (userId: string) => Promise<void>) => Promise<void>;
  installProvider: (handler: ProviderHandler) => Array<{ url: string; method: string }>;
  markerForUser: (userId: string) => string;
};

const PHONE_ENV_SCRIPT = path.resolve(__dirname, '../../../scripts/blackbox-phone-env.sh');
// Newest agent on the production AgentPhone account on 2026-11-15; the list is
// newest-first and every agent predates a provisioning attempt made now.
const NEWEST_ACCOUNT_AGENT_MS = Date.parse('2026-10-28T03:10:18.000Z');

// The production account on 2026-11-15: 12,530 agents, newest-first, all older
// than any provisioning attempt that starts now.
function newestFirstAccountPage(offset: number, extra: Record<string, unknown>[] = []) {
  return Response.json({
    data: [
      ...extra,
      ...Array.from({ length: 100 - extra.length }, (_, index) => ({
        id: `prod-agent-${offset + index}`,
        description: '',
        createdAt: new Date(NEWEST_ACCOUNT_AGENT_MS - (offset + index) * 60_000).toISOString(),
        numbers: [],
      })),
    ],
    total: 12_530,
  });
}

async function testUncertainCreateOnOversizedAccountReconcilesWithoutAccountScan(
  h: ScanBoundHarness
) {
  await h.withUser(async (userId) => {
    await prisma.agentIdentity.create({ data: { userId, email: `${userId}@example.test` } });

    let agentCreates = 0;
    const calls = h.installProvider((url, method, init) => {
      if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
        return newestFirstAccountPage(Number(new URL(url).searchParams.get('offset')));
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/agents') {
        agentCreates += 1;
        if (agentCreates === 1) throw new DOMException('request outcome unknown', 'AbortError');
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return Response.json({ id: 'agt-after-uncertain', description: body.description });
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/numbers') {
        return Response.json({ id: 'num-after-uncertain', phoneNumber: '+19125550166' });
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });
    const listPages = () =>
      calls.filter((call) => call.url.includes('/agents?limit=100&offset=')).length;

    try {
      await createAgentPhoneNumber({ userId });
      assert.fail('expected an uncertain agent create to fail closed');
    } catch (error) {
      assert.doesNotMatch(
        String(error),
        /scan bound/,
        'an uncertain create must reconcile without walking the whole shared account'
      );
      assert.match(String(error), /AgentPhone agent creation is uncertain/);
      assert.equal(isAgentPhoneEmailFallbackSafe(error), false);
    }
    const firstAttemptPages = listPages();
    assert.ok(
      firstAttemptPages <= 2,
      `reconciliation must stop at agents older than the attempt, read ${firstAttemptPages} pages`
    );

    const provisioned = await createAgentPhoneNumber({ userId });
    assert.equal(provisioned?.agentId, 'agt-after-uncertain', 'the retry must provision');
    assert.equal(provisioned?.phoneNumber, '+19125550166');
    assert.ok(
      listPages() - firstAttemptPages <= 2,
      `recovery must stop at agents older than the uncertain attempt, read ${
        listPages() - firstAttemptPages
      } pages`
    );
    assert.equal(agentCreates, 2, 'the retry creates exactly one agent after an absence proof');
  });
}

async function testUncertainCreateThatLandedIsRecoveredFromNewestPage(h: ScanBoundHarness) {
  await h.withUser(async (userId) => {
    const marker = h.markerForUser(userId);
    await prisma.agentIdentity.create({ data: { userId, email: `${userId}@example.test` } });

    let landed: Record<string, unknown> | null = null;
    let agentCreates = 0;
    h.installProvider((url, method) => {
      if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
        const offset = Number(new URL(url).searchParams.get('offset'));
        return newestFirstAccountPage(offset, offset === 0 && landed ? [landed] : []);
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/agents') {
        agentCreates += 1;
        landed = {
          id: 'agt-landed',
          description: marker,
          createdAt: new Date().toISOString(),
          numbers: [{ id: 'num-landed', phoneNumber: '+19125550155', status: 'active' }],
        };
        throw new DOMException('provider response was lost', 'AbortError');
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    const provisioned = await createAgentPhoneNumber({ userId });
    assert.equal(provisioned?.agentId, 'agt-landed', 'a landed create must be recovered');
    assert.equal(provisioned?.numberId, 'num-landed');
    assert.equal(agentCreates, 1, 'a landed create must not be duplicated');
  });
}

async function testUnorderedAgentListFailsClosed(h: ScanBoundHarness) {
  await h.withUser(async (userId) => {
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phoneProvider: `agentphone:recovery:${Date.now()}:${randomUUID()}`,
      },
    });

    let agentCreates = 0;
    h.installProvider((url, method) => {
      if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
        return Response.json({
          data: [
            { id: 'agt-old', description: '', createdAt: '2026-01-01T00:00:00.000Z' },
            { id: 'agt-new', description: '', createdAt: new Date().toISOString() },
          ],
          total: 12_530,
        });
      }
      if (method === 'POST' && url === 'https://agentphone.test/v1/agents') {
        agentCreates += 1;
        throw new Error('must not create after an unordered agent list');
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });

    await assert.rejects(
      () => createAgentPhoneNumber({ userId }),
      /AgentPhone recovery scan failed: AgentPhone agent list is not newest-first/,
      'a list whose order cannot bound the scan must fail closed'
    );
    assert.equal(agentCreates, 0, 'must not create a successor without an absence proof');
  });
}

async function testIsolatedTestBackendRefusesProductionAccount(h: ScanBoundHarness) {
  await h.withUser(async (userId) => {
    await prisma.agentIdentity.create({ data: { userId, email: `${userId}@example.test` } });
    const calls = h.installProvider((url, method) => {
      if (method === 'POST' && url === 'https://api.agentphone.ai/v1/agents') {
        return Response.json({ id: 'agt-test-account' });
      }
      if (method === 'POST' && url === 'https://api.agentphone.ai/v1/numbers') {
        return Response.json({ id: 'num-test-account', phoneNumber: '+19125550144' });
      }
      throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
    });
    const keys = [
      'BLACKBOX_TEST_CAPTURE_OUTBOUND',
      'BLACKBOX_TEST_FAKE_AGENTPHONE',
      'AGENTPHONE_TEST_API_KEY',
    ] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    try {
      process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND = '1';
      delete process.env.BLACKBOX_TEST_FAKE_AGENTPHONE;
      delete process.env.AGENTPHONE_BASE_URL;
      process.env.AGENTPHONE_API_KEY = 'production-account-key';
      delete process.env.AGENTPHONE_TEST_API_KEY;

      await assert.rejects(
        () => createAgentPhoneNumber({ userId }),
        /export AGENTPHONE_TEST_API_KEY/,
        'an isolated test backend must refuse a non-test AgentPhone key'
      );
      assert.equal(calls.length, 0, 'the production account must receive no request');

      process.env.AGENTPHONE_API_KEY = 'dedicated-test-account-key';
      process.env.AGENTPHONE_TEST_API_KEY = 'dedicated-test-account-key';
      const provisioned = await createAgentPhoneNumber({ userId });
      assert.equal(provisioned?.numberId, 'num-test-account', 'the test account key provisions');
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

// Newest-first page: newer decoys, then this user's landed agent, then older agents.
function pageWithLandedAgent(offset: number, landed: Record<string, unknown>, landedMs: number) {
  if (offset > 0) return Response.json({ data: [], total: 3 });
  return Response.json({
    data: [
      { id: 'agt-newer', description: '', createdAt: new Date().toISOString() },
      landed,
      { id: 'agt-older', description: '', createdAt: new Date(landedMs - 3_600_000).toISOString() },
    ],
    total: 3,
  });
}

async function expectRecoveredWithoutCreate(h: ScanBoundHarness, userId: string, landedMs: number) {
  let agentCreates = 0;
  h.installProvider((url, method) => {
    if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
      return pageWithLandedAgent(
        Number(new URL(url).searchParams.get('offset')),
        {
          id: 'agt-landed-earlier',
          description: h.markerForUser(userId),
          createdAt: new Date(landedMs).toISOString(),
          numbers: [{ id: 'num-landed-earlier', phoneNumber: '+19125550133', status: 'active' }],
        },
        landedMs
      );
    }
    if (method === 'POST' && url === 'https://agentphone.test/v1/agents') {
      agentCreates += 1;
      return Response.json({ id: 'agt-duplicate' });
    }
    throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
  });
  const provisioned = await createAgentPhoneNumber({ userId });
  assert.equal(provisioned?.agentId, 'agt-landed-earlier', 'the earlier landed agent is reused');
  assert.equal(agentCreates, 0, 'a landed agent inside the chain bound must not be duplicated');
}

async function testCrashedRecoveryClaimKeepsChainLowerBound(h: ScanBoundHarness) {
  await h.withUser(async (userId) => {
    const chainStartMs = Date.now() - 3_600_000;
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phoneProvider: `agentphone:recovery:${Date.now()}:${randomUUID()}:since:${chainStartMs}`,
      },
    });
    // Attempt B claims the recovery and dies before releasing; its lease expires.
    const crashed = await claimAgentPhoneProvisioning(userId);
    assert.equal(crashed.kind, 'owner');
    const expiredStart = Date.now() - AGENT_PHONE_PROVISIONING_LEASE_MS - 1_000;
    await prisma.agentIdentity.update({
      where: { userId },
      data: {
        phoneProvider: (crashed.kind === 'owner' ? crashed.marker : '').replace(
          /^agentphone:provisioning:\d+:/,
          `agentphone:provisioning:${expiredStart}:`
        ),
      },
    });
    await expectRecoveredWithoutCreate(h, userId, chainStartMs + 60_000);
  });
}

async function testLegacyRecoveryMarkerIsBoundedByIdentityCreation(h: ScanBoundHarness) {
  await h.withUser(async (userId) => {
    const identityCreatedMs = Date.now() - 2 * 3_600_000;
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        createdAt: new Date(identityCreatedMs),
        // Pre-fix recovery markers carry only their release time.
        phoneProvider: `agentphone:recovery:${Date.now()}:${randomUUID()}`,
      },
    });
    await expectRecoveredWithoutCreate(h, userId, identityCreatedMs + 30 * 60_000);
  });
}

function phoneEnvAgentPhoneKey(env: Record<string, string>): string {
  const result = spawnSync(
    'bash',
    ['-c', 'source "$1"; printf %s "${AGENTPHONE_API_KEY-unset}"', 'phone-env', PHONE_ENV_SCRIPT],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', CLOUD_IPHONE_ALLOWED_PHONES: '+19990000000', ...env },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function testBlackboxRunnerEnvNeverInheritsProductionKey() {
  assert.equal(
    phoneEnvAgentPhoneKey({ AGENTPHONE_API_KEY: 'production-account-key' }),
    '',
    'isolated test stacks must blank the production AgentPhone key from back-end/.env'
  );
  assert.equal(
    phoneEnvAgentPhoneKey({
      AGENTPHONE_API_KEY: 'production-account-key',
      AGENTPHONE_TEST_API_KEY: 'dedicated-test-account-key',
    }),
    'dedicated-test-account-key',
    'a dedicated test account key is the only AgentPhone key a test stack may use'
  );
}

export function boundedReconcileCases(h: ScanBoundHarness) {
  return [
    [
      'uncertain agent create on a 12k-agent account reconciles without an account scan',
      () => testUncertainCreateOnOversizedAccountReconcilesWithoutAccountScan(h),
    ],
    [
      'uncertain agent create that landed is recovered from the newest page',
      () => testUncertainCreateThatLandedIsRecoveredFromNewestPage(h),
    ],
    ['unordered AgentPhone agent list fails closed', () => testUnorderedAgentListFailsClosed(h)],
    [
      'isolated test backend refuses the production AgentPhone account',
      () => testIsolatedTestBackendRefusesProductionAccount(h),
    ],
    [
      'blackbox runner env never inherits the production AgentPhone key',
      testBlackboxRunnerEnvNeverInheritsProductionKey,
    ],
    [
      'crashed recovery claim keeps the lease chain lower bound',
      () => testCrashedRecoveryClaimKeepsChainLowerBound(h),
    ],
    [
      'legacy recovery marker is bounded by identity creation',
      () => testLegacyRecoveryMarkerIsBoundedByIdentityCreation(h),
    ],
  ] as const;
}
