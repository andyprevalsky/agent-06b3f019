import {
  BASE_URL,
  API_KEY,
  FAKE_UUID,
  trackedAgentIds,
  trackedUserIds,
  ListAgentsResponse,
  GetAgentResponse,
  StatusResponse,
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
  sleep,
  withTransientDbRetry,
  test,
  prisma,
  randomUUID,
} from './agents-blackbox-harness';

test('POST /messages/batch — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    body: JSON.stringify({ ids: [] }),
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /messages/batch — empty ids → 400', async () => {
  const session = await createAnonymousSession('batch-empty');
  const res = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ ids: [] }),
  });
  assertStatus(res.status, 400, res.data);
  trackedUserIds.add(session.user.id);
});

test('POST /messages/batch — nonexistent IDs → 200 empty', async () => {
  const session = await createAnonymousSession('batch-fake');
  const fakeIds = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];
  const res = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ ids: fakeIds }),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { messages: unknown[] };
  if (!Array.isArray(body.messages)) {
    throw new Error('Expected messages array in response');
  }
  if (body.messages.length !== 0) {
    throw new Error(`Expected 0 messages for fake IDs, got ${body.messages.length}`);
  }
  trackedUserIds.add(session.user.id);
});

test('POST /messages/batch — over 50 IDs → 400', async () => {
  const session = await createAnonymousSession('batch-over50');
  trackedUserIds.add(session.user.id);
  const ids = Array.from(
    { length: 51 },
    (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
  );
  const res = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ ids }),
  });
  assertStatus(res.status, 400, res.data);
});

test('POST /messages/batch — returns real messages scoped to user', async () => {
  const session = await createAnonymousSession('batch-real');
  trackedUserIds.add(session.user.id);

  // Create agent using the retry-capable helper, then post a USER message
  const agentId = await createTestAgent(session.user.id, 'batch test agent');
  trackedAgentIds.add(agentId);

  const msgRes = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ message: 'batch test message content', role: 'USER' }),
  });
  assertStatus(msgRes.status, 201, msgRes.data);
  const messageId = (msgRes.data as { message_id: string }).message_id;

  // Batch fetch that message
  const batchRes = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ ids: [messageId] }),
  });
  assertStatus(batchRes.status, 200, batchRes.data);
  const body = batchRes.data as { messages: { id: string; text: string; role: string }[] };
  if (body.messages.length !== 1) {
    throw new Error(`Expected 1 message, got ${body.messages.length}`);
  }
  if (body.messages[0].id !== messageId) {
    throw new Error(`Expected message id ${messageId}, got ${body.messages[0].id}`);
  }
  if (body.messages[0].text !== 'batch test message content') {
    throw new Error(`Unexpected text: ${body.messages[0].text}`);
  }
  if (body.messages[0].role !== 'USER') {
    throw new Error(`Expected role USER, got ${body.messages[0].role}`);
  }
});

// ========================= POST /generate-response-schema ==================

