#!/usr/bin/env tsx
/**
 * Black-box tests for the WhatsApp Cloud API webhook.
 *
 * Domain surface:
 *   GET  /api/whatsapp/webhook  — Meta subscription-verification handshake
 *   POST /api/whatsapp/webhook  — inbound messages + delivery/read receipts
 *
 * This is the WhatsApp analogue of sms-webhook.blackbox.ts. Texting Rose over
 * WhatsApp routes through the SAME SMS supervisor with channel=WHATSAPP, so the
 * HTTP surface is what's WhatsApp-specific and worth pinning:
 *
 * Invariants covered:
 *   - verification handshake: correct hub.verify_token echoes hub.challenge (200
 *     text/plain); wrong token or wrong mode -> 403
 *   - signature verification (pure fn): a body signed with the app secret passes;
 *     a tampered body / bad scheme / absent header fails (constant-time compare)
 *   - waId normalization: Meta's `15551234567` -> `+15551234567` (matches User.phone)
 *   - inbound parsing: first text message extracted; status-only receipts and
 *     non-text media yield no route (acknowledged 200, no provisioning)
 *   - provisioning: an unknown WhatsApp number is SILENTLY onboarded (User row
 *     created) and routes to the supervisor (lastInboundSeq bumped)
 *   - harness independence: supervisor runs async; webhook returns 200 immediately
 *   - idempotency / concurrency / reproducibility on the verification endpoint
 *
 * Usage:
 *   npx tsx src/tests/blackbox/whatsapp-webhook.blackbox.ts
 */

import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from '../../providers/whatsappCloud';
import {
  parseWhatsAppInbound,
  normalizeWaId,
  resolveWebhookVerification,
  isStatusOnlyEvent,
} from '../../domains/whatsapp-webhook/service.validation';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '';

const prisma = new PrismaClient();

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data: unknown;
  const ct = response.headers.get('content-type');
  if (ct?.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }
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
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
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

// ==================== PURE-FUNCTION COVERAGE ====================
// The signature check is gated on IS_PRODUCTION, so it can't be exercised via
// HTTP in dev. Test the pure functions directly.

async function testUnit_normalizeWaId() {
  assertEqual(normalizeWaId('15551234567'), '+15551234567', 'plain digits');
  assertEqual(normalizeWaId('+15551234567'), '+15551234567', 'already plus');
  assertEqual(normalizeWaId('1 (555) 123-4567'), '+15551234567', 'formatted');
}

async function testUnit_verifyMetaSignature_valid() {
  const secret = 'test_app_secret';
  const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const hmac = createHmac('sha256', secret).update(rawBody, 'utf-8').digest('hex');
  if (!verifyMetaSignature(`sha256=${hmac}`, rawBody, secret)) {
    throw new Error('valid signature should verify');
  }
}

async function testUnit_verifyMetaSignature_rejects() {
  const secret = 'test_app_secret';
  const rawBody = JSON.stringify({ a: 1 });
  const good = createHmac('sha256', secret).update(rawBody, 'utf-8').digest('hex');
  // tampered body
  if (verifyMetaSignature(`sha256=${good}`, JSON.stringify({ a: 2 }), secret)) {
    throw new Error('tampered body must fail');
  }
  // wrong scheme
  if (verifyMetaSignature(`sha1=${good}`, rawBody, secret)) {
    throw new Error('wrong scheme must fail');
  }
  // absent header
  if (verifyMetaSignature(undefined, rawBody, secret)) {
    throw new Error('absent header must fail');
  }
  // wrong secret
  if (verifyMetaSignature(`sha256=${good}`, rawBody, 'other_secret')) {
    throw new Error('wrong secret must fail');
  }
}

async function testUnit_resolveWebhookVerification() {
  const token = 'verify_tok';
  assertEqual(
    resolveWebhookVerification({ mode: 'subscribe', token, challenge: 'CHAL' }, token),
    'CHAL',
    'match echoes challenge'
  );
  assertEqual(
    resolveWebhookVerification({ mode: 'subscribe', token: 'nope', challenge: 'CHAL' }, token),
    null,
    'wrong token -> null'
  );
  assertEqual(
    resolveWebhookVerification({ mode: 'unsubscribe', token, challenge: 'CHAL' }, token),
    null,
    'wrong mode -> null'
  );
  assertEqual(
    resolveWebhookVerification({ mode: 'subscribe', token, challenge: 'CHAL' }, undefined),
    null,
    'no expected token -> null'
  );
}

