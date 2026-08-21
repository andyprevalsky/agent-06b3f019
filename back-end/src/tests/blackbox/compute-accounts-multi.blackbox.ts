#!/usr/bin/env tsx
/**
 * Multi-account connections, the Gmail-style chip model.
 *
 * The old shape was `@@unique([userId, name])` on Integration -- literally one
 * Claude and one Codex account per user. These tests exercise the full service
 * path (connect / list / disconnect) to prove that limit is gone and, just as
 * importantly, that removing one account cannot disturb another.
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '../../providers/database';
import * as service from '../../domains/compute-grants/service';
import { connectAccountSchema } from '../../domains/compute-grants/types';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const RUN = randomUUID().slice(0, 8);
const USER = `multi-${RUN}`;
const SESSION = JSON.stringify([{ name: 'sessionKey', value: 'x' }]);

async function cleanup() {
  await prisma.computeGrant.deleteMany({ where: { userId: USER } });
  await prisma.computeAccountConnection.deleteMany({ where: { userId: USER } });
}

const connect = (provider: string, accountId: string, accountEmail?: string, session?: string) =>
  service.connectAccount(
    USER,
    connectAccountSchema.parse({ provider, accountId, accountEmail, session })
  );

test('THE FIX: two Claude AND two Codex accounts coexist', async () => {
  await connect('claude', 'anthropic-1', 'work@example.com', SESSION);
  await connect('claude', 'anthropic-2', 'personal@example.com', SESSION);
  await connect('codex', 'gpt-1', 'work@example.com', SESSION);
  await connect('codex', 'gpt-2', 'alt@example.com', SESSION);

  const all = await service.listConnectedAccounts(USER);
  assert(all.length === 4, `expected 4 connected accounts, got ${all.length}`);
  assert(all.filter((a) => a.provider === 'claude').length === 2, 'expected 2 Claude accounts');
  assert(all.filter((a) => a.provider === 'codex').length === 2, 'expected 2 Codex accounts');
});

test('each chip carries its own identity', async () => {
  const all = await service.listConnectedAccounts(USER);
  const emails = new Set(all.map((a) => a.accountEmail));
  assert(emails.has('personal@example.com'), 'each account must show its own email');
  assert(
    all.every((a) => a.state === 'connected'),
    'newly connected accounts start healthy'
  );
});

test('accounts can be listed per provider', async () => {
  const claude = await service.listConnectedAccounts(USER, 'claude');
  assert(claude.length === 2, `expected 2 Claude accounts, got ${claude.length}`);
  assert(
    claude.every((a) => a.provider === 'claude'),
    'provider filter must not leak other providers'
  );
});

test('every connected account can mint unattended', async () => {
  const all = await service.listConnectedAccounts(USER);
  const canMint = await Promise.all(
    all.map((a) => service.connectionCanMint(USER, a.provider, a.accountId))
  );
  assert(canMint.every(Boolean), 'each stored session must support unattended minting');
});

test('an account WITHOUT a session reports that honestly', async () => {
  // Silence here would look identical to a healthy account until the first
  // failure, which is the exact ambiguity this design removes.
  await connect('claude', 'anthropic-3', 'nosession@example.com');
  const canMint = await service.connectionCanMint(USER, 'claude', 'anthropic-3');
  assert(!canMint, 'an account with no stored session must not claim it can mint');
});

test('THE EVICTION GUARD: removing one account leaves every other intact', async () => {
  await service.disconnectAccount(USER, 'claude', 'anthropic-1');

  const after = await service.listConnectedAccounts(USER);
  assert(after.length === 4, `expected 4 remaining, got ${after.length}`);
  assert(
    after.some((a) => a.accountId === 'anthropic-2'),
    'the other Claude account must survive'
  );
  assert(
    after.filter((a) => a.provider === 'codex').length === 2,
    'both Codex accounts must survive removing a Claude one'
  );
});

test('re-connecting updates in place rather than duplicating', async () => {
  await connect('claude', 'anthropic-2', 'renamed@example.com', SESSION);
  const claude = (await service.listConnectedAccounts(USER, 'claude')).filter(
    (a) => a.accountId === 'anthropic-2'
  );
  assert(claude.length === 1, `re-connect must not duplicate, got ${claude.length}`);
  assert(claude[0].accountEmail === 'renamed@example.com', 'the email should update');
});

test('disconnecting an unknown account is a 404, not a silent success', async () => {
  let threw = false;
  try {
    await service.disconnectAccount(USER, 'claude', 'does-not-exist');
  } catch (err) {
    threw = err instanceof service.NotFoundError;
  }
  assert(threw, 'removing a non-existent account must surface, not pretend to work');
});

test('validation rejects an unknown provider', async () => {
  let threw = false;
  try {
    connectAccountSchema.parse({ provider: 'gemini', accountId: 'x' });
  } catch {
    threw = true;
  }
  assert(threw, 'only supported providers may be connected');
});

test('accounts are scoped per user', async () => {
  const other = `${USER}-other`;
  await service.connectAccount(
    other,
    connectAccountSchema.parse({ provider: 'claude', accountId: 'anthropic-2' })
  );
  const mine = await service.listConnectedAccounts(USER, 'claude');
  assert(
    mine.every((a) => a.accountEmail !== null),
    "another user's connection must not appear here"
  );
  await prisma.computeAccountConnection.deleteMany({ where: { userId: other } });
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\nmulti-account compute connections\n');
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

if (process.argv[1]?.includes('compute-accounts-multi')) {
  void main();
}
