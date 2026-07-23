import {
  BASE_URL,
  API_KEY,
  FAKE_UUID,
  RUN_ID,
  trackedAgentIds,
  ErrorResponse,
  ListAgentsResponse,
  TreeResponse,
  CreateAgentResponse,
  GetAgentResponse,
  AncestorsResponse,
  PostMessageResponse,
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
  prepareTestParentWorkflow,
  withTransientDbRetry,
  test,
  prisma,
  randomUUID,
} from './agents-blackbox-harness';

test('GET / — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents`);
  assertStatus(res.status, 401, res.data);
});

test('GET / — happy path (JWT) — schema validated', async () => {
  const session = await createAnonymousSession('list-jwt');
  const res = await request(`${BASE_URL}/api/agents`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListAgentsResponse, res.data, 'GET /');
});

test('GET / — happy path (API key) — schema validated', async () => {
  const session = await createAnonymousSession('list-apikey');
  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(session.user.id) });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListAgentsResponse, res.data, 'GET / (API key)');
});

test('GET / — new user sees empty list', async () => {
  const session = await createAnonymousSession('list-empty');
  const res = await request(`${BASE_URL}/api/agents`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListAgentsResponse, res.data, 'GET / empty');
  assert(body.agents.length === 0, `Expected 0 agents, got ${body.agents.length}`);
});

test('GET / — tenant isolation: user A cannot see user B agents', async () => {
  const sessionA = await createAnonymousSession('list-iso-a');
  const sessionB = await createAnonymousSession('list-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, 'Isolation test agent');

  const resB = await request(`${BASE_URL}/api/agents`, {
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(resB.status, 200, resB.data);
  const bodyB = assertSchema(ListAgentsResponse, resB.data, 'GET / isolation');
  const found = bodyB.agents.find((a) => a.agent_id === agentId);
  assert(!found, 'User B should not see user A agent');

  await deleteTestAgent(agentId, sessionA.user.id);
});

test('GET / — excludes soft-deleted agents', async () => {
  const session = await createAnonymousSession('list-deleted');
  const agentId = await createTestAgent(session.user.id, 'Soon deleted');
  await deleteTestAgent(agentId, session.user.id);

  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(session.user.id) });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListAgentsResponse, res.data, 'GET / after delete');
  const found = body.agents.find((a) => a.agent_id === agentId);
  assert(!found, 'Deleted agent should not appear in list');
});

test('GET / — no-cache headers present', async () => {
  const session = await createAnonymousSession('list-cache');
  const res = await request(`${BASE_URL}/api/agents`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  const cc = res.headers.get('cache-control');
  assert(cc && cc.includes('no-store'), `Expected no-store in Cache-Control, got "${cc}"`);
});

// ========================= GET /tree =======================================

test('GET /tree — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/tree`);
  assertStatus(res.status, 401, res.data);
});

test('GET /tree — missing busId → 400', async () => {
  const session = await createAnonymousSession('tree-no-bus');
  const res = await request(`${BASE_URL}/api/agents/tree`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
});

test('GET /tree — happy path — schema validated', async () => {
  const session = await createAnonymousSession('tree-happy');
  const agentId = await createTestAgent(session.user.id, 'Tree test agent');

  // Root agents have busId = own id
  const res = await request(`${BASE_URL}/api/agents/tree?busId=${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(TreeResponse, res.data, 'GET /tree');
  assert(body.agents.length >= 1, 'Expected at least 1 agent in tree');
  const self = body.agents.find((a) => a.agent_id === agentId);
  assert(self, 'Agent should appear in its own tree');
  assert(
    typeof self.tokens_in === 'number',
    `Expected tree tokens_in number, got ${self.tokens_in}`
  );
  assert(
    typeof self.tokens_out === 'number',
    `Expected tree tokens_out number, got ${self.tokens_out}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('GET /tree — unknown busId returns empty', async () => {
  const session = await createAnonymousSession('tree-empty');
  const res = await request(`${BASE_URL}/api/agents/tree?busId=${randomUUID()}`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(TreeResponse, res.data, 'GET /tree empty');
  assert(body.agents.length === 0, `Expected 0 agents in tree, got ${body.agents.length}`);
});

// ========================= POST / (create agent) ===========================

test('POST / — no auth → 401 or 402', async () => {
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    body: JSON.stringify({ goal: 'test' }),
  });
  if (res.status !== 401 && res.status !== 402) {
    throw new Error(`Expected 401 or 402, got ${res.status}`);
  }
});

test('POST / — anonymous JWT cannot create agent → 401', async () => {
  const session = await createAnonymousSession('create-anon-rejected');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ goal: 'Anonymous create should fail' }),
  });
  assertStatus(res.status, 401, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'POST / anonymous rejected');
  assert(body.error.includes('Login required'), `Unexpected error: ${body.error}`);
});

