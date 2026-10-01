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
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(stored.status === 'ACTIVE', `a user message must resume the agent, got ${stored.status}`);
  const delivered = await prisma.message.count({ where: { agentId, role: 'USER', text } });
  assert(delivered === 1, `the message must be persisted once, got ${delivered}`);

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — an internal USER injection leaves a PAUSED agent paused', async () => {
  const { session, agentId } = await createPausedWorkflowAgent('msg-internal-keeps-paused');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'Recently received SMS OTP code: 123456', role: 'USER' }),
  });

  assertStatus(res.status, 201, res.data);
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(
    stored.status === 'PAUSED',
    `only the user can lift their own pause, internal write made it ${stored.status}`
  );

  await deleteTestAgent(agentId, session.user.id);
});
