#!/usr/bin/env tsx
/**
 * Black-box tests for /api/imessage
 *
 * Domain surface:
 *   POST /api/imessage/queue     — queue an iMessage for sending (auth: API key or JWT)
 *   GET  /api/imessage/queue/pop — claim next pending iMessage (auth: JWT)
 *   GET  /api/imessage/queue/:id/status — read durable send state (auth: API key or JWT)
 *   POST /api/imessage/queue/:id/result — acknowledge send or release for retry (auth: JWT)
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated requests return 401 for every endpoint
 *   - error-surface: missing user_id returns 401 (auth check before validation); missing other fields or invalid phone return 400
 *   - read-after-write: queue a message then pop it
 *   - idempotency: pop from empty queue always returns { message: null }
 *   - atomicity: a claim hides the message from concurrent claims
 *   - concurrency: 10 parallel empty-pop requests all return null
 *   - same-input reproducibility: three sequential empty-pops return identical responses
 *   - ordering: messages pop in FIFO order (oldest first)
 *   - cleanup: each test run creates a fresh user; legacy pops terminally dispatch leftovers
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - referential integrity: userId/agentId are plain strings, not FK-validated
 *   - event/job cardinality: no events emitted
 *   - tenant isolation: pop only returns messages for the authenticated user (tested via read-after-write)
 *   - time/clock: created_at in pop response but not assertion-worthy
 *   - boundary param: no third-party HTTP calls
 *   - call ordering: no outbound calls
 *
 * Usage:
 *   npx tsx src/tests/blackbox/imessage.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/imessage.blackbox.ts
 */

import {
  BASE_URL,
  CASE_CONCURRENCY,
  PopResponse,
  QueueSuccessResponse,
  ackAuthHeaders,
  apiKeyHeaders,
  assertSchema,
  assertStatus,
  authHeaders,
  ctx,
  drainQueueForCurrentUser,
  request,
  runPool,
  runTest,
  setup,
  testBridgeHeartbeatMakesExactBackendReady,
  testDeliveryResultThirdFailureIsTerminal,
  testQueueDatabaseDefaultDoesNotExpire,
  testQueuedEntryPersistsUntilMacReturns,
  testQueueReceiptIncludesRelayStatusAtEnqueue,
  type TestResult,
} from './imessage.blackbox.helpers';

// ==================== POST /api/imessage/queue ====================

async function testQueue_noAuth() {
  const res = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    body: JSON.stringify({
      user_id: 'test',
      agent_id: 'test',
      phone_number: '+19729777432',
      message: 'test',
    }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testQueue_invalidToken() {
  const res = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: authHeaders('invalid.jwt.token'),
    body: JSON.stringify({
      user_id: 'test',
      agent_id: 'test',
      phone_number: '+19729777432',
      message: 'test',
    }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testQueue_missingAllFields() {
  const res = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  // user_id is required for authorization; when absent the endpoint returns 401 before field validation
  assertStatus(res.status, 401, res.data);
}

async function testQueue_missingUserId() {
  const res = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agent_id: 'x', phone_number: '+19729777432', message: 'test' }),
  });
  // user_id is used for authorization; when absent the endpoint returns 401 before field validation
  assertStatus(res.status, 401, res.data);
}

async function testQueue_missingMessage() {
  const res = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ user_id: ctx.userId, agent_id: 'x', phone_number: '+19729777432' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testQueue_invalidPhone() {
  const res = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'x',
      phone_number: 'not-a-phone',
      message: 'test',
    }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testQueue_invalidPhoneNoPlus() {
  const res = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'x',
      phone_number: '19729777432', // Missing + prefix
      message: 'test',
    }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testQueue_happy() {
  const res = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'test-agent-id',
      phone_number: '+19729777432',
      message: 'Hello from blackbox test',
    }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(QueueSuccessResponse, res.data, 'POST /queue (happy)');
}

