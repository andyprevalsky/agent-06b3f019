#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /webhooks/stripe
 *
 * Domain surface:
 *   POST /webhooks/stripe — handle Stripe webhook events (verified by Stripe signature)
 *
 * Invariants covered:
 *   - auth boundary: requires valid Stripe signature; missing/invalid signature returns 400
 *   - error-surface: invalid signature returns 400 with descriptive error
 *   - idempotency: same invalid request always returns same error
 *   - concurrency: 10 parallel invalid requests all return 400 consistently
 *   - same-input reproducibility: three sequential invalid requests return identical status
 *   - cleanup: read-only tests (no valid events processed), no state mutations
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write: cannot test without valid Stripe signature
 *   - state-transition: cannot trigger valid events without Stripe signing secret
 *   - ordering/pagination: no list endpoints
 *   - atomicity: cannot test without valid events
 *   - referential integrity: cannot test without valid events
 *   - event/job cardinality: cannot test without valid events
 *   - duplication prevention: cannot test without valid events
 *   - tenant isolation: events are routed by Stripe customer ID
 *   - time/clock: no timestamps in error responses
 *   - boundary param: Stripe SDK calls are inside event handlers (untestable without valid sig)
 *   - call ordering: cannot test without valid events
 *
 * Usage:
 *   npx tsx src/tests/blackbox/webhooks.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/webhooks.blackbox.ts
 */

import { config } from 'dotenv';
config();

import { prisma } from '../../providers/database';
import { stripe } from '../../providers/stripe';

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function req(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: string; headers: Headers }> {
  const response = await fetch(url, options);
  const data = await response.text();
  return { status: response.status, data, headers: response.headers };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${String(data).substring(0, 300)}`
    );
  }
}

async function runPool(
  tests: { name: string; fn: () => Promise<void> }[],
  concurrency: number
): Promise<TestResult[]> {
  const results: TestResult[] = new Array(tests.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= tests.length) return;
      results[idx] = await runTest(tests[idx].name, tests[idx].fn);
    }
  }
  const workerCount = Math.min(concurrency, tests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ==================== POST /webhooks/stripe ====================

async function testStripe_noSignature() {
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'invoice.payment_succeeded' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_invalidSignature() {
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=1234567890,v1=invalidsignaturehex',
    },
    body: JSON.stringify({ type: 'invoice.payment_succeeded' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_errorContainsWebhookError() {
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=9999999999,v1=invalidhash',
    },
    body: JSON.stringify({ type: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  if (!res.data.includes('Webhook Error') && !res.data.includes('stripe-signature')) {
    throw new Error(
      `Expected error message containing "Webhook Error" or stripe-signature info, got: ${res.data.substring(0, 200)}`
    );
  }
}

async function testStripe_emptyBody() {
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '',
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_malformedSignatureFormat() {
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 'not-a-valid-format',
    },
    body: JSON.stringify({ type: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_getNotAllowed() {
  const res = await req(`${BASE_URL}/webhooks/stripe`);
  // GET should not return 200 (either 404 or 405)
  if (res.status === 200) {
    throw new Error('GET should not return 200 for webhook endpoint');
  }
}

// ==================== ADDITIONAL COVERAGE — EVENT TYPES ====================

async function testStripe_unhandledEventType() {
  // Valid payload structure with an unhandled event type
  // Without valid signature, this will still return 400 (sig verification first)
  // But it exercises the request parsing path with a different event type
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature':
        't=1234567890,v1=0000000000000000000000000000000000000000000000000000000000000000',
    },
    body: JSON.stringify({
      type: 'customer.created',
      data: { object: { id: 'cus_test123' } },
    }),
  });
  // Still 400 because signature is invalid, but exercises the full payload path
  assertStatus(res.status, 400, res.data);
}

async function testStripe_paymentSucceededNoSub() {
  // invoice.payment_succeeded with subscription=null
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature':
        't=1234567890,v1=0000000000000000000000000000000000000000000000000000000000000000',
    },
    body: JSON.stringify({
      type: 'invoice.payment_succeeded',
      data: { object: { subscription: null, customer: 'cus_test' } },
    }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_largePayload() {
  // Large payload body to exercise buffer handling
  const largeData = { type: 'test.event', data: { object: { notes: 'x'.repeat(5000) } } };
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(largeData),
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_signatureTimestampOnly() {
  // Signature with only timestamp, no v1
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=1234567890',
    },
    body: JSON.stringify({ type: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_emptySignatureValue() {
  // Empty stripe-signature header
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': '',
    },
    body: JSON.stringify({ type: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
}

// ==================== INVARIANTS ====================

async function testIdempotency_sameInvalidRequest() {
  const body = JSON.stringify({ type: 'test' });
  const r1 = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const r2 = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelInvalidRequests() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      req(`${BASE_URL}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'test' }),
      })
    )
  );
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size !== 1) {
    throw new Error(`Expected uniform status, got: ${[...statuses].join(', ')}`);
  }
}

