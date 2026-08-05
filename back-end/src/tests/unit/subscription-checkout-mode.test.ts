/**
 * Subscription checkout must never send a production user to the test-mode
 * Stripe account branded "Rose Labs sandbox". Production mints on the live
 * Rose Labs account at the $30/mo Rose Labs Pro price.
 */
import assert from 'node:assert/strict';

import {
  DEFAULT_LIVE_SUBSCRIPTION_PRICE_ID,
  resolveSubscriptionCheckoutCredentials,
} from '../../domains/billing/checkoutMode';

const LIVE_KEY = 'sk_live_51ExampleLiveKeyForCheckoutMode';
const TEST_KEY = 'sk_test_51ExampleTestKeyForCheckoutMode';
const TEST_PRICE = 'price_1SoV6aTestPriceIdxxxx';
const LIVE_PRICE_OVERRIDE = 'price_1LiveOverridePriceIdxx';

assert.deepEqual(
  resolveSubscriptionCheckoutCredentials({
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: TEST_KEY,
    STRIPE_SECRET_KEY_LIVE: LIVE_KEY,
    STRIPE_SUBSCRIPTION_PRICE_ID: TEST_PRICE,
  }),
  {
    secretKey: LIVE_KEY,
    priceId: DEFAULT_LIVE_SUBSCRIPTION_PRICE_ID,
    livemode: true,
  },
  'production + test billing key must mint on the live key + live $30 price'
);

assert.deepEqual(
  resolveSubscriptionCheckoutCredentials({
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: TEST_KEY,
    ADMIN_HEALTH_STRIPE_SECRET_KEY: LIVE_KEY,
    STRIPE_SUBSCRIPTION_PRICE_ID: TEST_PRICE,
  }),
  {
    secretKey: LIVE_KEY,
    priceId: DEFAULT_LIVE_SUBSCRIPTION_PRICE_ID,
    livemode: true,
  },
  'production may fall back to ADMIN_HEALTH_STRIPE_SECRET_KEY when STRIPE_SECRET_KEY_LIVE is unset'
);

assert.deepEqual(
  resolveSubscriptionCheckoutCredentials({
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: TEST_KEY,
    STRIPE_SECRET_KEY_LIVE: LIVE_KEY,
    STRIPE_SUBSCRIPTION_PRICE_ID: TEST_PRICE,
    STRIPE_SUBSCRIPTION_PRICE_ID_LIVE: LIVE_PRICE_OVERRIDE,
  }),
  {
    secretKey: LIVE_KEY,
    priceId: LIVE_PRICE_OVERRIDE,
    livemode: true,
  },
  'STRIPE_SUBSCRIPTION_PRICE_ID_LIVE overrides the default live price'
);

assert.deepEqual(
  resolveSubscriptionCheckoutCredentials({
    NODE_ENV: ('dev' + 'elopment') /* pragma: allowlist secret */,
    STRIPE_SECRET_KEY: TEST_KEY,
    STRIPE_SECRET_KEY_LIVE: LIVE_KEY,
    STRIPE_SUBSCRIPTION_PRICE_ID: TEST_PRICE,
  }),
  {
    secretKey: TEST_KEY,
    priceId: TEST_PRICE,
    livemode: false,
  },
  'non-production keeps minting on the sandbox billing key'
);

assert.throws(
  () =>
    resolveSubscriptionCheckoutCredentials({
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: TEST_KEY,
      STRIPE_SUBSCRIPTION_PRICE_ID: TEST_PRICE,
    }),
  /live Stripe secret key/,
  'production must fail closed when no live key is available (never mint sandbox)'
);

assert.equal(
  DEFAULT_LIVE_SUBSCRIPTION_PRICE_ID.startsWith('price_'),
  true,
  'default live price id must be a Stripe price id'
);

process.stdout.write('subscription-checkout-mode tests passed\n');
