#!/usr/bin/env tsx
/**
 * Subscription usage bars: agents report each account's 5h/7d usage on the
 * lineage heartbeat they already send, and GET /api/compute-accounts returns it
 * per account.
 *
 * Exercises the real HTTP surface of a running backend:
 *   POST /api/integrations/compute-code/token/lineage-heartbeat  (internal)
 *   GET  /api/compute-accounts                                   (user)
 *
 * Invariants:
 *   - usage lands on the exact account (Integration row) that served the lease,
 *     and on no other account
 *   - a heartbeat never writes usage onto another user's or another pool row
 *   - an older snapshot never overwrites a newer one; one row is written at most
 *     once per USAGE_WRITE_MIN_INTERVAL_MS (10k agents share accounts)
 *   - a malformed snapshot never fails the heartbeat it rides on
 *   - a released lease records nothing
 *   - the provider cooldown (rateLimitedUntil) is returned with the account
 */

import { randomUUID } from 'node:crypto';

import type { IntegrationType } from '@prisma/client';
import { prisma } from '../../providers/database';
import { USAGE_WRITE_MIN_INTERVAL_MS } from '../../providers/computeSubscriptionUsage';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN = randomUUID().slice(0, 8);
const USER = `usage-${RUN}`;
const OTHER_USER = `usage-other-${RUN}`;
const TYPE = 'TOOL_SETUP' as IntegrationType;
const leases: string[] = [];

interface AccountDto {
  provider: string;
  accountId: string;
  usage: {
    fiveHour: { usedPct: number; resetsAt: string | null } | null;
    sevenDay: { usedPct: number; resetsAt: string | null } | null;
    observedAt: string;
  } | null;
  rateLimitedUntil: string | null;
}

async function seedAccount(userId: string, provider: 'claude' | 'codex', accountId: string) {
  const name = provider === 'claude' ? 'claude_code' : 'gpt_code';
  await prisma.computeAccountConnection.create({
    data: { userId, provider, accountId, accountEmail: `${accountId}@example.com` },
  });
  return prisma.integration.create({
    data: { userId, type: TYPE, name, status: 'CONNECTED', accountId, accountEmail: null },
  });
}

async function seedLease(tokenType: 'claude' | 'gpt', source: 'user' | 'pool', identity: string) {
  const lineageKey = `usage-lease-${RUN}-${leases.length}`;
  leases.push(lineageKey);
  await prisma.computeTokenLineageLease.create({
    data: { lineageKey, tokenType, tokenSource: source, tokenIdentity: identity, userId: USER },
  });
  return lineageKey;
}

