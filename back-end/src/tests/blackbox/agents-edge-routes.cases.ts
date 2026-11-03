import { deepStrictEqual } from 'node:assert';
import {
  BASE_URL,
  API_KEY,
  FAKE_UUID,
  trackedAgentIds,
  ListAgentsResponse,
  CreateAgentResponse,
  GetAgentResponse,
  UpdateStatusResponse,
  authHeaders,
  apiKeyHeaders,
  request,
  assertStatus,
  assertSchema,
  assert,
  createAnonymousSession,
  createTestAgent,
  postAgentWithRetry,
  deleteTestAgent,
  withTransientDbRetry,
  test,
  prisma,
  randomUUID,
  geoFromDeliveryAddress,
} from './agents-blackbox-harness';

test('GET / — with source query param', async () => {
  const session = await createAnonymousSession('list-source');
  const agentId = await createTestAgent(session.user.id, 'Source filter test');

  // Filter by WEB source (default)
  const res = await request(`${BASE_URL}/api/agents?source=WEB`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListAgentsResponse, res.data, 'GET / source filter');

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/messages — message empty string =======

test('POST /:id/messages — empty message text succeeds', async () => {
  const session = await createAnonymousSession('msg-empty-text');
  const agentId = await createTestAgent(session.user.id, 'Empty message test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: '', role: 'TOOL' }),
  });
  // Empty message may succeed or fail depending on validation
  if (res.status !== 201 && res.status !== 400) {
    throw new Error(`Expected 201 or 400 for empty message, got ${res.status}`);
  }

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST / — with response_schema ===================

test('POST / — with response_schema parameter', async () => {
  const session = await createAnonymousSession('response-schema');
  const schema = {
    fields: [
      {
        name: 'result',
        type: 'str',
        required: true,
        minLength: 3,
        maxLength: 80,
        description: 'The result string',
      },
      { name: 'confidence', type: 'float', required: false, description: 'Confidence score' },
      { name: 'optional_count', type: 'int', required: false, description: 'Omittable count' },
      { name: 'nullable_summary', type: 'str', required: true, nullable: true },
      {
        name: 'rows',
        type: 'list[object]',
        required: true,
        minItems: 2,
        maxItems: 2,
        description: 'Rows with label and count',
        properties: [
          {
            name: 'label',
            type: 'str',
            minLength: 2,
            maxLength: 40,
            description: 'Preserve the submitted row label.\nRésumé ∑.',
          },
          { name: 'count', type: 'int', required: false },
          { name: 'asset', type: 'file_pointer' },
          { name: 'remote_asset', type: 'session_file_pointer' },
          {
            name: 'remote_frames',
            type: 'list[session_file_pointer]',
            maxItems: 3,
            nullable: true,
          },
        ],
      },
      {
        name: 'session_file',
        type: 'session_file_pointer',
        required: false,
        description: 'Remote session artifact',
      },
    ],
  };
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Response schema test',
    response_schema: schema,
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateAgentResponse, res.data, 'POST / response_schema');
  trackedAgentIds.add(body.agent_id);

  // Verify response_schema is persisted
  const detail = await request(`${BASE_URL}/api/agents/${body.agent_id}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detail.status, 200, detail.data);
  const detailBody = assertSchema(GetAgentResponse, detail.data, 'response_schema detail');
  assert(detailBody.agent.response_schema !== null, 'response_schema should be persisted');
  deepStrictEqual(detailBody.agent.response_schema, schema);
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: body.agent_id } });
  deepStrictEqual(stored.responseSchema, schema);
  const storedFields = (detailBody.agent.response_schema as { fields: Record<string, unknown>[] })
    .fields;
  assert(
    storedFields[0].minLength === 3 &&
      storedFields[0].maxLength === 80 &&
      storedFields[2].required === false &&
      storedFields[3].nullable === true &&
      storedFields[4].minItems === 2 &&
      storedFields[4].maxItems === 2 &&
      (storedFields[4].properties as Record<string, unknown>[])[0].minLength === 2 &&
      (storedFields[4].properties as Record<string, unknown>[])[1].required === false &&
      (storedFields[4].properties as Record<string, unknown>[])[4].nullable === true,
    'response_schema bounds, optional flags, and legacy nullable flags should round-trip through the API'
  );

  const updatedSchema = structuredClone(schema);
  updatedSchema.fields[0].description = 'Updated caller criteria.\nNo inferred replacement.';
  const update = await request(`${BASE_URL}/api/agents/${body.agent_id}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ response_schema: updatedSchema }),
  });
  assertStatus(update.status, 200, update.data);
  const afterUpdate = await request(`${BASE_URL}/api/agents/${body.agent_id}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(afterUpdate.status, 200, afterUpdate.data);
  deepStrictEqual(
    assertSchema(GetAgentResponse, afterUpdate.data, 'updated response_schema detail').agent
      .response_schema,
    updatedSchema
  );
  deepStrictEqual(
    (await prisma.agent.findUniqueOrThrow({ where: { id: body.agent_id } })).responseSchema,
    updatedSchema
  );

  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — rejects invalid output schema bounds', async () => {
  const session = await createAnonymousSession('response-schema-bounds');
  const invalidFields = [
    { name: 'items', type: 'list[str]', required: true, minItems: 3, maxItems: 2 },
    { name: 'title', type: 'str', required: true, minItems: 1 },
    { name: 'items', type: 'list[str]', required: true, maxLength: 10 },
    { name: 'items', type: 'list[str]', required: true, minItems: -1 },
    {
      name: 'rows',
      type: 'list[object]',
      required: true,
      properties: [{ name: 'label', type: 'str', minLength: 8, maxLength: 2 }],
    },
  ];
  for (const field of invalidFields) {
    const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
      goal: 'Invalid response schema bounds',
      response_schema: { fields: [field] },
    });
    assertStatus(res.status, 400, res.data);
  }
});

// ========================= POST / — with max_iterations ====================

test('POST / — with max_iterations parameter', async () => {
  const session = await createAnonymousSession('max-iterations');
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Max iterations test',
    max_iterations: 5,
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateAgentResponse, res.data, 'POST / max_iterations');
  trackedAgentIds.add(body.agent_id);
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: body.agent_id } });
  assert(stored.workflowMaxIterations === 5, 'max_iterations should be persisted');

  await deleteTestAgent(body.agent_id, session.user.id);
});

// ========================= PATCH /:id/status — statusMessage only ==========

test('PATCH /:id/status — update statusMessage without changing status', async () => {
  const session = await createAnonymousSession('status-msg-only');

  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-status-msg-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Status message only test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'ACTIVE',
      statusMessage: 'Planning next steps...',
      progress: 0.2,
      tokenCount: 500,
      contextSize: 2000,
      messageCount: 5,
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateStatusResponse, res.data, 'PATCH status msg only');
  assert(
    body.status_message === 'Planning next steps...',
    `Expected status message, got "${body.status_message}"`
  );
  assert(body.status === 'ACTIVE', `Expected ACTIVE, got ${body.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/pause — tenant isolation ===============

test('POST /:id/pause — tenant isolation: user B cannot pause user A agent → 404', async () => {
  const sessionA = await createAnonymousSession('pause-iso-a');
  const sessionB = await createAnonymousSession('pause-iso-b');

  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-pause-iso', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: sessionA.user.id,
        goal: 'Pause isolation test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/pause`, {
    method: 'POST',
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);

  await withTransientDbRetry('cleanup-pause-iso', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

// ========================= GET /:id — soft-deleted agent → 404 =============

test('GET /:id — soft-deleted agent returns 404', async () => {
  const session = await createAnonymousSession('get-soft-del');

  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-soft-del-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Soft deleted test',
        status: 'ACTIVE',
        deletedAt: new Date(), // Pre-soft-delete
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 404, res.data);
});

// ==================== DEEP COVERAGE — HYBRIDAUTH + MESSAGES + GEOIP ====================

// 1. Rose API key auth: invalid key should return 401
test('HybridAuth — invalid Rose API key → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents`, {
    headers: { 'X-API-Key': 'invalid-rose-api-key-that-does-not-exist' },
  });
  assertStatus(res.status, 401, res.data);
});

// 2. Agent creation with X-Forwarded-For to exercise geoip getClientIP
test('POST /agents — with X-Forwarded-For header (geoip path)', async () => {
  const session = await createAnonymousSession('geo-test');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: {
      ...apiKeyHeaders(session.user.id),
      'X-Forwarded-For': '8.8.8.8',
    },
    body: JSON.stringify({ goal: 'Geoip test agent', model: 'rose-1-flash' }),
  });
  // Agent creation should succeed (geoip lookup happens asynchronously)
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  await deleteTestAgent(body.agent_id, session.user.id);
});

