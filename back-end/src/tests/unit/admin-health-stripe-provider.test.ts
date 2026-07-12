#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import 'dotenv/config';
import {
  assertStripeMetricsAccountId,
  resolveStripeMetricsSecretKey,
} from '../../providers/stripe';

assert.strictEqual(
  resolveStripeMetricsSecretKey('sk_live_admin_health', 'sk_live_billing'),
  'sk_live_admin_health'
);
assert.strictEqual(resolveStripeMetricsSecretKey(undefined, 'sk_live_billing'), 'sk_live_billing');

assert.doesNotThrow(() => assertStripeMetricsAccountId('acct_rose_labs', 'acct_rose_labs'));
assert.throws(
  () => assertStripeMetricsAccountId('acct_rose_labs', 'acct_unrelated_business'),
  /Stripe account mismatch/
);
assert.throws(
  () => assertStripeMetricsAccountId('', 'acct_rose_labs'),
  /ADMIN_HEALTH_STRIPE_ACCOUNT_ID/
);

console.log('admin-health Stripe provider: passed');
