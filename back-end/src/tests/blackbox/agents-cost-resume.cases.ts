import {
  BASE_URL,
  trackedAgentIds,
  trackedUserIds,
  GetAgentResponse,
  StatusResponse,
  UpdateStatusResponse,
  UpdateAgentResponse,
  authHeaders,
  apiKeyHeaders,
  request,
  assertStatus,
  assertSchema,
  assert,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  prepareTestParentWorkflow,
  withTransientDbRetry,
  test,
  prisma,
  randomUUID,
  z,
} from './agents-blackbox-harness';

test('POST /:id/resume — child with COST_LIMIT_REACHED parent → 400', async () => {
  const session = await createAnonymousSession('resume-cost-limit');

  // Create parent via HTTP then set to COST_LIMIT_REACHED
  const parentId = await createTestAgent(session.user.id, 'Cost-limited parent');
  await prepareTestParentWorkflow(parentId);
  await request(`${BASE_URL}/api/agents/${parentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'COST_LIMIT_REACHED',
      progress: 0,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });

  // Create child via HTTP with parent_agent_id — may fail (500) if Temporal not running,
  // but the agent row is committed to DB before the workflow launch attempt
  const childCreateRes = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Child of cost-limited parent',
      parent_agent_id: parentId,
      parent_workflow_id: parentId,
      bus_id: parentId,
    }),
  });

  let childId: string;
  if (childCreateRes.status === 201) {
    childId = (childCreateRes.data as { agent_id: string }).agent_id;
  } else {
    // Temporal not running: child was written to DB before workflow launch failed.
    const child = await withTransientDbRetry('find-child-cost-limit', async () =>
      prisma.agent.findFirst({
        where: { parentAgentId: parentId, userId: session.user.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    );
    if (!child) throw new Error('Child agent not found after sub-agent creation attempt');
    childId = child.id;
    // Set child to PAUSED
    await request(`${BASE_URL}/api/agents/${childId}/status`, {
      method: 'PATCH',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        status: 'PAUSED',
        progress: 0,
        tokenCount: 0,
        contextSize: 0,
        messageCount: 0,
      }),
    });
  }
  trackedAgentIds.add(childId);

  // Try to resume child — should fail because parent is COST_LIMIT_REACHED
  const res = await request(`${BASE_URL}/api/agents/${childId}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('cost-limited'), `Expected cost-limited error, got: ${body.error}`);

  await deleteTestAgent(parentId, session.user.id);
});

// ========================= Resume tenant isolation ==========================

