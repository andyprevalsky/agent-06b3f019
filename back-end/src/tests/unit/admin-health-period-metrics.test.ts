#!/usr/bin/env tsx

import assert from 'node:assert';
import type { AgentStatus } from '@prisma/client';
import 'dotenv/config';
import {
  buildArchivedRootCostTelemetry,
  buildStoredRootCostTelemetry,
  readStoredRootCostTelemetry,
} from '../../domains/admin-health/costTelemetry';
import { calculateTaskCostPerTask } from '../../domains/admin-health/costs';
import {
  buildRetentionCohorts,
  buildSeries,
  gmvPerTaskCents,
  sumGmvCents,
} from '../../domains/admin-health/metrics';
import { parseTimeSlice } from '../../domains/admin-health/service';
import { buildPeriods } from '../../domains/admin-health/time';
import type { AdminHealthPeriod } from '../../domains/admin-health/types';

const periods: AdminHealthPeriod[] = [
  {
    key: '2026-05',
    label: 'May 2026',
    start: '2026-05-01T00:00:00.000Z',
    end: '2026-06-01T00:00:00.000Z',
  },
  {
    key: '2026-06',
    label: 'Jun 2026',
    start: '2026-06-01T00:00:00.000Z',
    end: '2026-07-01T00:00:00.000Z',
  },
];

const task = (id: string, createdAt: string, userId = 'subscriber-user', goal = `goal-${id}`) => ({
  taskId: id,
  userId,
  goal,
  createdAt: new Date(createdAt),
  tokensOut: 100,
  status: 'COMPLETED' as AgentStatus,
  archivedBeforeOutcome: false,
  coreTeam: userId === '1f85ff25-6e29-4c1b-8739-f917bd101a30',
});

const run = (taskId: string, createdAt: string) => ({ taskId, createdAt: new Date(createdAt) });

const waitlistSignup = (createdAt: string) => ({ createdAt: new Date(createdAt) });

const gmvRecord = (
  totalCents: number,
  createdAt: string,
  userId = 'subscriber-user',
  provider = 'agentcard'
) => ({
  userId,
  agentId: `agent-${createdAt}`,
  totalCents,
  createdAt: new Date(createdAt),
  provider,
});

const usage = (
  taskId: string,
  overrides: Partial<{
    kind: string;
    model: string;
    fromFastCache: boolean;
    tokensIn: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    tokensOut: number;
    costCents: number;
  }> = {}
) => ({
  taskId,
  kind: 'service',
  model: 'unknown',
  fromFastCache: false,
  tokensIn: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  tokensOut: 0,
  costCents: 0,
  ...overrides,
});