// 2b. geoFromDeliveryAddress — pure-function normalization (item: proxy follows
//     delivery location when no client IP is available).
test('geoFromDeliveryAddress — full US state name normalizes to abbrev + uppercase city', () => {
  const geo = geoFromDeliveryAddress({
    city: 'San Francisco',
    state: 'California',
    country: 'United States',
  });
  if (!geo || geo.country !== 'US' || geo.state !== 'CA' || geo.city !== 'SAN FRANCISCO') {
    throw new Error(`Expected {US, CA, SAN FRANCISCO}, got ${JSON.stringify(geo)}`);
  }
});

test('geoFromDeliveryAddress — accepts a 2-letter state abbreviation as-is', () => {
  const geo = geoFromDeliveryAddress({ city: 'San Francisco', state: 'CA' });
  if (!geo || geo.country !== 'US' || geo.state !== 'CA' || geo.city !== 'SAN FRANCISCO') {
    throw new Error(`Expected {US, CA, SAN FRANCISCO}, got ${JSON.stringify(geo)}`);
  }
});

test('geoFromDeliveryAddress — returns null when no city or state', () => {
  if (geoFromDeliveryAddress({ city: '', state: null, country: 'United States' }) !== null) {
    throw new Error('Expected null for an address with no city/state');
  }
});

