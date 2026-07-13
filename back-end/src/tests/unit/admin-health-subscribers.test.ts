#!/usr/bin/env tsx

import assert from 'node:assert';
import {
  ADMIN_HEALTH_ADDITIONAL_USER_IDS,
  ADMIN_HEALTH_EXCLUDED_USER_IDS,
  ADMIN_USER_IDS,
} from '../../domains/admin-health/config';
import { buildSubscriberSeries } from '../../domains/admin-health/subscriberMetrics';
import type { AdminHealthPeriod } from '../../domains/admin-health/types';

const periods: AdminHealthPeriod[] = [
  {
    key: '2026-01',
    label: 'Jan 2026',
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-02-01T00:00:00.000Z',
  },
  {
    key: '2026-02',
    label: 'Feb 2026',
    start: '2026-02-01T00:00:00.000Z',
    end: '2026-03-01T00:00:00.000Z',
  },
];

const series = buildSubscriberSeries(
  periods,
  [
    {
      customerId: 'cus_active',
      userId: 'active-user',
      startedAt: new Date('2026-01-10T00:00:00.000Z'),
      endedAt: null,
      status: 'active',
    },
    {
      customerId: 'cus_active',
      userId: 'active-user',
      startedAt: new Date('2026-02-20T00:00:00.000Z'),
      endedAt: null,
      status: 'active',
    },
    {
      customerId: 'cus_ended',
      userId: 'ended-user',
      startedAt: new Date('2026-01-20T00:00:00.000Z'),
      endedAt: new Date('2026-02-15T00:00:00.000Z'),
      status: 'canceled',
    },
    {
      customerId: 'cus_trialing',
      userId: 'trialing-user',
      startedAt: new Date('2026-02-10T00:00:00.000Z'),
      endedAt: null,
      status: 'trialing',
    },
    {
      customerId: 'cus_tamy_later',
      userId: 'tamy-user',
      startedAt: new Date('2026-02-12T00:00:00.000Z'),
      endedAt: null,
      status: 'active',
    },
    {
      customerId: 'cus_past_due',
      userId: 'past-due-user',
      startedAt: new Date('2026-01-05T00:00:00.000Z'),
      endedAt: null,
      status: 'past_due',
    },
    {
      customerId: 'cus_unpaid',
      userId: 'unpaid-user',
      startedAt: new Date('2026-01-15T00:00:00.000Z'),
      endedAt: null,
      status: 'unpaid',
    },
    {
      customerId: 'cus_paused',
      userId: 'paused-user',
      startedAt: new Date('2026-02-05T00:00:00.000Z'),
      endedAt: null,
      status: 'paused',
    },
    {
      customerId: 'cus_incomplete',
      userId: 'incomplete-user',
      startedAt: new Date('2026-01-25T00:00:00.000Z'),
      endedAt: null,
      status: 'incomplete',
    },
    {
      customerId: 'cus_never_activated',
      userId: 'never-activated-user',
      startedAt: new Date('2026-01-03T00:00:00.000Z'),
      endedAt: new Date('2026-01-04T00:00:00.000Z'),
      status: 'incomplete_expired',
    },
  ],
  new Date('2026-03-01T00:00:00.000Z'),
  [{ userId: 'tamy-user', startedAt: new Date('2026-01-15T00:00:00.000Z') }]
);

assert.deepStrictEqual(series, [
  {
    userCount: 3,
    newUsers: 3,
    userIds: new Set(['active-user', 'ended-user', 'tamy-user']),
  },
  {
    userCount: 3,
    newUsers: 1,
    userIds: new Set(['active-user', 'trialing-user', 'tamy-user']),
  },
]);

assert.ok(ADMIN_USER_IDS.has('1f85ff25-6e29-4c1b-8739-f917bd101a30'));
assert.ok(!ADMIN_HEALTH_ADDITIONAL_USER_IDS.has('1f85ff25-6e29-4c1b-8739-f917bd101a30'));
assert.ok(ADMIN_HEALTH_ADDITIONAL_USER_IDS.has('43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9'));
assert.ok(ADMIN_HEALTH_EXCLUDED_USER_IDS.has('1f85ff25-6e29-4c1b-8739-f917bd101a30'));
assert.ok(!ADMIN_HEALTH_EXCLUDED_USER_IDS.has('43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9'));