const series = buildSeries(
  periods,
  [
    task('may-1', '2026-05-03T00:00:00.000Z'),
    task('may-2', '2026-05-20T00:00:00.000Z'),
    task('may-outside-cohort', '2026-05-21T00:00:00.000Z', 'outside-user'),
    task('jun-1', '2026-06-03T00:00:00.000Z'),
    task('jun-2', '2026-06-10T00:00:00.000Z'),
    task('jun-3', '2026-06-20T00:00:00.000Z'),
    task('jun-outside-cohort', '2026-06-21T00:00:00.000Z', 'outside-user'),
  ],
  [
    waitlistSignup('2026-05-07T00:00:00.000Z'),
    waitlistSignup('2026-06-08T00:00:00.000Z'),
    waitlistSignup('2026-06-21T00:00:00.000Z'),
  ],
  [
    {
      userCount: 2,
      newUsers: 2,
      userIds: new Set(['subscriber-user']),
      subscribedUserIds: new Set(['subscriber-user']),
    },
    {
      userCount: 1,
      newUsers: 0,
      userIds: new Set(['subscriber-user']),
      subscribedUserIds: new Set(['subscriber-user']),
    },
  ],
  [{ revenueCents: 0 }, { revenueCents: 0 }],
  [
    { andyLinearPoints: 0, githubCommits: 0, tamaraLinearPoints: 0 },
    { andyLinearPoints: 0, githubCommits: 0, tamaraLinearPoints: 0 },
  ],
  [
    task('may-1', '2026-05-03T00:00:00.000Z'),
    { ...task('may-2', '2026-05-20T00:00:00.000Z'), status: 'FAILED' },
    task('may-outside-cohort', '2026-05-21T00:00:00.000Z', 'outside-user'),
    task('jun-1', '2026-06-03T00:00:00.000Z'),
    { ...task('jun-2', '2026-06-10T00:00:00.000Z'), status: 'FAILED' },
  ],
  [
    gmvRecord(1000, '2026-05-04T00:00:00.000Z'),
    gmvRecord(500, '2026-05-18T00:00:00.000Z', 'subscriber-user', 'order_confirmation'),
    gmvRecord(3000, '2026-06-05T00:00:00.000Z'),
  ],
  [
    run('may-1', '2026-05-03T00:00:00.000Z'),
    run('may-outside-cohort', '2026-05-21T00:00:00.000Z'),
    run('jun-1', '2026-06-03T00:00:00.000Z'),
  ],
  [
    usage('may-1', { costCents: 20 }),
    usage('may-outside-cohort', { costCents: 1_000 }),
    usage('jun-1', { costCents: 30 }),
    usage('unrelated-child-agent', { costCents: 10_000 }),
  ]
);

assert.deepStrictEqual(
  series.map((point) => point.tasksIssuedPerUser),
  [1, 3],
  "Each bucket must divide only that period's tasks by that period's subscribed users"
);
assert.deepStrictEqual(
  series.map((point) => point.waitlistSignups),
  [1, 2],
  'Each bucket must include waitlist entries created during that period'
);
assert.deepStrictEqual(
  series.map((point) => point.taskCount),
  [2, 3],
  'Task metrics must exclude users outside the counted user cohort'
);
assert.deepStrictEqual(
  series.map((point) => point.taskCompletionRate),
  [0.5, 0.5],
  'Completion counts only Stripe subscribers in that period (plus the core team); unsubscribed users never count'
);
assert.deepStrictEqual(
  series.map((point) => point.gmvCents),
  [1500, 3000],
  'GMV must sum CLEARED AgentCard + order_confirmation spend per period'
);
assert.deepStrictEqual(
  series.map((point) => point.gmvPerTask),
  [750, 1000],
  'GMV / task must divide period GMV by subscriber root-task count'
);
assert.strictEqual(sumGmvCents([gmvRecord(100, '2026-05-01T00:00:00.000Z')]), 100);
assert.strictEqual(gmvPerTaskCents(1500, 2), 750);
assert.strictEqual(gmvPerTaskCents(100, 0), 0);
assert.deepStrictEqual(
  series.map((point) => point.costPerTask.zeroLlmCostDollars),
  [5.1, 0.3],
  'Cost per task must use real root runs independently of the subscriber task cohort'
);
assert.strictEqual(parseTimeSlice(undefined), 'monthly');
assert.strictEqual(parseTimeSlice('weekly'), 'weekly');

