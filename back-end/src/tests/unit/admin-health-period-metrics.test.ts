#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import type { AgentStatus } from '@prisma/client';
import 'dotenv/config';
import { buildSeries } from '../../domains/admin-health/metrics';
import { parseTimeSlice } from '../../domains/admin-health/service';
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

const task = (id: string, createdAt: string) => ({
  taskId: id,
  userId: 'subscriber-user',
  createdAt: new Date(createdAt),
  tokensOut: 100,
  status: 'COMPLETED' as AgentStatus,
});

const series = buildSeries(
  periods,
  [
    task('may-1', '2026-05-03T00:00:00.000Z'),
    task('may-2', '2026-05-20T00:00:00.000Z'),
    task('jun-1', '2026-06-03T00:00:00.000Z'),
    task('jun-2', '2026-06-10T00:00:00.000Z'),
    task('jun-3', '2026-06-20T00:00:00.000Z'),
  ],
  [
    { userCount: 2, newUsers: 2 },
    { userCount: 1, newUsers: 0 },
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
assert.strictEqual(parseTimeSlice(undefined), 'monthly');
assert.strictEqual(parseTimeSlice('weekly'), 'weekly');

console.log('admin-health period metrics: passed');