test('geoFromDeliveryAddress — city-only address still resolves', () => {
  const geo = geoFromDeliveryAddress({ city: 'Austin' });
  if (!geo || geo.country !== 'US' || geo.city !== 'AUSTIN' || 'state' in geo) {
    throw new Error(`Expected {US, AUSTIN, no state}, got ${JSON.stringify(geo)}`);
  }
});

test('geoFromDeliveryAddress — non-US full country name normalizes to a 2-letter code', () => {
  // state is only emitted for US; non-US drops it and truncates the country name.
  const geo = geoFromDeliveryAddress({
    city: 'London',
    state: 'England',
    country: 'United Kingdom',
  });
  if (!geo || geo.country !== 'UN' || geo.city !== 'LONDON') {
    throw new Error(`Expected {country: 'UN' (truncated), LONDON}, got ${JSON.stringify(geo)}`);
  }
});

test('geoFromDeliveryAddress — non-US 2-letter country code is uppercased as-is', () => {
  const geo = geoFromDeliveryAddress({ city: 'Toronto', state: 'ON', country: 'ca' });
  if (!geo || geo.country !== 'CA' || geo.city !== 'TORONTO') {
    throw new Error(`Expected {CA, TORONTO}, got ${JSON.stringify(geo)}`);
  }
});

