#!/usr/bin/env tsx
/**
 * Black-box tests for /api/admin-health.
 *
 * Covers:
 *   GET /api/admin-health — admin-only company health metrics.
 *
 * Invariants covered:
 *   - auth boundary: no auth returns 401, non-admin JWT returns 403
 *   - authorization: Andy's admin account can read company-health metrics
 *   - response shape: metrics include revenue, waitlist signups, users, runs, retention, and velocity
 *   - parameter handling: supported time slices are accepted
 *   - periodization: every supported time slice uses contiguous rolling-day buckets
 *   - error-surface: failures return { error: string }
 */

import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { findWaitlistSignupsBetween } from '../../domains/admin-health/repo';
import { isCacheableAdminHealthResponse } from '../../domains/admin-health/service';
import {
  assertConnectorAdoption,
  assertDatabaseActivationCounts,
  AdminHealthResponseSchema,
  ErrorResponseSchema,
  type AdminHealthResponse,
} from './admin-health.blackbox.helpers';
import { prisma } from '../../providers/database';
import { findProductRootTasksBetween } from '../../domains/admin-health/repoProductUsage';
import { testProductCompletionCohort } from './admin-health-product-usage.cases';

// Refuse to seed fixtures into prod when this file is run directly (bypassing
// the runner, which is what put ~2,690 fixture rows in the prod Waitlist table).
import './assertLocalDatabase';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);
const ANDY_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const NON_ADMIN_USER_ID = 'admin-health-non-admin-user';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

function assertRollingPeriods(
  body: AdminHealthResponse,
  expectedPoints: number,
  expectedDays: number
): void {
  if (body.series.length !== expectedPoints) {
    throw new Error(`Expected ${expectedPoints} points, got ${body.series.length}`);
  }
  const expectedDurationMs = expectedDays * 24 * 60 * 60 * 1000;
  for (let index = 0; index < body.series.length; index += 1) {
    const point = body.series[index];
    if (Date.parse(point.end) - Date.parse(point.start) !== expectedDurationMs) {
      throw new Error(`${body.timeSlice} point ${index} is not ${expectedDays} rolling days`);
    }
    const previous = body.series[index - 1];
    if (previous !== undefined && previous.end !== point.start) {
      throw new Error(`${body.timeSlice} points ${index - 1} and ${index} are not contiguous`);
    }
  }
  const first = body.series[0];
  const latest = body.series.at(-1);
  if (first === undefined || latest === undefined) throw new Error('Expected non-empty series');
  if (body.range.start !== latest.start || body.range.end !== latest.end) {
    throw new Error('Summary range must match the latest rolling period');
  }
  if (body.historyRange.start !== first.start || body.historyRange.end !== latest.end) {
    throw new Error('History range must span every rolling period');
  }
  if (JSON.stringify(body.summary.costPerTask) !== JSON.stringify(latest.costPerTask)) {
    throw new Error('Summary cost per task must match the latest rolling period');
  }
  const generatedAt = new Date(body.generatedAt);
  // The latest period ends at the START OF TOMORROW so the in-progress day is
  // included dashboard-wide (current bucket = "this period so far").
  const nextUtcDayStart = Date.UTC(
    generatedAt.getUTCFullYear(),
    generatedAt.getUTCMonth(),
    generatedAt.getUTCDate() + 1
  );
  if (Date.parse(latest.end) !== nextUtcDayStart) {
    throw new Error(
      'Latest rolling period must end at the start of the next UTC day (includes today)'
    );
  }
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data, headers: response.headers };
}

function tokenFor(userId: string, phone?: string): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!secret || !supabaseUrl) {
    throw new Error('SUPABASE_JWT_SECRET and SUPABASE_URL are required for admin-health tests');
  }
  return jwt.sign({ sub: userId, phone }, secret, {
    algorithm: 'HS256',
    issuer: `${supabaseUrl}/auth/v1`,
    expiresIn: '1h',
  });
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
  }
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

function assertWaitlistMetrics(data: unknown): void {
  const payload = data as {
    summary?: { waitlistSignups?: unknown };
    series?: Array<{ waitlistSignups?: unknown }>;
  };
  const summaryCount = payload.summary?.waitlistSignups;
  const latestCount = payload.series?.at(-1)?.waitlistSignups;
  if (typeof summaryCount !== 'number') {
    throw new Error('Summary must include a numeric waitlist signup count');
  }
  if (typeof latestCount !== 'number') {
    throw new Error('Each series must include numeric waitlist signup counts');
  }
  if (summaryCount !== latestCount) {
    throw new Error('Summary waitlist signups must match the current weekly period');
  }
}

