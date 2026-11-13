#!/usr/bin/env tsx
/**
 * Subscription usage bars: agents report each account's 5h/7d usage on the
 * lineage heartbeat they already send, and GET /api/compute-accounts returns it
 * per account.
 *
 * Exercises the real HTTP surface of a running backend:
 *   POST /api/integrations/compute-code/token/lineage-heartbeat  (internal)
 *   POST /api/integrations/compute-code/token/rate-limited       (internal)
 *   POST /api/integrations/compute-code/code-session-usage       (internal)
 *   GET  /api/compute-accounts                                   (user)
 *
 * Invariants:
 *   - usage lands on the exact account (Integration row) that served the lease,
 *     and on no other account
 *   - a heartbeat never writes usage onto another user's or another pool row
 *   - an older snapshot never overwrites a newer one; one row is written at most
 *     once per USAGE_WRITE_MIN_INTERVAL_MS (10k agents share accounts), except a
 *     rejection, which is always written (still never over a newer one)
 *   - a malformed snapshot never fails the heartbeat it rides on
 *   - a lease's last flush is kept shortly after its release; later, nothing
 *   - the cooldown is returned with the account: why, whether the provider gave
 *     its reset, and nextResetAt only for a provider reset (never Rose's backoff)
 *   - a user cooldown that names no login never lands on sibling accounts
 *   - a code session's rate_limit_event usage lands on the task's login
 *   - the backend's own Rose completions (chat path: fetchChatComputeAuth →
 *     callWithChatComputeRotation → createStreamingCompletion) record the
 *     account's usage from every response, success or 429, in the background:
 *     a stalled usage write never delays the completion, and a 429's provider
 *     reset becomes an authoritative cooldown naming the spent window
 *   - an account nothing has measured gets its windows and reset times in the
 *     background: an inference-only login (setup-token, no user:profile) or one
 *     the usage endpoint refuses gets them from one max_tokens 1 quota check
 */

import { randomUUID } from 'node:crypto';

import type { IntegrationType } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  USAGE_RELEASED_LEASE_GRACE_MS,
  USAGE_WRITE_MIN_INTERVAL_MS,
} from '../../providers/computeSubscriptionUsage';
import { assertLocalDatabase } from './assertLocalDatabase';
import { registerChatPathCases } from './compute-subscription-usage.chat.cases';
import { registerUsageRefreshCases } from './compute-subscription-usage.refresh.cases';

// The chat-path cases run Rose in this process and write Integration rows.
assertLocalDatabase();

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
    source: string;
    status: string | null;
  } | null;
  rateLimitedUntil: string | null;
  cooldown: { until: string; reason: string; authoritative: boolean } | null;
  nextResetAt: string | null;
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

async function internalPost(path: string, body: Record<string, unknown>, userId?: string) {
  const res = await fetch(`${BASE_URL}/api/integrations/compute-code/${path}`, {
    method: 'POST',
    headers: {
      'X-API-Key': API_KEY,
      'Content-Type': 'application/json',
      ...(userId !== undefined ? { 'X-User-Id': userId } : {}),
    },
    body: JSON.stringify(body),
  });
  assert(res.status === 200, `${path} returned ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
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

const chatUsers: string[] = [];
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
  for (const userId of [USER, OTHER_USER, ...chatUsers]) {
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

test('a lease released past the grace records nothing', async () => {
  const lease = await seedLease('claude', 'user', USER);
  await prisma.computeTokenLineageLease.update({
    where: { lineageKey: lease },
    data: { releasedAt: new Date(Date.now() - USAGE_RELEASED_LEASE_GRACE_MS - 5_000) },
  });
  const res = await heartbeat({
    lineageKey: lease,
    integrationId: claudeB,
    usage: usage(5, 5, at(0)),
  });
  assert(!res.ok && !res.usageRecorded, 'long-released leases must not write usage');
  const b = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `b-${RUN}`);
  assert(b?.usage === null, 'account B must still have no usage');
});

test("a lease's last flush right after its release is kept", async () => {
  const lease = await seedLease('claude', 'user', USER);
  await prisma.computeTokenLineageLease.update({
    where: { lineageKey: lease },
    data: { releasedAt: new Date(Date.now() - 2_000) },
  });
  const res = await heartbeat({
    lineageKey: lease,
    integrationId: claudeB,
    usage: { ...usage(5, 25, at(0)), source: 'response', status: 'allowed' },
  });
  assert(!res.ok, 'the released lease is not kept alive');
  assert(res.usageRecorded, 'but the usage its agent saw last is recorded');
  const b = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `b-${RUN}`);
  assert(b?.usage?.sevenDay?.usedPct === 25, `expected 25, got ${JSON.stringify(b)}`);
  assert(b.usage.source === 'response' && b.usage.status === 'allowed', JSON.stringify(b.usage));
});

test('a rejection is written inside the interval, with its source and status', async () => {
  const lease = await seedLease('claude', 'user', USER);
  const base = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `a-${RUN}`);
  const baseObserved = Date.parse(base?.usage?.observedAt ?? '');
  const reset = at(2 * 86_400_000);
  const res = await heartbeat({
    lineageKey: lease,
    integrationId: claudeA,
    usage: {
      observedAt: new Date(baseObserved + 1_000).toISOString(),
      sevenDay: { usedPct: 100, resetsAt: reset },
      source: 'rate_limit',
      status: 'rejected',
    },
  });
  assert(res.usageRecorded, 'a rejection must not be coalesced away');
  const a = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `a-${RUN}`);
  assert(a?.usage?.sevenDay?.usedPct === 100, JSON.stringify(a));
  assert(a.usage.status === 'rejected' && a.usage.source === 'rate_limit', JSON.stringify(a.usage));
  assert(a.nextResetAt === reset, `nextResetAt must be the spent window's reset: ${a.nextResetAt}`);
});

