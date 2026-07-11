#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
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
      startedAt: new Date('2026-01-10T00:00:00.000Z'),
      endedAt: null,
      status: 'active',
    },
    {
      customerId: 'cus_active',
      startedAt: new Date('2026-02-20T00:00:00.000Z'),
      endedAt: null,
      status: 'active',
    },
    {
      customerId: 'cus_ended',
      startedAt: new Date('2026-01-20T00:00:00.000Z'),
      endedAt: new Date('2026-02-15T00:00:00.000Z'),
      status: 'canceled',
    },
    {
      customerId: 'cus_trialing',
      startedAt: new Date('2026-02-10T00:00:00.000Z'),
      endedAt: null,
      status: 'trialing',
    },
    {
      customerId: 'cus_past_due',
      startedAt: new Date('2026-01-05T00:00:00.000Z'),
      endedAt: null,
      status: 'past_due',
    },
    {
      customerId: 'cus_unpaid',
      startedAt: new Date('2026-01-15T00:00:00.000Z'),
      endedAt: null,
      status: 'unpaid',
    },
    {
      customerId: 'cus_paused',
      startedAt: new Date('2026-02-05T00:00:00.000Z'),
      endedAt: null,
      status: 'paused',
    },
    {
      customerId: 'cus_incomplete',
      startedAt: new Date('2026-01-25T00:00:00.000Z'),
      endedAt: null,
      status: 'incomplete',
    },
    {
      customerId: 'cus_never_activated',
      startedAt: new Date('2026-01-03T00:00:00.000Z'),
      endedAt: new Date('2026-01-04T00:00:00.000Z'),
      status: 'incomplete_expired',
    },
  ],
  new Date('2026-03-01T00:00:00.000Z')
);

assert.deepStrictEqual(series, [
  { userCount: 4, newUsers: 4 },
  { userCount: 2, newUsers: 2 },
]);

console.log('admin-health subscriber series: passed');
