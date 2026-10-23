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
import {
  TERMINAL_BROWSER_RELEASE_LEASE_KEY,
  reconcileTerminalAgentBrowserSessions,
  releaseAgentBrowserSessions,
  runTerminalAgentBrowserReleaseReconcileWithLease,
} from '../../providers/agentCleanup';

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
  const context = await prisma.browserContext.upsert({
    where: { userId },
    create: { userId, contextId: `steel-profile-${randomUUID()}` },
    update: {},
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

test('browser release retries sessions durably marked ERROR', async () => {
  const session = await createAnonymousSession('browser-release-error-retry');
  trackedUserIds.add(session.user.id);
  const agentId = await createTestAgent(session.user.id);
  const browserSessionId = await seedBrowserSession(session.user.id, agentId);
  await prisma.browserSession.update({
    where: { id: browserSessionId },
    data: { status: 'ERROR', closedAt: null },
  });

  const attempted: string[] = [];
  const released = await releaseAgentBrowserSessions(agentId, {
    closeSession: async (sessionId) => {
      attempted.push(sessionId);
    },
  });
  assert(released === 1, `expected one ERROR session retry, got ${released}`);
  assert(attempted.length === 1, 'durable ERROR session was omitted from release retry query');
});

test('terminal browser release reconciliation includes COMPLETED and FAILED agents', async () => {
  const session = await createAnonymousSession('terminal-browser-release-reconcile');
  trackedUserIds.add(session.user.id);
  const completedAgentId = await createTestAgent(session.user.id);
  const failedAgentId = await createTestAgent(session.user.id);
  await Promise.all([
    prisma.agent.update({ where: { id: completedAgentId }, data: { status: 'COMPLETED' } }),
    prisma.agent.update({ where: { id: failedAgentId }, data: { status: 'FAILED' } }),
  ]);
  // BrowserContext.userId is unique; create/reuse it before seeding the second
  // session instead of racing two upserts for the same user's context.
  await seedBrowserSession(session.user.id, completedAgentId);
  await seedBrowserSession(session.user.id, failedAgentId);

  const attempted = new Set<string>();
  await reconcileTerminalAgentBrowserSessions({
    releaseBrowserSessions: async (agentId) => {
      attempted.add(agentId);
      return 0;
    },
  });
  assert(attempted.has(completedAgentId), 'COMPLETED agent was excluded from release retry');
  assert(attempted.has(failedAgentId), 'FAILED agent was excluded from release retry');
});

test('terminal browser release reconciliation isolates provider failures', async () => {
  const attempted: string[] = [];
  const summary = await reconcileTerminalAgentBrowserSessions({
    findTerminalAgentIds: async () => ['failed-release-agent', 'healthy-release-agent'],
    releaseBrowserSessions: async (agentId) => {
      attempted.push(agentId);
      if (agentId === 'failed-release-agent') throw new Error('provider unavailable');
      return 2;
    },
  });
  assert(attempted.length === 2, 'one provider failure prevented another agent retry');
  assert(summary.discovered === 2, `expected two candidates, got ${summary.discovered}`);
  assert(summary.failed === 1, `expected one failed agent retry, got ${summary.failed}`);
  assert(summary.released === 2, `expected two released sessions, got ${summary.released}`);
});

test('terminal browser reconciliation forwards its batch bound and honors its deadline', async () => {
  let requestedBatchSize = 0;
  let attempted = 0;
  const summary = await reconcileTerminalAgentBrowserSessions(
    {
      findTerminalAgentIds: async (batchSize) => {
        requestedBatchSize = batchSize;
        return ['deferred-terminal-agent'];
      },
      releaseBrowserSessions: async () => {
        attempted += 1;
        return 1;
      },
    },
    { batchSize: 17, deadlineAtMs: Date.now() - 1 }
  );
  assert(requestedBatchSize === 17, `expected query batch size 17, got ${requestedBatchSize}`);
  assert(attempted === 0, 'a passed deadline must stop new provider release work');
  assert(summary.discovered === 1, 'deadline must preserve the discovered-candidate summary');
});

test('terminal browser reconciliation lease excludes replicas and releases ownership', async () => {
  await prisma.toolSideEffect.deleteMany({
    where: { operationKey: TERMINAL_BROWSER_RELEASE_LEASE_KEY },
  });
  let unblockFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstCanFinish = new Promise<void>((resolve) => {
    unblockFirst = resolve;
  });
  let firstRun: ReturnType<typeof runTerminalAgentBrowserReleaseReconcileWithLease> | undefined;
  try {
    firstRun = runTerminalAgentBrowserReleaseReconcileWithLease(
      {},
      {
        reconcile: async () => {
          markFirstStarted?.();
          await firstCanFinish;
          return { discovered: 0, released: 0, failed: 0 };
        },
      }
    );
    await firstStarted;
    const competingRun = await runTerminalAgentBrowserReleaseReconcileWithLease(
      {},
      {
        reconcile: async () => {
          throw new Error('competing replica must not reconcile');
        },
      }
    );
    assert(!competingRun.acquired, 'a live lease must exclude a competing replica');
    unblockFirst?.();
    const completedRun = await firstRun;
    assert(completedRun.acquired, 'the first replica should acquire the reconciliation lease');
    const releasedLease = await prisma.toolSideEffect.findUnique({
      where: { operationKey: TERMINAL_BROWSER_RELEASE_LEASE_KEY },
      select: { status: true },
    });
    assert(releasedLease?.status === 'RELEASED', 'completed reconciliation must release its lease');
  } finally {
    unblockFirst?.();
    await firstRun?.catch(() => undefined);
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: TERMINAL_BROWSER_RELEASE_LEASE_KEY },
    });
  }
});

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

    // Ordinary terminal shutdown pauses (releases provider compute, keeps the
    // profile); only explicit agent deletion retires the session.
    const released = await prisma.browserSession.findUnique({ where: { id: browserSessionId } });
    assert(
      released !== null && released.status === 'PAUSED',
      `Terminal ${status} left the browser session running (status=${String(released?.status)})`
    );
    assert(
      released.closedAt === null,
      `Terminal ${status} retired a browser session that ordinary shutdown must only pause`
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
    released?.status === 'PAUSED' && released.closedAt === null,
    `Terminal child left its browser rental running (status=${String(released?.status)})`
  );
});