test('POST / — missing goal → 400', async () => {
  const session = await createAnonymousSession('create-no-goal');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / missing goal');
});

test('POST / — empty goal → 400', async () => {
  const session = await createAnonymousSession('create-empty-goal');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ goal: '' }),
  });
  assertStatus(res.status, 400, res.data);
});

test('POST / — happy path — full response schema', async () => {
  const session = await createAnonymousSession('create-happy');
  const goal = `Create happy test ${RUN_ID} ${randomUUID().slice(0, 8)}`;
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), { goal });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateAgentResponse, res.data, 'POST / happy');
  assert(body.goal === goal, `Goal mismatch: "${body.goal}" !== "${goal}"`);
  assert(body.status === 'ACTIVE', `Expected ACTIVE status, got ${body.status}`);
  assert(body.progress === 0, `Expected progress 0, got ${body.progress}`);
  trackedAgentIds.add(body.agent_id);

  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — creates initial goal message', async () => {
  const session = await createAnonymousSession('create-msg');
  const goal = `Goal message test ${RUN_ID}`;
  const agentId = await createTestAgent(session.user.id, goal);

  // Verify via GET detail
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetAgentResponse, res.data, 'POST / verify goal message');
  assert(body.messages.length >= 1, `Expected at least 1 message, got ${body.messages.length}`);
  const goalMsg = body.messages.find((m) => m.role === 'USER' && m.text === goal);
  assert(goalMsg, 'Initial goal message not found');

  await deleteTestAgent(agentId, session.user.id);
});