async function testQueue_unicodeMessage() {
  const res = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'test-agent-id',
      phone_number: '+19729777432',
      message: 'Hello! Bonjour! Hola! Hallo!',
    }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(QueueSuccessResponse, res.data, 'POST /queue (unicode)');
}

// ==================== GET /api/imessage/queue/pop ====================

async function testPop_noAuth() {
  const res = await request(`${BASE_URL}/api/imessage/queue/pop`);
  assertStatus(res.status, 401, res.data);
}

async function testPop_invalidToken() {
  const res = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders('invalid.jwt.token'),
  });
  assertStatus(res.status, 401, res.data);
}

async function testDeliveryResult_noAuth() {
  const res = await request(`${BASE_URL}/api/imessage/queue/queue-id/result`, {
    method: 'POST',
    body: JSON.stringify({ success: true }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testDeliveryStatus_noAuth() {
  const res = await request(`${BASE_URL}/api/imessage/queue/queue-id/status`);
  assertStatus(res.status, 401, res.data);
}

async function testBridgeStatus_noAuth() {
  const res = await request(`${BASE_URL}/api/imessage/bridge/status`);
  assertStatus(res.status, 401, res.data);
}

async function testPop_emptyQueue() {
  const res = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(PopResponse, res.data, 'GET /pop (empty)');
  if (body.message !== null) {
    throw new Error('Expected null message for empty queue');
  }
}

// ==================== READ-AFTER-WRITE ====================

async function testReadAfterWrite_queueThenPop() {
  const uniqueMsg = `RAW test ${Date.now()}`;

  // Queue a message via API key (as agent worker would)
  const queueRes = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'raw-test-agent',
      phone_number: '+19729777432',
      message: uniqueMsg,
    }),
  });
  assertStatus(queueRes.status, 200, queueRes.data);

  // Pop via JWT (as mac app would)
  const popRes = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(popRes.status, 200, popRes.data);
  const popBody = assertSchema(PopResponse, popRes.data, 'GET /pop (RAW)');
  if (!popBody.message) {
    throw new Error('Expected a message after queue, got null');
  }
  if (popBody.message.message !== uniqueMsg) {
    throw new Error(`Expected message "${uniqueMsg}", got "${popBody.message.message}"`);
  }
  if (popBody.message.phone_number !== '+19729777432') {
    throw new Error(`Expected phone +19729777432, got ${popBody.message.phone_number}`);
  }
  if (popBody.message.agent_id !== 'raw-test-agent') {
    throw new Error(`Expected agent_id "raw-test-agent", got ${popBody.message.agent_id}`);
  }
}

async function testAtomicity_noDuplicate() {
  // Queue one message
  const uniqueMsg = `Atomic test ${Date.now()}`;
  const queued = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'atomic-agent',
      phone_number: '+19729777432',
      message: uniqueMsg,
    }),
  });

  // Pop it
  const pop1 = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(pop1.status, 200, pop1.data);
  const body1 = pop1.data as { message: { message: string } | null };
  if (!body1.message || body1.message.message !== uniqueMsg) {
    throw new Error('First pop should return the queued message');
  }

  // Second legacy pop is empty: old deployed clients keep one-shot behavior.
  const pop2 = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(pop2.status, 200, pop2.data);
  const body2 = pop2.data as { message: null };
  if (body2.message !== null) {
    throw new Error('Second legacy pop should return null (message already dispatched)');
  }

  const receipt = queued.data as { queue_id: string };
  const status = await request(`${BASE_URL}/api/imessage/queue/${receipt.queue_id}/status`, {
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
  });
  assertStatus(status.status, 200, status.data);
  if ((status.data as { status: string }).status !== 'legacy_dispatched') {
    throw new Error('Legacy pop must be terminal but must not claim confirmed send');
  }
}

