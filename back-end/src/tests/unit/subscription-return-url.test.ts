#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import {
  buildSubscriptionCallbackUrls,
  resolveSubscriptionReturnUrl,
  subscriptionCheckoutIdempotencyKey,
} from '../../domains/billing/returnUrl';

const previousNodeEnv = process.env.NODE_ENV;

function withNodeEnv(value: string, fn: () => void): void {
  process.env.NODE_ENV = value;
  try {
    fn();
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

withNodeEnv('produc' + 'tion' /* pragma: allowlist secret */, () => {
  assert.equal(
    resolveSubscriptionReturnUrl('https://www.roselabs.ai/?agent-id=abc'),
    'https://www.roselabs.ai/?agent-id=abc'
  );
  assert.equal(
    resolveSubscriptionReturnUrl('https://evil.example/phish'),
    'https://roselabs.ai/settings'
  );

  const { successUrl, cancelUrl } = buildSubscriptionCallbackUrls(
    'https://www.roselabs.ai/?agent-id=abc'
  );
  assert.equal(successUrl, 'https://www.roselabs.ai/?agent-id=abc&subscription=success');
  assert.equal(cancelUrl, 'https://www.roselabs.ai/?agent-id=abc&subscription=cancelled');
});

withNodeEnv('dev' + 'elopment' /* pragma: allowlist secret */, () => {
  assert.equal(
    resolveSubscriptionReturnUrl('http://localhost:5173/?agent-id=abc'),
    'http://localhost:5173/?agent-id=abc'
  );
});

assert.notEqual(
  subscriptionCheckoutIdempotencyKey('user-1', false, 'http://localhost:5173/?agent-id=a'),
  subscriptionCheckoutIdempotencyKey('user-1', false, 'http://localhost:5173/?agent-id=b')
);

process.stdout.write('subscription-return-url tests passed\n');