test('POST /generate-response-schema — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/generate-response-schema`, {
    method: 'POST',
    body: JSON.stringify({ goal: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /generate-response-schema — missing goal → 400', async () => {
  const session = await createAnonymousSession('schema-no-goal');
  const res = await request(`${BASE_URL}/api/agents/generate-response-schema`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
});

// ========================= GET /:id/phone-calls/:callId/recording ==========

test('GET /:id/phone-calls/:callId/recording — no auth → 401', async () => {
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/phone-calls/${FAKE_UUID}/recording`
  );
  assertStatus(res.status, 401, res.data);
});

test('GET /:id/phone-calls/:callId/recording — unknown agent → 404', async () => {
  const session = await createAnonymousSession('phone-rec-missing');
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/phone-calls/${FAKE_UUID}/recording`,
    { headers: authHeaders(session.session.access_token) }
  );
  assertStatus(res.status, 404, res.data);
});

// ========================= GET /:id/attachments/:fileId/url ================

test('GET /:id/attachments/:fileId/url — no auth → 401', async () => {
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/attachments/${FAKE_UUID}/url?storage_path=test`
  );
  assertStatus(res.status, 401, res.data);
});

test('GET /:id/attachments/:fileId/url — missing storage_path → 400', async () => {
  const session = await createAnonymousSession('att-no-path');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/attachments/${FAKE_UUID}/url`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
});

test('GET /:id/attachments/:fileId/url — wrong user path → 403', async () => {
  const session = await createAnonymousSession('att-wrong-user');
  const otherUserId = randomUUID();
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/attachments/${FAKE_UUID}/url?storage_path=${encodeURIComponent(otherUserId + '/file.txt')}`,
    { headers: authHeaders(session.session.access_token) }
  );
  assertStatus(res.status, 403, res.data);
});

test('GET /:id/attachments/:fileId/url — admin can sign inspected agent owner path', async () => {
  const owner = await createAnonymousSession('att-admin-owner');
  trackedUserIds.add(owner.user.id);
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-att-admin-owner', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: owner.user.id,
        goal: 'attachment admin inspect',
        status: 'COMPLETED',
        model: 'rose-labs/rose-1-ultra',
        busId: agentId,
      },
    });
  });
  const form = new FormData();
  form.append('file', new Blob(['<html>recording</html>'], { type: 'text/html' }), 'rec.html');
  const uploaded = await fetch(`${BASE_URL}/api/agents/${agentId}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner.session.access_token}` },
    body: form,
  });
  assertStatus(uploaded.status, 201, await uploaded.clone().json());
  const uploadedBody = (await uploaded.json()) as { file_pointer?: { storage_path?: string } };
  const storagePath = uploadedBody.file_pointer?.storage_path;
  assert(typeof storagePath === 'string' && storagePath.startsWith(`${owner.user.id}/`));
  const andy = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
  const res = await request(
    `${BASE_URL}/api/agents/${agentId}/attachments/${FAKE_UUID}/url?storage_path=${encodeURIComponent(storagePath)}`,
    { headers: { ...apiKeyHeaders(), 'X-User-Id': andy } }
  );
  assertStatus(res.status, 200, res.data);
  assert(typeof (res.data as { signed_url?: string }).signed_url === 'string');
});

test('GET /:id/attachments/:fileId/url — admin cannot sign a different user path', async () => {
  const owner = await createAnonymousSession('att-admin-other');
  trackedUserIds.add(owner.user.id);
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-att-admin-other', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: owner.user.id,
        goal: 'attachment admin deny other',
        status: 'COMPLETED',
        model: 'rose-labs/rose-1-ultra',
        busId: agentId,
      },
    });
  });
  const andy = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
  const otherUserId = randomUUID();
  const res = await request(
    `${BASE_URL}/api/agents/${agentId}/attachments/${FAKE_UUID}/url?storage_path=${encodeURIComponent(otherUserId + '/browser-recording.html')}`,
    { headers: { ...apiKeyHeaders(), 'X-User-Id': andy } }
  );
  assertStatus(res.status, 403, res.data);
});

// ========================= State transition invariants ======================

test('state: pause → resume round-trip preserves agent data', async () => {
  const session = await createAnonymousSession('state-round-trip');

  // Seed the state-machine precondition directly. Creating a chat-mode root via
  // HTTP starts a background LLM request whose terminal failure can race this
  // route-level transition assertion.
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-state-round-trip', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'State round-trip test',
        status: 'ACTIVE',
        model: 'rose-labs/rose-1-ultra',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Get initial state
  const before = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const beforeBody = assertSchema(GetAgentResponse, before.data, 'before pause');

  // Force PAUSED via status PATCH — this is race-safe because
  // failAgentIfStillActive only overwrites STARTING_UP/ACTIVE, not PAUSED.
  // Using the pause endpoint alone races with handleChatMessage's fire-and-forget.
  const patchRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
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
  assertStatus(patchRes.status, 200, patchRes.data);

  // Verify intermediate PAUSED state
  const pausedCheck = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const pausedStatus = assertSchema(StatusResponse, pausedCheck.data, 'intermediate PAUSED check');
  assert(
    pausedStatus.status === 'PAUSED',
    `Expected PAUSED after pause, got ${pausedStatus.status}`
  );

  // Resume — assert the mutation response
  const resumeRes = await request(`${BASE_URL}/api/agents/${agentId}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(resumeRes.status, 200, resumeRes.data);

  // Get after state
  const after = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const afterBody = assertSchema(GetAgentResponse, after.data, 'after resume');

  assert(
    afterBody.agent.status === 'ACTIVE',
    `Expected ACTIVE after round-trip, got ${afterBody.agent.status}`
  );
  assert(afterBody.agent.goal === beforeBody.agent.goal, 'Goal should survive round-trip');
  assert(afterBody.agent.model === beforeBody.agent.model, 'Model should survive round-trip');

  await deleteTestAgent(agentId, session.user.id);
});

