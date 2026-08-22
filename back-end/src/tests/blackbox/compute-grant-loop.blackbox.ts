#!/usr/bin/env tsx
/**
 * The whole self-healing loop, end to end, against a real database.
 *
 * Everything else tests a layer. This tests the behaviour the feature actually
 * promises: an agent using a grant that has been revoked recovers by itself, the
 * replacement is durably persisted, and the user is never asked to do anything.
 *
 * The minter is stubbed (a real one drives a browser -- covered by
 * claude-cloud-remint.ts), but the classifier, orchestrator, transaction and
 * schema are all real.
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '../../providers/database';
import { ComputeGrantReminter, type GrantMinter } from '../../providers/computeGrantRemint';
import {
  createPrismaGrantStore,
  listConnections,
  upsertAccountConnection,
} from '../../domains/compute-grants/repo';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const RUN = randomUUID().slice(0, 8);
const USER = `loop-user-${RUN}`;
const ACCOUNT = 'acct-loop';
const REVOKED_BODY =
  '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}';

async function cleanup() {
  await prisma.computeGrant.deleteMany({ where: { userId: USER } });
  await prisma.computeAccountConnection.deleteMany({ where: { userId: USER } });
}

function minterYielding(tokens: string[]): { minter: GrantMinter; calls: () => number } {
  let i = 0;
  return {
    minter: {
      async mint() {
        const token = tokens[Math.min(i, tokens.length - 1)];
        i += 1;
        return { accessToken: token };
      },
    },
    calls: () => i,
  };
}

/** Simulates an agent call that fails once with `body`, then succeeds. */
async function agentRunWithRecovery(
  reminter: ComputeGrantReminter,
  store: ReturnType<typeof createPrismaGrantStore>,
  body: string,
  status = 401
): Promise<{ completed: boolean; usedToken?: string }> {
  const active = await store.getActiveGrant(USER, 'claude', ACCOUNT);
  assert(active !== null, 'precondition: an active grant must exist');

  // The provider rejects the grant mid-run.
  const outcome = await reminter.onCompletionFailure({
    userId: USER,
    provider: 'claude',
    accountId: ACCOUNT,
    grantId: active.grantId,
    status,
    body,
  });

  if (outcome.accessToken === undefined) return { completed: false };
  // The retry uses the replacement token and succeeds.
  return { completed: true, usedToken: outcome.accessToken };
}

test('setup: connect an account and mint an initial grant', async () => {
  await upsertAccountConnection({
    userId: USER,
    provider: 'claude',
    accountId: ACCOUNT,
    accountEmail: 'loop@example.com',
    session: `session-${RUN}`,
  });
  const store = createPrismaGrantStore('cloud');
  await store.saveGrant({
    userId: USER,
    provider: 'claude',
    accountId: ACCOUNT,
    accessToken: 'sk-ant-oat01-original',
  });
  const active = await store.getActiveGrant(USER, 'claude', ACCOUNT);
  assert(active?.accessToken === 'sk-ant-oat01-original', 'initial grant must be active');
});

test('THE LOOP: a revoked grant self-heals and the agent completes', async () => {
  const store = createPrismaGrantStore('cloud');
  const { minter, calls } = minterYielding(['sk-ant-oat01-healed']);
  const reminter = new ComputeGrantReminter({ store, minter });

  const run = await agentRunWithRecovery(reminter, store, REVOKED_BODY);
  assert(run.completed, 'the agent must complete despite the revocation');
  assert(run.usedToken === 'sk-ant-oat01-healed', `retried with ${run.usedToken}`);
  assert(calls() === 1, `expected exactly 1 mint, got ${calls()}`);
});

test('the replacement grant is durably persisted and active', async () => {
  const store = createPrismaGrantStore('cloud');
  const active = await store.getActiveGrant(USER, 'claude', ACCOUNT);
  assert(active?.accessToken === 'sk-ant-oat01-healed', 'the healed grant must be the active one');

  const activeCount = await prisma.computeGrant.count({
    where: { userId: USER, accountId: ACCOUNT, surface: 'cloud', status: 'active' },
  });
  assert(activeCount === 1, `exactly one active grant expected, got ${activeCount}`);
});

test('the revoked grant is recorded as dead WITH the provider reason', async () => {
  // This is the observability gap that let a token sit dead for 18 days.
  const dead = await prisma.computeGrant.findFirst({
    where: { userId: USER, status: 'dead' },
    orderBy: { diedAt: 'desc' },
  });
  assert(dead !== null, 'the revoked grant must be retained, not deleted');
  assert(
    dead.deadReason !== null && /revoked/i.test(dead.deadReason),
    `dead reason must capture the provider's verdict, got "${dead.deadReason}"`
  );
  assert(dead.diedAt !== null, 'death must be timestamped');
});

test('the account stays connected -- token churn is invisible to the user', async () => {
  const [conn] = await listConnections(USER, 'claude');
  assert(conn.state === 'connected', `user must not be prompted; state is "${conn.state}"`);
});

