import {
  BASE_URL,
  apiKeyHeaders,
  assert,
  assertStatus,
  authHeaders,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  prisma,
  request,
  test,
} from './agents-blackbox-harness';

async function createPausedWorkflowAgent(label: string) {
  const session = await createAnonymousSession(label);
  const agentId = await createTestAgent(session.user.id, 'Buy the newest AirPods Pro', {
    start_phase: 'execute',
    pause_state: true,
  });
  const created = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(created.status === 'PAUSED', `fixture must start PAUSED, got ${created.status}`);
  assert(created.temporalWorkflowId === agentId, 'fixture must own a running workflow');
  return { session, agentId };
}

async function storedStatus(agentId: string): Promise<string> {
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  return stored.status;
}

test('POST /:id/messages — a user message resumes a PAUSED agent', async () => {
  // Resume-on-message used to live only in the web composer, so every other
  // user channel (SMS supervisor, public API, older clients) left the agent
  // PAUSED with the new instruction unread.
  const { session, agentId } = await createPausedWorkflowAgent('msg-resumes-paused');
  const text = 'Skip DoorDash; buy from Amazon instead.';

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: text }),
  });

  assertStatus(res.status, 201, res.data);
  const status = await storedStatus(agentId);
  assert(status === 'ACTIVE', `a user message must resume the agent, got ${status}`);
  const delivered = await prisma.message.count({ where: { agentId, role: 'USER', text } });
  assert(delivered === 1, `the message must be persisted once, got ${delivered}`);

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — a USER message over the internal API key resumes a PAUSED agent', async () => {
  // Server-to-server senders (the benchmark harness, integrations) speak for
  // the user too; they must not need a follow-up /resume call.
  const { session, agentId } = await createPausedWorkflowAgent('msg-internal-resumes');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'Use the saved card instead.', role: 'USER' }),
  });

  assertStatus(res.status, 201, res.data);
  const status = await storedStatus(agentId);
  assert(status === 'ACTIVE', `any message send must resume the agent, got ${status}`);

  await deleteTestAgent(agentId, session.user.id);
});

test("POST /:id/messages — the agent's own workflow USER write leaves a PAUSED agent paused", async () => {
  // Worker activities stamp their generation. Their USER rows (response-schema
  // context, OTP relays) can land after the user paused and must not undo it.
  const { session, agentId } = await createPausedWorkflowAgent('msg-workflow-write-keeps-paused');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Agent-Workflow-Generation': agentId },
    body: JSON.stringify({
      message: 'Recently received SMS OTP code: 123456',
      role: 'USER',
      metadata: { hidden: true },
    }),
  });

  assertStatus(res.status, 201, res.data);
  const status = await storedStatus(agentId);
  assert(status === 'PAUSED', `a workflow-authored row must not lift the pause, got ${status}`);

  await deleteTestAgent(agentId, session.user.id);
});

async function answerAttentionRequestOfPausedAgent(label: string, action: 'respond' | 'reject') {
  const { session, agentId } = await createPausedWorkflowAgent(label);
  const attention = await prisma.agentAttentionRequest.create({
    data: {
      userId: session.user.id,
      agentId,
      workflowId: agentId,
      question: 'Place the AirPods Pro order for $249?',
    },
  });
  try {
    const res = await request(`${BASE_URL}/api/attention-requests/${attention.id}/${action}`, {
      method: 'POST',
      headers: authHeaders(session.session.access_token),
      body: JSON.stringify(action === 'respond' ? { response: 'Yes, go ahead' } : {}),
    });
    assertStatus(res.status, 200, res.data);
    const status = await storedStatus(agentId);
    assert(status === 'ACTIVE', `an attention ${action} must resume the agent, got ${status}`);
  } finally {
    await prisma.agentAttentionRequest.deleteMany({ where: { id: attention.id } });
    await deleteTestAgent(agentId, session.user.id);
  }
}

test('POST /attention-requests/:id/respond — an answer resumes a PAUSED agent', async () => {
  await answerAttentionRequestOfPausedAgent('attention-respond-resumes', 'respond');
});

test('POST /attention-requests/:id/reject — a rejection resumes a PAUSED agent', async () => {
  await answerAttentionRequestOfPausedAgent('attention-reject-resumes', 'reject');
});