function inboundPayload(from: string, text: string): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551976475', phone_number_id: 'PNID' },
              contacts: [{ profile: { name: 'Tester' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: 'wamid.TEST',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551976475', phone_number_id: 'PNID' },
              statuses: [
                {
                  id: 'wamid.OUT',
                  status: 'delivered',
                  timestamp: '1700000001',
                  recipient_id: '15551234567',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function testUnit_parseInbound_text() {
  const parsed = parseWhatsAppInbound(inboundPayload('15551234567', '  hello rose  '));
  if (parsed === null) throw new Error('expected a parsed message');
  assertEqual(parsed.fromPhone, '+15551234567', 'fromPhone normalized');
  assertEqual(parsed.messageBody, 'hello rose', 'body trimmed');
  assertEqual(parsed.messageId, 'wamid.TEST', 'messageId');
}

async function testUnit_parseInbound_statusOnly() {
  assertEqual(isStatusOnlyEvent(statusPayload()), true, 'status-only detected');
  assertEqual(parseWhatsAppInbound(statusPayload()), null, 'status-only yields no message');
}

async function testUnit_parseInbound_nonText() {
  const image = inboundPayload('15551234567', 'x');
  // Replace the text message with an image message (no text.body).
  (
    ((image.entry as Record<string, unknown>[])[0].changes as Record<string, unknown>[])[0]
      .value as Record<string, unknown>
  ).messages = [
    {
      from: '15551234567',
      id: 'wamid.IMG',
      timestamp: '1700000000',
      type: 'image',
      image: { id: 'MEDIA' },
    },
  ];
  assertEqual(parseWhatsAppInbound(image), null, 'non-text yields no message (v1 media follow-up)');
}

// ==================== GET verification (HTTP) ====================

async function testVerify_correctTokenEchoesChallenge() {
  if (VERIFY_TOKEN === '') throw new Error('WHATSAPP_WEBHOOK_VERIFY_TOKEN not set in test env');
  const challenge = 'challenge_12345';
  const url = `${BASE_URL}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
    VERIFY_TOKEN
  )}&hub.challenge=${challenge}`;
  const res = await request(url);
  assertStatus(res.status, 200, res.data);
  if (res.data !== challenge) {
    throw new Error(`Expected challenge echoed, got: ${JSON.stringify(res.data)}`);
  }
}

async function testVerify_wrongTokenForbidden() {
  const url = `${BASE_URL}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=x`;
  const res = await request(url);
  assertStatus(res.status, 403, res.data);
}

async function testVerify_wrongModeForbidden() {
  if (VERIFY_TOKEN === '') throw new Error('WHATSAPP_WEBHOOK_VERIFY_TOKEN not set in test env');
  const url = `${BASE_URL}/api/whatsapp/webhook?hub.mode=unsubscribe&hub.verify_token=${encodeURIComponent(
    VERIFY_TOKEN
  )}&hub.challenge=x`;
  const res = await request(url);
  assertStatus(res.status, 403, res.data);
}

// ==================== POST inbound (HTTP) ====================

async function testInbound_statusOnlyAcknowledgedNotRouted() {
  const res = await request(`${BASE_URL}/api/whatsapp/webhook`, {
    method: 'POST',
    body: JSON.stringify(statusPayload()),
  });
  assertStatus(res.status, 200, res.data);
}

async function testInbound_nonTextAcknowledged() {
  const image = inboundPayload('15559990000', 'x');
  (
    ((image.entry as Record<string, unknown>[])[0].changes as Record<string, unknown>[])[0]
      .value as Record<string, unknown>
  ).messages = [
    {
      from: '15559990000',
      id: 'wamid.IMG',
      timestamp: '1700000000',
      type: 'image',
      image: { id: 'MEDIA' },
    },
  ];
  const res = await request(`${BASE_URL}/api/whatsapp/webhook`, {
    method: 'POST',
    body: JSON.stringify(image),
  });
  assertStatus(res.status, 200, res.data);
  // No provisioning for non-text in v1.
  const user = await prisma.user.findFirst({ where: { phone: '+15559990000' } });
  if (user) {
    await prisma.user.deleteMany({ where: { phone: '+15559990000' } }).catch(() => {});
    throw new Error('non-text message must not provision a user');
  }
}

async function testInbound_malformedAcknowledged() {
  const res = await request(`${BASE_URL}/api/whatsapp/webhook`, {
    method: 'POST',
    body: JSON.stringify({ object: 'whatsapp_business_account' }),
  });
  assertStatus(res.status, 200, res.data);
}

let phoneCounter = 0;
function uniqueWaNumber(): string {
  phoneCounter++;
  const rand = Math.floor(1000 + Math.random() * 9000);
  const counter = String(phoneCounter).padStart(3, '0');
  return `1926${rand}${counter}`; // digits, no '+', NANP-ish
}

async function testInbound_newNumberProvisionsAndRoutes() {
  const wa = uniqueWaNumber();
  const phone = `+${wa}`;
  let userId: string | undefined;
  try {
    const res = await request(`${BASE_URL}/api/whatsapp/webhook`, {
      method: 'POST',
      body: JSON.stringify(inboundPayload(wa, 'hey rose, what can you do?')),
    });
    assertStatus(res.status, 200, res.data);
    const body = res.data as { ok?: boolean };
    if (body.ok !== true) throw new Error(`Expected { ok: true }, got ${JSON.stringify(res.data)}`);

    const user = await prisma.user.findFirst({ where: { phone } });
    if (!user) throw new Error('Expected new WhatsApp number to be provisioned as a User row');
    userId = user.userId;
    // An inbound WhatsApp message marks the user reachable so lifecycle/onboarding
    // notifications mirror to WhatsApp (and self-heal a previously-unreachable flag).
    if (user.whatsappReachable !== true) {
      throw new Error(
        `Expected inbound WhatsApp to set whatsappReachable=true, got ${String(user.whatsappReachable)}`
      );
    }
    // routeToSupervisor bumps the inbound seq synchronously before the async run.
    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session || session.lastInboundSeq < 1) {
      throw new Error('Expected provisioned user to route to supervisor (lastInboundSeq >= 1)');
    }
  } finally {
    if (userId) {
      // Supersede the in-flight run so its background reply self-cancels, then
      // remove every row this test created.
      await prisma.smsSession
        .updateMany({ where: { userId }, data: { lastInboundSeq: 9999 } })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      await prisma.smsSession.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.credit.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.agent.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { userId } }).catch(() => {});
    }
  }
}

// ==================== invariants on verification endpoint ====================

async function testConcurrency_parallelVerify() {
  if (VERIFY_TOKEN === '') throw new Error('WHATSAPP_WEBHOOK_VERIFY_TOKEN not set in test env');
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      request(
        `${BASE_URL}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
          VERIFY_TOKEN
        )}&hub.challenge=c${i}`
      )
    )
  );
  for (let i = 0; i < results.length; i++) {
    assertStatus(results[i].status, 200, results[i].data);
    if (results[i].data !== `c${i}`) throw new Error('challenge mismatch under concurrency');
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('WhatsApp Webhook Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const parallelTests = [
    // pure-function coverage (no server needed, safe to parallelize)
    { name: 'unit -- normalizeWaId', fn: testUnit_normalizeWaId },
    { name: 'unit -- verifyMetaSignature accepts valid', fn: testUnit_verifyMetaSignature_valid },
    {
      name: 'unit -- verifyMetaSignature rejects tampered/bad',
      fn: testUnit_verifyMetaSignature_rejects,
    },
    { name: 'unit -- resolveWebhookVerification', fn: testUnit_resolveWebhookVerification },
    { name: 'unit -- parseWhatsAppInbound text', fn: testUnit_parseInbound_text },
    { name: 'unit -- parseWhatsAppInbound status-only', fn: testUnit_parseInbound_statusOnly },
    { name: 'unit -- parseWhatsAppInbound non-text', fn: testUnit_parseInbound_nonText },
    // GET verification
    {
      name: 'GET /whatsapp/webhook -- correct token echoes challenge',
      fn: testVerify_correctTokenEchoesChallenge,
    },
    { name: 'GET /whatsapp/webhook -- wrong token -> 403', fn: testVerify_wrongTokenForbidden },
    { name: 'GET /whatsapp/webhook -- wrong mode -> 403', fn: testVerify_wrongModeForbidden },
    // POST acknowledge-only paths (no provisioning)
    {
      name: 'POST /whatsapp/webhook -- status-only receipt acknowledged',
      fn: testInbound_statusOnlyAcknowledgedNotRouted,
    },
    {
      name: 'POST /whatsapp/webhook -- non-text acknowledged, not provisioned',
      fn: testInbound_nonTextAcknowledged,
    },
    {
      name: 'POST /whatsapp/webhook -- malformed acknowledged',
      fn: testInbound_malformedAcknowledged,
    },
    // invariants
    { name: 'concurrency -- 10 parallel verifies consistent', fn: testConcurrency_parallelVerify },
  ];

  const sequentialTests = [
    {
      name: 'POST /whatsapp/webhook -- new number provisions + routes to supervisor',
      fn: testInbound_newNumberProvisionsAndRoutes,
    },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  console.log(`Running ${sequentialTests.length} sequential tests...`);
  const sequentialResults: TestResult[] = [];
  for (const test of sequentialTests) {
    sequentialResults.push(await runTest(test.name, test.fn));
  }

  const allResults = [...parallelResults, ...sequentialResults];
  for (const r of allResults) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);

  await prisma.$disconnect();

  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL WHATSAPP WEBHOOK BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
