#!/usr/bin/env tsx
/**
 * Compute-grant persistence, against a REAL database.
 *
 * The orchestration tests use an in-memory store, so this is where the actual
 * schema decisions get exercised: multi-account support, the retire-then-insert
 * transaction, cascade behaviour, and the guarantee that removing one connected
 * account cannot disturb another.
 *
 * Runs against whatever DATABASE_URL points at, and cleans up everything it
 * creates.
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '../../providers/database';
import {
  createPrismaGrantStore,
  encryptGrantMaterial,
  getConnectionSession,
  listConnections,
  removeConnection,
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
const userA = `ct-user-a-${RUN}`;
const userB = `ct-user-b-${RUN}`;
const createdUsers = [userA, userB];

async function cleanup() {
  await prisma.computeGrant.deleteMany({ where: { userId: { in: createdUsers } } });
  await prisma.computeAccountConnection.deleteMany({ where: { userId: { in: createdUsers } } });
}

test('THE FIX: one user can connect MULTIPLE accounts per provider', async () => {
  // The old shape was @@unique([userId, name]) on Integration -- literally one
  // Claude and one Codex account per user. This is the regression guard.
  await upsertAccountConnection({
    userId: userA,
    provider: 'claude',
    accountId: 'acct-1',
    accountEmail: 'one@example.com',
  });
  await upsertAccountConnection({
    userId: userA,
    provider: 'claude',
    accountId: 'acct-2',
    accountEmail: 'two@example.com',
  });
  await upsertAccountConnection({
    userId: userA,
    provider: 'codex',
    accountId: 'gpt-1',
    accountEmail: 'three@example.com',
  });

  const all = await listConnections(userA);
  assert(all.length === 3, `expected 3 connections, got ${all.length}`);
  const claude = all.filter((c) => c.provider === 'claude');
  assert(claude.length === 2, `expected 2 claude accounts, got ${claude.length}`);
});

test('re-linking the same account updates rather than duplicating', async () => {
  await upsertAccountConnection({
    userId: userA,
    provider: 'claude',
    accountId: 'acct-1',
    accountEmail: 'renamed@example.com',
  });
  const claude = (await listConnections(userA, 'claude')).filter((c) => c.accountId === 'acct-1');
  assert(claude.length === 1, `re-link must not duplicate, got ${claude.length}`);
  assert(claude[0].accountEmail === 'renamed@example.com', 'email should update');
});

test('account session round-trips through encryption and is never stored raw', async () => {
  const secret = `session-cookie-${RUN}`;
  await upsertAccountConnection({
    userId: userA,
    provider: 'claude',
    accountId: 'acct-1',
    session: secret,
  });
  const row = await prisma.computeAccountConnection.findFirst({
    where: { userId: userA, provider: 'claude', accountId: 'acct-1' },
  });
  assert(row !== null && row.encryptedSession !== null, 'session must be persisted');
  assert(
    !row.encryptedSession.includes(secret),
    'SECURITY: the raw session must never appear in the stored envelope'
  );
  const back = await getConnectionSession(userA, 'claude', 'acct-1');
  assert(back === secret, 'session must decrypt back to the original');
});

test('saveGrant retires the previous active grant (exactly one active per surface)', async () => {
  const store = createPrismaGrantStore('cloud');
  const first = await store.saveGrant({
    userId: userA,
    provider: 'claude',
    accountId: 'acct-1',
    accessToken: 'sk-ant-oat01-first',
  });
  const second = await store.saveGrant({
    userId: userA,
    provider: 'claude',
    accountId: 'acct-1',
    accessToken: 'sk-ant-oat01-second',
  });

  const active = await prisma.computeGrant.findMany({
    where: { userId: userA, accountId: 'acct-1', surface: 'cloud', status: 'active' },
  });
  assert(active.length === 1, `exactly one active grant expected, got ${active.length}`);
  assert(active[0].id === second.grantId, 'the newest grant must be the active one');

  const retired = await prisma.computeGrant.findUnique({ where: { id: first.grantId } });
  assert(retired?.status === 'dead', 'the superseded grant must be retired');
  assert(retired !== null && retired.diedAt !== null, 'retirement must be timestamped');
});

test('getActiveGrant returns the newest grant, decrypted', async () => {
  const store = createPrismaGrantStore('cloud');
  const got = await store.getActiveGrant(userA, 'claude', 'acct-1');
  assert(got !== null, 'expected an active grant');
  assert(got.accessToken === 'sk-ant-oat01-second', `got stale token ${got.accessToken}`);
});

test('grant tokens are encrypted at rest', async () => {
  const row = await prisma.computeGrant.findFirst({
    where: { userId: userA, accountId: 'acct-1', status: 'active' },
  });
  assert(row !== null, 'expected a stored grant');
  assert(
    !row.encryptedCredentials.includes('sk-ant-oat01-second'),
    'SECURITY: the raw token must never appear in the stored envelope'
  );
});

test('markGrantDead is idempotent under concurrent observers', async () => {
  // Many agents observe the same revocation simultaneously; double-marking must
  // not corrupt the record or throw.
  const store = createPrismaGrantStore('cloud');
  const g = await store.saveGrant({
    userId: userA,
    provider: 'claude',
    accountId: 'acct-2',
    accessToken: 'sk-ant-oat01-dies',
  });
  await Promise.all(Array.from({ length: 5 }, () => store.markGrantDead(g.grantId, 'revoked')));
  const row = await prisma.computeGrant.findUnique({ where: { id: g.grantId } });
  assert(row?.status === 'dead', 'grant must be dead');
  assert(row.deadReason === 'revoked', 'first reason should be preserved');
});

test('history is kept: dead grants are retained, never deleted', async () => {
  const dead = await prisma.computeGrant.count({
    where: { userId: userA, status: 'dead' },
  });
  assert(dead >= 2, `expected retained dead grants for tracing, found ${dead}`);
});

test('grants for one account are isolated from another account', async () => {
  const store = createPrismaGrantStore('cloud');
  await store.saveGrant({
    userId: userA,
    provider: 'claude',
    accountId: 'acct-2',
    accessToken: 'sk-ant-oat01-acct2',
  });
  const one = await store.getActiveGrant(userA, 'claude', 'acct-1');
  const two = await store.getActiveGrant(userA, 'claude', 'acct-2');
  assert(one?.accessToken === 'sk-ant-oat01-second', 'acct-1 grant must be untouched');
  assert(two?.accessToken === 'sk-ant-oat01-acct2', 'acct-2 must have its own grant');
});

test('THE EVICTION GUARD: removing one account leaves the others intact', async () => {
  const store = createPrismaGrantStore('cloud');
  await removeConnection(userA, 'claude', 'acct-2');

  const remaining = await listConnections(userA, 'claude');
  assert(remaining.length === 1, `expected 1 remaining claude account, got ${remaining.length}`);
  const survivor = await store.getActiveGrant(userA, 'claude', 'acct-1');
  assert(survivor?.accessToken === 'sk-ant-oat01-second', 'the other account must still work');

  const orphaned = await prisma.computeGrant.count({
    where: { userId: userA, accountId: 'acct-2' },
  });
  assert(orphaned === 0, `removed account's grants must cascade, ${orphaned} left behind`);
});

test('a grant cannot be minted for an unconnected account', async () => {
  const store = createPrismaGrantStore('cloud');
  let threw = false;
  try {
    await store.saveGrant({
      userId: userA,
      provider: 'claude',
      accountId: 'never-connected',
      accessToken: 'sk-ant-oat01-orphan',
    });
  } catch {
    threw = true;
  }
  assert(threw, 'grants must be anchored to a connection, not float free');
});

test('users are isolated from each other', async () => {
  await upsertAccountConnection({ userId: userB, provider: 'claude', accountId: 'acct-1' });
  const store = createPrismaGrantStore('cloud');
  await store.saveGrant({
    userId: userB,
    provider: 'claude',
    accountId: 'acct-1',
    accessToken: 'sk-ant-oat01-userB',
  });
  const a = await store.getActiveGrant(userA, 'claude', 'acct-1');
  const b = await store.getActiveGrant(userB, 'claude', 'acct-1');
  assert(a?.accessToken === 'sk-ant-oat01-second', "user A's grant must be unaffected");
  assert(b?.accessToken === 'sk-ant-oat01-userB', 'user B must get their own grant');
});

test('setConnectionState drives the FE chip and clears the error on recovery', async () => {
  const store = createPrismaGrantStore('cloud');
  await store.setConnectionState(userA, 'claude', 'acct-1', 'needs_reconnect');
  let row = await prisma.computeAccountConnection.findFirst({
    where: { userId: userA, provider: 'claude', accountId: 'acct-1' },
  });
  assert(row?.state === 'needs_reconnect', 'state must flip for the chip');

  await store.setConnectionState(userA, 'claude', 'acct-1', 'connected');
  row = await prisma.computeAccountConnection.findFirst({
    where: { userId: userA, provider: 'claude', accountId: 'acct-1' },
  });
  assert(row?.state === 'connected', 'recovery must clear the state');
  assert(row?.lastErrorReason === null, 'recovery must clear the stale error reason');
});

test('encryption refuses empty material rather than storing a blank envelope', () => {
  let threw = false;
  try {
    encryptGrantMaterial('');
  } catch {
    threw = true;
  }
  assert(threw, 'empty plaintext must be rejected');
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\ncompute-grant persistence (real database)\n');
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

if (process.argv[1]?.includes('compute-grants-repo')) {
  void main();
}