test('state: pause skips terminal agents', async () => {
  const session = await createAnonymousSession('state-terminal');

  // Create agent via HTTP, then set to COMPLETED via internal status update
  const agentId = await createTestAgent(session.user.id, 'Terminal pause test');
  await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'COMPLETED',
      progress: 1.0,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });

  // Pause should succeed but not change status (skips terminal)
  const pauseRes = await request(`${BASE_URL}/api/agents/${agentId}/pause`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(pauseRes.status, 200, pauseRes.data);

  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const status = assertSchema(StatusResponse, statusRes.data, 'terminal pause check');
  assert(status.status === 'COMPLETED', `Expected COMPLETED to persist, got ${status.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Read-after-write consistency ====================

test('read-after-write: create agent → immediately visible in list', async () => {
  const session = await createAnonymousSession('raw-list');
  const goal = `RAW list test ${randomUUID().slice(0, 8)}`;
  const agentId = await createTestAgent(session.user.id, goal);

  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(session.user.id) });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListAgentsResponse, res.data, 'RAW list');
  const found = body.agents.find((a) => a.agent_id === agentId);
  assert(found, 'Newly created agent should appear in list');
  assert(found!.goal === goal, 'Goal should match in list');

  await deleteTestAgent(agentId, session.user.id);
});

test('read-after-write: update agent → visible in detail', async () => {
  const session = await createAnonymousSession('raw-update');
  const agentId = await createTestAgent(session.user.id, 'RAW update test');

  const patchAgent = async () => {
    const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'PATCH',
      headers: apiKeyHeaders(session.user.id),
      body: JSON.stringify({ model: 'rose-labs/rose-1-ultra', progress: 0.5, message_count: 10 }),
    });
    return res;
  };
  const patchRes = await patchAgent();
  // A transient write failure (pool timeout, 5xx) must surface HERE as a failed
  // write, not later as a confusing "read shows stale values" mismatch.
  assert(patchRes.status === 200, `PATCH must succeed, got ${patchRes.status}`);

  // Read-after-write can briefly race the Prisma connection pool (the read may
  // land on a connection whose snapshot predates the just-committed write), so
  // poll a few times instead of asserting a single immediate read.
  const readDetail = async () => {
    const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
      headers: apiKeyHeaders(session.user.id),
    });
    return assertSchema(GetAgentResponse, res.data, 'RAW update verify');
  };
  let body = await readDetail();
  // Poll budget is generous (up to ~4s) so the read-after-write pool-snapshot
  // race resolves even against the c8-instrumented coverage backend, which runs
  // ~2-3x slower than the bare stack and can otherwise briefly serve a
  // pre-commit snapshot past a tighter budget.
  //
  // A goal-only agent also has a detached chat run (startChatMode →
  // handleChatMessage) that legitimately writes agent fields (message_count)
  // while it settles. That concurrent writer can clobber this test's PATCH —
  // which is valid last-write-wins behavior, not a read-after-write violation.
  // The contract under test is "a PATCH is visible to subsequent reads absent
  // other writers", so re-issue the PATCH periodically; once the short-lived
  // chat run settles, the written values stick and the read converges.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (
      body.agent.model === 'rose-labs/rose-1-ultra' &&
      body.agent.progress === 0.5 &&
      body.agent.message_count === 10
    ) {
      break;
    }
    if (attempt % 10 === 9) {
      await patchAgent();
    }
    await sleep(100);
    body = await readDetail();
  }
  assert(body.agent.model === 'rose-labs/rose-1-ultra', 'Model not updated');
  assert(body.agent.progress === 0.5, 'Progress not updated');
  assert(body.agent.message_count === 10, 'Message count not updated');

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Ordering / pagination invariant =================

test('ordering: list agents returns newest first', async () => {
  const session = await createAnonymousSession('order-list');
  const id1 = await createTestAgent(session.user.id, 'First agent');
  // Small delay to ensure distinct timestamps
  await sleep(50);
  const id2 = await createTestAgent(session.user.id, 'Second agent');

  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(session.user.id) });
  const body = assertSchema(ListAgentsResponse, res.data, 'order list');
  const idx1 = body.agents.findIndex((a) => a.agent_id === id1);
  const idx2 = body.agents.findIndex((a) => a.agent_id === id2);
  assert(idx1 >= 0 && idx2 >= 0, 'Both agents should be in list');
  assert(idx2 < idx1, 'Newer agent should appear first');

  await deleteTestAgent(id1, session.user.id);
  await deleteTestAgent(id2, session.user.id);
});

test('ordering: messages returned in timestamp asc', async () => {
  const session = await createAnonymousSession('order-msgs');
  const agentId = await createTestAgent(session.user.id, 'Message order test');

  // Post two more messages
  await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'msg-1', role: 'ASSISTANT' }),
  });
  await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'msg-2', role: 'TOOL' }),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const body = assertSchema(GetAgentResponse, res.data, 'message order');
  const timestamps = body.messages.map((m) => new Date(m.timestamp as string).getTime());
  for (let i = 1; i < timestamps.length; i++) {
    assert(timestamps[i] >= timestamps[i - 1], `Messages not in ascending order at index ${i}`);
  }

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Sub-agent creation & recursive delete ===========

test('POST / — sub-agent creation with parent_agent_id', async () => {
  const session = await createAnonymousSession('sub-agent-create');
  const parentId = await createTestAgent(session.user.id, 'Parent for sub-agent test');
  await prepareTestParentWorkflow(parentId);

  // Create child agent with parent_agent_id, depth, and bus_id via API key
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Child sub-agent test',
      parent_agent_id: parentId,
      parent_workflow_id: parentId,
      depth: 1,
      bus_id: parentId,
      task_queue: 'test-queue',
    }),
  });
  // Sub-agent creation may succeed (201) or fail (500 if Temporal not running)
  if (res.status !== 201 && res.status !== 500) {
    throw new Error(`Expected 201 or 500 for sub-agent create, got ${res.status}`);
  }
  if (res.status === 201) {
    const body = res.data as { agent_id: string };
    trackedAgentIds.add(body.agent_id);
    await deleteTestAgent(body.agent_id, session.user.id);
  }
  await deleteTestAgent(parentId, session.user.id);
});

test('DELETE /:id — recursive delete with children', async () => {
  const session = await createAnonymousSession('recursive-del');

  // Create parent via HTTP so it's visible to the server
  const parentId = await createTestAgent(session.user.id, 'Parent recursive delete test');
  await prepareTestParentWorkflow(parentId);

  // Create child via HTTP with parent_agent_id — may fail (500) if Temporal not running,
  // but the agent row is committed to DB before the workflow launch attempt
  const childCreateRes = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Child recursive delete test',
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
    const child = await withTransientDbRetry('find-child-recursive', async () =>
      prisma.agent.findFirst({
        where: { parentAgentId: parentId, userId: session.user.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    );
    if (!child) throw new Error('Child agent not found after sub-agent creation attempt');
    childId = child.id;
  }
  trackedAgentIds.add(childId);

  // Delete parent — should recursively delete child
  const delRes = await request(`${BASE_URL}/api/agents/${parentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(delRes.status, 204, delRes.data);

  // Both parent and child should be 404 on GET
  const parentGet = await request(`${BASE_URL}/api/agents/${parentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(parentGet.status, 404, parentGet.data);

  const childGet = await request(`${BASE_URL}/api/agents/${childId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(childGet.status, 404, childGet.data);
});

test('DELETE /:id — cleans up attention requests', async () => {
  const session = await createAnonymousSession('del-attention');

  // Create agent via HTTP so it's visible to the server
  const agentId = await createTestAgent(session.user.id, 'Attention request cleanup test');

  // Create an attention request via Prisma (no HTTP endpoint for this)
  await withTransientDbRetry('create-attention-request', async () => {
    await prisma.agentAttentionRequest.create({
      data: {
        userId: session.user.id,
        agentId,
        workflowId: 'test-workflow-id',
        question: 'Test question?',
      },
    });
  });

  // Verify attention request exists
  const beforeCount = await withTransientDbRetry('count-attention-before', async () => {
    return prisma.agentAttentionRequest.count({ where: { agentId } });
  });
  assert(beforeCount === 1, `Expected 1 attention request before delete, got ${beforeCount}`);

  // Delete agent
  const delRes = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(delRes.status, 204, delRes.data);

  // Verify attention request is cleaned up
  const afterCount = await withTransientDbRetry('count-attention-after', async () => {
    return prisma.agentAttentionRequest.count({ where: { agentId } });
  });
  assert(afterCount === 0, `Expected 0 attention requests after delete, got ${afterCount}`);
});

test('DELETE /:id — internal auth delete (no userId)', async () => {
  const session = await createAnonymousSession('del-internal');
  const agentId = await createTestAgent(session.user.id, 'Internal delete test');

  // Delete with only X-API-Key (no X-User-Id) — internal auth bypasses ownership check
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': API_KEY },
  });
  assertStatus(res.status, 204, res.data);

  // Verify it's gone
  const check = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(check.status, 404, check.data);
});

// ========================= Terminal agent pause behavior ====================

test('POST /:id/pause — terminal FAILED agent stays FAILED', async () => {
  const session = await createAnonymousSession('pause-failed');

  // Create agent via HTTP, then set to FAILED via internal status update
  const agentId = await createTestAgent(session.user.id, 'Pause FAILED test');
  await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'FAILED',
      statusMessage: 'Test failure',
      progress: 0,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });

  const pauseRes = await request(`${BASE_URL}/api/agents/${agentId}/pause`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(pauseRes.status, 200, pauseRes.data);

  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const status = assertSchema(StatusResponse, statusRes.data, 'pause-failed check');
  assert(status.status === 'FAILED', `Expected FAILED to persist, got ${status.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Resume with COST_LIMIT_REACHED parent ===========