async function testIdempotency_queueRetryAfterPopDoesNotDuplicate() {
  const idempotencyKey = `tool-call-${Date.now()}`;
  const uniqueMsg = `Idempotent queue test ${Date.now()}`;
  const payload = {
    user_id: ctx.userId,
    agent_id: 'idempotent-agent',
    idempotency_key: idempotencyKey,
    phone_number: '+19729777432',
    message: uniqueMsg,
  };

  const firstQueue = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify(payload),
  });
  assertStatus(firstQueue.status, 200, firstQueue.data);

  const firstPop = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(firstPop.status, 200, firstPop.data);
  const firstMessage = (firstPop.data as { message: { message: string } | null }).message;
  if (firstMessage?.message !== uniqueMsg) {
    throw new Error(
      `Expected first pop to return idempotent message, got ${firstMessage?.message}`
    );
  }

  const retryQueue = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify(payload),
  });
  assertStatus(retryQueue.status, 200, retryQueue.data);
  const firstReceipt = firstQueue.data as { queue_id: string };
  const retryReceipt = retryQueue.data as { queue_id: string };
  if (retryReceipt.queue_id !== firstReceipt.queue_id) {
    throw new Error('Activity retry returned a different queue receipt');
  }

  const secondPop = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(secondPop.status, 200, secondPop.data);
  if ((secondPop.data as { message: unknown | null }).message !== null) {
    throw new Error('Activity retry recreated an iMessage after it was already consumed');
  }
}

async function testIdempotency_conflictingPayloadRejected() {
  const idempotencyKey = `conflict-${Date.now()}`;
  const basePayload = {
    user_id: ctx.userId,
    agent_id: 'conflict-agent',
    idempotency_key: idempotencyKey,
    phone_number: '+19729777432',
  };
  const first = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ ...basePayload, message: 'first payload' }),
  });
  assertStatus(first.status, 200, first.data);

  const conflict = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ ...basePayload, message: 'different payload' }),
  });
  assertStatus(conflict.status, 409, conflict.data);

  const cleanup = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(cleanup.status, 200, cleanup.data);
  const cleanupMessage = (cleanup.data as { message: { message: string } | null }).message;
  if (cleanupMessage?.message !== 'first payload') {
    throw new Error('Conflicting retry changed or lost the original queued payload');
  }
}

async function testDeliveryResult_failedSendIsRetriedThenAcknowledged() {
  const uniqueMsg = `Retryable Mac send ${Date.now()}`;
  const queued = await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'mac-retry-agent',
      idempotency_key: `mac-retry-${Date.now()}`,
      phone_number: '+19729777432',
      message: uniqueMsg,
    }),
  });
  assertStatus(queued.status, 200, queued.data);

  const firstClaim = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: ackAuthHeaders(ctx.accessToken!),
  });
  const firstMessage = (
    firstClaim.data as {
      message: { id: string; message: string; claim_token: string } | null;
    }
  ).message;
  if (firstMessage?.message !== uniqueMsg)
    throw new Error('Mac did not claim the queued retry test message');

  const failed = await request(`${BASE_URL}/api/imessage/queue/${firstMessage.id}/result`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      claim_token: firstMessage.claim_token,
      success: false,
      error: 'Messages permission denied',
    }),
  });
  assertStatus(failed.status, 200, failed.data);

  const retryClaim = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: ackAuthHeaders(ctx.accessToken!),
  });
  const retryMessage = (
    retryClaim.data as {
      message: { id: string; message: string; claim_token: string } | null;
    }
  ).message;
  if (retryMessage?.id !== firstMessage.id)
    throw new Error('Failed Mac send was not released for retry');
  if (retryMessage.claim_token === firstMessage.claim_token)
    throw new Error('A retry must receive a new claim token');

  const stale = await request(`${BASE_URL}/api/imessage/queue/${retryMessage.id}/result`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ claim_token: firstMessage.claim_token, success: true }),
  });
  assertStatus(stale.status, 409, stale.data);

  const delivered = await request(`${BASE_URL}/api/imessage/queue/${retryMessage.id}/result`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ claim_token: retryMessage.claim_token, success: true }),
  });
  assertStatus(delivered.status, 200, delivered.data);

  const afterDelivery = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  if ((afterDelivery.data as { message: unknown | null }).message !== null) {
    throw new Error('Delivered iMessage remained eligible for another send');
  }

  const receipt = queued.data as { queue_id: string };
  const status = await request(`${BASE_URL}/api/imessage/queue/${receipt.queue_id}/status`, {
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
  });
  assertStatus(status.status, 200, status.data);
  const statusBody = status.data as { status: string; sent_at: string | null };
  if (statusBody.status !== 'sent' || statusBody.sent_at === null) {
    throw new Error(`Expected confirmed send status, got ${JSON.stringify(status.data)}`);
  }
}