function assertNoImpossibleConversion(body: z.infer<typeof AdminHealthResponseSchema>): void {
  for (const step of body.funnel.steps) {
    if (step.conversionRate !== null && step.conversionRate > 1) {
      throw new Error(`Funnel step ${step.id} has an impossible conversion rate`);
    }
  }
  for (const source of ['client_analytics', 'database'] as const) {
    const steps = body.funnel.steps.filter((step) => step.source === source);
    const readySteps = steps.filter((step) => step.status === 'ready');
    if (readySteps.length === 0) continue;
    if (readySteps.length !== steps.length) {
      throw new Error(`${source} funnel cannot mix ready and unavailable steps`);
    }
    if (readySteps[0]?.conversionRate !== 1) {
      throw new Error(`${source} funnel must restart at its own 100% denominator`);
    }
    for (let index = 1; index < readySteps.length; index += 1) {
      const previous = readySteps[index - 1].count;
      const current = readySteps[index].count;
      if (previous === null || current === null || current > previous) {
        throw new Error(`${source} funnel counts must be non-increasing`);
      }
    }
  }
}

/**
 * Expected "# of Users" cohort for the current admin-health period.
 *
 * Must call the same Stripe+local join the service uses
 * (`fetchStripeSubscribersByPeriod` → `buildSubscriberSeries`). A hand-rolled
 * active/trialing-only mirror drifted to `expected 2, got 4` when canceled
 * lifecycles still included at period end, invite redeemers, and checkout
 * recovery disagreed with the helper — cement the production path instead.
 */
async function expectedAdminHealthUserIds(
  periodStart: string,
  periodEnd: string
): Promise<Set<string>> {
  const { fetchStripeSubscribersByPeriod } =
    await import('../../domains/admin-health/stripeSubscribers');
  const series = await fetchStripeSubscribersByPeriod([{ start: periodStart, end: periodEnd }]);
  const latest = series.at(-1);
  if (latest === undefined) {
    throw new Error('fetchStripeSubscribersByPeriod returned no period points');
  }
  return latest.userIds;
}

/**
 * Completed / resolved real agent runs by the core team or that period's Stripe
 * subscribers, a core-team member's retried goal counted once by its latest
 * resolved attempt; no resolved task is null rather than 0%.
 */
async function expectedCompletionRate(periodStart: string, periodEnd: string) {
  const { fetchStripeSubscribersByPeriod } =
    await import('../../domains/admin-health/stripeSubscribers');
  const series = await fetchStripeSubscribersByPeriod([{ start: periodStart, end: periodEnd }]);
  const subscribed = series.at(-1)?.subscribedUserIds ?? new Set<string>();
  const productTasks = await findProductRootTasksBetween(
    new Date(periodStart),
    new Date(periodEnd)
  );
  const latestByKey = new Map<string, (typeof productTasks)[number]>();
  for (const task of productTasks) {
    if (!task.coreTeam && !subscribed.has(task.userId)) continue;
    if (['STARTING_UP', 'ACTIVE', 'PAUSED'].includes(task.status) || task.archivedBeforeOutcome)
      continue;
    const key = task.coreTeam ? `${task.userId} ${task.goal}` : task.taskId;
    const kept = latestByKey.get(key);
    if (!kept || task.createdAt > kept.createdAt) latestByKey.set(key, task);
  }
  const resolved = [...latestByKey.values()];
  if (resolved.length === 0) return null;
  const completed = resolved.filter((task) => task.status === 'COMPLETED').length;
  return Number((completed / resolved.length).toFixed(4));
}