// Pin pricedAt before SONNET_5_PRICE_CHANGE_AT (2026-09-01). Defaulting to
// Date.now() made this assertion flip overnight when the sonnet-5 list price
// stepped from $2/$10 to $3/$15.
const cacheAwareCost = calculateTaskCostPerTask(
  [{ taskId: 'root-task' }],
  [
    usage('root-task', { costCents: 25 }),
    usage('root-task', {
      kind: 'llm',
      model: 'claude-sonnet-5-claude',
      tokensIn: 100_000,
      cacheReadInputTokens: 200_000,
      cacheCreationInputTokens: 100_000,
      tokensOut: 10_000,
    }),
    usage('root-task', {
      kind: 'llm',
      model: 'gpt-5.6-sol-gpt',
      fromFastCache: true,
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    }),
    usage('spawned-child', { costCents: 1_000 }),
  ],
  Date.parse('2026-08-15T00:00:00.000Z')
);
const providerCacheSemantics = calculateTaskCostPerTask(
  [{ taskId: 'provider-cache-semantics' }],
  [
    usage('provider-cache-semantics', {
      kind: 'llm',
      model: 'gpt-5.4',
      tokensIn: 1_000_000,
      cacheReadInputTokens: 400_000,
      cacheCreationInputTokens: 100_000,
    }),
    usage('provider-cache-semantics', {
      kind: 'llm',
      model: 'claude-sonnet-5',
      tokensIn: 500_000,
      cacheReadInputTokens: 400_000,
      cacheCreationInputTokens: 100_000,
    }),
  ],
  Date.parse('2026-08-03T00:00:00.000Z')
);
assert.strictEqual(
  buildStoredRootCostTelemetry([{ agentId: 'chat-only', toolName: 'chat_router', usageItems: [] }]),
  null,
  'Chat/setup-only agent records must not become cost samples'
);
const storedTelemetry = buildStoredRootCostTelemetry([
  {
    agentId: 'root-task',
    toolName: 'execute_loop',
    usageItems: [
      {
        type: 'llm',
        model: 'claude-sonnet-5',
        tokens_in: 100,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 300,
        tokens_out: 40,
        cost_cents: 2,
      },
    ],
  },
]);
assert.ok(storedTelemetry, 'An execute-loop usage row must be recognized as a real agent run');
assert.deepStrictEqual(readStoredRootCostTelemetry('root-task', storedTelemetry), [
  {
    taskId: 'root-task',
    kind: 'llm',
    model: 'claude-sonnet-5',
    fromFastCache: false,
    tokensIn: 100,
    cacheReadInputTokens: 200,
    cacheCreationInputTokens: 300,
    tokensOut: 40,
    costCents: 2,
  },
]);
assert.deepStrictEqual(
  buildArchivedRootCostTelemetry('archived-root', {
    rows: {
      Agent: [{ id: 'archived-root' }],
      ToolUsage: [
        {
          agentId: 'archived-root',
          toolName: 'execute_loop',
          usageItems: [{ type: 'service', cost_cents: 5 }],
        },
        {
          agentId: 'spawned-child',
          toolName: 'execute_loop',
          usageItems: [{ type: 'service', cost_cents: 5_000 }],
        },
      ],
    },
  }),
  {
    worldModelMode: 'real',
    telemetry: {
      schemaVersion: 1,
      usage: [
        {
          kind: 'service',
          model: 'unknown',
          fromFastCache: false,
          tokensIn: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          tokensOut: 0,
          costCents: 5,
        },
      ],
    },
  },
  'R2 end fixtures must recover only root-owned usage and default legacy runs to real mode'
);
assert.deepStrictEqual(
  calculateTaskCostPerTask([], []),
  {
    zeroLlmCostDollars: null,
    apiRateDollars: null,
    computeTokenRateDollars: null,
    sampleSize: 0,
    unpricedUsageTokens: 0,
  },
  'Periods without a real root-run sample must be unavailable rather than reported as zero cost'
);
assert.deepStrictEqual(
  cacheAwareCost,
  {
    zeroLlmCostDollars: 0.25,
    apiRateDollars: 0.84,
    computeTokenRateDollars: 0.2795,
    sampleSize: 1,
    unpricedUsageTokens: 0,
  },
  'Cost scenarios must retain service spend, apply cache rates, price Fast Cache at zero, and exclude children'
);
// A task repeated in the runs array must not divide that task's usage across the
// repeats. The numerator attributes each usage row to a task exactly once, so a
// denominator that counted raw runs would report every scenario at a fraction of
// its true value.
const duplicatedRunCost = calculateTaskCostPerTask(
  [{ taskId: 'root-task' }, { taskId: 'root-task' }, { taskId: 'root-task' }],
  [usage('root-task', { kind: 'llm', model: 'claude-sonnet-4-6', tokensIn: 1_000_000 })]
);
assert.strictEqual(
  duplicatedRunCost.apiRateDollars,
  3,
  'Repeated task IDs must not divide the usage of one task across the duplicates'
);
assert.strictEqual(
  duplicatedRunCost.sampleSize,
  1,
  'sampleSize must report distinct tasks rather than an inflated raw run count'
);
// An unknown model with no recorded cost is unpriceable. Averaging it in as $0
// would silently understate the repriced figures, so it must surface as coverage
// loss instead.
const unpricedCost = calculateTaskCostPerTask(
  [{ taskId: 'root-task' }],
  [
    usage('root-task', {
      kind: 'llm',
      model: 'some-unreleased-model-v9',
      tokensIn: 1_000,
      tokensOut: 500,
      costCents: 0,
    }),
  ]
);
assert.strictEqual(
  unpricedCost.apiRateDollars,
  0,
  'An unpriceable model contributes no invented dollars'
);
assert.strictEqual(
  unpricedCost.unpricedUsageTokens,
  1_500,
  'Unpriceable LLM tokens must be surfaced as coverage loss, not silently averaged in as $0'
);
// `gpt-5.4` (bare) is the DIRECT OpenAI route at $2.50/$15 per M. Unlike
// sol/terra/luna, 5.4's direct and OpenRouter rates coincide; the repo's
// long-standing $1.75/$14 was stale for both and under-reported by ~30%.
// gpt-5.4 leg: prompt total is inclusive, so the 400k cache-read and 100k
// cache-write are subtracted from the 1M before charging full rate --
// 500k*$2.50 + 400k*$0.25 + 100k*$2.50 per M = $1.60.
// claude-sonnet-5 leg: input is exclusive, so all three buckets are additive --
// 500k*$2 + 400k*$0.20 + 100k*$2.50 per M = $1.33. Total $2.93.
assert.strictEqual(
  providerCacheSemantics.apiRateDollars,
  2.93,
  'OpenAI prompt totals must subtract cache tokens while Anthropic input totals remain exclusive'
);
// The OpenRouter route and the direct OpenAI API are separate contracts for the
// same model: gpt-5.6-sol is $2.50/$15 per M through OpenRouter and $5/$30
// direct. normalizeModel used to strip the `openai/` prefix, collapsing both
// onto one rate, so one of the two routes was always billed at the other's
// price. Anthropic may still collapse because its rates match on both routes.
const openRouterSol = calculateTaskCostPerTask(
  [{ taskId: 'route-split' }],
  [usage('route-split', { kind: 'llm', model: 'openai/gpt-5.6-sol', tokensIn: 1_000_000 })]
);
const directSol = calculateTaskCostPerTask(
  [{ taskId: 'route-split' }],
  [usage('route-split', { kind: 'llm', model: 'gpt-5.6-sol-openai', tokensIn: 1_000_000 })]
);
assert.strictEqual(
  openRouterSol.apiRateDollars,
  2.5,
  'OpenRouter-routed gpt-5.6-sol must bill at OpenRouter rates'
);
assert.strictEqual(
  directSol.apiRateDollars,
  5,
  'Direct OpenAI gpt-5.6-sol must bill at OpenAI list rates, not OpenRouter rates'
);
assert.notStrictEqual(
  openRouterSol.apiRateDollars,
  directSol.apiRateDollars,
  'the two OpenAI routes must not collapse onto a single rate'
);

