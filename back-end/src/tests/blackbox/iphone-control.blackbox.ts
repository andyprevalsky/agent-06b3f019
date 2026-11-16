#!/usr/bin/env tsx
import { phoneFixtureNumber } from './phone-fixture-users';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import { cases } from './iphone-control.cases';
import { Harness } from './iphone-control.fixtures';
import { recordedProofScreensVerify } from './iphone-control.setup-verifier-replay.cases';
import { BlackboxCaseResults, onlyKnownCaseAssertions } from '../helpers/blackboxCaseFailures';
import { quarantine } from '../helpers/quarantine';

/** Preserve the first production-server regression: the route must be mounted,
 * and queue denial must happen before default provider credentials are needed. */
async function mountedRoute(): Promise<void> {
  const baseUrl = process.env.TEST_BASE_URL;
  assert.ok(baseUrl, 'TEST_BASE_URL from the normal blackbox runner is required');
  const userId = `iphone-control-mounted-${randomUUID()}`;
  const request = async (path: string, body: unknown, method = 'POST') => {
    const response = await fetch(`${baseUrl}/api/iphone${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.BACKEND_API_KEY ?? '',
        'X-User-Id': userId,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      data: (await response.json()) as { lease?: { id: string; status: string } },
    };
  };
  await prisma.user.create({ data: { userId, phone: phoneFixtureNumber() } });
  try {
    assert.equal(
      (await request('/device', { providerDeviceId: `fixture-${randomUUID()}` }, 'PUT')).status,
      200
    );
    const agents = await Promise.all(
      [0, 1].map(() =>
        prisma.agent.create({
          data: { userId, goal: 'Synthetic phone operation admission', status: 'ACTIVE' },
        })
      )
    );
    assert.equal(
      (await request('/leases', { agentId: agents[0].id, requestKey: randomUUID() })).status,
      201
    );
    const queued = await request('/leases', { agentId: agents[1].id, requestKey: randomUUID() });
    assert.equal(queued.data.lease?.status, 'WAITING');
    const blocked = await request(`/leases/${queued.data.lease!.id}/operations`, {
      operationId: randomUUID(),
      operation: 'screen.text',
      args: {},
    });
    assert.equal(
      blocked.status,
      409,
      'Queued operation route must be mounted and fail before provider access'
    );
    assert.equal(await prisma.agentAttentionRequest.count({ where: { userId } }), 0);
  } finally {
    await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}
async function main(): Promise<void> {
  assert.ok(
    nonLocalDatabaseReason(process.env.DATABASE_URL) === null,
    'Explicit LOCAL DATABASE_URL required'
  );
  assert.ok(
    nonLocalDatabaseReason(process.env.DIRECT_URL) === null,
    'Explicit LOCAL DIRECT_URL required'
  );
  const results = new BlackboxCaseResults((passed, name, error) => {
    if (passed) {
      process.stdout.write(`PASS ${name}\n`);
    } else {
      process.stderr.write(
        `FAIL ${name}: ${error instanceof Error ? error.message : 'Assertion failed'}\n`
      );
    }
  });
  let harness: Harness | undefined;
  try {
    await results.run('main backend mounts queued operation admission', mountedRoute, mountedRoute);
    harness = await Harness.start();
    for (const [name, action] of cases) {
      harness.resetControls();
      const current = harness;
      const providerErrors = current.fixtureErrors.length;
      await results.run(
        name,
        action,
        () => action(current),
        () =>
          assert.equal(
            current.fixtureErrors.length,
            providerErrors,
            `Fake provider observed a wire/auth contract violation: ${current.fixtureErrors.slice(providerErrors).join('; ')}`
          )
      );
    }
  } finally {
    try {
      await harness?.close();
    } finally {
      await prisma.$disconnect();
    }
  }
  process.stdout.write(
    `Passed ${results.passed}/${results.passed + results.failed} iphone-control test(s).\n`
  );
  results.throwFailures();
}
const iphoneControlUnit = 'iphone-control';
quarantine(
  {
    since: '2026-11-16',
    repair: 'https://boxes.dev/thread/thr_936e5f263b93487ca3480f41deb517c8',
    error: 'RERUN: iphone-control failed (158451ms); rerunning once',
    evidence: '.context/browser-chip-repair/iphone-control-rca/RCA.md',
  },
  main,
  {
    unit: iphoneControlUnit,
    acceptsError: (error) =>
      onlyKnownCaseAssertions(error, [
        {
          name: 'live setup verifier: recorded proof screens and controls',
          action: recordedProofScreensVerify,
          operator: 'deepStrictEqual',
          expected: [],
          actual: [
            {
              name: 'Saved to iCloud: Passwords & Keychain On',
              expected: 'confirmed',
              status: 'unknown:gpt-5.6-luna-foundry',
            },
          ],
        },
      ]),
  }
)().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Phone route test failed'}\n`);
  process.exitCode = 1;
});