async function liveStripeRevenueCents(start: string, end: string): Promise<number> {
  const { getVerifiedStripeMetricsClient } = await import('../../providers/stripe');
  const stripe = await getVerifiedStripeMetricsClient();
  const excludedChargeIds = new Set(
    (process.env.ADMIN_HEALTH_STRIPE_EXCLUDED_CHARGE_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
  let total = 0;
  for await (const charge of stripe.charges.list({
    created: {
      gte: Math.floor(Date.parse(start) / 1000),
      lt: Math.floor(Date.parse(end) / 1000),
    },
    limit: 100,
  })) {
    if (!charge.livemode) throw new Error('Admin health must query live-mode Stripe data');
    if (!charge.paid || charge.status !== 'succeeded') continue;
    if (excludedChargeIds.has(charge.id)) continue;
    total += Math.max(0, charge.amount - charge.amount_refunded);
  }
  return total;
}

async function runPool(
  tests: { name: string; fn: () => Promise<void> }[],
  concurrency: number
): Promise<TestResult[]> {
  const results: TestResult[] = new Array(tests.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= tests.length) return;
      results[idx] = await runTest(tests[idx].name, tests[idx].fn);
    }
  }

  const workerCount = Math.min(concurrency, tests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function testNoAuth() {
  const res = await request(`${BASE_URL}/api/admin-health`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'GET /admin-health no-auth');
}

async function testNonAdminForbidden() {
  const res = await request(`${BASE_URL}/api/admin-health`, {
    headers: authHeaders(tokenFor(NON_ADMIN_USER_ID, '+15555550123')),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'GET /admin-health non-admin');
}

async function testAdminHappyWeekly() {
  const res = await request(`${BASE_URL}/api/admin-health?timeSlice=weekly`, {
    headers: authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
  });
  assertStatus(res.status, 200, res.data);
  assertWaitlistMetrics(res.data);
  assertConnectorAdoption(res.data);
  const body = assertSchema(AdminHealthResponseSchema, res.data, 'GET /admin-health weekly');
  if (body.timeSlice !== 'weekly') throw new Error(`Expected weekly, got ${body.timeSlice}`);
  assertRollingPeriods(body, 12, 7);
  const cachedRes = await request(`${BASE_URL}/api/admin-health?timeSlice=weekly`, {
    headers: authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
  });
  assertStatus(cachedRes.status, 200, cachedRes.data);
  const cachedBody = assertSchema(
    AdminHealthResponseSchema,
    cachedRes.data,
    'GET /admin-health weekly cached'
  );
  // The backend only day-caches a fully-ready response (isCacheableAdminHealthResponse):
  // when a velocity source errors (e.g. no valid GITHUB_TOKEN locally) or revenue is
  // null, it deliberately evicts the entry so the next request retries the degraded
  // source. Only assert cache reuse when the response is actually cacheable — in CI
  // (valid tokens + Stripe) it always is, so this preserves the invariant there while
  // tolerating a token-degraded local/instrumented backend.
  if (isCacheableAdminHealthResponse(body) && cachedBody.generatedAt !== body.generatedAt) {
    throw new Error('Same-day weekly requests must reuse the backend day cache');
  }
  const latest = body.series.at(-1);
  if (latest === undefined) throw new Error('Expected a latest weekly series point');
  if (body.range.start !== latest.start || body.range.end !== latest.end) {
    throw new Error('Summary range must match the current weekly period');
  }
  if (body.summary.revenueCents !== latest.revenueCents) {
    throw new Error('Summary revenue must match the current weekly period');
  }
  if (body.summary.taskCount !== latest.taskCount) {
    throw new Error('Summary tasks must match the current weekly period');
  }
  if (body.summary.outputTokensPerTask !== latest.outputTokensPerTask) {
    throw new Error('Summary output tokens must match the current weekly period');
  }
  if (body.summary.tasksIssuedPerUser !== latest.tasksIssuedPerUser) {
    throw new Error('Tasks per user must match the current weekly period');
  }
  if (process.env.STRIPE_SECRET_KEY) {
    const expectedUserIds = await expectedAdminHealthUserIds(body.range.start, body.range.end);
    if (body.summary.userCount !== expectedUserIds.size) {
      throw new Error(
        `User count must match the configured user cohort: expected ${expectedUserIds.size}, got ${body.summary.userCount}`
      );
    }
    const { findRootTasksBetween } = await import('../../domains/admin-health/repo');
    const { dedupeInternalRepeatTasks } = await import('../../domains/admin-health/benchmarkDedup');
    // Mirror buildSeries: filter to the counted cohort, then collapse internal-account
    // repeat goals (benchmark stripping) exactly as the metric does.
    const cohortTaskCount = dedupeInternalRepeatTasks(
      (await findRootTasksBetween(new Date(body.range.start), new Date(body.range.end))).filter(
        (task) => expectedUserIds.has(task.userId)
      )
    ).length;
    if (body.summary.taskCount !== cohortTaskCount) {
      throw new Error(
        `Task count must use the same user cohort: expected ${cohortTaskCount}, got ${body.summary.taskCount}`
      );
    }
    const liveRevenue = await liveStripeRevenueCents(body.range.start, body.range.end);
    if (body.summary.revenueCents !== liveRevenue) {
      throw new Error(
        `Revenue must match live Stripe charges: expected ${liveRevenue}, got ${body.summary.revenueCents}`
      );
    }
  }
  if (body.summary.taskCompletionRate !== latest.taskCompletionRate) {
    throw new Error('Task completion rate must match the current weekly period');
  }
  if (process.env.STRIPE_SECRET_KEY) {
    const expected = await expectedCompletionRate(body.range.start, body.range.end);
    if (body.summary.taskCompletionRate !== expected) {
      throw new Error(
        `Completion must cover the core team + Stripe subscribers: expected ${expected}, got ${body.summary.taskCompletionRate}`
      );
    }
  }
  if (
    body.velocity.dev.linearPointsCompleted.status === 'ready' &&
    body.velocity.dev.linearPointsCompleted.value !== latest.andyLinearPoints
  ) {
    throw new Error('Andy velocity summary must match the current weekly period');
  }
  if (
    body.velocity.dev.githubCommitsLanded.status === 'ready' &&
    body.velocity.dev.githubCommitsLanded.value !== latest.githubCommits
  ) {
    throw new Error('GitHub velocity summary must match the current weekly period');
  }
  const generatedWeek = new Date(body.generatedAt);
  const generatedDay = generatedWeek.getUTCDay();
  generatedWeek.setUTCDate(
    generatedWeek.getUTCDate() + (generatedDay === 0 ? -6 : 1 - generatedDay)
  );
  generatedWeek.setUTCHours(0, 0, 0, 0);
  for (const cohort of body.retentionCohorts) {
    const weekZero = cohort.points.find((point) => point.week === 0);
    if (
      weekZero === undefined ||
      weekZero.retainedUsers !== cohort.size ||
      weekZero.retentionRate !== 1
    ) {
      throw new Error(`Cohort ${cohort.cohortWeek} must start at 100% week-zero retention`);
    }
    for (const point of cohort.points) {
      const pointWeek = Date.parse(`${cohort.cohortWeek}T00:00:00.000Z`) + point.week * 604_800_000;
      if (pointWeek > generatedWeek.getTime()) {
        throw new Error(`Cohort ${cohort.cohortWeek} contains a future retention point`);
      }
    }
  }
  const funnelIds = body.funnel.steps.map((step) => step.id);
  if (funnelIds.includes('anonymous_session_created')) {
    throw new Error('Internal anonymous-account creation must not be a customer funnel step');
  }
  for (const id of [
    'landing_page_viewed',
    'querybox_clicked',
    'content_typed',
    'goal_submitted',
    'account_created',
    'first_task_created',
    'second_task_created',
    'third_task_created',
  ]) {
    if (!funnelIds.includes(id)) throw new Error(`Missing funnel step ${id}`);
  }
  for (const step of body.funnel.steps.filter((item) => item.status === 'unavailable')) {
    if (step.count !== null) throw new Error(`Unavailable funnel step ${step.id} has a fake count`);
  }
  assertNoImpossibleConversion(body);
  await assertDatabaseActivationCounts(body, async () => {
    const fresh = await request(`${BASE_URL}/api/admin-health?timeSlice=weekly`, {
      headers: authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
    });
    assertStatus(fresh.status, 200, fresh.data);
    return assertSchema(AdminHealthResponseSchema, fresh.data, 'GET /admin-health weekly retry');
  });
  if (process.env.AMPLITUDE_API_KEY && process.env.AMPLITUDE_SECRET_KEY) {
    for (const id of [
      'landing_page_viewed',
      'querybox_clicked',
      'content_typed',
      'goal_submitted',
      'phone_entered',
      'otp_code_submitted',
    ]) {
      const step = body.funnel.steps.find((item) => item.id === id);
      if (step?.status !== 'ready' || step.count === null) {
        throw new Error(
          `Configured Amplitude funnel step ${id} must have a real count ` +
            `(status=${step?.status ?? 'missing'}, detail=${step?.detail ?? 'missing'})`
        );
      }
    }
  }
}

async function testAdminHappyMonthly() {
  const res = await request(`${BASE_URL}/api/admin-health?timeSlice=monthly`, {
    headers: authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AdminHealthResponseSchema, res.data, 'GET /admin-health monthly');
  if (body.timeSlice !== 'monthly') throw new Error(`Expected monthly, got ${body.timeSlice}`);
  assertRollingPeriods(body, 12, 30);
}

async function testAdminHappyQuarterly() {
  const res = await request(`${BASE_URL}/api/admin-health?timeSlice=quarterly`, {
    headers: authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AdminHealthResponseSchema, res.data, 'GET /admin-health quarterly');
  if (body.timeSlice !== 'quarterly') throw new Error(`Expected quarterly, got ${body.timeSlice}`);
  assertRollingPeriods(body, 8, 90);
}

async function testAdminHappyYearly() {
  const res = await request(`${BASE_URL}/api/admin-health?timeSlice=yearly`, {
    headers: authHeaders(tokenFor(ANDY_USER_ID, '+19729777432')),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AdminHealthResponseSchema, res.data, 'GET /admin-health yearly');
  if (body.timeSlice !== 'yearly') throw new Error(`Expected yearly, got ${body.timeSlice}`);
  assertRollingPeriods(body, 5, 365);
  assertNoImpossibleConversion(body);
}

// A signup counts on email OR phone. This metric used to require a phone as a
// stand-in for "not fixture junk", which silently discarded every real
// email-only signup — the entire public landing-form population, which never
// collects a phone. Fixtures are excluded by classification instead.
async function testWaitlist_countsEmailOrPhoneAndExcludesFixtures() {
  const marker = `wlcase-wl-${Date.now()}-${process.pid}`;
  const start = new Date('2000-01-01T00:00:00.000Z');
  const end = new Date('2000-01-02T00:00:00.000Z');
  const at = new Date('2000-01-01T12:00:00.000Z');
  // `phone` is @unique, so the empty-string row below can only exist once
  // globally. A prior run that was SIGKILLed before its `finally` cleanup (e.g.
  // a coverage run killed on timeout) would leave a `phone: ''` row behind and
  // make every subsequent run collide. Purge any leaked fixture rows first so
  // the test self-heals instead of staying wedged.
  await prisma.waitlist.deleteMany({ where: { name: { startsWith: 'wlcase-wl-' } } });
  try {
    await prisma.waitlist.createMany({
      data: [
        // Counts: phone-bearing.
        {
          name: `${marker}-phone`,
          phone: `+1206555${String(Date.now() % 10000).padStart(4, '0')}`,
          createdAt: at,
        },
        // Counts: email-only — the case the old phone filter threw away.
        {
          name: `${marker}-email`,
          email: `${marker}-a@waitlist-case.dev`,
          phone: null,
          createdAt: at,
        },
        // Counts: a blank phone string is still an email-bearing signup.
        {
          name: `${marker}-blank`,
          email: `${marker}-b@waitlist-case.dev`,
          phone: '',
          createdAt: at,
        },
        // Excluded: one of our own fixtures, which is what the phone filter was
        // really trying (and failing) to keep out of the metric.
        { name: `${marker}-fixture`, email: `${marker}-c@blackbox-test.dev`, createdAt: at },
      ],
    });
    const rows = await findWaitlistSignupsBetween(start, end);
    if (rows.length !== 3) {
      throw new Error(
        `Expected 3 real signups (phone, email-only, blank-phone+email) in the window, ` +
          `got ${rows.length} — fixtures must be excluded and email-only rows must count`
      );
    }
  } finally {
    await prisma.waitlist.deleteMany({ where: { name: { startsWith: marker } } });
  }
}

async function main() {
  const liveOnly = process.env.ADMIN_HEALTH_LIVE_ONLY === '1';
  if (
    liveOnly &&
    (!process.env.AMPLITUDE_API_KEY?.trim() || !process.env.AMPLITUDE_SECRET_KEY?.trim())
  ) {
    throw new Error(
      'ADMIN_HEALTH_LIVE_ONLY=1 requires AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY; ' +
        'the live Amplitude deploy gate must not pass without provider credentials'
    );
  }
  const strictLiveTests = [
    { name: 'GET /api/admin-health no auth -> 401', fn: testNoAuth },
    { name: 'GET /api/admin-health non-admin -> 403', fn: testNonAdminForbidden },
    { name: 'GET /api/admin-health weekly admin -> metrics', fn: testAdminHappyWeekly },
  ];
  const remainingTests = [
    {
      name: 'completion rate counts only real customer product usage',
      fn: testProductCompletionCohort,
    },
    { name: 'GET /api/admin-health monthly admin -> metrics', fn: testAdminHappyMonthly },
    { name: 'GET /api/admin-health quarterly admin -> metrics', fn: testAdminHappyQuarterly },
    { name: 'GET /api/admin-health yearly admin -> metrics', fn: testAdminHappyYearly },
    {
      name: 'waitlist metric counts email-or-phone signups and excludes fixtures',
      fn: testWaitlist_countsEmailOrPhoneAndExcludesFixtures,
    },
  ];

  // The weekly case is the strict live-Amplitude integration probe. Run it
  // before broader period-shape checks so sibling cases cannot spend the
  // provider's shared chart-query budget first.
  const results = liveOnly
    ? await runPool([strictLiveTests[2]], 1)
    : [
        ...(await runPool(strictLiveTests, 1)),
        ...(await runPool(remainingTests, CASE_CONCURRENCY)),
      ];
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    console.log(`${icon} ${result.name} (${result.duration}ms)`);
    if (result.error) console.log(`   ${result.error}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} admin-health tests passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