async function heartbeat(body: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/api/integrations/compute-code/token/lineage-heartbeat`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(res.status === 200, `heartbeat returned ${res.status}`);
  return (await res.json()) as { ok: boolean; usageRecorded: boolean };
}

async function listAccounts(userId: string, provider?: string): Promise<AccountDto[]> {
  const qs = provider === undefined ? '' : `?provider=${provider}`;
  const res = await fetch(`${BASE_URL}/api/compute-accounts${qs}`, {
    headers: { 'X-API-Key': API_KEY, 'X-User-Id': userId },
  });
  assert(res.status === 200, `list returned ${res.status}`);
  return ((await res.json()) as { accounts: AccountDto[] }).accounts;
}

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const usage = (fiveHour: number, sevenDay: number, observedAt: string, sevenDayReset?: string) => ({
  observedAt,
  fiveHour: { usedPct: fiveHour, resetsAt: at(2 * 3_600_000) },
  sevenDay: { usedPct: sevenDay, resetsAt: sevenDayReset ?? at(3 * 86_400_000) },
});

let claudeA = '';
let claudeB = '';
let codexA = '';

async function setup() {
  claudeA = (await seedAccount(USER, 'claude', `a-${RUN}`)).id;
  claudeB = (await seedAccount(USER, 'claude', `b-${RUN}`)).id;
  codexA = (await seedAccount(USER, 'codex', `c-${RUN}`)).id;
}

async function cleanup() {
  await prisma.computeTokenLineageLease.deleteMany({ where: { lineageKey: { in: leases } } });
  for (const userId of [USER, OTHER_USER]) {
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.computeAccountConnection.deleteMany({ where: { userId } });
  }
}

test('an account no agent has used yet reports no usage', async () => {
  const accounts = await listAccounts(USER);
  assert(accounts.length === 3, `expected 3 accounts, got ${accounts.length}`);
  assert(
    accounts.every((a) => a.usage === null && a.rateLimitedUntil === null),
    'unused accounts must not invent usage'
  );
});

test('the heartbeat records usage on the exact account that served the lease', async () => {
  const lease = await seedLease('claude', 'user', USER);
  const reset = at(3 * 86_400_000);
  const res = await heartbeat({
    lineageKey: lease,
    integrationId: claudeA,
    usage: usage(12.5, 40, at(0), reset),
  });
  assert(res.ok && res.usageRecorded, `usage must be recorded, got ${JSON.stringify(res)}`);
  const claude = await listAccounts(USER, 'claude');
  const a = claude.find((x) => x.accountId === `a-${RUN}`);
  const b = claude.find((x) => x.accountId === `b-${RUN}`);
  assert(a?.usage?.sevenDay?.usedPct === 40, `7d used must be 40, got ${JSON.stringify(a)}`);
  assert(a.usage.fiveHour?.usedPct === 12.5, '5h used must be 12.5');
  assert(a.usage.sevenDay.resetsAt === reset, '7d reset must round-trip');
  assert(b?.usage === null, 'the sibling account must stay untouched');
});

test('a newer snapshot inside the write interval is coalesced, after it is written', async () => {
  const lease = await seedLease('claude', 'user', USER);
  const base = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `a-${RUN}`);
  const baseObserved = Date.parse(base?.usage?.observedAt ?? '');
  const soon = new Date(baseObserved + USAGE_WRITE_MIN_INTERVAL_MS / 2).toISOString();
  const coalesced = await heartbeat({
    lineageKey: lease,
    integrationId: claudeA,
    usage: usage(20, 50, soon),
  });
  assert(coalesced.ok && !coalesced.usageRecorded, 'writes inside the interval must coalesce');
  const later = new Date(baseObserved + USAGE_WRITE_MIN_INTERVAL_MS + 1000).toISOString();
  const written = await heartbeat({
    lineageKey: lease,
    integrationId: claudeA,
    usage: usage(30, 60, later),
  });
  assert(written.usageRecorded, 'a snapshot past the interval must be written');
  const a = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `a-${RUN}`);
  assert(a?.usage?.sevenDay?.usedPct === 60, `expected 60, got ${a?.usage?.sevenDay?.usedPct}`);
});

test('an older snapshot never overwrites a newer one', async () => {
  const lease = await seedLease('claude', 'user', USER);
  const res = await heartbeat({
    lineageKey: lease,
    integrationId: claudeA,
    usage: usage(1, 1, at(-3_600_000)),
  });
  assert(!res.usageRecorded, 'a stale snapshot must be ignored');
  const a = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `a-${RUN}`);
  assert(a?.usage?.sevenDay?.usedPct === 60, 'the newer value must survive');
});

test("a lease cannot write usage onto another user's account", async () => {
  const foreign = await prisma.integration.create({
    data: { userId: OTHER_USER, type: TYPE, name: 'claude_code', status: 'CONNECTED' },
  });
  const lease = await seedLease('claude', 'user', USER);
  const res = await heartbeat({
    lineageKey: lease,
    integrationId: foreign.id,
    usage: usage(99, 99, at(0)),
  });
  assert(res.ok && !res.usageRecorded, 'foreign rows must not be written');
  const row = await prisma.integration.findUnique({ where: { id: foreign.id } });
  assert(row?.usageObservedAt === null, 'foreign row must have no usage');
});

test('a lease of one provider cannot write the other provider row', async () => {
  const lease = await seedLease('gpt', 'user', USER);
  const res = await heartbeat({
    lineageKey: lease,
    integrationId: claudeB,
    usage: usage(5, 5, at(0)),
  });
  assert(!res.usageRecorded, 'a GPT lease must not write a Claude row');
});

test('a pool lease writes only its own pool row', async () => {
  const wrongPool = await seedLease('gpt', 'pool', claudeB);
  const denied = await heartbeat({
    lineageKey: wrongPool,
    integrationId: codexA,
    usage: usage(5, 5, at(0)),
  });
  assert(!denied.usageRecorded, 'a pool lease must not write a different row');
  const pool = await seedLease('gpt', 'pool', codexA);
  const res = await heartbeat({
    lineageKey: pool,
    integrationId: codexA,
    usage: usage(7, 70, at(0)),
  });
  assert(res.usageRecorded, 'a pool lease must write its own row');
  const codex = (await listAccounts(USER, 'codex'))[0];
  assert(codex?.usage?.sevenDay?.usedPct === 70, 'codex account must carry pooled usage');
});

test('a malformed snapshot keeps the heartbeat working and records nothing', async () => {
  const lease = await seedLease('claude', 'user', USER);
  for (const bad of [
    { observedAt: 'not-a-date', sevenDay: { usedPct: 1 } },
    { observedAt: at(0), sevenDay: { usedPct: 'lots' } },
    { observedAt: at(0) },
    'nope',
  ]) {
    const res = await heartbeat({ lineageKey: lease, integrationId: claudeB, usage: bad });
    assert(res.ok && !res.usageRecorded, `malformed ${JSON.stringify(bad)} must be dropped`);
  }
  const plain = await heartbeat({ lineageKey: lease });
  assert(plain.ok && !plain.usageRecorded, 'a heartbeat without usage still refreshes the lease');
});

test('a released lease records nothing', async () => {
  const lease = await seedLease('claude', 'user', USER);
  await prisma.computeTokenLineageLease.update({
    where: { lineageKey: lease },
    data: { releasedAt: new Date() },
  });
  const res = await heartbeat({
    lineageKey: lease,
    integrationId: claudeB,
    usage: usage(5, 5, at(0)),
  });
  assert(!res.ok && !res.usageRecorded, 'released leases must not write usage');
  const b = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `b-${RUN}`);
  assert(b?.usage === null, 'account B must still have no usage');
});

test('the provider cooldown is returned with the account', async () => {
  const until = new Date(Date.now() + 2 * 86_400_000);
  await prisma.integration.update({ where: { id: claudeB }, data: { rateLimitedUntil: until } });
  const b = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `b-${RUN}`);
  assert(b?.rateLimitedUntil === until.toISOString(), `cooldown missing: ${JSON.stringify(b)}`);
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\ncompute subscription usage\n');
  try {
    await setup();
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

if (process.argv[1]?.includes('compute-subscription-usage')) {
  void main();
}