test('POST /:id/resume — tenant isolation: user B cannot resume user A agent → 404', async () => {
  const sessionA = await createAnonymousSession('resume-iso-a');
  const sessionB = await createAnonymousSession('resume-iso-b');

  // Create PAUSED agent for user A
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-resume-iso', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: sessionA.user.id,
        goal: 'Resume isolation test',
        status: 'PAUSED',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // User B tries to resume user A's agent
  const res = await request(`${BASE_URL}/api/agents/${agentId}/resume`, {
    method: 'POST',
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);

  // Cleanup
  await withTransientDbRetry('cleanup-resume-iso', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

// ========================= Start-agent edge cases ==========================

test('POST /:id/start-agent — already in agent mode → 400', async () => {
  const session = await createAnonymousSession('start-already');

  // Create agent with temporalWorkflowId set (simulating agent mode)
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-agent-mode', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Already in agent mode test',
        status: 'ACTIVE',
        temporalWorkflowId: 'fake-workflow-id-' + randomUUID(),
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/start-agent`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(
    body.error.includes('already in agent mode'),
    `Expected already in agent mode error, got: ${body.error}`
  );

  await withTransientDbRetry('cleanup-agent-mode', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

test('POST /:id/start-agent — no verifier → 400', async () => {
  const session = await createAnonymousSession('start-no-verifier');

  // Create agent WITHOUT a verifier
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-no-verifier', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'No verifier start-agent test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    // No verifier created intentionally
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/start-agent`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('verifier'), `Expected verifier error, got: ${body.error}`);

  await withTransientDbRetry('cleanup-no-verifier', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

// ========================= Restart edge cases ==============================

test('POST /:id/restart — no verifier → 400', async () => {
  const session = await createAnonymousSession('restart-no-verifier');

  // Create agent WITHOUT a verifier
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-restart-no-verifier', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'No verifier restart test',
        status: 'FAILED',
        busId: agentId,
      },
    });
    // No verifier created intentionally
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/restart`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('verifier'), `Expected verifier error, got: ${body.error}`);

  await withTransientDbRetry('cleanup-restart-no-verifier', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

test('POST /:id/restart — tenant isolation: user B cannot restart user A agent → 404', async () => {
  const sessionA = await createAnonymousSession('restart-iso-a');
  const sessionB = await createAnonymousSession('restart-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, 'Restart isolation test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/restart`, {
    method: 'POST',
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);

  await deleteTestAgent(agentId, sessionA.user.id);
});

// ========================= PATCH /:id/status with structuredResponse =======

test('PATCH /:id/status — with structuredResponse and all fields', async () => {
  const session = await createAnonymousSession('status-structured');

  // Create agent directly in DB to avoid chatHandler race
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-structured-status', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Structured response test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const structuredResponse = { result: 'success', data: [1, 2, 3] };
  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'COMPLETED',
      statusMessage: 'Done with structured output',
      progress: 1.0,
      tokenCount: 8000,
      tokensIn: 5000,
      tokensOut: 3000,
      contextSize: 15000,
      messageCount: 30,
      structuredResponse,
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateStatusResponse, res.data, 'PATCH status structured');
  assert(body.status === 'COMPLETED', `Expected COMPLETED, got ${body.status}`);
  assert(body.tokens_in === 5000, `Expected tokens_in 5000, got ${body.tokens_in}`);
  assert(body.tokens_out === 3000, `Expected tokens_out 3000, got ${body.tokens_out}`);

  // Verify structuredResponse is persisted by checking via GET detail
  const detail = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detail.status, 200, detail.data);
  const detailBody = assertSchema(GetAgentResponse, detail.data, 'GET detail structured');
  assert(
    z
      .object({ result: z.literal('success'), data: z.array(z.number()) })
      .safeParse(detailBody.agent.structured_output).success,
    `GET detail should expose structured output, got ${JSON.stringify(detailBody.agent.structured_output)}`
  );
  assert(
    detailBody.agent.failure_context === null,
    'Completed agent should not expose failure_context'
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('GET /:id — failed agent exposes partial structured failure context', async () => {
  const session = await createAnonymousSession('failed-structured-detail');

  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  const structuredResponse = { easy_fact: 'Paris', impossible_receipt_url: '' };
  await withTransientDbRetry('create-failed-structured-detail', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Failed structured detail test',
        status: 'FAILED',
        statusMessage: 'Max Steps Reached',
        busId: agentId,
        structuredResponse,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const detail = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detail.status, 200, detail.data);
  const detailBody = assertSchema(GetAgentResponse, detail.data, 'GET failed structured detail');
  assert(
    JSON.stringify(detailBody.agent.structured_output) === JSON.stringify(structuredResponse),
    'GET detail should expose failed structured output'
  );
  assert(
    JSON.stringify(detailBody.agent.failure_context) ===
      JSON.stringify({ partial_structured_response: structuredResponse }),
    'GET detail should expose partial structured failure context'
  );

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= PATCH /:id price_limit via prisma direct ========

test('PATCH /:id — price_limit_cents below cost set via prisma → 400', async () => {
  const session = await createAnonymousSession('price-prisma');

  // Create agent directly in DB and set treeCostCents via prisma
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-price-prisma', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Price limit prisma test',
        status: 'ACTIVE',
        treeCostCents: 100,
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Try to set price limit below current tree cost
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ price_limit_cents: 50 }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string; current_cost_cents?: number };
  assert(body.error.includes('current cost'), `Expected cost error, got: ${body.error}`);
  assert(
    body.current_cost_cents === 100,
    `Expected current_cost_cents=100, got ${body.current_cost_cents}`
  );

  await withTransientDbRetry('cleanup-price-prisma', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

// ========================= POST /:id/messages — completed agent resets =====

test('POST /:id/messages — user message to completed agent resets status', async () => {
  const session = await createAnonymousSession('msg-reset');

  // Create agent with COMPLETED status and a temporalWorkflowId
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-completed-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Completed agent message test',
        status: 'COMPLETED',
        temporalWorkflowId: 'fake-completed-workflow-' + randomUUID(),
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Post a user message — should reset status from COMPLETED to ACTIVE
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'follow-up question' }),
  });
  assertStatus(res.status, 201, res.data);

  // Verify status has been reset
  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const status = assertSchema(StatusResponse, statusRes.data, 'msg-reset status check');
  assert(
    status.status === 'ACTIVE',
    `Expected ACTIVE after message to completed agent, got ${status.status}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Batch messages tenant isolation ==================

test('POST /messages/batch — tenant isolation: user B cannot see user A messages', async () => {
  const sessionA = await createAnonymousSession('batch-iso-a');
  const sessionB = await createAnonymousSession('batch-iso-b');
  trackedUserIds.add(sessionA.user.id);
  trackedUserIds.add(sessionB.user.id);

  // Create agent for user A and post a message
  const agentId = await createTestAgent(sessionA.user.id, 'Batch isolation agent');
  const msgRes = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'secret message', role: 'ASSISTANT' }),
  });
  assertStatus(msgRes.status, 201, msgRes.data);
  const messageId = (msgRes.data as { message_id: string }).message_id;

  // User B tries to batch-fetch user A's message
  const batchRes = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': sessionB.user.id },
    body: JSON.stringify({ ids: [messageId] }),
  });
  assertStatus(batchRes.status, 200, batchRes.data);
  const body = batchRes.data as { messages: unknown[] };
  assert(
    body.messages.length === 0,
    `User B should not see user A messages, got ${body.messages.length}`
  );

  await deleteTestAgent(agentId, sessionA.user.id);
});

// ========================= PATCH /:id — tool_ids update ====================

test('PATCH /:id — tool_ids update', async () => {
  const session = await createAnonymousSession('upd-tools');
  const agentId = await createTestAgent(session.user.id, 'Tool IDs update test');

  // Get current tools (should be empty or default)
  const detailBefore = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detailBefore.status, 200, detailBefore.data);

  // Update with empty tool_ids (clear all tools)
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ tool_ids: [] }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id tool_ids');
  assert(
    body.agent.tools.length === 0,
    `Expected 0 tools after clearing, got ${body.agent.tools.length}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Cleanup invariant (best-effort) =================

test('cleanup: tracked agents are soft-deleted', async () => {
  // This test ensures we can clean up after ourselves.
  // Creates and immediately deletes an agent.
  const session = await createAnonymousSession('cleanup');
  const agentId = await createTestAgent(session.user.id, 'Cleanup test');
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 204, res.data);
});

// ========================= Additional coverage tests =======================