test('REGRESSION: a throttled agent does NOT burn a grant', async () => {
  const store = createPrismaGrantStore('cloud');
  const { minter, calls } = minterYielding(['sk-ant-oat01-should-not-happen']);
  const reminter = new ComputeGrantReminter({ store, minter });

  const before = await store.getActiveGrant(USER, 'claude', ACCOUNT);
  const outcome = await reminter.onCompletionFailure({
    userId: USER,
    provider: 'claude',
    accountId: ACCOUNT,
    grantId: before?.grantId,
    status: 429,
    body: '{"error":{"message":"weekly usage limit. Resets 2026-08-25"}}',
  });

  assert(outcome.status === 'not_revoked', `429 must not re-mint, got ${outcome.status}`);
  assert(calls() === 0, `429 minted ${calls()} grants; must be 0`);
  const after = await store.getActiveGrant(USER, 'claude', ACCOUNT);
  assert(after?.grantId === before?.grantId, 'the grant must be untouched by a throttle');
});

test('SCALE: 25 concurrent agents on one revoked grant produce ONE replacement', async () => {
  const store = createPrismaGrantStore('cloud');
  const { minter, calls } = minterYielding(['sk-ant-oat01-single']);
  const reminter = new ComputeGrantReminter({ store, minter });
  const active = await store.getActiveGrant(USER, 'claude', ACCOUNT);

  const outcomes = await Promise.all(
    Array.from({ length: 25 }, () =>
      reminter.onCompletionFailure({
        userId: USER,
        provider: 'claude',
        accountId: ACCOUNT,
        grantId: active?.grantId,
        status: 401,
        body: REVOKED_BODY,
      })
    )
  );

  assert(calls() === 1, `expected 1 mint for 25 failures, got ${calls()}`);
  assert(
    outcomes.every((o) => o.accessToken === 'sk-ant-oat01-single'),
    'every agent must receive the same replacement token'
  );
  const activeCount = await prisma.computeGrant.count({
    where: { userId: USER, accountId: ACCOUNT, surface: 'cloud', status: 'active' },
  });
  assert(activeCount === 1, `25 failures must not create ${activeCount} active grants`);
});

test('a dead CONNECTION flips the chip to needs_reconnect instead of looping', async () => {
  const store = createPrismaGrantStore('cloud');
  const reminter = new ComputeGrantReminter({
    store,
    minter: {
      async mint() {
        throw new Error('consent screen never rendered (session cookie expired)');
      },
    },
  });
  const active = await store.getActiveGrant(USER, 'claude', ACCOUNT);

  const outcome = await reminter.onCompletionFailure({
    userId: USER,
    provider: 'claude',
    accountId: ACCOUNT,
    grantId: active?.grantId,
    status: 401,
    body: REVOKED_BODY,
  });

  assert(outcome.status === 'needs_reconnect', `expected needs_reconnect, got ${outcome.status}`);
  const [conn] = await listConnections(USER, 'claude');
  assert(conn.state === 'needs_reconnect', 'the chip must prompt a reconnect');
});

test('re-linking the account heals it and minting resumes', async () => {
  // The documented user recovery: reconnect, and everything downstream resumes
  // without touching any grant.
  await upsertAccountConnection({
    userId: USER,
    provider: 'claude',
    accountId: ACCOUNT,
    session: `session-refreshed-${RUN}`,
  });
  const [conn] = await listConnections(USER, 'claude');
  assert(conn.state === 'connected', 'reconnecting must clear needs_reconnect');

  const store = createPrismaGrantStore('cloud');
  const { minter } = minterYielding(['sk-ant-oat01-after-reconnect']);
  const reminter = new ComputeGrantReminter({ store, minter });
  const outcome = await reminter.onCompletionFailure({
    userId: USER,
    provider: 'claude',
    accountId: ACCOUNT,
    status: 401,
    body: REVOKED_BODY,
  });
  assert(outcome.status === 'reminted', `minting must resume, got ${outcome.status}`);
});

test('minting works even when NO usable grant exists (death cannot block recovery)', async () => {
  // Kill every grant, then recover. Proves the loop depends on the connection,
  // never on a surviving token.
  await prisma.computeGrant.updateMany({
    where: { userId: USER },
    data: { status: 'dead', deadReason: 'test: all dead', diedAt: new Date() },
  });
  const store = createPrismaGrantStore('cloud');
  assert(
    (await store.getActiveGrant(USER, 'claude', ACCOUNT)) === null,
    'precondition: no active grant'
  );

  const { minter } = minterYielding(['sk-ant-oat01-from-nothing']);
  const reminter = new ComputeGrantReminter({ store, minter });
  const outcome = await reminter.onCompletionFailure({
    userId: USER,
    provider: 'claude',
    accountId: ACCOUNT,
    status: 401,
    body: REVOKED_BODY,
  });
  assert(
    outcome.status === 'reminted',
    `expected recovery from zero grants, got ${outcome.status}`
  );
  const active = await store.getActiveGrant(USER, 'claude', ACCOUNT);
  assert(active?.accessToken === 'sk-ant-oat01-from-nothing', 'a fresh grant must be active');
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\ncompute-grant self-healing loop (real database)\n');
  try {
    for (const t of tests) {
      try {
        await t.fn();
        passed += 1;
        console.log(`  PASS  ${t.name}`);
      } catch (err) {
        failures.push(t.name);
        console.log(`  FAIL  ${t.name}\n        ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(`\nRESULTS: ${passed}/${tests.length} passed`);
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1]?.includes('compute-grant-loop')) {
  void main();
}
