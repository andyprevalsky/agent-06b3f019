#!/usr/bin/env tsx

import assert from 'node:assert';
import type { AgentStatus } from '@prisma/client';
import 'dotenv/config';
import { buildRetentionCohorts, buildSeries } from '../../domains/admin-health/metrics';
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

const task = (id: string, createdAt: string, userId = 'subscriber-user') => ({
  taskId: id,
  userId,
  createdAt: new Date(createdAt),
  tokensOut: 100,
  status: 'COMPLETED' as AgentStatus,
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
    { userCount: 2, newUsers: 2, userIds: new Set(['subscriber-user']) },
    { userCount: 1, newUsers: 0, userIds: new Set(['subscriber-user']) },
  ],
  [{ revenueCents: 0 }, { revenueCents: 0 }],
  [
    { andyLinearPoints: 0, githubCommits: 0, tamaraLinearPoints: 0 },
    { andyLinearPoints: 0, githubCommits: 0, tamaraLinearPoints: 0 },
  ]
);

assert.deepStrictEqual(
  series.map((point) => point.tasksIssuedPerUser),
  [1, 3],
  "Each bucket must divide only that period's tasks by that period's subscribed users"
);
assert.deepStrictEqual(
  series.map((point) => point.taskCount),
  [2, 3],
  'Task metrics must exclude users outside the counted user cohort'
);
assert.strictEqual(parseTimeSlice(undefined), 'monthly');
assert.strictEqual(parseTimeSlice('weekly'), 'weekly');

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
const retrievalDayStart = '2026-07-12T00:00:00.000Z';
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
    retrievalDayStart,
    `${timeSlice} must end at the last complete UTC day`
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
    '2026-07-13T00:00:00.000Z',
    `${timeSlice} periods must roll over on the next UTC retrieval day`
  );
}
