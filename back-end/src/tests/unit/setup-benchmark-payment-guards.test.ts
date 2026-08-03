import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {
  BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID,
  BENCHMARK_PAYMENT_LIFECYCLE_USER_ID,
} from '../../domains/purchases/config';
import {
  assertLiveCardholderReady,
  assertSandboxDatabaseIsLocal,
  assertUserMatchesMode,
  DEFAULT_SANDBOX_CARDHOLDER_ID,
  isStripeResourceMissing,
  requireLiveCardholderId,
  requireStripeLiveKey,
} from '../../../scripts/setup-benchmark-payment-guards';

const malformedKey = 'sk_test_sensitive-key-material';
assert.throws(
  () => requireStripeLiveKey({ STRIPE_SECRET_KEY: malformedKey }),
  (error: unknown) =>
    error instanceof Error &&
    error.message.includes('sk_live_*') &&
    !error.message.includes(malformedKey) &&
    !error.message.includes(malformedKey.slice(0, 8))
);
assert.equal(requireStripeLiveKey({ STRIPE_SECRET_KEY: 'sk_live_fixture' }), 'sk_live_fixture');

assert.doesNotThrow(() =>
  assertSandboxDatabaseIsLocal({ DATABASE_URL: 'postgresql://postgres:postgres@[::1]:5432/db' })
);
assert.throws(
  () =>
    assertSandboxDatabaseIsLocal({
      DATABASE_URL: 'postgresql://postgres:postgres@production.example/db',
    }),
  /Refusing to seed/
);

assert.throws(
  () => requireLiveCardholderId({ BENCHMARK_AGENTCARD_CARDHOLDER_ID: '' }),
  /needs the live AgentCard cardholder id/
);
assert.throws(
  () =>
    requireLiveCardholderId({
      BENCHMARK_AGENTCARD_CARDHOLDER_ID: DEFAULT_SANDBOX_CARDHOLDER_ID,
    }),
  /refuses the known AgentCard sandbox cardholder/
);
assert.equal(
  requireLiveCardholderId({ BENCHMARK_AGENTCARD_CARDHOLDER_ID: 'cardholder-live' }),
  'cardholder-live'
);
assert.doesNotThrow(() => assertLiveCardholderReady('verified'));
assert.doesNotThrow(() => assertLiveCardholderReady('approved'));
assert.throws(() => assertLiveCardholderReady('pending'), /did not resolve as a ready live/);

assert.throws(
  () => assertUserMatchesMode(BENCHMARK_PAYMENT_LIFECYCLE_USER_ID, 'live'),
  /sandbox identity/
);
assert.throws(
  () => assertUserMatchesMode(BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID, 'sandbox'),
  /production identity/
);
assert.doesNotThrow(() => assertUserMatchesMode(BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID, 'live'));
assert.doesNotThrow(() => assertUserMatchesMode('custom-sandbox-user', 'sandbox'));

const missing = new Stripe.errors.StripeInvalidRequestError({
  type: 'invalid_request_error',
  code: 'resource_missing',
  message: 'No such customer',
});
const permission = new Stripe.errors.StripeInvalidRequestError({
  type: 'invalid_request_error',
  code: 'permission_denied',
  message: 'Denied',
});
assert.equal(isStripeResourceMissing(missing), true);
assert.equal(isStripeResourceMissing(permission), false);
assert.equal(isStripeResourceMissing({ code: 'resource_missing' }), false);

process.stdout.write('PASS benchmark payment setup guards\n');
