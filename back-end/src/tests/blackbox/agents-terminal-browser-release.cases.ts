import {
  BASE_URL,
  apiKeyHeaders,
  request,
  assertStatus,
  assert,
  createAnonymousSession,
  createTestAgent,
  trackedAgentIds,
  trackedUserIds,
  test,
  prisma,
  randomUUID,
} from './agents-blackbox-harness';
import { releaseAgentBrowserSessions } from '../../providers/agentCleanup';

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

test('browser release attempts every session and reports provider failures', async () => {
  const attempted: string[] = [];
  let rejected = false;
  try {
    await releaseAgentBrowserSessions('provider-failure-agent', {
      findActiveSessions: async () => [
        { sessionId: 'session-that-fails' },
        { sessionId: 'session-that-closes' },
      ],
      closeSession: async (sessionId: string) => {
        attempted.push(sessionId);
        if (sessionId === 'session-that-fails') throw new Error('provider close failed');
      },
    });
  } catch (error) {
    rejected = error instanceof AggregateError && error.errors.length === 1;
  }
  assert(rejected, 'provider close failures must remain observable to retrying callers');
  assert(
    attempted.join(',') === 'session-that-fails,session-that-closes',
    `every browser session must be attempted before rejection (attempted=${attempted.join(',')})`
  );
});

test('browser release propagates active-session query failures', async () => {
  let rejected = false;
  try {
    await releaseAgentBrowserSessions('query-failure-agent', {
      findActiveSessions: async () => {
        throw new Error('browser session query failed');
      },
    });
  } catch (error) {
    rejected = error instanceof Error && error.message === 'browser session query failed';
  }
  assert(rejected, 'query failure must not be converted into a false zero-session success');
});

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

test("a child agent's first terminal transition releases its browser sessions", async () => {
  const session = await createAnonymousSession('child-browser-release');
  trackedUserIds.add(session.user.id);
  const rootAgentId = randomUUID();
  const childAgentId = randomUUID();
  trackedAgentIds.add(rootAgentId);
  trackedAgentIds.add(childAgentId);
  await prisma.agent.create({
    data: {
      id: rootAgentId,
      userId: session.user.id,
      goal: 'Parent for child browser release',
      status: 'ACTIVE',
      busId: rootAgentId,
    },
  });
  await prisma.agent.create({
    data: {
      id: childAgentId,
      userId: session.user.id,
      goal: 'Child with a rented browser',
      status: 'ACTIVE',
      parentAgentId: rootAgentId,
      parentWorkflowId: rootAgentId,
      busId: rootAgentId,
      depth: 1,
    },
  });
  const browserSessionId = await seedBrowserSession(session.user.id, childAgentId);

  const res = await request(`${BASE_URL}/api/agents/${childAgentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      status: 'COMPLETED',
      statusMessage: 'child terminal transition',
      progress: 1,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });
  assertStatus(res.status, 200, res.data);

  const released = await prisma.browserSession.findUnique({ where: { id: browserSessionId } });
  assert(
    released?.status === 'CLOSED' && released.closedAt !== null,
    `Terminal child left its browser rental open (status=${String(released?.status)})`
  );
});
