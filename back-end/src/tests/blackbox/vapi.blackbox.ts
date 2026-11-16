#!/usr/bin/env tsx
/**
 * Black-box tests for /api/vapi
 *
 * Domain surface:
 *   POST /api/vapi/call     — initiate an outbound phone call via Vapi (auth: API key)
 *   GET  /api/vapi/call/:id — poll call status from Vapi (auth: API key)
 *
 * Boundary coverage (fake upstream, never the real Vapi/Twilio hosts):
 *   The runners point VAPI_API_BASE_URL / TWILIO_API_BASE_URL / VAPI_PRIVATE_KEY at
 *   the isolated backend's loopback fake (/api/test/fake-phone-upstream), so no
 *   case can dial a real number. A precondition aborts the file before any call
 *   is attempted unless the backend's effective Vapi + Twilio base URLs route to
 *   that fake. Boundary tests read the fake's request log and assert the exact
 *   create/poll requests (URL path, method, Authorization scheme, body).
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated requests return 401
 *   - error-surface: missing required fields return 400; Vapi misconfigured returns 500
 *   - idempotency: same invalid request always returns same error
 *   - concurrency: 10 parallel auth-check requests return consistent results
 *   - same-input reproducibility: three sequential validation errors return identical status
 *   - cleanup: no state mutations (calls land on the loopback fake upstream)
 *   - boundary param: Vapi API call uses expected URL, method, and auth header
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write: the fake upstream does not model call progress
 *   - state-transition: call state transitions happen on Vapi's side
 *   - ordering/pagination: no list endpoints
 *   - atomicity: single external API call per request
 *   - referential integrity: no DB relations
 *   - event/job cardinality: no events emitted
 *   - duplication prevention: each call is unique
 *   - tenant isolation: auth via API key (internal service-to-service)
 *   - time/clock: no timestamps in error responses
 *   - call ordering: sequential outbound calls (create then poll)
 *
 * Usage:
 *   npx tsx src/tests/blackbox/vapi.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/vapi.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
import {
  assertVapiCallPlaced,
  fakeCursor,
  fakeRequestsAfter,
  fakeVapiCreate,
  testGuard_phoneUpstreamIsLocalFake,
} from './vapi-fake-upstream.support';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({ error: z.string() });

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

function apiKeyHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
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

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  }
  return result.data;
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

// ==================== POST /api/vapi/call ====================

// --- auth boundary ---

async function testCall_noAuth() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    body: JSON.stringify({
      to: '+10000000000',
      system_prompt: 'test',
      output_schema: {},
    }),
  });
  assertStatus(res.status, 401, res.data);
}

// --- validation ---

async function testCall_missingTo() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ system_prompt: 'test', output_schema: {} }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /call (missing to)');
}

async function testCall_missingPrompt() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ to: '+10000000000', output_schema: {} }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /call (missing prompt)');
}

async function testCall_missingSchema() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ to: '+10000000000', system_prompt: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /call (missing schema)');
}

async function testCall_emptyBody() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
}

async function testCall_allFieldsMissing() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ extra: 'field' }),
  });
  assertStatus(res.status, 400, res.data);
}

// --- Vapi not configured (500 if VAPI_PRIVATE_KEY missing) ---

async function testCall_vapiNotConfigured() {
  const cursor = await fakeCursor();
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      to: '+10000000000',
      system_prompt: 'Vapi config check prompt',
      output_schema: { result: 'description' },
    }),
  });
  assertVapiCallPlaced(res);
  await fakeVapiCreate(cursor, 'Vapi config check prompt');
}

async function testCall_validSchemaAndTenDigitPhone() {
  const cursor = await fakeCursor();
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      to: '0000000000',
      system_prompt: 'Schema normalization coverage',
      output_schema: {
        type: 'object',
        properties: { result: { type: 'string' } },
      },
    }),
  });
  assertVapiCallPlaced(res);
  const { body } = await fakeVapiCreate(cursor, 'Schema normalization coverage');
  if (body.customer?.number !== '+10000000000') {
    throw new Error(`Expected 10-digit number normalized to +1, got ${body.customer?.number}`);
  }
}

async function testCall_propertiesOnlySchemaAndInternationalPhone() {
  const cursor = await fakeCursor();
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      to: '+442079460958',
      system_prompt: 'Properties-only schema normalization coverage',
      output_schema: {
        properties: { result: { type: 'string' } },
      },
    }),
  });
  assertVapiCallPlaced(res);
  const { body } = await fakeVapiCreate(cursor, 'Properties-only schema normalization coverage');
  if (body.customer?.number !== '+442079460958') {
    throw new Error(`Expected international number unchanged, got ${body.customer?.number}`);
  }
  const schema = body.assistant?.analysisPlan?.structuredDataPlan?.schema as
    { type?: string; properties?: Record<string, unknown> } | undefined;
  if (schema?.type !== 'object' || schema.properties?.result === undefined) {
    throw new Error(
      `Expected properties-only schema typed as object, got ${JSON.stringify(schema)}`
    );
  }
}

// ==================== GET /api/vapi/call/:id ====================

// --- auth boundary ---

async function testGetCall_noAuth() {
  const res = await request(`${BASE_URL}/api/vapi/call/nonexistent`);
  assertStatus(res.status, 401, res.data);
}

// --- validation / error surface ---

async function testGetCall_nonexistentId() {
  const res = await request(`${BASE_URL}/api/vapi/call/nonexistent-call-id`, {
    headers: apiKeyHeaders(),
  });
  // The upstream's 404 surfaces unchanged.
  assertStatus(res.status, 404, res.data);
}

// ==================== BOUNDARY CAPTURE ====================

// Exact non-identifying opening instructions from the third reported call.
const REPORTED_SPANISH_OPENING =
  'IDIOMA: español de España únicamente. Nunca diga nada en inglés, ni siquiera el saludo. ' +
  'Pronuncie los números en español ("diecisiete", "las siete de la tarde"). ' +
  'Hablar despacio y claro, frases cortas.\n' +
  'Primera frase exacta apenas el teléfono responda: "Hola, buenas. ¿Tienen mesa para dos personas para mañana martes, a las siete de la tarde?"';

async function testBoundary_vapiCallCreation() {
  const cursor = await fakeCursor();

  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      to: '+10000000000',
      system_prompt: REPORTED_SPANISH_OPENING,
      output_schema: { result: 'string' },
    }),
  });
  assertVapiCallPlaced(res);

  const { body: outboundBody } = await fakeVapiCreate(cursor, REPORTED_SPANISH_OPENING);

  const assistant = outboundBody.assistant;
  if (!assistant) {
    throw new Error('Expected inline Vapi assistant config');
  }
  if (outboundBody.customer?.number !== '+10000000000') {
    throw new Error(`Expected normalized customer number, got ${outboundBody.customer?.number}`);
  }
  if (assistant.name !== 'Rose Outbound Call Agent') {
    throw new Error(`Expected assistant name to be code-controlled, got ${assistant.name}`);
  }
  if (assistant.model?.provider !== 'openai' || assistant.model.model !== 'gpt-4.1-mini') {
    throw new Error(`Expected openai/gpt-4.1-mini model, got ${JSON.stringify(assistant.model)}`);
  }
  // Hold parking (backend-owned Twilio call) and the wait_for_human tool come together.
  const holdTool = assistant.model.tools?.find((t) => t.function?.name === 'wait_for_human');
  const holdToolMatchesPath =
    outboundBody.phoneCallProviderBypassEnabled === true
      ? holdTool?.server?.url?.includes('/api/vapi/hold/tool?session=') === true
      : holdTool === undefined;
  if (!holdToolMatchesPath) {
    throw new Error(`Hold parking and wait_for_human disagree: ${JSON.stringify(holdTool)}`);
  }
  const systemMessage = assistant.model.messages?.find((m) => m.role === 'system')?.content;
  if (!systemMessage?.startsWith('You are Rose.')) {
    throw new Error(
      `Expected deterministic "You are <name>." identity prefix at top of system prompt, got: ${systemMessage?.substring(0, 60)}`
    );
  }
  if (!systemMessage.includes('You are making an outbound phone call.')) {
    throw new Error('Expected base system prompt in outbound assistant config');
  }
  if (!systemMessage.includes('use the endCall tool')) {
    throw new Error('Expected outbound assistant prompt to instruct explicit call termination');
  }
  if (!systemMessage.includes('use the dtmf function')) {
    throw new Error('Expected outbound assistant prompt to instruct DTMF for IVR navigation');
  }
  if (!systemMessage.endsWith(REPORTED_SPANISH_OPENING)) {
    throw new Error('Expected per-call system prompt in outbound assistant config');
  }
  if (!assistant.model.tools?.some((tool) => tool.type === 'endCall')) {
    throw new Error(
      `Expected outbound assistant to include endCall tool, got ${JSON.stringify(assistant.model.tools)}`
    );
  }
  if (!assistant.model.tools?.some((tool) => tool.type === 'dtmf')) {
    throw new Error(
      `Expected outbound assistant to include dtmf tool for IVR navigation, got ${JSON.stringify(assistant.model.tools)}`
    );
  }
  if (
    assistant.firstMessage !== undefined ||
    assistant.firstMessageMode !== 'assistant-speaks-first-with-model-generated-message'
  ) {
    throw new Error(
      `Expected prompt-generated Spanish opening, got ${JSON.stringify({ firstMessage: assistant.firstMessage, firstMessageMode: assistant.firstMessageMode })}`
    );
  }
  if (assistant.endCallMessage !== undefined) {
    throw new Error(`Expected prompt-controlled closing, got ${assistant.endCallMessage}`);
  }
  const endCall = assistant.model.tools?.find((tool) => tool.type === 'endCall');
  if (
    JSON.stringify(endCall?.messages) !== JSON.stringify([{ type: 'request-start', content: '' }])
  ) {
    throw new Error('Expected silent endCall after the model speaks its prompt-controlled goodbye');
  }
  // "Rose" preset from mac-app onboarding VoiceSelector (PRESET_VOICES[0]).
  if (
    assistant.voice?.provider !== '11labs' ||
    assistant.voice.voiceId !== '6fZce9LFNG3iEITDfqZZ' ||
    assistant.voice.model !== 'eleven_turbo_v2_5'
  ) {
    throw new Error(`Expected 11labs/Rose voice, got ${JSON.stringify(assistant.voice)}`);
  }
  if (
    assistant.transcriber?.provider !== 'deepgram' ||
    assistant.transcriber.model !== 'nova-3' ||
    assistant.transcriber.language !== 'multi' ||
    assistant.transcriber.eotThreshold !== undefined ||
    assistant.transcriber.eotTimeoutMs !== undefined
  ) {
    throw new Error(
      `Expected deepgram transcriber config, got ${JSON.stringify(assistant.transcriber)}`
    );
  }
  if (assistant.silenceTimeoutSeconds !== 30 || assistant.maxDurationSeconds !== 600) {
    throw new Error(
      `Expected timeout settings, got silence=${assistant.silenceTimeoutSeconds}, max=${assistant.maxDurationSeconds}`
    );
  }
  if (assistant.analysisPlan?.structuredDataPlan?.enabled !== true) {
    throw new Error('Expected structured data extraction to be enabled');
  }
  if (!assistant.serverMessages?.includes('end-of-call-report')) {
    throw new Error('Expected server messages to be code-controlled');
  }
  if (!assistant.clientMessages?.includes('transcript')) {
    throw new Error('Expected client messages to be code-controlled');
  }

  // Negative controls: language-independent configuration and the IVR exception.
  for (const brief of [
    'Speak English. Open with "Hello, is this a good time?" Close with "Cheers."',
    'Parlez français. Commencez par "Bonjour, puis-je vous poser une question ?"',
    'Navigate the keypad IVR and enter tracking number 2451338820 followed by #.',
  ]) {
    const variantCursor = await fakeCursor();
    assertVapiCallPlaced(
      await request(`${BASE_URL}/api/vapi/call`, {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: JSON.stringify({
          to: '+10000000000',
          system_prompt: brief,
          output_schema: { result: 'string' },
        }),
      })
    );
    const variant = (await fakeVapiCreate(variantCursor, brief)).body.assistant;
    const ivr = brief.startsWith('Navigate');
    if (
      variant?.firstMessageMode !==
        (ivr
          ? 'assistant-waits-for-user'
          : 'assistant-speaks-first-with-model-generated-message') ||
      variant.firstMessage !== (ivr ? '' : undefined)
    ) {
      throw new Error(`Incorrect opening mode for negative control: ${brief}`);
    }
    if (!variant.model?.messages?.some((message) => message.content?.endsWith(brief))) {
      throw new Error(`Call brief was changed: ${brief}`);
    }
    if (
      variant.voice?.model !== 'eleven_turbo_v2_5' ||
      variant.transcriber?.model !== 'nova-3' ||
      variant.transcriber.language !== 'multi' ||
      !variant.model?.tools?.some((tool) => tool.type === 'dtmf')
    ) {
      throw new Error(`Multilingual speech or IVR capability lost: ${brief}`);
    }
  }
}

async function testBoundary_vapiCallWithUserOverrides() {
  // 1. Create an anonymous user to attach settings to.
  const anonRes = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(anonRes.status, 200, anonRes.data);
  const anonBody = anonRes.data as {
    user: { id: string };
    session: { access_token: string };
  };
  const access_token = anonBody.session.access_token;
  const user_id = anonBody.user.id;

  // 2. Persist the user's chosen system name + voice ID via the same path the
  //    onboarding flow uses.
  const patchRes = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${access_token}` },
    body: JSON.stringify({
      systemName: 'Atlas',
      voicePreferenceId: 'voice_test_atlas_xyz',
    }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);

  // 3. Trigger an outbound call as the agent worker would.
  const cursor = await fakeCursor();
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      to: '+10000000000',
      system_prompt: 'User-override boundary test',
      output_schema: { result: 'string' },
      user_id,
    }),
  });

  assertVapiCallPlaced(res);
  const { body: outbound } = await fakeVapiCreate(cursor, 'User-override boundary test');
  const systemMessage = outbound.assistant?.model?.messages?.find(
    (m) => m.role === 'system'
  )?.content;
  if (!systemMessage?.startsWith('You are Atlas.')) {
    throw new Error(
      `Expected user's systemName to flow into identity prefix, got: ${systemMessage?.substring(0, 60)}`
    );
  }
  if (
    outbound.assistant?.voice?.voiceId !== 'voice_test_atlas_xyz' ||
    outbound.assistant.voice.model !== 'eleven_turbo_v2_5'
  ) {
    throw new Error(
      `Expected user's voicePreferenceId to override default voice, got: ${outbound.assistant?.voice?.voiceId}`
    );
  }
}

async function testBoundary_vapiCallPoll() {
  const cursor = await fakeCursor();

  const res = await request(`${BASE_URL}/api/vapi/call/test-poll-id`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 404, res.data);

  const polls = (await fakeRequestsAfter(cursor)).filter(
    (r) => r.method === 'GET' && r.path === '/call/test-poll-id'
  );
  if (polls.length !== 1) {
    throw new Error(`Expected the fake Vapi upstream to receive 1 poll, got ${polls.length}`);
  }
  if (polls[0].authorizationScheme !== 'Bearer') {
    throw new Error(
      `Expected Bearer Authorization in Vapi poll, got ${polls[0].authorizationScheme}`
    );
  }
}

// ==================== INVARIANTS ====================

async function testIdempotency_validationError() {
  const body = JSON.stringify({ system_prompt: 'test', output_schema: {} }); // missing 'to'
  const r1 = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body,
  });
  const r2 = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body,
  });
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelAuthChecks() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(`${BASE_URL}/api/vapi/call`, {
        method: 'POST',
        body: JSON.stringify({ to: '+10000000000', system_prompt: 'test', output_schema: {} }),
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
    const res = await request(`${BASE_URL}/api/vapi/call`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output_schema: {} }), // missing to + system_prompt
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(`Three sequential: ${statuses.join(', ')}`);
  }
}

async function testPollDiagnosticsArchiveFreshnessSignalsWithoutSecrets() {
  const { buildVapiPollExchange } = await import('../../domains/vapi/archive');
  const response = new Response('{}', {
    status: 200,
    headers: {
      authorization: 'Bearer provider-secret',
      'cf-cache-status': 'DYNAMIC',
      date: 'Mon, 13 Jul 2026 01:53:58 GMT',
      etag: 'W/"poll-version"',
      'set-cookie': 'provider-session=secret',
    },
  });
  const exchange = buildVapiPollExchange(
    'https://api.vapi.ai/call/call-1',
    new Date('2026-07-13T01:53:57.900Z'),
    new Date('2026-07-13T01:53:58.025Z'),
    response
  );

  if (exchange.response.durationMs !== 125) {
    throw new Error(`Expected 125ms duration, got ${exchange.response.durationMs}`);
  }
  if (exchange.response.headers.etag !== 'W/"poll-version"') {
    throw new Error('ETag was not preserved in poll diagnostics');
  }
  if (exchange.response.headers['cf-cache-status'] !== 'DYNAMIC') {
    throw new Error('Cloudflare cache status was not preserved in poll diagnostics');
  }
  if ('authorization' in exchange.response.headers || 'set-cookie' in exchange.response.headers) {
    throw new Error('Poll diagnostics captured a secret-bearing header');
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('Vapi Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const guard = await runTest(
    'guard -- backend Vapi/Twilio upstream is the loopback fake',
    testGuard_phoneUpstreamIsLocalFake
  );
  console.log(
    `  ${guard.passed ? 'PASS' : 'FAIL'}  ${guard.name}${guard.passed ? '' : ` -- ${guard.error}`}`
  );
  if (!guard.passed) {
    console.log('\nRefusing to run call-placing cases against a real phone upstream.');
    process.exit(1);
  }

  const parallelTests = [
    // auth boundary
    { name: 'POST /vapi/call -- no auth -> 401', fn: testCall_noAuth },
    { name: 'GET /vapi/call/:id -- no auth -> 401', fn: testGetCall_noAuth },
    // validation
    { name: 'POST /vapi/call -- missing to -> 400', fn: testCall_missingTo },
    { name: 'POST /vapi/call -- missing system_prompt -> 400', fn: testCall_missingPrompt },
    { name: 'POST /vapi/call -- missing output_schema -> 400', fn: testCall_missingSchema },
    { name: 'POST /vapi/call -- empty body -> 400', fn: testCall_emptyBody },
    { name: 'POST /vapi/call -- all fields missing -> 400', fn: testCall_allFieldsMissing },
    // error surface
    { name: 'POST /vapi/call -- Vapi config check', fn: testCall_vapiNotConfigured },
    {
      name: 'POST /vapi/call -- valid schema and 10-digit phone normalization',
      fn: testCall_validSchemaAndTenDigitPhone,
    },
    {
      name: 'POST /vapi/call -- properties schema and international phone normalization',
      fn: testCall_propertiesOnlySchemaAndInternationalPhone,
    },
    { name: 'GET /vapi/call/:id -- nonexistent -> 404', fn: testGetCall_nonexistentId },
    // invariants
    {
      name: 'idempotency -- same validation error same status',
      fn: testIdempotency_validationError,
    },
    {
      name: 'concurrency -- 10 parallel auth checks consistent',
      fn: testConcurrency_parallelAuthChecks,
    },
    {
      name: 'reproducibility -- 3 sequential identical status',
      fn: testReproducibility_threeSequential,
    },
    {
      name: 'observability -- poll freshness signals exclude secrets',
      fn: testPollDiagnosticsArchiveFreshnessSignalsWithoutSecrets,
    },
  ];

  const sequentialTests = [
    // boundary capture (must be sequential due to shared capture buffer)
    { name: 'boundary -- Vapi call creation outbound', fn: testBoundary_vapiCallCreation },
    {
      name: 'boundary -- Vapi call honors user systemName + voicePreferenceId',
      fn: testBoundary_vapiCallWithUserOverrides,
    },
    { name: 'boundary -- Vapi call poll outbound', fn: testBoundary_vapiCallPoll },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  console.log(`Running ${sequentialTests.length} sequential boundary tests...`);
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
  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL VAPI BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