// 2c. Integration: a server-originated agent (no resolvable client IP) inherits
//     the user's delivery-address city instead of the default Dallas proxy.
test('POST /agents — no resolvable IP falls back to user delivery address', async () => {
  const session = await createAnonymousSession('geo-delivery');
  await prisma.user.upsert({
    where: { userId: session.user.id },
    update: { city: 'San Francisco', state: 'California', country: 'United States' },
    create: {
      userId: session.user.id,
      isAnonymous: true,
      city: 'San Francisco',
      state: 'California',
      country: 'United States',
    },
  });
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: {
      ...apiKeyHeaders(session.user.id),
      // Private IP → geoip returns null → delivery-address fallback engages.
      'X-Forwarded-For': '10.0.0.5',
    },
    body: JSON.stringify({ goal: 'Delivery-address proxy test', model: 'rose-1-flash' }),
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  const agent = await prisma.agent.findUnique({
    where: { id: body.agent_id },
    select: { proxyCountry: true, proxyState: true, proxyCity: true },
  });
  if (!agent || agent.proxyCity !== 'SAN FRANCISCO' || agent.proxyState !== 'CA') {
    throw new Error(`Expected SF/CA proxy from delivery address, got ${JSON.stringify(agent)}`);
  }
  await deleteTestAgent(body.agent_id, session.user.id);
});

// X-Benchmark-Run marks the root agent as a benchmark run so admin-health metrics
// strip it out. The header value must equal the internal backend key — a marker that
// external clients can't forge — so it works no matter whether the benchmark created
// the agent via API key or a real operator JWT, while a spoofed value (or no header)
// stays false. This is the durable, going-forward mechanism for keeping benchmark/eval
// runs out of the metrics even under a real operator's account. See admin-health/repo.ts.
test('POST /agents — X-Benchmark-Run key persists isBenchmark; spoof/absent stay false', async () => {
  const session = await createAnonymousSession('bench-flag');
  const marked = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(session.user.id), 'X-Benchmark-Run': API_KEY },
    body: JSON.stringify({ goal: 'Benchmark-flagged agent', model: 'rose-1-flash' }),
  });
  assertStatus(marked.status, 201, marked.data);
  const markedId = (marked.data as { agent_id: string }).agent_id;

  // Wrong header value must NOT mark the run — otherwise any authenticated caller
  // could exclude their own agents from admin-health metrics.
  const spoofed = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(session.user.id), 'X-Benchmark-Run': 'true' },
    body: JSON.stringify({ goal: 'Spoofed benchmark agent', model: 'rose-1-flash' }),
  });
  assertStatus(spoofed.status, 201, spoofed.data);
  const spoofedId = (spoofed.data as { agent_id: string }).agent_id;

  const unmarked = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ goal: 'Regular agent', model: 'rose-1-flash' }),
  });
  assertStatus(unmarked.status, 201, unmarked.data);
  const unmarkedId = (unmarked.data as { agent_id: string }).agent_id;

  const [markedRow, spoofedRow, unmarkedRow] = await Promise.all([
    prisma.agent.findUnique({
      where: { id: markedId },
      select: { isBenchmark: true, memoryEnabled: true },
    }),
    prisma.agent.findUnique({
      where: { id: spoofedId },
      select: { isBenchmark: true, memoryEnabled: true },
    }),
    prisma.agent.findUnique({
      where: { id: unmarkedId },
      select: { isBenchmark: true, memoryEnabled: true },
    }),
  ]);
  if (markedRow?.isBenchmark !== true) {
    throw new Error(
      `Expected isBenchmark=true for benchmark-flagged agent, got ${JSON.stringify(markedRow)}`
    );
  }
  if (markedRow.memoryEnabled !== false) {
    throw new Error(`Expected benchmark memory default off, got ${JSON.stringify(markedRow)}`);
  }
  if (spoofedRow?.isBenchmark !== false) {
    throw new Error(
      `Expected isBenchmark=false for spoofed header value, got ${JSON.stringify(spoofedRow)}`
    );
  }
  if (spoofedRow.memoryEnabled !== true) {
    throw new Error(
      `Expected spoofed benchmark memory default on, got ${JSON.stringify(spoofedRow)}`
    );
  }
  if (unmarkedRow?.isBenchmark !== false) {
    throw new Error(
      `Expected isBenchmark=false for regular agent, got ${JSON.stringify(unmarkedRow)}`
    );
  }
  if (unmarkedRow.memoryEnabled !== true) {
    throw new Error(`Expected production memory default on, got ${JSON.stringify(unmarkedRow)}`);
  }
  await deleteTestAgent(markedId, session.user.id);
  await deleteTestAgent(spoofedId, session.user.id);
  await deleteTestAgent(unmarkedId, session.user.id);
});

