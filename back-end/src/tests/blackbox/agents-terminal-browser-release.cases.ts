import {
  BASE_URL,
  apiKeyHeaders,
  request,
  assertStatus,
  assert,
  createAnonymousSession,
  createTestAgent,
  trackedUserIds,
  test,
  prisma,
  randomUUID,
} from './agents-blackbox-harness';

/**
 * A browser session is a rented remote browser that costs money for as long as it is
 * open. Release used to hang off agent DELETION only (`providers/agentCleanup`
 * `cleanupAgentSessions`), an action most agents never receive — so every agent that
 * merely finished left its browser running. Prod held 12 such rows still
 * `ACTIVE / closedAt NULL` across COMPLETED, COST_LIMIT_REACHED and FAILED agents,
 * the oldest from 2026-07-24.
 *
 * The Python browser activity's own `POST /api/browser-session/close` lives inside its
 * `try` body — not a `finally` — so a Temporal terminate, a worker kill, or a backend
 * 5xx skips it entirely. The backend terminal transition is the only release the agent
 * cannot fail to reach.
 */
async function seedBrowserSession(userId: string, agentId: string): Promise<string> {
  const context = await prisma.browserContext.create({
    data: { userId, contextId: `steel-profile-${randomUUID()}` },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId,
      sessionId: `local-${randomUUID()}`,
      debugUrl: 'http://localhost:9222/session/terminal-release?interactive=false',
      status: 'ACTIVE',
      provider: 'steel',
      providerProfileId: `session-bound-profile-${randomUUID()}`,
      providerProfileSource: 'test_session_bound',
    },
  });
  return session.id;
}

for (const status of ['COMPLETED', 'COST_LIMIT_REACHED'] as const) {
  test(`PATCH /:id/status ${status} releases the agent's browser sessions`, async () => {
    const session = await createAnonymousSession(`browser-release-${status.toLowerCase()}`);
    trackedUserIds.add(session.user.id);
    const agentId = await createTestAgent(session.user.id);
    const browserSessionId = await seedBrowserSession(session.user.id, agentId);

    const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
      method: 'PATCH',
      headers: apiKeyHeaders(session.user.id),
      body: JSON.stringify({
        status,
        statusMessage: 'blackbox terminal transition',
        progress: 1,
        tokenCount: 0,
        contextSize: 0,
        messageCount: 0,
      }),
    });
    assertStatus(res.status, 200, res.data);

    const released = await prisma.browserSession.findUnique({ where: { id: browserSessionId } });
    assert(
      released !== null && released.status === 'CLOSED',
      `Terminal ${status} left the browser session open (status=${String(released?.status)})`
    );
    assert(
      released.closedAt !== null,
      `Terminal ${status} left closedAt null on a released browser session`
    );
  });
}