test('the provider cooldown is returned with the account', async () => {
  const until = new Date(Date.now() + 2 * 86_400_000);
  await prisma.integration.update({ where: { id: claudeB }, data: { rateLimitedUntil: until } });
  const b = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `b-${RUN}`);
  assert(b?.rateLimitedUntil === until.toISOString(), `cooldown missing: ${JSON.stringify(b)}`);
});

test('a Rose backoff is a non-authoritative cooldown without a next reset', async () => {
  const until = at(10 * 60_000);
  await internalPost(
    'token/rate-limited',
    {
      type: 'gpt',
      source: 'user',
      userId: USER,
      integrationId: codexA,
      rateLimitedUntil: until,
      failureReason: 'stall',
      rateLimitReason: 'stall',
      rateLimitAuthoritative: false,
      credential: 'f'.repeat(16),
    },
    USER
  );
  const codex = (await listAccounts(USER, 'codex'))[0];
  assert(
    codex?.cooldown?.reason === 'stall' && codex.cooldown.authoritative === false,
    `cooldown: ${JSON.stringify(codex?.cooldown)}`
  );
  assert(codex.nextResetAt === null, 'a stall backoff is not a quota reset');
});

test('a provider reset is an authoritative cooldown and the next reset', async () => {
  const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
  await internalPost(
    'token/rate-limited',
    {
      type: 'claude',
      source: 'user',
      userId: USER,
      integrationId: claudeA,
      rateLimitedUntil: until,
      failureReason: 'rate_limit',
      rateLimitReason: 'usage_window_7d',
      rateLimitAuthoritative: true,
      credential: 'e'.repeat(16),
    },
    USER
  );
  const a = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `a-${RUN}`);
  assert(
    a?.cooldown?.reason === 'usage_window_7d' && a.cooldown.authoritative === true,
    `cooldown: ${JSON.stringify(a?.cooldown)}`
  );
});

test('a user cooldown that names no login never lands on sibling accounts', async () => {
  const before = await prisma.integration.findMany({
    where: { userId: USER, name: 'claude_code' },
    select: { id: true, rateLimitedUntil: true },
  });
  assert(before.length === 2, 'two claude accounts');
  await internalPost(
    'token/rate-limited',
    {
      type: 'claude',
      source: 'user',
      userId: USER,
      rateLimitedUntil: new Date(Date.now() + 9 * 86_400_000).toISOString(),
      failureReason: 'rate_limit',
      credential: 'd'.repeat(16),
    },
    USER
  );
  const after = await prisma.integration.findMany({
    where: { userId: USER, name: 'claude_code' },
    select: { id: true, rateLimitedUntil: true },
  });
  for (const row of after) {
    const prior = before.find((b) => b.id === row.id);
    assert(
      row.rateLimitedUntil?.getTime() === prior?.rateLimitedUntil?.getTime(),
      `account ${row.id} must keep its own cooldown`
    );
  }
});

test("a code session's rate_limit_event usage lands on the task's login", async () => {
  const task = await prisma.claudeCodeSession.create({
    data: {
      agentId: `usage-agent-${RUN}`,
      sandboxId: `usage-sandbox-${RUN}`,
      goal: 'usage',
      claudeTokenSource: 'user',
      claudeTokenIntegrationId: claudeB,
    },
  });
  try {
    const observedAt = new Date(Date.now() + USAGE_WRITE_MIN_INTERVAL_MS + 5_000).toISOString();
    const res = await internalPost('code-session-usage', {
      taskId: task.id,
      usage: {
        observedAt,
        fiveHour: { usedPct: 64, resetsAt: at(3_600_000) },
        source: 'code_session',
        status: 'allowed_warning',
      },
    });
    assert(res.recorded === true, JSON.stringify(res));
    const b = (await listAccounts(USER, 'claude')).find((x) => x.accountId === `b-${RUN}`);
    assert(b?.usage?.fiveHour?.usedPct === 64, JSON.stringify(b));
    assert(
      b.usage.source === 'code_session' && b.usage.status === 'allowed_warning',
      JSON.stringify(b.usage)
    );
  } finally {
    await prisma.claudeCodeSession.delete({ where: { id: task.id } });
  }
});

registerChatPathCases({
  test,
  listAccounts,
  run: RUN,
  baseUrl: BASE_URL,
  chatUsers,
  integrationType: TYPE,
});

registerUsageRefreshCases({
  test,
  listAccounts,
  run: RUN,
  baseUrl: BASE_URL,
  chatUsers,
  integrationType: TYPE,
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
