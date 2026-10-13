import {
  BASE_URL,
  trackedAgentIds,
  CreateAgentResponse,
  GetAgentResponse,
  PostMessageResponse,
  StatusResponse,
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
} from './agents-blackbox-harness';
import { DEFAULT_TASK_PRICE_LIMIT_CENTS } from '../../providers/priceLimitDefaults';
import { schemaDescriptionCases } from './agents-response-schema-descriptions.cases';

for (const { name, fn } of schemaDescriptionCases) test(name, fn);

test('POST / — with context_gates parameter', async () => {
  const session = await createAnonymousSession('ctx-gates');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Context gates test',
      context_gates: {
        user_profile: true,
        network: false,
        recent_communications: false,
        integrations: true,
      },
    }),
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  assert(typeof body.agent_id === 'string', 'Expected agent_id in response');
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: body.agent_id } });
  const storedGates = stored.workflowContextGates as Record<string, boolean> | null;
  assert(
    storedGates?.user_profile === true &&
      storedGates.network === false &&
      storedGates.recent_communications === false &&
      storedGates.integrations === true &&
      Object.keys(storedGates).length === 4,
    'context_gates should be persisted'
  );
  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — with start_phase=plan', async () => {
  const session = await createAnonymousSession('start-plan');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ goal: 'Start phase plan test', start_phase: 'plan' }),
  });
  // 201 on success; 500 if Temporal is not running in this environment
  if (res.status !== 201 && res.status !== 500) {
    throw new Error(`Expected 201 or 500 for start_phase=plan, got ${res.status}`);
  }
  if (res.status === 201) {
    const body = res.data as { agent_id: string };
    await deleteTestAgent(body.agent_id, session.user.id);
  }
});

test('POST / — with start_phase=execute', async () => {
  const session = await createAnonymousSession('start-exec');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ goal: 'Start phase execute test', start_phase: 'execute' }),
  });
  // 201 on success; 500 if Temporal is not running in this environment
  if (res.status !== 201 && res.status !== 500) {
    throw new Error(`Expected 201 or 500 for start_phase=execute, got ${res.status}`);
  }
  if (res.status === 201) {
    const body = res.data as { agent_id: string };
    await deleteTestAgent(body.agent_id, session.user.id);
  }
});

test('POST / — with price_limit_cents', async () => {
  const session = await createAnonymousSession('price-limit');
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Price limit test',
    price_limit_cents: 500,
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  // Verify price_limit_cents is persisted
  const detailRes = await request(`${BASE_URL}/api/agents/${body.agent_id}`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(detailRes.status, 200, detailRes.data);
  const detail = detailRes.data as { agent: { price_limit_cents: number | null } };
  assert(
    detail.agent.price_limit_cents === 500,
    `Expected price_limit_cents=500, got ${detail.agent.price_limit_cents}`
  );
  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — default price_limit_cents is $10', async () => {
  const session = await createAnonymousSession('default-price-limit');
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Default price limit test',
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };

  const detailRes = await request(`${BASE_URL}/api/agents/${body.agent_id}`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(detailRes.status, 200, detailRes.data);
  const detail = detailRes.data as { agent: { price_limit_cents: number | null } };
  assert(
    detail.agent.price_limit_cents === DEFAULT_TASK_PRICE_LIMIT_CENTS,
    `Expected price_limit_cents=${DEFAULT_TASK_PRICE_LIMIT_CENTS}, got ${detail.agent.price_limit_cents}`
  );
  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — with custom_system_prompt', async () => {
  const session = await createAnonymousSession('custom-prompt');
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Custom prompt test',
    custom_system_prompt: 'You are a helpful coding assistant.',
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — with write_lock_enabled', async () => {
  const session = await createAnonymousSession('write-lock');
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Write lock test',
    write_lock_enabled: false,
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  const detailRes = await request(`${BASE_URL}/api/agents/${body.agent_id}`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(detailRes.status, 200, detailRes.data);
  const detail = detailRes.data as { agent: { write_lock_enabled: boolean } };
  assert(detail.agent.write_lock_enabled === false, 'write_lock_enabled should persist on create');
  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — API key auth with write_lock_enabled', async () => {
  const session = await createAnonymousSession('write-lock-api-key');
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Write lock API key test',
    write_lock_enabled: false,
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  const detailRes = await request(`${BASE_URL}/api/agents/${body.agent_id}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detailRes.status, 200, detailRes.data);
  const detail = detailRes.data as { agent: { write_lock_enabled: boolean } };
  assert(
    detail.agent.write_lock_enabled === false,
    'write_lock_enabled should persist with API key auth'
  );
  await deleteTestAgent(body.agent_id, session.user.id);
});

test('GET /:id — with before query param (pagination)', async () => {
  const session = await createAnonymousSession('msg-since');
  const agentId = await createTestAgent(session.user.id, 'Message since test');
  const before = new Date().toISOString();
  // Messages are returned via the agent detail endpoint with optional ?before= pagination param
  const res = await request(`${BASE_URL}/api/agents/${agentId}?before=${before}`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GetAgentResponse, res.data, 'GET /:id with before param');
  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — system message via internal auth', async () => {
  const session = await createAnonymousSession('msg-system');
  const agentId = await createTestAgent(session.user.id, 'System message test');
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      message: 'System notification',
      role: 'SYSTEM',
      metadata: { type: 'system_notification' },
    }),
  });
  assertStatus(res.status, 201, res.data);
  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/start-agent — happy path (no Temporal)', async () => {
  const session = await createAnonymousSession('start-agent');

  // Create the exact pre-escalation state. createTestAgent starts a background
  // chat handler that can independently escalate before this request runs.
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-start-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Start agent test',
        status: 'ACTIVE',
        busId: agentId,
        verifier: {
          create: { type: 'FLOAT_LLM_JUDGE' },
        },
      },
    });
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/start-agent`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({}),
  });
  // May succeed (200) or fail (500 if Temporal not running) — exercises the route
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500 for start-agent, got ${res.status}`);
  }
  if (res.status === 200) {
    // Terminal cleanup identifies a chain by workflow id plus first run id; a
    // started chain without its run id cannot be told apart from an older one.
    const started = await prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { temporalWorkflowId: true, temporalFirstExecutionRunId: true },
    });
    assert(
      started.temporalWorkflowId === agentId,
      `start-agent must record its workflow id, got ${started.temporalWorkflowId}`
    );
    assert(
      typeof started.temporalFirstExecutionRunId === 'string' &&
        started.temporalFirstExecutionRunId.length > 0,
      `start-agent must record its first execution run id, got ${started.temporalFirstExecutionRunId}`
    );
  }
  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/restart — happy path (no Temporal)', async () => {
  const session = await createAnonymousSession('restart');
  const agentId = await createTestAgent(session.user.id, 'Restart test');
  const res = await request(`${BASE_URL}/api/agents/${agentId}/restart`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
  });
  // May succeed (200) or fail (500 if Temporal not running) — exercises the route
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500 for restart, got ${res.status}`);
  }
  await deleteTestAgent(agentId, session.user.id);
});

