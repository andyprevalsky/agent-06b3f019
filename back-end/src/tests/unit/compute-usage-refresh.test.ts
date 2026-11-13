#!/usr/bin/env tsx
/**
 * Usage bars, producer side: what reaches GET /api/compute-accounts.
 *
 *   agents heartbeat / code session / usage endpoint ─► Integration usage columns
 *   cooldown reports ─► rateLimitedUntil + rateLimitReason + rateLimitAuthoritative
 *   accountUsageView ─► { usage{source,status}, cooldown, nextResetAt }
 *
 * Invariants:
 *   - absent data stays absent: no usage → null (unknown), a Rose backoff is a
 *     non-authoritative cooldown and never a nextResetAt
 *   - stale/unmeasured Claude rows are refreshed in the background, at most once
 *     per 5 min per row; a user:profile token reads the usage endpoint (PERCENT
 *     utilization, source usage_endpoint). Inference-only and refused tokens get a
 *     quota check instead: compute-usage-quota-check.test.ts
 *   - a user cooldown without integrationId never lands on sibling rows
 *   - a rejection skips the 15 s write throttle; a lease's last flush is accepted
 *     shortly after its release
 *   - code sessions: every rate_limit_event status becomes usage
 *
 * Pure parts are hermetic; the writers run against the local test database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { prisma } from '../../providers/database';
import { waitFor } from '../helpers/waitFor';
import { markUserTokenRateLimited } from '../../providers/claudeCredentials';
import { markGptUserTokenRateLimited } from '../../providers/gptCredentials';
import {
  accountUsageView,
  parseUsagePayload,
  recordCodeTaskSubscriptionUsage,
  recordSubscriptionUsage,
  USAGE_RELEASED_LEASE_GRACE_MS,
  type SubscriptionUsageReport,
} from '../../providers/computeSubscriptionUsage';
import {
  parseUsageEndpointBody,
  refreshClaudeUsage,
  resetUsageRefreshStateForTests,
  scheduleClaudeUsageRefresh,
  USAGE_ENDPOINT_BETA,
  USAGE_ENDPOINT_URL,
  usageNeedsRefresh,
  type RefreshDeps,
} from '../../providers/computeUsageRefresh';
import {
  parseCliOutcome,
  usageFromRateLimitInfo,
} from '../../providers/codeSessions/inspectSandbox';

const NOW = new Date('2026-11-12T12:00:00Z');
const MIN = 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const emptyRow = {
  rateLimitedUntil: null,
  rateLimitReason: null,
  rateLimitAuthoritative: null,
  usage5hUsedPct: null,
  usage5hResetsAt: null,
  usage7dUsedPct: null,
  usage7dResetsAt: null,
  usageObservedAt: null,
  usageSource: null,
  usageStatus: null,
};

function testUsagePayload(): void {
  const report = parseUsagePayload(
    {
      observedAt: NOW.toISOString(),
      sevenDay: { usedPct: 140, resetsAt: at(60 * MIN).toISOString() },
      source: 'rate_limit',
      status: 'rejected',
    },
    'row-1',
    NOW
  );
  assert.ok(report);
  assert.deepEqual(report.sevenDay, { usedPct: 100, resetsAt: at(60 * MIN) }, 'clamped to 100');
  assert.equal(report.source, 'rate_limit');
  assert.equal(report.status, 'rejected');
  const legacy = parseUsagePayload(
    { observedAt: NOW.toISOString(), fiveHour: { usedPct: 5, resetsAt: null } },
    'row-1',
    NOW
  );
  assert.equal(legacy?.source, 'response', 'older agents: a response observation');
  assert.equal(legacy?.status, null);
  const bogus = parseUsagePayload(
    { observedAt: NOW.toISOString(), fiveHour: { usedPct: 5 }, source: 'made_up', status: 'nope' },
    'row-1',
    NOW
  );
  assert.equal(bogus?.source, 'response');
  assert.equal(bogus?.status, null);
  assert.equal(
    parseUsagePayload({ observedAt: NOW.toISOString() }, 'row-1', NOW),
    null,
    'no window'
  );
  assert.equal(
    parseUsagePayload({ observedAt: NOW.toISOString(), fiveHour: { usedPct: 1 } }, '', NOW),
    null
  );
}

function testAccountUsageView(): void {
  assert.deepEqual(
    accountUsageView(undefined, NOW),
    { usage: null, rateLimitedUntil: null, cooldown: null, nextResetAt: null },
    'never measured: unknown, not zero'
  );
  // Rose's own backoff over a healthy account: cooling, not exhausted, no reset.
  const stall = accountUsageView(
    {
      ...emptyRow,
      rateLimitedUntil: at(10 * MIN),
      rateLimitReason: 'stall',
      rateLimitAuthoritative: false,
      usage7dUsedPct: 20,
      usage7dResetsAt: at(48 * 60 * MIN),
      usageObservedAt: at(-MIN),
      usageSource: 'response',
      usageStatus: 'allowed',
    },
    NOW
  );
  assert.deepEqual(stall.cooldown, {
    until: at(10 * MIN).toISOString(),
    reason: 'stall',
    authoritative: false,
  });
  assert.equal(stall.nextResetAt, null, 'a Rose backoff is never shown as a quota reset');
  assert.equal(stall.usage?.source, 'response');
  assert.equal(stall.usage?.status, 'allowed');
  assert.deepEqual(stall.usage?.sevenDay, {
    usedPct: 20,
    resetsAt: at(48 * 60 * MIN).toISOString(),
  });
  // Legacy cooldown (no metadata): non-authoritative rate_limit.
  const legacy = accountUsageView({ ...emptyRow, rateLimitedUntil: at(5 * MIN) }, NOW);
  assert.deepEqual(legacy.cooldown, {
    until: at(5 * MIN).toISOString(),
    reason: 'rate_limit',
    authoritative: false,
  });
  assert.equal(legacy.usage, null);
  // Spent 7d window: nextResetAt is its reset (earliest spent window wins).
  const spent = accountUsageView(
    {
      ...emptyRow,
      rateLimitedUntil: at(48 * 60 * MIN),
      rateLimitReason: 'usage_window_7d',
      rateLimitAuthoritative: true,
      usage5hUsedPct: 100,
      usage5hResetsAt: at(-MIN), // already reset: not binding
      usage7dUsedPct: 100,
      usage7dResetsAt: at(47 * 60 * MIN),
      usageObservedAt: at(-MIN),
      usageSource: 'rate_limit',
      usageStatus: 'rejected',
    },
    NOW
  );
  assert.equal(spent.nextResetAt, at(47 * 60 * MIN).toISOString());
  assert.equal(spent.cooldown?.authoritative, true);
  assert.equal(spent.usage?.status, 'rejected');
  // Authoritative cooldown without a spent window: its end is the next reset.
  const auth = accountUsageView(
    {
      ...emptyRow,
      rateLimitedUntil: at(90 * MIN),
      rateLimitReason: 'usage_window',
      rateLimitAuthoritative: true,
    },
    NOW
  );
  assert.equal(auth.nextResetAt, at(90 * MIN).toISOString());
  // Expired cooldown: gone, but rateLimitedUntil is still echoed for older clients.
  const expired = accountUsageView(
    { ...emptyRow, rateLimitedUntil: at(-MIN), rateLimitAuthoritative: true },
    NOW
  );
  assert.equal(expired.cooldown, null);
  assert.equal(expired.nextResetAt, null);
  assert.equal(expired.rateLimitedUntil, at(-MIN).toISOString());
}

function fakeDeps(
  respond: () => Promise<Response> | Response,
  overrides: Partial<RefreshDeps> = {}
): RefreshDeps & {
  calls: Array<{ url: string; init: RequestInit }>;
  quotaChecks: string[];
  stored: SubscriptionUsageReport[];
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const quotaChecks: string[] = [];
  const stored: SubscriptionUsageReport[] = [];
  return {
    calls,
    quotaChecks,
    stored,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond();
    },
    readToken: async () => ({ accessToken: 'oauth-token', profileScope: true }),
    quotaCheck: async (accessToken) => {
      quotaChecks.push(accessToken);
      return { status: 200, headers: new Headers() };
    },
    store: async (report) => {
      stored.push(report);
      return true;
    },
    reconcile: async () => 'unchanged',
    now: () => NOW,
    ...overrides,
  };
}

async function testUsageEndpointRefresh(): Promise<void> {
  resetUsageRefreshStateForTests();
  const body = {
    five_hour: { utilization: 42, resets_at: '2026-11-12T15:00:00Z' },
    seven_day: { utilization: 100, resets_at: '2026-11-14T00:00:00Z' },
    seven_day_opus: { utilization: 3, resets_at: null },
  };
  const deps = fakeDeps(() => Response.json(body));
  assert.equal(await refreshClaudeUsage('row-ok', deps), 'stored');
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.quotaChecks.length, 0, 'a user:profile token reads the usage endpoint only');
  assert.equal(deps.calls[0].url, USAGE_ENDPOINT_URL);
  const headers = deps.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer oauth-token');
  assert.equal(headers['anthropic-beta'], USAGE_ENDPOINT_BETA);
  assert.deepEqual(deps.stored[0], {
    integrationId: 'row-ok',
    observedAt: NOW,
    fiveHour: { usedPct: 42, resetsAt: new Date('2026-11-12T15:00:00Z') },
    sevenDay: { usedPct: 100, resetsAt: new Date('2026-11-14T00:00:00Z') },
    source: 'usage_endpoint',
    status: null,
  });
  // At most once per 5 min per row.
  assert.equal(await refreshClaudeUsage('row-ok', deps), 'throttled');
  assert.equal(deps.calls.length, 1);
  assert.equal(
    await refreshClaudeUsage('row-ok', { ...deps, now: () => at(6 * MIN) }),
    'stored',
    'due again after the interval'
  );

  resetUsageRefreshStateForTests();
  const noToken = fakeDeps(() => Response.json(body), { readToken: async () => null });
  assert.equal(await refreshClaudeUsage('row-expired', noToken), 'no_token');
  assert.equal(noToken.calls.length + noToken.quotaChecks.length, 0, 'no token, no request');

  resetUsageRefreshStateForTests();
  const empty = fakeDeps(() => Response.json({ seven_day_opus: { utilization: 1 } }));
  assert.equal(await refreshClaudeUsage('row-empty', empty), 'empty');
  assert.equal(empty.stored.length, 0);
  assert.equal(parseUsageEndpointBody({ five_hour: null, seven_day: null }, 'r', NOW), null);

  // schedule never blocks: a hung request does not delay the caller.
  resetUsageRefreshStateForTests();
  let release: () => void = () => undefined;
  const hung = fakeDeps(
    () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(Response.json(body));
      })
  );
  const started = Date.now();
  scheduleClaudeUsageRefresh('row-hung', hung);
  scheduleClaudeUsageRefresh('row-hung', hung);
  assert.ok(Date.now() - started < 20, 'returns immediately');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hung.calls.length, 1, 'one request per row even when scheduled twice');
  release();
  await waitFor('the released refresh to store its usage', () => hung.stored.length === 1, 2_000);
  scheduleClaudeUsageRefresh(null, hung);
  scheduleClaudeUsageRefresh('', hung);

  const fresh = { usageObservedAt: at(-MIN), rateLimitedUntil: null, rateLimitAuthoritative: null };
  assert.equal(usageNeedsRefresh(fresh, NOW), false);
  assert.equal(usageNeedsRefresh({ ...fresh, usageObservedAt: null }, NOW), true, 'never measured');
  assert.equal(usageNeedsRefresh({ ...fresh, usageObservedAt: at(-31 * MIN) }, NOW), true, 'stale');
  assert.equal(
    usageNeedsRefresh(
      { ...fresh, rateLimitedUntil: at(5 * MIN), rateLimitAuthoritative: false },
      NOW
    ),
    true,
    'Rose backoff: fetch the real windows'
  );
  assert.equal(
    usageNeedsRefresh(
      { ...fresh, rateLimitedUntil: at(5 * MIN), rateLimitAuthoritative: true },
      NOW
    ),
    false,
    'the provider already said'
  );
  resetUsageRefreshStateForTests();
}

function testCodeSessionRateLimitEvents(): void {
  const allowed = usageFromRateLimitInfo(
    { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.31, resetsAt: 1_762_444_800 },
    NOW
  );
  assert.deepEqual(allowed, {
    observedAt: NOW.toISOString(),
    fiveHour: { usedPct: 31, resetsAt: '2025-11-06T16:00:00.000Z' },
    sevenDay: null,
    source: 'code_session',
    status: 'allowed',
  });
  const warning = usageFromRateLimitInfo(
    { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 },
    NOW
  );
  assert.equal(warning?.sevenDay?.usedPct, 80);
  assert.equal(warning?.status, 'allowed_warning');
  const rejected = usageFromRateLimitInfo(
    { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1_762_992_000 },
    NOW
  );
  assert.deepEqual(rejected?.sevenDay, { usedPct: 100, resetsAt: '2025-11-13T00:00:00.000Z' });
  assert.equal(
    usageFromRateLimitInfo({ status: 'allowed', rateLimitType: 'overage', utilization: 0.2 }, NOW),
    null
  );
  assert.equal(
    usageFromRateLimitInfo({ status: 'allowed', rateLimitType: 'five_hour' }, NOW),
    null,
    'no utilization'
  );

  const stdout = [
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 },
    },
    { type: 'result', subtype: 'success', result: 'done' },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const outcome = parseCliOutcome('claude', stdout, '', 0, null);
  assert.equal(outcome.usageLimit, null, 'allowed is not a usage limit');
  assert.equal(outcome.usageReport?.fiveHour?.usedPct, 50, 'but it is usage');
  assert.equal(outcome.answer, 'done');
}

async function seedUser(): Promise<string> {
  const userId = `usage-unit-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  return userId;
}

async function seedIntegration(
  userId: string,
  name: 'claude_code' | 'gpt_code',
  accountId: string
): Promise<string> {
  const row = await prisma.integration.create({
    data: { userId, name, accountId, type: 'TOOL_SETUP', status: 'CONNECTED' },
    select: { id: true },
  });
  return row.id;
}

async function cooldownOf(id: string) {
  return prisma.integration.findUniqueOrThrow({
    where: { id },
    select: { rateLimitedUntil: true, rateLimitReason: true, rateLimitAuthoritative: true },
  });
}

async function testCooldownNeverBroadcasts(userIds: string[]): Promise<void> {
  const until = at(60 * MIN).toISOString();
  for (const [name, mark] of [
    ['claude_code', markUserTokenRateLimited],
    ['gpt_code', markGptUserTokenRateLimited],
  ] as const) {
    const userId = await seedUser();
    userIds.push(userId);
    const a = await seedIntegration(userId, name, 'acct-a');
    const b = await seedIntegration(userId, name, 'acct-b');
    await mark(userId, { rateLimitedUntil: until, failureReason: 'rate_limit' });
    assert.equal(
      (await cooldownOf(a)).rateLimitedUntil,
      null,
      `${name}: unnamed cooldown must not land on a`
    );
    assert.equal(
      (await cooldownOf(b)).rateLimitedUntil,
      null,
      `${name}: unnamed cooldown must not land on b`
    );

    await mark(userId, {
      rateLimitedUntil: until,
      failureReason: 'rate_limit',
      integrationId: a,
      rateLimitReason: 'usage_window_7d',
      rateLimitAuthoritative: true,
    });
    assert.deepEqual(await cooldownOf(a), {
      rateLimitedUntil: new Date(until),
      rateLimitReason: 'usage_window_7d',
      rateLimitAuthoritative: true,
    });
    assert.equal((await cooldownOf(b)).rateLimitedUntil, null, `${name}: the sibling stays usable`);

    // A single-row user keeps the legacy unnamed behaviour (it is that row).
    const solo = await seedUser();
    userIds.push(solo);
    const only = await seedIntegration(solo, name, '');
    await mark(solo, { rateLimitedUntil: until, rateLimitReason: 'bogus' });
    const soloCooldown = await cooldownOf(only);
    assert.equal(soloCooldown.rateLimitedUntil?.toISOString(), new Date(until).toISOString());
    assert.equal(soloCooldown.rateLimitReason, null, 'unknown reason stored as null');
  }
}

async function testLeaseUsageWrites(userIds: string[]): Promise<void> {
  const userId = await seedUser();
  userIds.push(userId);
  const row = await seedIntegration(userId, 'claude_code', 'acct-lease');
  const lineageKey = `lease-${randomUUID()}`;
  await prisma.computeTokenLineageLease.create({
    data: { lineageKey, tokenType: 'claude', tokenSource: 'user', tokenIdentity: userId },
  });
  const report = (
    observedAt: Date,
    usedPct: number,
    status: SubscriptionUsageReport['status']
  ) => ({
    integrationId: row,
    observedAt,
    sevenDay: { usedPct, resetsAt: at(48 * 60 * MIN) },
    source: status === 'rejected' ? ('rate_limit' as const) : ('response' as const),
    status,
  });
  const t0 = new Date();
  assert.equal(await recordSubscriptionUsage(lineageKey, report(t0, 40, 'allowed')), true);
  assert.equal(
    await recordSubscriptionUsage(
      lineageKey,
      report(new Date(t0.getTime() + 2_000), 41, 'allowed')
    ),
    false,
    'throttled within 15 s'
  );
  assert.equal(
    await recordSubscriptionUsage(
      lineageKey,
      report(new Date(t0.getTime() + 3_000), 100, 'rejected')
    ),
    true,
    'a rejection skips the throttle'
  );
  assert.equal(
    await recordSubscriptionUsage(
      lineageKey,
      report(new Date(t0.getTime() + 1_000), 10, 'rejected')
    ),
    false,
    'but never overwrites a newer observation'
  );
  const stored = await prisma.integration.findUniqueOrThrow({
    where: { id: row },
    select: { usage7dUsedPct: true, usageSource: true, usageStatus: true },
  });
  assert.deepEqual(stored, {
    usage7dUsedPct: 100,
    usageSource: 'rate_limit',
    usageStatus: 'rejected',
  });

  // The flush of an agent's last response races its lease release.
  const released = new Date();
  await prisma.computeTokenLineageLease.update({
    where: { lineageKey },
    data: { releasedAt: released },
  });
  assert.equal(
    await recordSubscriptionUsage(
      lineageKey,
      report(new Date(released.getTime() + 20_000), 55, 'allowed')
    ),
    true,
    'accepted just after release'
  );
  assert.equal(
    await recordSubscriptionUsage(
      lineageKey,
      report(new Date(released.getTime() + 60_000), 56, 'allowed'),
      new Date(released.getTime() + USAGE_RELEASED_LEASE_GRACE_MS + 1_000)
    ),
    false,
    'not after the grace period'
  );
}

async function testCodeSessionUsageRecorded(userIds: string[]): Promise<void> {
  const userId = await seedUser();
  userIds.push(userId);
  const row = await seedIntegration(userId, 'claude_code', 'acct-cli');
  const sessions = prisma.claudeCodeSession as unknown as {
    findUnique: (...args: unknown[]) => Promise<unknown>;
  };
  const real = sessions.findUnique;
  sessions.findUnique = async () => ({ claudeTokenSource: 'user', claudeTokenIntegrationId: row });
  try {
    const usage = usageFromRateLimitInfo({
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 0.9,
    });
    assert.deepEqual(await recordCodeTaskSubscriptionUsage('task-1', usage), { recorded: true });
    const stored = await prisma.integration.findUniqueOrThrow({
      where: { id: row },
      select: { usage7dUsedPct: true, usageSource: true, usageStatus: true },
    });
    assert.deepEqual(stored, {
      usage7dUsedPct: 90,
      usageSource: 'code_session',
      usageStatus: 'allowed_warning',
    });
    assert.deepEqual(await recordCodeTaskSubscriptionUsage('task-1', { bogus: true }), {
      recorded: false,
    });
    sessions.findUnique = async () => ({
      claudeTokenSource: 'funded',
      claudeTokenIntegrationId: '',
    });
    assert.deepEqual(await recordCodeTaskSubscriptionUsage('task-2', usage), { recorded: false });
  } finally {
    sessions.findUnique = real;
  }
}

async function main(): Promise<void> {
  testUsagePayload();
  testAccountUsageView();
  await testUsageEndpointRefresh();
  testCodeSessionRateLimitEvents();
  const userIds: string[] = [];
  try {
    await testCooldownNeverBroadcasts(userIds);
    await testLeaseUsageWrites(userIds);
    await testCodeSessionUsageRecorded(userIds);
  } finally {
    await prisma.computeTokenLineageLease.deleteMany({ where: { tokenIdentity: { in: userIds } } });
    await prisma.integration.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
  }
}

main()
  .then(() => {
    process.stdout.write('PASS compute usage producer: refresh, cooldown meta, no broadcast\n');
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