const sonnetFiveUsage = [
  usage('root-task', {
    kind: 'llm',
    model: 'claude-sonnet-5',
    tokensIn: 1_000_000,
  }),
];
assert.strictEqual(
  calculateTaskCostPerTask(
    [{ taskId: 'root-task' }],
    sonnetFiveUsage,
    Date.parse('2026-08-31T23:59:59.999Z')
  ).apiRateDollars,
  2,
  'Claude Sonnet 5 must use its introductory API price through August 2026'
);
assert.strictEqual(
  calculateTaskCostPerTask(
    [{ taskId: 'root-task' }],
    sonnetFiveUsage,
    Date.parse('2026-09-01T00:00:00.000Z')
  ).apiRateDollars,
  3,
  'Claude Sonnet 5 must automatically adopt its published September 2026 API price'
);

// Benchmark stripping: an internal operator account (Andy) replaying the SAME goal
// string many times per period — the signature of pre-`isBenchmark` benchmark runs —
// must collapse to one counted task, while a real customer's repeated goals and every
// distinct internal goal are counted in full.
const ANDY_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const benchmarkSeries = buildSeries(
  periods,
  [
    // Andy runs the same benchmark goal 3× in May → counts once.
    task('bench-1', '2026-05-02T00:00:00.000Z', ANDY_USER_ID, 'party checkout benchmark'),
    task('bench-2', '2026-05-04T00:00:00.000Z', ANDY_USER_ID, 'party checkout benchmark'),
    task('bench-3', '2026-05-06T00:00:00.000Z', ANDY_USER_ID, 'party checkout benchmark'),
    // A genuine, distinct Andy task in May → still counted.
    task('andy-real', '2026-05-08T00:00:00.000Z', ANDY_USER_ID, 'book me a flight'),
    // A real customer repeating an identical goal → NOT deduped, both count.
    task('cust-1', '2026-05-10T00:00:00.000Z', 'subscriber-user', 'summarize my inbox'),
    task('cust-2', '2026-05-11T00:00:00.000Z', 'subscriber-user', 'summarize my inbox'),
  ],
  [],
  [
    {
      userCount: 2,
      newUsers: 2,
      // invite-user is in the app via an invite code but never subscribed.
      userIds: new Set([ANDY_USER_ID, 'subscriber-user', 'invite-user']),
      subscribedUserIds: new Set(['subscriber-user']),
    },
    { userCount: 0, newUsers: 0, userIds: new Set(), subscribedUserIds: new Set() },
  ],
  [{ revenueCents: 0 }, { revenueCents: 0 }],
  [
    { andyLinearPoints: 0, githubCommits: 0, tamaraLinearPoints: 0 },
    { andyLinearPoints: 0, githubCommits: 0, tamaraLinearPoints: 0 },
  ],
  [
    task('cust-1', '2026-05-10T00:00:00.000Z', 'subscriber-user', 'summarize my inbox'),
    {
      ...task('cust-2', '2026-05-11T00:00:00.000Z', 'subscriber-user', 'summarize my inbox'),
      status: 'FAILED',
    },
    // Still running: no outcome yet, so it is neither completed nor failed.
    {
      ...task('cust-3', '2026-05-12T00:00:00.000Z', 'subscriber-user', 'plan my trip'),
      status: 'ACTIVE',
    },
    // In the app via an invite code, not subscribed: never counted.
    {
      ...task('invite-1', '2026-05-14T00:00:00.000Z', 'invite-user', 'plan a party'),
      status: 'FAILED',
    },
    // Archived while running: FAILED by the archive, but no outcome to count.
    {
      ...task('cust-4', '2026-05-13T00:00:00.000Z', 'subscriber-user', 'find a dentist'),
      status: 'FAILED',
      archivedBeforeOutcome: true,
    },
    // The core team is the real in-app population; an operator retrying one goal
    // counts once, by its latest resolved attempt (FAILED -> COMPLETED -> PAUSED).
    {
      ...task('andy-1', '2026-05-02T00:00:00.000Z', ANDY_USER_ID, 'order my coffee'),
      status: 'FAILED',
    },
    task('andy-2', '2026-05-04T00:00:00.000Z', ANDY_USER_ID, 'order my coffee'),
    {
      ...task('andy-3', '2026-05-06T00:00:00.000Z', ANDY_USER_ID, 'order my coffee'),
      status: 'PAUSED',
    },
    // Aman is core team by phone (no admin user id): his retries collapse too.
    {
      ...task('aman-1', '2026-05-07T00:00:00.000Z', 'aman-user', 'draft the deck'),
      status: 'FAILED',
      coreTeam: true,
    },
    {
      ...task('aman-2', '2026-05-09T00:00:00.000Z', 'aman-user', 'draft the deck'),
      coreTeam: true,
    },
    {
      ...task('andy-june', '2026-06-03T00:00:00.000Z', ANDY_USER_ID, 'book me a flight'),
      status: 'ACTIVE',
    },
  ]
);
assert.strictEqual(
  benchmarkSeries[0]?.taskCount,
  4,
  'Repeated internal benchmark goals collapse to one; distinct internal + all customer tasks count'
);
assert.deepStrictEqual(
  benchmarkSeries.map((point) => point.taskCompletionRate),
  [0.75, null],
  'Completion = completed / resolved tasks with operator retries collapsed; archived-while-running has no outcome; no resolved task is null, never 0%'
);