// ========================= resolvePromptSecrets via internal auth ===========

test('POST / — resolvePromptSecrets replaces {{VAR}} in goal (internal auth)', async () => {
  const session = await createAnonymousSession('resolve-secrets');

  // When PROMPT_SECRET_UNDEFINED_SECRET is not set, {{UNDEFINED_SECRET}} stays as-is
  const goalWithSecret = 'Test goal with {{UNDEFINED_SECRET}} placeholder';
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), { goal: goalWithSecret });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateAgentResponse, res.data, 'POST / resolve secrets');

  // The {{UNDEFINED_SECRET}} should remain as-is since PROMPT_SECRET_UNDEFINED_SECRET is not set
  assert(
    body.goal.includes('{{UNDEFINED_SECRET}}'),
    `Expected unresolved secret to remain, got goal: "${body.goal}"`
  );
  trackedAgentIds.add(body.agent_id);
  await deleteTestAgent(body.agent_id, session.user.id);
});

// ========================= POST /:id/messages — FAILED agent resets ========

test('POST /:id/messages — user message to FAILED agent resets status', async () => {
  const session = await createAnonymousSession('msg-reset-failed');

  // Create agent with FAILED status and a temporalWorkflowId
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-failed-agent-msg', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Failed agent message test',
        status: 'FAILED',
        temporalWorkflowId: 'fake-failed-workflow-' + randomUUID(),
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Post a user message — should reset status from FAILED to ACTIVE
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'retry after failure' }),
  });
  assertStatus(res.status, 201, res.data);

  // Verify status has been reset
  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const status = assertSchema(StatusResponse, statusRes.data, 'msg-reset-failed status check');
  assert(
    status.status === 'ACTIVE',
    `Expected ACTIVE after message to failed agent, got ${status.status}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/messages — with attachments ===========

test('POST /:id/messages — message with file_pointer attachment', async () => {
  const session = await createAnonymousSession('msg-file-ptr');
  const agentId = await createTestAgent(session.user.id, 'File pointer message test');

  const filePointer = {
    id: randomUUID(),
    storage_path: `${session.user.id}/test-file.txt`,
    original_filename: 'test-file.txt',
    mime_type: 'text/plain',
    size_bytes: 100,
    created_at: new Date().toISOString(),
  };

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      message: 'Here is a file',
      role: 'USER',
      file_pointer: filePointer,
    }),
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(PostMessageResponse, res.data, 'POST messages file_pointer');
  assert(body.role === 'USER', `Expected USER role, got ${body.role}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/messages — message with metadata ======

test('POST /:id/messages — internal message with full metadata', async () => {
  const session = await createAnonymousSession('msg-metadata');
  const agentId = await createTestAgent(session.user.id, 'Metadata message test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      message: 'Tool output with rich metadata',
      role: 'TOOL',
      metadata: {
        toolName: 'web_search',
        toolStatus: 'success',
        title: 'Search results',
        duration_ms: 1500,
        urls: ['https://example.com'],
      },
    }),
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(PostMessageResponse, res.data, 'POST messages metadata');
  assert(body.role === 'TOOL', `Expected TOOL role, got ${body.role}`);

  // Verify metadata persisted via GET detail
  const detail = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detail.status, 200, detail.data);
  const detailBody = assertSchema(GetAgentResponse, detail.data, 'metadata detail');
  const toolMsg = detailBody.messages.find((m) => m.text === 'Tool output with rich metadata');
  assert(toolMsg !== undefined, 'Tool message should be visible in detail');
  assert(toolMsg!.metadata !== null, 'Metadata should be persisted');

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/messages — ACTIVE agent with workflow =

test('POST /:id/messages — user message to ACTIVE agent with dead workflow', async () => {
  const session = await createAnonymousSession('msg-dead-workflow');

  // Create ACTIVE agent with a fake workflow ID (will fail to signal but not break)
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-dead-workflow-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Dead workflow message test',
        status: 'ACTIVE',
        temporalWorkflowId: 'dead-workflow-' + randomUUID(),
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Message to agent with a dead workflow — should succeed (graceful error handling)
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'message to agent with dead workflow' }),
  });
  assertStatus(res.status, 201, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/messages — ACTIVE chat mode agent =====

test('POST /:id/messages — user message to chat-mode agent (no workflow)', async () => {
  const session = await createAnonymousSession('msg-chat-mode');

  // Create agent without temporalWorkflowId (chat mode)
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-chat-mode-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Chat mode message test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // User message triggers chat handler (fire-and-forget, may fail but request succeeds)
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'hello chat mode agent' }),
  });
  assertStatus(res.status, 201, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= DELETE /:id — recursive delete 3-level tree =====

test('DELETE /:id — recursive delete with grandchild (3-level tree)', async () => {
  const session = await createAnonymousSession('recursive-del-3');

  // Create grandparent
  const grandparentId = randomUUID();
  trackedAgentIds.add(grandparentId);
  await withTransientDbRetry('create-grandparent', async () => {
    await prisma.agent.create({
      data: {
        id: grandparentId,
        userId: session.user.id,
        goal: 'Grandparent',
        status: 'ACTIVE',
        busId: grandparentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId: grandparentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Create parent
  const parentId = randomUUID();
  trackedAgentIds.add(parentId);
  await withTransientDbRetry('create-parent-3', async () => {
    await prisma.agent.create({
      data: {
        id: parentId,
        userId: session.user.id,
        goal: 'Parent',
        parentAgentId: grandparentId,
        busId: grandparentId,
        status: 'ACTIVE',
      },
    });
    await prisma.verifier.create({
      data: { agentId: parentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Create grandchild
  const grandchildId = randomUUID();
  trackedAgentIds.add(grandchildId);
  await withTransientDbRetry('create-grandchild', async () => {
    await prisma.agent.create({
      data: {
        id: grandchildId,
        userId: session.user.id,
        goal: 'Grandchild',
        parentAgentId: parentId,
        busId: grandparentId,
        status: 'ACTIVE',
      },
    });
    await prisma.verifier.create({
      data: { agentId: grandchildId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Delete grandparent — should recursively delete parent and grandchild
  const delRes = await request(`${BASE_URL}/api/agents/${grandparentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(delRes.status, 204, delRes.data);

  // All three should be 404
  for (const id of [grandparentId, parentId, grandchildId]) {
    const getRes = await request(`${BASE_URL}/api/agents/${id}`, {
      headers: apiKeyHeaders(session.user.id),
    });
    assertStatus(getRes.status, 404, getRes.data);
  }
});

// ========================= PATCH /:id/status — tool token fields ===========

test('PATCH /:id/status — with tool token cost fields', async () => {
  const session = await createAnonymousSession('status-tool-tokens');

  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-tool-token-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Tool token cost test',
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
      progress: 0.5,
      tokenCount: 2000,
      tokensIn: 1200,
      tokensOut: 800,
      toolTokensIn: 500,
      toolTokensOut: 300,
      toolCostCents: 15,
      contextSize: 8000,
      messageCount: 12,
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateStatusResponse, res.data, 'PATCH status tool tokens');
  assert(body.status === 'ACTIVE', `Expected ACTIVE, got ${body.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= GET / — with source filter ======================
