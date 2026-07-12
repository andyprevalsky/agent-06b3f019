#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import 'dotenv/config';
import { collectedStripeRevenueCents } from '../../domains/admin-health/metrics';

const excluded = new Set(['py_december_payment']);

assert.strictEqual(
  collectedStripeRevenueCents(
    {
      id: 'py_december_payment',
      amount: 240_000,
      amount_refunded: 0,
      paid: true,
      status: 'succeeded',
    },
    excluded
  ),
  0
);
assert.strictEqual(
  collectedStripeRevenueCents(
    {
      id: 'py_included_payment',
      amount: 50_000,
      amount_refunded: 5_000,
      paid: true,
      status: 'succeeded',
    },
    excluded
  ),
  45_000
);
assert.strictEqual(
  collectedStripeRevenueCents(
    {
      id: 'py_failed_payment',
      amount: 50_000,
      amount_refunded: 0,
      paid: false,
      status: 'failed',
    },
    excluded
  ),
  0
);

console.log('admin-health revenue exclusions: passed');
