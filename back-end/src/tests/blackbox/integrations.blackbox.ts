#!/usr/bin/env tsx
/**
 * Black-box tests for the integrations domain (/api/integrations)
 *
 * Covers:
 *   GET    /api/integrations                           — list integrations + authenticated domains
 *   POST   /api/integrations                           — create/upsert integration
 *   PATCH  /api/integrations/:name                     — update integration
 *   DELETE /api/integrations/:name                     — delete integration
 *   POST   /api/integrations/imessage/upload           — iMessage data import
 *   POST   /api/integrations/whatsapp/upload           — WhatsApp data import
 *   POST   /api/integrations/telegram/connect          — Telegram connection
 *   POST   /api/integrations/telegram/upload           — Telegram data import
 *   POST   /api/integrations/cookies/upload            — encrypted browser cookies
 *   POST   /api/integrations/localStorage/upload       — encrypted localStorage
 *   POST   /api/integrations/indexedDB/upload          — encrypted IndexedDB
 *   POST   /api/integrations/fingerprint/upload        — encrypted browser fingerprint
 *   POST   /api/integrations/permissions/upload        — encrypted browser permissions
 *   POST   /api/integrations/cacheStorage/upload       — encrypted Cache Storage
 *   POST   /api/integrations/passwords/upload          — encrypted browser passwords
 *   POST   /api/integrations/passwords/apple/upload    — Apple passwords CSV
 *   POST   /api/integrations/passwords/request         — request new password integration
 *   POST   /api/integrations/email/:provider/start     — OAuth flow start
 *   GET    /api/integrations/email/:provider/callback  — OAuth callback (public)
 *   GET    /api/integrations/email/messages            — fetch Gmail messages
 *   POST   /api/integrations/email/send                — send email via Gmail
 *   POST   /api/integrations/upload                    — generic file upload
 *   POST   /api/integrations/linkedin/upload           — LinkedIn data import
 *   POST   /api/integrations/contacts/upload           — VCF contacts import
 *   POST   /api/integrations/email/upload              — email archive import
 *   POST   /api/integrations/claude-code/credentials/upload  — Claude Code credentials
 *   GET    /api/integrations/claude-code/credentials/token   — get Claude Code token
 *   POST   /api/integrations/claude-code/token/rate-limited  — mark token rate-limited (internal)
 *   POST   /api/integrations/claude-code/pool-token/rate-limited — mark pool token rate-limited (internal)
 *
 * Boundary capture tests (Phase 3):
 *   - POST /email/:provider/start with valid provider: asserts 0 outbound calls (DB-only)
 *   - POST / (create) with valid data: asserts 0 outbound calls (DB-only)
 *   - Validation failures that short-circuit: asserts 0 outbound calls
 *   - POST /passwords/request: asserts sendSms boundary call (Twilio/Surge)
 *
 * Invariants covered:
 *   - auth boundary: all authenticated endpoints reject 401 without auth
 *   - error-surface: all error responses include { error: string }
 *   - idempotency: create (upsert) is idempotent — same name returns updated integration
 *   - read-after-write: create → list includes the new integration
 *   - state-transition: NOT_CONNECTED → CONNECTED (via create upsert)
 *   - tenant isolation: one user cannot see another user's integrations
 *   - boundary param: exact params sent to third-party APIs are captured
 *   - call ordering: no unexpected outbound calls on DB-only endpoints
 *   - reproducibility: deterministic given the same inputs
 *   - cleanup: each test creates its own anonymous users; no shared mutable fixtures
 *   - not-found: PATCH/DELETE on nonexistent integration returns 404
 *
 * Invariants not applicable:
 *   - concurrency: integration CRUD is per-user upsert; no concurrent mutation risk
 *   - ordering/pagination: list endpoint has no pagination parameters
 *   - atomicity: upsert operations are single Prisma calls
 *   - referential integrity: enforced by Prisma/Postgres, not by the integration layer
 *   - harness independence: no background jobs affect the test (async processing is fire-and-forget)
 *   - observability: covered by the runner's manifest and artifact directory
 *   - time/clock: no timestamp assertions needed beyond date field presence
 *
 * Usage:
 *   npx tsx src/tests/blackbox/integrations.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/integrations.blackbox.ts
 */

import { deepStrictEqual } from 'node:assert';
import {
  prisma,
  createAnonSession,
  request,
  authHeaders,
  assertStatus,
  assert,
  BASE_URL,
  CASE_CONCURRENCY,
  ctx,
  setup,
  runPool,
  runTest,
  teardown,
  withComputePoolLock,
  TestResult,
} from './integrations.context';
import { assertIntegrationRegistration } from './integrations.registration';
import { parallelTestsPart1 } from './integrations.registry-parallel-1.cases';
import { parallelTestsPart2 } from './integrations.registry-parallel-2.cases';
import { parallelTestsPart3 } from './integrations.registry-parallel-3.cases';
import { parallelTestsPart4 } from './integrations.registry-parallel-4.cases';
import { parallelTestsPart5 } from './integrations.registry-parallel-5.cases';
import { sequentialTestsPart1 } from './integrations.registry-sequential-1.cases';
import { pooledSequentialTestsPart1 } from './integrations.registry-pooledsequential-1.cases';
import { boundarySequentialTestsPart1 } from './integrations.registry-boundarysequential-1.cases';