test('POST / — auto-generates verifier', async () => {
  const session = await createAnonymousSession('create-verifier');
  const agentId = await createTestAgent(session.user.id, 'Verifier test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetAgentResponse, res.data, 'POST / verify verifier');
  assert(body.agent.verifier !== null, 'Verifier should be auto-generated');
  assert(
    body.agent.verifier!.type === 'FLOAT_LLM_JUDGE',
    `Expected FLOAT_LLM_JUDGE, got ${body.agent.verifier!.type}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('POST / — custom model preserved', async () => {
  const session = await createAnonymousSession('create-model');
  const model = 'rose-labs/rose-1-ultra';
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Model test',
    model,
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateAgentResponse, res.data, 'POST / model');
  assert(body.model === model, `Expected model "${model}", got "${body.model}"`);
  trackedAgentIds.add(body.agent_id);

  await deleteTestAgent(body.agent_id, session.user.id);
});

// ========================= GET /:id (detail) ===============================

test('GET /:id — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`);
  assertStatus(res.status, 401, res.data);
});

test('GET /:id — not found → 404', async () => {
  const session = await createAnonymousSession('get-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('GET /:id — happy path — full schema', async () => {
  const session = await createAnonymousSession('get-happy');
  const agentId = await createTestAgent(session.user.id, 'Detail test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetAgentResponse, res.data, 'GET /:id happy');
  assert(body.agent.agent_id === agentId, 'Agent ID mismatch');
  assert(body.agent.goal === 'Detail test', 'Goal mismatch');
  assert(Array.isArray(body.messages), 'Messages should be array');
  assert(body.pagination.has_more === false, 'Pagination should indicate no more');

  await deleteTestAgent(agentId, session.user.id);
});

test('GET /:id — tenant isolation: user B cannot see user A agent → 404', async () => {
  const sessionA = await createAnonymousSession('get-iso-a');
  const sessionB = await createAnonymousSession('get-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, 'Isolation detail test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);

  await deleteTestAgent(agentId, sessionA.user.id);
});

test('GET /:id — internal auth bypasses user filter', async () => {
  const session = await createAnonymousSession('get-internal');
  const agentId = await createTestAgent(session.user.id, 'Internal access test');

  // API key without user ID → internal auth, no user filter
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: { 'X-API-Key': API_KEY },
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GetAgentResponse, res.data, 'GET /:id internal');

  await deleteTestAgent(agentId, session.user.id);
});

test('GET /:id — no-cache headers', async () => {
  const session = await createAnonymousSession('get-cache');
  const agentId = await createTestAgent(session.user.id, 'Cache test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const cc = res.headers.get('cache-control');
  assert(cc && cc.includes('no-store'), `Expected no-store, got "${cc}"`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= GET /:id/ancestors ==============================

test('GET /:id/ancestors — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/ancestors`);
  assertStatus(res.status, 401, res.data);
});

test('GET /:id/ancestors — root agent has empty ancestors', async () => {
  const session = await createAnonymousSession('ancestors-root');
  const agentId = await createTestAgent(session.user.id, 'Ancestor root test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/ancestors`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AncestorsResponse, res.data, 'GET /:id/ancestors root');
  assert(
    body.ancestors.length === 0,
    `Root agent should have 0 ancestors, got ${body.ancestors.length}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('GET /:id/ancestors — child agent returns parent', async () => {
  const session = await createAnonymousSession('ancestors-child');
  const parentGoal = `Parent agent ${RUN_ID}`;
  const parentId = await createTestAgent(session.user.id, parentGoal);
  await prepareTestParentWorkflow(parentId);

  // Create child agent via API with parent_agent_id
  const childCreateRes = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Child agent',
    parent_agent_id: parentId,
    parent_workflow_id: parentId,
    bus_id: parentId,
  });

  let childId: string;
  if (childCreateRes.status === 201) {
    childId = (childCreateRes.data as { agent_id: string }).agent_id;
  } else {
    // Temporal not running: child was written to DB before workflow launch failed.
    const child = await withTransientDbRetry('find-child-ancestors', async () =>
      prisma.agent.findFirst({
        where: { parentAgentId: parentId, userId: session.user.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    );
    if (!child) throw new Error('Child agent not found after sub-agent creation attempt');
    childId = child.id;
  }
  trackedAgentIds.add(childId);

  const res = await request(`${BASE_URL}/api/agents/${childId}/ancestors`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AncestorsResponse, res.data, 'GET /:id/ancestors child');
  assert(body.ancestors.length === 1, `Expected 1 ancestor, got ${body.ancestors.length}`);
  assert(body.ancestors[0].id === parentId, 'Ancestor should be parent');
  assert(body.ancestors[0].goal === parentGoal, 'Ancestor goal should match parent');

  await deleteTestAgent(parentId, session.user.id);
  // Child is cleaned up by parent delete (recursive) or final cleanup
});

// ========================= POST /:id/messages ==============================

test('POST /:id/messages — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/messages — not found → 404', async () => {
  const session = await createAnonymousSession('msg-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ message: 'test', role: 'USER' }),
  });
  assertStatus(res.status, 404, res.data);
});

test('POST /:id/messages — user message (JWT) — schema validated', async () => {
  const session = await createAnonymousSession('msg-user');
  const agentId = await createTestAgent(session.user.id, 'Message test agent');

  const msgText = `User message ${randomUUID().slice(0, 8)}`;
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: msgText }),
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(PostMessageResponse, res.data, 'POST /:id/messages user');
  assert(body.role === 'USER', `User auth should force USER role, got ${body.role}`);
  assert(body.text === msgText, 'Message text mismatch');

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — internal message requires role', async () => {
  const session = await createAnonymousSession('msg-int-no-role');
  const agentId = await createTestAgent(session.user.id, 'Internal role test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'test' }),
  });
  assertStatus(res.status, 400, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — internal TOOL message', async () => {
  const session = await createAnonymousSession('msg-tool');
  const agentId = await createTestAgent(session.user.id, 'Tool message test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      message: 'Search results: 3 items found',
      role: 'TOOL',
      metadata: { toolName: 'web_search', toolStatus: 'success' },
    }),
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(PostMessageResponse, res.data, 'POST /:id/messages TOOL');
  assert(body.role === 'TOOL', `Expected TOOL role, got ${body.role}`);

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — duplicate internal TOOL retry is idempotent', async () => {
  const session = await createAnonymousSession('msg-tool-dedupe');
  const agentId = await createTestAgent(session.user.id, 'Tool message dedupe test');
  const payload = {
    message: 'RemoteProtocolError: Server disconnected without sending a response.',
    role: 'TOOL',
    metadata: {
      toolCallId: 'attempt-completion-dedupe',
      toolName: 'attempt_completion',
      toolStatus: 'ERROR',
      title: 'attempt_completion',
    },
  };

  const first = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify(payload),
  });
  const second = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify(payload),
  });

  assertStatus(first.status, 201, first.data);
  assertStatus(second.status, 201, second.data);
  const firstBody = assertSchema(PostMessageResponse, first.data, 'POST duplicate TOOL first');
  const secondBody = assertSchema(PostMessageResponse, second.data, 'POST duplicate TOOL second');
  assert(
    firstBody.message_id === secondBody.message_id,
    'duplicate TOOL retry should return existing message id'
  );

  const detail = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detail.status, 200, detail.data);
  const detailBody = assertSchema(GetAgentResponse, detail.data, 'duplicate TOOL detail');
  const matches = detailBody.messages.filter(
    (m) =>
      m.role === 'TOOL' &&
      m.text === payload.message &&
      typeof m.metadata === 'object' &&
      m.metadata !== null &&
      (m.metadata as Record<string, unknown>).toolCallId === payload.metadata.toolCallId
  );
  assert(
    matches.length === 1,
    `Expected one persisted duplicate TOOL message, got ${matches.length}`
  );

  await deleteTestAgent(agentId, session.user.id);
});