const retention = buildRetentionCohorts(
  [{ userId: 'retained-user', firstTaskAt: new Date('2026-06-29T10:00:00.000Z') }],
  [
    task('activation-task', '2026-06-29T10:00:00.000Z', 'retained-user'),
    task('week-one-task', '2026-07-06T10:00:00.000Z', 'retained-user'),
  ],
  new Date('2026-07-12T23:59:59.999Z')
);
assert.deepStrictEqual(
  retention[0]?.points,
  [
    { week: 0, retainedUsers: 1, retentionRate: 1 },
    { week: 1, retainedUsers: 1, retentionRate: 1 },
  ],
  'Retention must include the first root task in week zero and never start below 100%'
);

const now = new Date('2026-07-12T19:30:00.000Z');
// The latest period ends at the START OF TOMORROW so the in-progress day is included.
const latestPeriodEnd = '2026-07-13T00:00:00.000Z';
const rollingDays = {
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
} as const;

for (const [timeSlice, days] of Object.entries(rollingDays)) {
  const rollingPeriods = buildPeriods(timeSlice as keyof typeof rollingDays, now);
  const latest = rollingPeriods.at(-1);
  assert.ok(latest, `Expected a latest ${timeSlice} period`);
  assert.strictEqual(
    latest.end,
    latestPeriodEnd,
    `${timeSlice} must end at the start of the next UTC day so today is included`
  );
  assert.strictEqual(
    Date.parse(latest.end) - Date.parse(latest.start),
    days * 24 * 60 * 60 * 1000,
    `${timeSlice} must cover the requested rolling day count`
  );
  for (let index = 1; index < rollingPeriods.length; index += 1) {
    const previous = rollingPeriods[index - 1];
    const current = rollingPeriods[index];
    assert.strictEqual(previous.end, current.start, `${timeSlice} periods must be contiguous`);
    assert.strictEqual(
      Date.parse(previous.end) - Date.parse(previous.start),
      days * 24 * 60 * 60 * 1000,
      `Every historical ${timeSlice} period must use the same rolling duration`
    );
  }
  assert.deepStrictEqual(
    buildPeriods(timeSlice as keyof typeof rollingDays, new Date('2026-07-12T01:00:00.000Z')),
    rollingPeriods,
    `${timeSlice} periods must be reusable throughout the same retrieval day`
  );
  assert.strictEqual(
    buildPeriods(timeSlice as keyof typeof rollingDays, new Date('2026-07-13T01:00:00.000Z')).at(-1)
      ?.end,
    '2026-07-14T00:00:00.000Z',
    `${timeSlice} periods must roll over on the next UTC retrieval day`
  );
}

process.stdout.write('admin-health period metrics: passed\n');
