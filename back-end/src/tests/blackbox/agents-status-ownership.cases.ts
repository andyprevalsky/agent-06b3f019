import {
  BASE_URL,
  authHeaders,
  request,
  assertStatus,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  test,
} from './agents-blackbox-harness';

test('GET /:id/status — another user cannot read the agent status', async () => {
  const owner = await createAnonymousSession('status-owner');
  const other = await createAnonymousSession('status-other');
  const agentId = await createTestAgent(owner.user.id, 'Private status test');
  try {
    const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
      headers: authHeaders(other.session.access_token),
    });
    assertStatus(res.status, 404, res.data);
  } finally {
    await deleteTestAgent(agentId, owner.user.id);
  }
});
