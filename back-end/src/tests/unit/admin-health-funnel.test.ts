#!/usr/bin/env tsx

import assert from 'node:assert';
import type { AgentStatus } from '@prisma/client';
import 'dotenv/config';
import {
  orderedFunnelCounts,
  type AmplitudeFunnelResult,
} from '../../domains/admin-health/amplitude';
import { buildFunnelSteps, compareFunnelSteps } from '../../domains/admin-health/metrics';
import {
  buildSignupCohort,
  isCacheableAdminHealthResponse,
} from '../../domains/admin-health/service';
import type { AdminHealthPeriod, AdminHealthResponse } from '../../domains/admin-health/types';

const amplitude: AmplitudeFunnelResult = {
  counts: orderedFunnelCounts([100, 80, 60, 40, 30, 20]),
  detail: 'Ordered website acquisition funnel.',
};
assert.deepStrictEqual(orderedFunnelCounts([0, 0, 0, 0, 0, 0]), {
  landing_page_viewed: 0,
  querybox_clicked: 0,
  content_typed: 0,
  goal_submitted: 0,
  phone_entered: 0,
  otp_code_submitted: 0,
});
assert.throws(() => orderedFunnelCounts([100, 80, 81, 40, 30, 20]), /must be non-increasing/);

const compared = compareFunnelSteps(
  buildFunnelSteps([], 5, amplitude),
  buildFunnelSteps([], 4, amplitude)
);
const accountCreated = compared.steps.find((step) => step.id === 'account_created');
assert.strictEqual(
  accountCreated?.conversionRate,
  1,
  'The first database activation step must not divide by the final Amplitude step'
);
assert.strictEqual(
  compared.endToEnd.conversionRate,
  0,
  'Account activation end-to-end must be account created to third task, not landing to third task'
);

const period: AdminHealthPeriod = {
  key: '2026-07-01',
  label: 'Jul 1',
  start: '2026-07-01T00:00:00.000Z',
  end: '2026-07-31T00:00:00.000Z',
};
const task = (taskId: string, userId: string, createdAt: string) => ({
  taskId,
  userId,
  goal: `goal-${taskId}`,
  createdAt: new Date(createdAt),
  tokensOut: 100,
  status: 'COMPLETED' as AgentStatus,
});
const cohort = buildSignupCohort(
  [
    { userId: 'new-user', createdAt: new Date('2026-07-10T00:00:00.000Z') },
    { userId: 'old-user', createdAt: new Date('2026-06-10T00:00:00.000Z') },
  ],
  [
    task('new-in-period', 'new-user', '2026-07-11T00:00:00.000Z'),
    task('new-after-period', 'new-user', '2026-08-01T00:00:00.000Z'),
    task('old-in-period', 'old-user', '2026-07-11T00:00:00.000Z'),
  ],
  period
);
assert.deepStrictEqual(cohort.userIds, new Set(['new-user']));
assert.deepStrictEqual(
  cohort.tasks.map((item) => item.taskId),
  ['new-in-period'],
  'Signup activation tasks must belong to the signup cohort and end with its bucket'
);

const cacheableResponse = {
  summary: { revenueCents: 100 },
  funnel: { steps: [{ source: 'client_analytics', status: 'ready' }] },
  velocity: {
    dev: {
      linearPointsCompleted: { status: 'ready' },
      githubCommitsLanded: { status: 'ready' },
    },
    ops: { linearPointsCompleted: { status: 'ready' } },
  },
} as AdminHealthResponse;
assert.ok(isCacheableAdminHealthResponse(cacheableResponse, true));
assert.ok(
  !isCacheableAdminHealthResponse(
    { ...cacheableResponse, summary: { ...cacheableResponse.summary, revenueCents: null } },
    true
  ),
  'A transient Stripe revenue failure must not poison the day cache'
);
assert.ok(
  !isCacheableAdminHealthResponse(
    {
      ...cacheableResponse,
      funnel: {
        ...cacheableResponse.funnel,
        steps: [{ ...cacheableResponse.funnel.steps[0], status: 'unavailable' }],
      },
    },
    true
  ),
  'A configured Amplitude failure must remain retryable'
);