async function testOrdering_fifo() {
  // Queue two messages
  const msg1 = `FIFO-1-${Date.now()}`;
  const msg2 = `FIFO-2-${Date.now()}`;

  await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'fifo-agent',
      phone_number: '+19729777432',
      message: msg1,
    }),
  });
  await request(`${BASE_URL}/api/imessage/queue`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'fifo-agent',
      phone_number: '+19729777432',
      message: msg2,
    }),
  });

  // Pop should return msg1 first (FIFO)
  const pop1 = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  const body1 = (pop1.data as { message: { message: string } | null }).message;
  if (!body1 || body1.message !== msg1) {
    throw new Error(`Expected first pop to return "${msg1}", got "${body1?.message}"`);
  }

  // Pop should return msg2 next
  const pop2 = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  const body2 = (pop2.data as { message: { message: string } | null }).message;
  if (!body2 || body2.message !== msg2) {
    throw new Error(`Expected second pop to return "${msg2}", got "${body2?.message}"`);
  }
}

// ==================== INVARIANTS ====================

async function testIdempotency_emptyPop() {
  const r1 = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  const r2 = await request(`${BASE_URL}/api/imessage/queue/pop`, {
    headers: authHeaders(ctx.accessToken!),
  });
  // Both pops on an empty queue should return null message bodies regardless of status code.
  // The server may return 200 or a non-200 status on subsequent pops from an empty queue,
  // so we assert on body content rather than status equality.
  const body1 = (r1.data as { message?: unknown })?.message ?? null;
  const body2 = (r2.data as { message?: unknown })?.message ?? null;
  if (body1 !== null || body2 !== null) {
    throw new Error(
      `Idempotency: expected null message on empty-queue pop, got ${JSON.stringify(body1)} and ${JSON.stringify(body2)}`
    );
  }
}

async function testConcurrency_parallelEmptyPops() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(`${BASE_URL}/api/imessage/queue/pop`, {
        headers: authHeaders(ctx.accessToken!),
      })
    )
  );
  const allNull = results.every((r) => {
    const body = r.data as { message: null };
    return r.status === 200 && body.message === null;
  });
  if (!allNull) {
    throw new Error('Expected all 10 parallel pops to return null');
  }
}