async function testGetIntegrations_readableOtpInboxBoundary() {
  const first = await createAnonSession();
  const other = await createAnonSession();
  const integration = await prisma.integration.create({
    data: {
      userId: first.userId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      config: { connectedEmails: ['configured-only@example.test'] },
    },
  });
  const foreign = await prisma.integration.create({
    data: {
      userId: other.userId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
    },
  });
  const url = `${BASE_URL}/api/integrations`;
  const before = await request(url, { headers: authHeaders(first.accessToken) });
  assertStatus(before.status, 200, before.data);
  type Listed = { name: string; readableInboxEmails?: string[]; emailCredentials?: unknown[] };
  const gmail = (body: unknown) =>
    (body as { integrations: Listed[] }).integrations.find((row) => row.name === 'gmail');
  deepStrictEqual(
    gmail(before.data)?.readableInboxEmails,
    [],
    'connected Gmail without OTP selectors must expose an explicit empty set'
  );
  await prisma.emailIntegrationCredential.createMany({
    data: [
      {
        userId: first.userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'READABLE@example.test',
        accessToken: 'private-access-one',
        refreshToken: 'private-refresh-one',
      },
      {
        userId: first.userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'stale@example.test',
        accessToken: 'private-access-stale',
        refreshToken: 'private-refresh-stale',
        state: 'needs_reconnect',
      },
      {
        userId: first.userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'tokenless@example.test',
      },
      {
        userId: other.userId,
        integrationId: foreign.id,
        provider: 'GMAIL',
        email: 'foreign@example.test',
        accessToken: 'private-access-foreign',
        refreshToken: 'private-refresh-foreign',
      },
    ],
  });
  const after = await request(url, { headers: authHeaders(first.accessToken) });
  assertStatus(after.status, 200, after.data);
  deepStrictEqual(gmail(after.data)?.readableInboxEmails, ['readable@example.test']);
  const foreignResponse = await request(url, { headers: authHeaders(other.accessToken) });
  assertStatus(foreignResponse.status, 200, foreignResponse.data);
  deepStrictEqual(gmail(foreignResponse.data)?.readableInboxEmails, ['foreign@example.test']);
  const serialized = JSON.stringify(after.data);
  for (const secret of ['private-access', 'private-refresh', 'foreign@example.test']) {
    assert(
      !serialized.includes(secret),
      'OTP selector response must not expose tokens or another user'
    );
  }
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('Integrations Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  // Phase 1: Setup
  console.log('Setting up auth sessions...');
  await setup();
  console.log(`  User 1: ${ctx.userId1}`);
  console.log(`  User 2: ${ctx.userId2}`);
  console.log(`  Capture available: ${ctx.captureAvailable}\n`);

  // Phase 2: Parallel independent tests
  const parallelTests = [
    ...parallelTestsPart1(),
    ...parallelTestsPart2(),
    ...parallelTestsPart3(),
    ...parallelTestsPart4(),
    ...parallelTestsPart5(),
  ];
  const readableInboxPredecessor = parallelTests.findIndex(
    (test) => test.fn.name === 'testGetIntegrations_derivesConnectedEmailsFromCredentials'
  );
  assert(readableInboxPredecessor >= 0, 'OTP selector owning test predecessor remains registered');
  parallelTests.splice(readableInboxPredecessor + 1, 0, {
    name: 'GET /integrations preserves OTP selector scope, emptiness, tenant isolation and no secrets',
    fn: testGetIntegrations_readableOtpInboxBoundary,
  });
  assertIntegrationRegistration('parallelTests', parallelTests);

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  for (const r of parallelResults) {
    const icon = r.passed ? '  PASS' : '  FAIL';
    console.log(`${icon}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`);
  }

  // Phase 3: Sequential tests (state-dependent + boundary capture)
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [...sequentialTestsPart1()];
  assertIntegrationRegistration('sequentialTests', sequentialTests);

  // Pool-mutating sequential tests: seed/select/disable rows in the SHARED
  // compute-token pool and assert exact LRU selection. Run under the
  // cross-process advisory lock (see withComputePoolLock) so a concurrent
  // suite instance sharing this database cannot perturb pool state mid-test.
  const pooledSequentialTests: { name: string; fn: () => Promise<void> }[] = [
    ...pooledSequentialTestsPart1(),
  ];
  assertIntegrationRegistration('pooledSequentialTests', pooledSequentialTests);

  const boundarySequentialTests: { name: string; fn: () => Promise<void> }[] = [];
  if (ctx.captureAvailable) {
    boundarySequentialTests.push(...boundarySequentialTestsPart1());
    assertIntegrationRegistration('boundarySequentialTests', boundarySequentialTests);
  } else {
    console.log(
      '\n  [info] Capture not available (BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) -- skipping boundary tests'
    );
  }

  const totalSequential =
    sequentialTests.length + pooledSequentialTests.length + boundarySequentialTests.length;
  console.log(`\nRunning ${totalSequential} sequential tests...`);
  const sequentialResults: TestResult[] = [];
  const runSequentialGroup = async (tests: { name: string; fn: () => Promise<void> }[]) => {
    for (const test of tests) {
      const result = await runTest(test.name, test.fn);
      sequentialResults.push(result);
      const icon = result.passed ? '  PASS' : '  FAIL';
      console.log(
        `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
      );
    }
  };
  await runSequentialGroup(sequentialTests);
  await withComputePoolLock(() => runSequentialGroup(pooledSequentialTests));
  await runSequentialGroup(boundarySequentialTests);

  // Summary
  const allResults = [...parallelResults, ...sequentialResults];
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);

  await teardown();

  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }

  console.log('\nALL INTEGRATIONS BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch(async (error) => {
  console.error('\nBlack-box test suite crashed:', error);
  await teardown().catch((e) => console.error('Teardown also failed:', e));
  process.exit(1);
});
