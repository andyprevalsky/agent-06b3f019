import {
  BASE_URL,
  FAKE_UUID,
  trackedAgentIds,
  StatusResponse,
  WorkflowReplacementBootstrapAckResponse,
  UpdateAgentResponse,
  SuccessResponse,
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
} from './agents-blackbox-harness';

test('POST bootstrap-ack — generation fenced, durable, and idempotent', async () => {
  const session = await createAnonymousSession('bootstrap-ack');
  const agentId = await createTestAgent(session.user.id, 'Bootstrap acknowledgement test');
  const candidateGeneration = `${agentId}:replacement:${randomUUID()}`;
  const replacementToken = randomUUID();
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      temporalWorkflowId: candidateGeneration,
      temporalFirstExecutionRunId: 'candidate-run',
      workflowReplacementToken: replacementToken,
      workflowReplacementState: {
        version: 1,
        kind: 'deployment',
      },
      staleTemporalWorkflowId: `${agentId}:stale`,
      staleTemporalFirstExecutionRunId: 'stale-run',
    },
  });

  const staleRes = await request(
    `${BASE_URL}/api/agents/${agentId}/workflow-replacement/bootstrap-ack`,
    {
      method: 'POST',
      headers: {
        ...apiKeyHeaders(),
        'X-Agent-Workflow-Generation': `${agentId}:stale`,
      },
    }
  );
  assertStatus(staleRes.status, 409, staleRes.data);
  let stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(
    stored.workflowReplacementToken === replacementToken,
    'Stale generation consumed replacement token'
  );
  assert(stored.workflowReplacementState !== null, 'Stale generation consumed replacement state');

  const ackRes = await request(
    `${BASE_URL}/api/agents/${agentId}/workflow-replacement/bootstrap-ack`,
    {
      method: 'POST',
      headers: {
        ...apiKeyHeaders(),
        'X-Agent-Workflow-Generation': candidateGeneration,
      },
    }
  );
  assertStatus(ackRes.status, 200, ackRes.data);
  const ack = assertSchema(
    WorkflowReplacementBootstrapAckResponse,
    ackRes.data,
    'POST bootstrap-ack'
  );
  assert(ack.already_acknowledged === false, 'First acknowledgement reported as duplicate');

  stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(stored.workflowReplacementToken === null, 'Acknowledgement retained replacement token');
  assert(stored.workflowReplacementState === null, 'Acknowledgement retained replacement state');
  assert(stored.staleTemporalWorkflowId === null, 'Acknowledgement retained stale workflow ID');
  assert(
    stored.staleTemporalFirstExecutionRunId === null,
    'Acknowledgement retained stale workflow run ID'
  );

  const repeatedRes = await request(
    `${BASE_URL}/api/agents/${agentId}/workflow-replacement/bootstrap-ack`,
    {
      method: 'POST',
      headers: {
        ...apiKeyHeaders(),
        'X-Agent-Workflow-Generation': candidateGeneration,
      },
    }
  );
  assertStatus(repeatedRes.status, 200, repeatedRes.data);
  const repeated = assertSchema(
    WorkflowReplacementBootstrapAckResponse,
    repeatedRes.data,
    'POST bootstrap-ack repeated'
  );
  assert(repeated.already_acknowledged === true, 'Repeated acknowledgement was not idempotent');

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= DELETE /:id =====================================

test('DELETE /:id — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`, { method: 'DELETE' });
  assertStatus(res.status, 401, res.data);
});

test('DELETE /:id — not found → 404', async () => {
  const session = await createAnonymousSession('del-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 404, res.data);
});

test('DELETE /:id — happy path → 204', async () => {
  const session = await createAnonymousSession('del-happy');
  const agentId = await createTestAgent(session.user.id, 'Delete test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 204, res.data);
});

test('DELETE /:id — idempotent: re-delete → 404', async () => {
  const session = await createAnonymousSession('del-idempotent');
  const agentId = await createTestAgent(session.user.id, 'Idempotent delete test');

  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 404, res.data);
});

test('DELETE /:id — read-after-write: deleted agent → 404 on GET', async () => {
  const session = await createAnonymousSession('del-raw');
  const agentId = await createTestAgent(session.user.id, 'Delete RAW test');

  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 404, res.data);
});

test('DELETE /:id — tenant isolation: user B cannot delete user A agent', async () => {
  const sessionA = await createAnonymousSession('del-iso-a');
  const sessionB = await createAnonymousSession('del-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, 'Delete isolation test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);

  // Agent should still be accessible to owner
  const check = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(sessionA.user.id),
  });
  assertStatus(check.status, 200, check.data);

  await deleteTestAgent(agentId, sessionA.user.id);
});

// ========================= POST /:id/pause =================================