// 3. POST /:id/messages with invalid body (Zod validation error → handleRouteError ZodError branch)
test('POST /:id/messages — invalid body → 400 (Zod)', async () => {
  const session = await createAnonymousSession('msg-zod-err');
  const agentId = await createTestAgent(session.user.id, 'Zod error test');
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 12345, role: 'INVALID_ROLE' }), // wrong types
  });
  assertStatus(res.status, 400, res.data);
  await deleteTestAgent(agentId, session.user.id);
});

// 4. POST /messages/batch with non-string IDs → 400 or 500 (validation error)
test('POST /messages/batch — non-string IDs → 400 or 500', async () => {
  const session = await createAnonymousSession('batch-nonstr');
  const res = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ ids: [123, 456] }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400 or 500 for non-string IDs, got ${res.status}`);
  }
});

// 5. GET /:id/attachments/:fileId/url — empty storage_path → 400
test('GET /:id/attachments/:fileId/url — empty string storage_path → 400', async () => {
  const session = await createAnonymousSession('attach-empty');
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/attachments/${FAKE_UUID}/url?storage_path=`,
    { headers: authHeaders(session.session.access_token) }
  );
  assertStatus(res.status, 400, res.data);
});

// 6. Agent creation with private IP in X-Forwarded-For (exercises isPrivateIP branches in geoip)
test('POST /agents — with private IP in X-Forwarded-For', async () => {
  const session = await createAnonymousSession('geo-private');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: {
      ...apiKeyHeaders(session.user.id),
      'X-Forwarded-For': '192.168.1.1',
    },
    body: JSON.stringify({ goal: 'Private IP test', model: 'rose-1-flash' }),
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  await deleteTestAgent(body.agent_id, session.user.id);
});

// 7. Agent creation with IPv6-mapped IPv4 in X-Forwarded-For
test('POST /agents — with IPv6-mapped IPv4 X-Forwarded-For', async () => {
  const session = await createAnonymousSession('geo-ipv6');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: {
      ...apiKeyHeaders(session.user.id),
      'X-Forwarded-For': '::ffff:10.0.0.1',
    },
    body: JSON.stringify({ goal: 'IPv6 mapped test', model: 'rose-1-flash' }),
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  await deleteTestAgent(body.agent_id, session.user.id);
});

// 8. POST /:id/messages — with missing message field
test('POST /:id/messages — missing message field → 400', async () => {
  const session = await createAnonymousSession('msg-nomsg');
  const agentId = await createTestAgent(session.user.id, 'Missing message field');
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  await deleteTestAgent(agentId, session.user.id);
});

// 9. Multiple different model names to exercise model pricing paths
test('POST /agents — with different model names (model pricing)', async () => {
  const session = await createAnonymousSession('model-pricing');
  // Create agents with different models to exercise modelPricing getModelPricing
  for (const model of ['rose-1-flash', 'rose-1-ultra']) {
    const res = await request(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: apiKeyHeaders(session.user.id),
      body: JSON.stringify({ goal: `Model pricing test ${model}`, model }),
    });
    assertStatus(res.status, 201, res.data);
    const body = res.data as { agent_id: string };
    await deleteTestAgent(body.agent_id, session.user.id);
  }
});