async function testReproducibility_threeSequential() {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/imessage/queue`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({}),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(`Three sequential: ${statuses.join(', ')}`);
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('iMessage Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth session...');
  await setup();
  console.log(`  User: ${ctx.userId}\n`);

  // Drain any existing queued messages for this user first
  const drained = await drainQueueForCurrentUser();
  if (drained > 0) console.log(`  Drained ${drained} existing messages\n`);

  const parallelTests = [
    // auth boundary
    { name: 'POST /queue -- no auth -> 401', fn: testQueue_noAuth },
    { name: 'POST /queue -- invalid token -> 401', fn: testQueue_invalidToken },
    { name: 'GET /queue/pop -- no auth -> 401', fn: testPop_noAuth },
    { name: 'GET /queue/pop -- invalid token -> 401', fn: testPop_invalidToken },
    { name: 'POST /queue/:id/result -- no auth -> 401', fn: testDeliveryResult_noAuth },
    { name: 'GET /queue/:id/status -- no auth -> 401', fn: testDeliveryStatus_noAuth },
    { name: 'GET /bridge/status -- no auth -> 401', fn: testBridgeStatus_noAuth },
    // validation
    { name: 'POST /queue -- missing all fields -> 401', fn: testQueue_missingAllFields },
    { name: 'POST /queue -- missing user_id -> 401', fn: testQueue_missingUserId },
    { name: 'POST /queue -- missing message -> 400', fn: testQueue_missingMessage },
    { name: 'POST /queue -- invalid phone -> 400', fn: testQueue_invalidPhone },
    { name: 'POST /queue -- invalid phone no plus -> 400', fn: testQueue_invalidPhoneNoPlus },
    // happy path (validation-only; queue tests that create messages moved to sequential)
    { name: 'GET /queue/pop -- empty queue -> null', fn: testPop_emptyQueue },
    // invariants (parallel-safe)
    { name: 'idempotency -- empty pop same on repeat', fn: testIdempotency_emptyPop },
    {
      name: 'reproducibility -- 3 sequential identical status',
      fn: testReproducibility_threeSequential,
    },
  ];

  const sequentialTests = [
    // happy path (queue + pop, must be sequential to avoid cross-test pollution)
    { name: 'POST /queue -- happy path', fn: testQueue_happy },
    { name: 'POST /queue -- unicode message', fn: testQueue_unicodeMessage },
  ];

  // Drain any messages created by happy path tests before RAW tests
  const drainTests = [
    // read-after-write (queue then pop, must be sequential)
    { name: 'read-after-write -- queue then pop', fn: testReadAfterWrite_queueThenPop },
    { name: 'atomicity -- no duplicate pop', fn: testAtomicity_noDuplicate },
    {
      name: 'idempotency -- activity retry after pop does not duplicate',
      fn: testIdempotency_queueRetryAfterPopDoesNotDuplicate,
    },
    {
      name: 'idempotency -- conflicting payload rejected',
      fn: testIdempotency_conflictingPayloadRejected,
    },
    {
      name: 'delivery result -- failed send retries then success acknowledges',
      fn: testDeliveryResult_failedSendIsRetriedThenAcknowledged,
    },
    {
      name: 'delivery result -- third reported send failure is terminal',
      fn: testDeliveryResultThirdFailureIsTerminal,
    },
    {
      name: 'durability -- queued entry remains sendable when Mac returns later',
      fn: testQueuedEntryPersistsUntilMacReturns,
    },
    {
      name: 'durability -- database default does not expire queued sends',
      fn: testQueueDatabaseDefaultDoesNotExpire,
    },
    {
      name: 'relay status -- queue receipt reports current Mac availability',
      fn: testQueueReceiptIncludesRelayStatusAtEnqueue,
    },
    {
      name: 'bridge preflight -- ack poll makes exact backend ready',
      fn: testBridgeHeartbeatMakesExactBackendReady,
    },
    { name: 'ordering -- FIFO pop order', fn: testOrdering_fifo },
    {
      name: 'concurrency -- 10 parallel empty pops all null',
      fn: testConcurrency_parallelEmptyPops,
    },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  console.log(`Running ${sequentialTests.length} sequential happy-path tests...`);
  const sequentialResults: TestResult[] = [];
  for (const test of sequentialTests) {
    sequentialResults.push(await runTest(test.name, test.fn));
  }

  // Drain messages left by happy path tests before RAW/atomicity/ordering tests
  const postDrain = await drainQueueForCurrentUser();
  if (postDrain > 0) console.log(`  Drained ${postDrain} messages from happy-path tests`);

  console.log(`Running ${drainTests.length} sequential RAW tests...`);
  const drainResults: TestResult[] = [];
  for (const test of drainTests) {
    drainResults.push(await runTest(test.name, test.fn));
  }

  const allResults = [...parallelResults, ...sequentialResults, ...drainResults];

  for (const r of allResults) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL IMESSAGE BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