test('POST /:id/pause — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/pause`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/pause — not found → 404', async () => {
  const session = await createAnonymousSession('pause-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/pause`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('POST /:id/pause — happy path: status changes to PAUSED', async () => {
  const session = await createAnonymousSession('pause-happy');

  // Seed the route precondition directly. Creating a chat-mode root via HTTP
  // starts a background chat handler, which can independently fail and overwrite
  // the status to FAILED while this route-level assertion is reading it (the
  // resume happy-path test below was fixed the same way).
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-pause-happy', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Pause test',
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
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /:id/pause');

  // Verify status changed
  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(statusRes.status, 200, statusRes.data);
  const status = assertSchema(StatusResponse, statusRes.data, 'pause verify');
  assert(status.status === 'PAUSED', `Expected PAUSED, got ${status.status}`);

  await withTransientDbRetry('cleanup-pause-happy', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

// ========================= POST /:id/resume ================================

test('POST /:id/resume — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/resume`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/resume — not found → 404', async () => {
  const session = await createAnonymousSession('resume-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('POST /:id/resume — happy path: status changes to ACTIVE', async () => {
  const session = await createAnonymousSession('resume-happy');

  // Seed the route precondition directly. Creating a chat-mode root via HTTP
  // starts a background chat handler, which can independently fail and overwrite
  // the status while this route-level assertion is reading it.
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-resume-happy', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Resume test',
        status: 'PAUSED',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Resume
  const res = await request(`${BASE_URL}/api/agents/${agentId}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /:id/resume');

  // Verify status
  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const status = assertSchema(StatusResponse, statusRes.data, 'resume verify');
  assert(status.status === 'ACTIVE', `Expected ACTIVE after resume, got ${status.status}`);

  await withTransientDbRetry('cleanup-resume-happy', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

test('POST /:id/resume — child with paused parent → 400', async () => {
  const session = await createAnonymousSession('resume-parent-paused');

  // Create parent via HTTP then set to PAUSED so both parent and child are server-visible
  const parentId = await createTestAgent(session.user.id, 'Parent for resume test');
  await prepareTestParentWorkflow(parentId);
  await request(`${BASE_URL}/api/agents/${parentId}/status`, {
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

  // Create child via HTTP with parent_agent_id — may fail (500) if Temporal not running,
  // but the agent row is committed to DB before the workflow launch attempt
  const childCreateRes = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Child resume test',
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
    // Find child by parentAgentId lookup.
    const child = await withTransientDbRetry('find-child-resume', async () =>
      prisma.agent.findFirst({
        where: { parentAgentId: parentId, userId: session.user.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    );
    if (!child) throw new Error('Child agent not found after sub-agent creation attempt');
    childId = child.id;
    // Set child to PAUSED so its status matches original test intent
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

  // Try to resume child while parent is paused → 400
  const res = await request(`${BASE_URL}/api/agents/${childId}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);

  await deleteTestAgent(parentId, session.user.id);
});

// ========================= PATCH /:id (update agent) =======================

test('PATCH /:id — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
});

test('PATCH /:id — not found → 404', async () => {
  const session = await createAnonymousSession('upd-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ model: 'rose-labs/rose-1-ultra' }),
  });
  assertStatus(res.status, 404, res.data);
});

test('PATCH /:id — happy path: update model — schema validated', async () => {
  const session = await createAnonymousSession('upd-model');
  const agentId = await createTestAgent(session.user.id, 'Update model test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ model: 'rose-labs/rose-1-ultra' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id model');
  assert(
    body.agent.model === 'rose-labs/rose-1-ultra',
    `Expected updated model, got ${body.agent.model}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — update write_lock_enabled', async () => {
  const session = await createAnonymousSession('upd-wl');
  const agentId = await createTestAgent(session.user.id, 'Write lock test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ write_lock_enabled: false }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id write_lock');
  assert(body.agent.write_lock_enabled === false, 'Write lock should be disabled');

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — price_limit_cents below current cost → 400', async () => {
  const session = await createAnonymousSession('upd-price-low');
  const agentId = await createTestAgent(session.user.id, 'Price limit test');

  // Set tree cost to 50 cents via internal update
  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ tree_cost_cents: 50 }),
  });

  // Try to set limit below current cost
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ price_limit_cents: 30 }),
  });
  assertStatus(res.status, 400, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — price_limit_cents at or above current cost succeeds', async () => {
  const session = await createAnonymousSession('upd-price-ok');
  const agentId = await createTestAgent(session.user.id, 'Price limit OK test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ price_limit_cents: 500 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id price ok');
  assert(body.agent.price_limit_cents === 500, `Expected 500, got ${body.agent.price_limit_cents}`);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — invalid body → 400', async () => {
  const session = await createAnonymousSession('upd-bad-body');
  const agentId = await createTestAgent(session.user.id, 'Bad body test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ status: 'NOT_A_REAL_STATUS' }),
  });
  assertStatus(res.status, 400, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — tenant isolation: user B cannot update user A agent', async () => {
  const sessionA = await createAnonymousSession('upd-iso-a');
  const sessionB = await createAnonymousSession('upd-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, 'Update isolation test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: authHeaders(sessionB.session.access_token),
    body: JSON.stringify({ model: 'rose-labs/rose-1-ultra' }),
  });
  assertStatus(res.status, 404, res.data);

  await deleteTestAgent(agentId, sessionA.user.id);
});

// ========================= POST /:id/start-agent ==========================

test('POST /:id/start-agent — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/start-agent`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/start-agent — not found → 404', async () => {
  const session = await createAnonymousSession('start-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/start-agent`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

// ========================= POST /:id/restart ===============================

test('POST /:id/restart — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/restart`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/restart — not found → 404', async () => {
  const session = await createAnonymousSession('restart-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/restart`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

// ========================= POST /:id/signal/* ==============================

test('POST /:id/signal/signup_completed — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/signal/signup_completed`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/signal/signup_completed — not found → 404', async () => {
  const session = await createAnonymousSession('sig-comp-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/signal/signup_completed`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('POST /:id/signal/signup_completed — happy path (no workflow)', async () => {
  const session = await createAnonymousSession('sig-comp-happy');
  const agentId = await createTestAgent(session.user.id, 'Signup signal test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/signal/signup_completed`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'signal/signup_completed');

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/signal/signup_dismissed — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/signal/signup_dismissed`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/signal/signup_dismissed — not found → 404', async () => {
  const session = await createAnonymousSession('sig-dis-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/signal/signup_dismissed`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('POST /:id/signal/signup_dismissed — happy path (no workflow)', async () => {
  const session = await createAnonymousSession('sig-dis-happy');
  const agentId = await createTestAgent(session.user.id, 'Signup dismiss test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/signal/signup_dismissed`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'signal/signup_dismissed');

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /messages/batch ============================
