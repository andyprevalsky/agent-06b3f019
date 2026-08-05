/**
 * End-to-end mint against Stripe: production credentials must return a live
 * Checkout session (cs_live_… / livemode=true), never the "Rose Labs sandbox"
 * test account (cs_test_…).
 *
 * Skips when no live Stripe key is available in the environment.
 */
import assert from 'node:assert/strict';
import { config } from 'dotenv';

config();

async function main(): Promise<void> {
  const liveKey =
    process.env.STRIPE_SECRET_KEY_LIVE?.trim() ||
    process.env.ADMIN_HEALTH_STRIPE_SECRET_KEY?.trim() ||
    '';

  if (!/^(?:sk|rk)_live_/.test(liveKey)) {
    process.stdout.write('subscription-checkout-live-mint skipped (no live Stripe key in env)\n');
    return;
  }

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  try {
    const { createSubscriptionCheckoutSession } = await import('../../domains/billing/service');
    const result = await createSubscriptionCheckoutSession(`checkout-mode-repro-${Date.now()}`);
    assert.match(
      result.url,
      /^https:\/\/checkout\.stripe\.com\//,
      `expected Stripe Checkout URL, got ${result.url}`
    );
    assert.match(
      result.url,
      /cs_live_/,
      `production checkout must mint a LIVE session (cs_live_), got ${result.url}`
    );
    assert.doesNotMatch(
      result.url,
      /cs_test_/,
      'production checkout must not mint a sandbox (cs_test_) session'
    );
    process.stdout.write('subscription-checkout-live-mint tests passed\n');
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