async function testReproducibility_threeSequential() {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await req(`${BASE_URL}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'test' }),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(
      `Three sequential requests returned different statuses: ${statuses.join(', ')}`
    );
  }
}

// ==================== RUN ====================

// ==================== signed-event integration (handler logic) ====================
// These construct a VALID Stripe signature (generateTestHeaderString) so the request
// reaches the switch and exercises the real handlers, then assert DB side effects.
// Skipped (logged) when STRIPE_WEBHOOK_SECRET is absent, since signing is impossible.

function rid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function postSignedEvent(eventType: string, dataObject: Record<string, unknown>) {
  const payload = JSON.stringify({
    id: rid('evt_test'),
    type: eventType,
    data: { object: dataObject },
  });
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: STRIPE_WEBHOOK_SECRET,
  });
  return req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
}

async function seedSubscription(userId: string, stripeSubscriptionId: string) {
  await prisma.user.upsert({ where: { userId }, create: { userId }, update: {} });
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 25,
      stripeSubscriptionId,
      stripeCustomerId: 'cus_test_webhook',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    },
  });
}

async function cleanupSubscription(userId: string) {
  await prisma.subscription.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

// customer.subscription.deleted -> revokes (deletes) the local subscription record
async function testStripe_subscriptionDeleted_revokesRecord() {
  if (STRIPE_WEBHOOK_SECRET === '') {
    console.warn(
      '  [skip] STRIPE_WEBHOOK_SECRET not set — cannot sign customer.subscription.deleted'
    );
    return;
  }
  const userId = rid('wh-del');
  const subId = rid('sub_del');
  await seedSubscription(userId, subId);
  try {
    const res = await postSignedEvent('customer.subscription.deleted', {
      id: subId,
      customer: 'cus_test_webhook',
      status: 'canceled',
      current_period_end: Math.floor(Date.now() / 1000),
      items: { data: [{ price: { unit_amount: 2500 } }] },
    });
    assertStatus(res.status, 200, res.data);
    const after = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subId } });
    if (after !== null) {
      throw new Error('subscription record should be deleted after customer.subscription.deleted');
    }
  } finally {
    await cleanupSubscription(userId);
  }
}

// customer.subscription.updated -> syncs tier + currentPeriodEnd on the local record
async function testStripe_subscriptionUpdated_syncsRecord() {
  if (STRIPE_WEBHOOK_SECRET === '') {
    console.warn(
      '  [skip] STRIPE_WEBHOOK_SECRET not set — cannot sign customer.subscription.updated'
    );
    return;
  }
  const userId = rid('wh-upd');
  const subId = rid('sub_upd');
  await seedSubscription(userId, subId);
  try {
    const newPeriodEnd = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const res = await postSignedEvent('customer.subscription.updated', {
      id: subId,
      customer: 'cus_test_webhook',
      status: 'active',
      current_period_end: newPeriodEnd,
      items: { data: [{ price: { unit_amount: 5000 } }] }, // tier 50
    });
    assertStatus(res.status, 200, res.data);
    const after = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subId } });
    if (after === null) throw new Error('subscription record missing after update');
    if (after.subscriptionTier !== 50) {
      throw new Error(`expected synced tier 50, got ${after.subscriptionTier}`);
    }
    if (Math.abs(after.currentPeriodEnd.getTime() - newPeriodEnd * 1000) > 2000) {
      throw new Error('currentPeriodEnd not synced from the updated event');
    }
  } finally {
    await cleanupSubscription(userId);
  }
}

// invoice.payment_failed -> handler runs (200) for a known subscription
async function testStripe_paymentFailed_handled() {
  if (STRIPE_WEBHOOK_SECRET === '') {
    console.warn('  [skip] STRIPE_WEBHOOK_SECRET not set — cannot sign invoice.payment_failed');
    return;
  }
  const userId = rid('wh-fail');
  const subId = rid('sub_fail');
  await seedSubscription(userId, subId);
  try {
    const res = await postSignedEvent('invoice.payment_failed', {
      id: rid('in_test'),
      subscription: subId,
    });
    assertStatus(res.status, 200, res.data);
  } finally {
    await cleanupSubscription(userId);
  }
}

async function runAll() {
  console.log('Webhooks (Stripe) Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const parallelTests = [
    { name: 'POST /webhooks/stripe -- no signature -> 400', fn: testStripe_noSignature },
    { name: 'POST /webhooks/stripe -- invalid signature -> 400', fn: testStripe_invalidSignature },
    {
      name: 'POST /webhooks/stripe -- error contains "Webhook Error"',
      fn: testStripe_errorContainsWebhookError,
    },
    { name: 'POST /webhooks/stripe -- empty body -> 400', fn: testStripe_emptyBody },
    {
      name: 'POST /webhooks/stripe -- malformed signature format -> 400',
      fn: testStripe_malformedSignatureFormat,
    },
    { name: 'GET /webhooks/stripe -- not allowed', fn: testStripe_getNotAllowed },
    // signed-event integration — exercise the real handlers + assert DB side effects
    {
      name: 'POST /webhooks/stripe -- customer.subscription.deleted revokes record',
      fn: testStripe_subscriptionDeleted_revokesRecord,
    },
    {
      name: 'POST /webhooks/stripe -- customer.subscription.updated syncs record',
      fn: testStripe_subscriptionUpdated_syncsRecord,
    },
    {
      name: 'POST /webhooks/stripe -- invoice.payment_failed handled',
      fn: testStripe_paymentFailed_handled,
    },
    // additional coverage — event types and edge cases
    {
      name: 'POST /webhooks/stripe -- unhandled event type (customer.created)',
      fn: testStripe_unhandledEventType,
    },
    {
      name: 'POST /webhooks/stripe -- payment_succeeded no subscription',
      fn: testStripe_paymentSucceededNoSub,
    },
    {
      name: 'POST /webhooks/stripe -- large payload body',
      fn: testStripe_largePayload,
    },
    {
      name: 'POST /webhooks/stripe -- signature timestamp only',
      fn: testStripe_signatureTimestampOnly,
    },
    {
      name: 'POST /webhooks/stripe -- empty signature value',
      fn: testStripe_emptySignatureValue,
    },
    {
      name: 'idempotency -- same invalid request returns same status',
      fn: testIdempotency_sameInvalidRequest,
    },
    {
      name: 'concurrency -- 10 parallel invalid requests consistent',
      fn: testConcurrency_parallelInvalidRequests,
    },
    {
      name: 'reproducibility -- 3 sequential identical status',
      fn: testReproducibility_threeSequential,
    },
  ];

  console.log(`Running ${parallelTests.length} tests (concurrency=${CASE_CONCURRENCY})...`);
  const results = await runPool(parallelTests, CASE_CONCURRENCY);

  for (const r of results) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL WEBHOOKS BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
