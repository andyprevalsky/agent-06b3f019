import { randomUUID } from 'crypto';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { completeAuthAssistanceForUser } from '../../providers/authAssistanceCompletion';
import { retryWithBackoff } from '../../providers/retry';
import {
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  lockAgentWorkflowGeneration,
} from '../../providers/workflowGeneration';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

type Provider = 'kernel' | 'steel' | 'browser-use';
type TestCase = [string, () => Promise<void>];

interface Fixture {
  userId: string;
  agentId: string;
  browserSessionId: string;
  sessionId: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function assertAuthoredCompletionMessages(
  agentId: string,
  expected?: string
): Promise<void> {
  const rows = await prisma.message.findMany({ where: { agentId, role: 'USER' } });
  assert(
    rows.length === (expected ? 1 : 0),
    'Only explicit authored input may create one auth completion USER row'
  );
  if (expected) assert(rows[0].text === expected, 'Auth completion must preserve authored bytes');
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null, 'Expected object response');
  return value as Record<string, unknown>;
}

async function request(
  path: string,
  userId: string,
  method = 'POST',
  body?: object
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'X-User-Id': userId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

function assertStatus(result: { status: number; data: unknown }, expected: number): void {
  if (result.status !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${result.status}: ${JSON.stringify(result.data)}`
    );
  }
}

async function createFixture(label: string, provider: Provider): Promise<Fixture> {
  const userId = `auth-assist-provider-${label}-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId } });
  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: 'Complete a provider-aware login handoff',
      status: 'PAUSED',
      temporalWorkflowId: null,
    },
  });
  const context = await prisma.browserContext.create({
    data: { userId, contextId: `fixture-context-${randomUUID()}` },
  });
  const sessionId = `${provider}-session-${randomUUID()}`;
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: agent.id,
      sessionId,
      status: 'ACTIVE',
      provider,
      providerProfileId: `${provider}-profile-${randomUUID()}`,
      providerProfileSource: 'user_persistent',
      providerProfilePersist: true,
      debugUrl:
        provider === 'kernel'
          ? 'https://proxy.example.onkernel.com/browser/live/auth'
          : provider === 'browser-use'
            ? 'https://live.browser-use.com/session/auth'
            : 'https://debug.steel.dev/session/auth',
    },
  });
  return { userId, agentId: agent.id, browserSessionId: session.id, sessionId };
}

async function cleanupFixture(userId: string): Promise<void> {
  await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
  await prisma.browserContext.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function withFixture(
  label: string,
  provider: Provider,
  test: (fixture: Fixture) => Promise<void>
): Promise<void> {
  const fixture = await createFixture(label, provider);
  try {
    await test(fixture);
  } finally {
    await cleanupFixture(fixture.userId);
  }
}

async function createLiveViewRequest(fixture: Fixture, authRealm: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/auth-assistance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'X-User-Id': fixture.userId,
    },
    body: JSON.stringify({
      agentId: fixture.agentId,
      authRealm,
      mode: 'live_view',
      browserSessionId: fixture.browserSessionId,
    }),
  });
  const data = await response.json();
  assertStatus({ status: response.status, data }, 201);
  const requestId = String(asRecord(asRecord(data).request).id);
  const attention = await prisma.agentAttentionRequest.findUniqueOrThrow({
    where: { id: requestId },
  });
  assert(
    attention.workflowId === fixture.agentId,
    'Null-current auth handoff must use its legitimate legacy root workflow identity'
  );
  return requestId;
}

async function assertNoSteelCredential(fixture: Fixture): Promise<void> {
  assert(
    (await prisma.steelSessionAuth.count({ where: { userId: fixture.userId } })) === 0,
    'Non-Steel completion should not create SteelSessionAuth'
  );
  const message = await prisma.message.findFirst({
    where: {
      agentId: fixture.agentId,
      metadata: { path: ['credential_ref', 'kind'], equals: 'steel_session' },
    },
  });
  assert(message === null, 'Non-Steel completion should not emit a Steel credential ref');
}

async function completeAndAssertResumed(fixture: Fixture, requestId: string): Promise<void> {
  assertStatus(await request(`/api/auth-assistance/${requestId}/complete`, fixture.userId), 200);
  const completed = await prisma.userAuthAssistanceRequest.findUniqueOrThrow({
    where: { id: requestId },
  });
  assert(completed.completedAt !== null, 'Completion should persist completedAt');
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
  assert(agent.status === 'ACTIVE', 'Completion should resume the paused agent');
}

async function testKernelCompletion(): Promise<void> {
  await withFixture('kernel', 'kernel', async (fixture) => {
    const requestId = await createLiveViewRequest(fixture, 'microsoftonline.com');
    await completeAndAssertResumed(fixture, requestId);
    await assertNoSteelCredential(fixture);
  });
}

async function testBrowserUseCompletion(): Promise<void> {
  await withFixture('browser-use', 'browser-use', async (fixture) => {
    const requestId = await createLiveViewRequest(fixture, 'microsoftonline.com');
    const requestRow = await prisma.userAuthAssistanceRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    assert(
      requestRow.browserSessionId === fixture.browserSessionId,
      'Browser Use handoff must bind to the stable browser task ID'
    );
    const attention = await prisma.agentAttentionRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const metadata = asRecord(attention.metadata);
    const auth = asRecord(metadata.authAssistance);
    const liveUrl = new URL(String(auth.liveViewUrl));
    assert(liveUrl.hostname === 'live.browser-use.com', 'Handoff must use the Browser Use viewer');
    assert(liveUrl.searchParams.get('readOnly') === null, 'Handoff viewer must be interactive');

    await completeAndAssertResumed(fixture, requestId);
    await assertNoSteelCredential(fixture);
    const session = await prisma.browserSession.findUniqueOrThrow({
      where: { id: fixture.browserSessionId },
    });
    assert(
      session.provider === 'browser-use' && session.providerProfilePersist,
      'Completion must retain the persistent Browser Use profile'
    );
  });
}

async function testSteelToKernelSwitch(): Promise<void> {
  await withFixture('steel-to-kernel', 'steel', async (fixture) => {
    const requestId = await createLiveViewRequest(fixture, 'microsoftonline.com');
    await prisma.browserSession.update({
      where: { id: fixture.browserSessionId },
      data: {
        sessionId: `kernel-session-${randomUUID()}`,
        provider: 'kernel',
        providerProfileId: `kernel-profile-${randomUUID()}`,
        providerProfileSource: 'user_persistent',
        debugUrl: 'https://proxy.example.onkernel.com/browser/live/after-steel-switch',
      },
    });
    const staleRequest = await prisma.userAuthAssistanceRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    assert(
      staleRequest.steelSessionId === fixture.sessionId,
      'The request should retain its pre-switch provider session ID for this repro'
    );
    await completeAndAssertResumed(fixture, requestId);
    await assertNoSteelCredential(fixture);
  });
}

async function testKernelToSteelSwitch(): Promise<void> {
  await withFixture('kernel-to-steel', 'kernel', async (fixture) => {
    const requestId = await createLiveViewRequest(fixture, 'example.com');
    const steelProfileId = `steel-profile-${randomUUID()}`;
    await prisma.browserSession.update({
      where: { id: fixture.browserSessionId },
      data: {
        sessionId: `steel-session-${randomUUID()}`,
        provider: 'steel',
        providerProfileId: steelProfileId,
        providerProfileSource: 'user_persistent',
        debugUrl: 'https://debug.steel.dev/session/after-kernel-switch',
      },
    });
    await completeAndAssertResumed(fixture, requestId);
    const steelAuthRows = await prisma.steelSessionAuth.findMany({
      where: { userId: fixture.userId },
    });
    assert(steelAuthRows.length === 1, 'Kernel-to-Steel completion should create one Steel auth');
    assert(
      steelAuthRows[0]?.contextId === steelProfileId,
      'Kernel-to-Steel completion should bind auth to the current Steel profile'
    );
    const message = await prisma.message.findFirst({
      where: {
        agentId: fixture.agentId,
        metadata: { path: ['credential_ref', 'kind'], equals: 'steel_session' },
      },
    });
    assert(message !== null, 'Kernel-to-Steel completion should emit a Steel credential ref');
    const credentialRef = asRecord(asRecord(message.metadata).credential_ref);
    assert(
      credentialRef.id === steelAuthRows[0]?.id,
      'Kernel-to-Steel credential ref should identify the current Steel auth row'
    );
  });
}

async function testSteelWithoutProfileFailsClosed(): Promise<void> {
  await withFixture('steel-missing-profile', 'steel', async (fixture) => {
    await prisma.browserSession.update({
      where: { id: fixture.browserSessionId },
      data: { providerProfileId: null },
    });
    const requestId = await createLiveViewRequest(fixture, 'example.com');
    const result = await request(`/api/auth-assistance/${requestId}/complete`, fixture.userId);
    assertStatus(result, 400);
    assert(
      asRecord(result.data).error === 'Browser context is not available for this live_view request',
      'A Steel session without a bound profile should fail closed'
    );
    const incomplete = await prisma.userAuthAssistanceRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    assert(incomplete.completedAt === null, 'Failed Steel completion must stay incomplete');
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
    assert(agent.status === 'PAUSED', 'Failed Steel completion must not resume the agent');
  });
}

/** Answers the request the way the app does when the user says no. */
async function decline(requestId: string, userId: string, route: 'respond' | 'reject') {
  const response = await fetch(`${BASE_URL}/api/attention-requests/${requestId}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY, 'X-User-Id': userId },
    body: JSON.stringify(route === 'respond' ? { response: '__REJECTED__' } : {}),
  });
  return { status: response.status, data: (await response.json()) as unknown };
}

/**
 * A "no" must reach the agent as a no. Answering through /respond used to
 * complete the request whatever the answer was, so a declined sign-in was
 * recorded as the user having signed in.
 */
async function testDeclineDoesNotCompleteAuthAssistance(): Promise<void> {
  for (const route of ['respond', 'reject'] as const) {
    await withFixture(`decline-${route}`, 'kernel', async (fixture) => {
      const requestId = await createLiveViewRequest(fixture, 'example.com');
      assertStatus(await decline(requestId, fixture.userId, route), 200);
      const assistance = await prisma.userAuthAssistanceRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      assert(assistance.completedAt === null, `${route}: a declined request must not be completed`);
      const attention = await prisma.agentAttentionRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      assert(
        attention.userResponse === '__REJECTED__',
        `${route}: the agent must be told the user declined, got ${attention.userResponse}`
      );
      const steelAuth = await prisma.steelSessionAuth.count({ where: { userId: fixture.userId } });
      assert(steelAuth === 0, `${route}: a decline must not record an authenticated session`);
    });
  }
}

async function testAuthoredCompletion(controlFirst: boolean): Promise<void> {
  await withFixture('authored', 'kernel', async (fixture) => {
    const requestId = await createLiveViewRequest(fixture, 'example.com');
    if (controlFirst) {
      await completeAndAssertResumed(fixture, requestId);
      await assertAuthoredCompletionMessages(fixture.agentId);
    }
    const text = '  Return only venue_prices\nDo not use the old account.  ';
    const path = `/api/attention-requests/${requestId}/respond`;
    for (let attempt = 0; attempt < 2; attempt++) {
      assertStatus(
        await request(path, fixture.userId, 'POST', {
          response: 'Authentication complete',
          user_message: text,
        }),
        200
      );
      await assertAuthoredCompletionMessages(fixture.agentId, text);
      const row = await prisma.agentAttentionRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      assert(
        row.userResponse === '__AUTH_ASSISTANCE_COMPLETED__',
        'Authored input must preserve the auth protocol decision'
      );
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } });
      assert(agent.status === 'ACTIVE', 'Authored completion must resume the agent');
    }
    assertStatus(
      await request(path, fixture.userId, 'POST', {
        response: 'Authentication complete',
        user_message: 'A distinct later authored reply',
      }),
      409
    );
    await assertAuthoredCompletionMessages(fixture.agentId, text);
  });
}

async function testAuthoredCompletionScopeBeforeSignal(): Promise<void> {
  await withFixture('authored-task-scope', 'kernel', async (fixture) => {
    const requestId = await createLiveViewRequest(fixture, 'example.com');
    const text = '  Use this account\nKeep only venue_prices.  ';
    let signals = 0;
    const result = await completeAuthAssistanceForUser(
      requestId,
      fixture.userId,
      new Date(),
      {
        signalCompleted: async () => {
          signals++;
          // An independent read at the signal boundary proves the authored source committed first.
          const rows = await prisma.message.findMany({
            where: {
              agentId: fixture.agentId,
              role: 'USER',
              metadata: { path: ['attentionRequestId'], equals: requestId },
            },
          });
          assert(rows.length === 1 && rows[0].text === text, 'Authored bytes commit before signal');
          const metadata = asRecord(rows[0].metadata);
          assert(
            metadata.browserTaskId === fixture.browserSessionId,
            'Locked auth request scopes the reply to BrowserSession.id, not the provider session'
          );
          assert(
            metadata.browserTaskId !== fixture.sessionId,
            'Provider session ID is not task identity'
          );
        },
        resumeAgent: async () => ({ success: true }),
      },
      text
    );
    assert(result.status === 'completed' && signals === 1, 'Real auth completion must signal once');
  });
}

async function testCompletedAuthRetryReadsFenceAfterGenerationLock(): Promise<void> {
  await withFixture('completed-retry-fence', 'kernel', async (fixture) => {
    const requestId = await createLiveViewRequest(fixture, 'example.com');
    // Legacy completed credentials can still have an unanswered attention row.
    await prisma.userAuthAssistanceRequest.update({
      where: { id: requestId },
      data: { completedAt: new Date() },
    });
    let release!: () => void;
    let announce!: (pid: number) => void;
    let rejectLock!: (error: unknown) => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<number>((resolve, reject) => {
      announce = resolve;
      rejectLock = reject;
    });
    const cleanup = runTransactionWithRetry(async (tx) => {
      await lockAgentWorkflowGeneration(tx, fixture.agentId);
      const [session] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      announce(session.pid);
      await released;
      await tx.agentAttentionRequest.update({
        where: { id: requestId },
        data: { userResponse: DEPLOY_INTERRUPTED_TOOL_MESSAGE },
      });
    });
    void cleanup.catch(rejectLock);
    const pid = await locked;
    let signals = 0;
    let resumes = 0;
    const text = '  Use the current signed-in account.  ';
    const retry = completeAuthAssistanceForUser(
      requestId,
      fixture.userId,
      new Date(),
      {
        signalCompleted: async () => {
          signals++;
        },
        resumeAgent: async () => {
          resumes++;
        },
      },
      text
    );
    try {
      const { blocked } = await retryWithBackoff(
        async () => {
          const [result] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`;
          return result;
        },
        {
          maxRetries: 100,
          fixedDelays: Array(100).fill(25),
          shouldRetryResult: (result) => !result.blocked,
        }
      );
      assert(blocked, 'Completed auth retry never reached the generation lock');
    } finally {
      release();
      await cleanup;
    }
    const result = await retry;
    assert(
      result.status === 'already_completed' && result.interrupted,
      'Completed retry used a control snapshot read before the generation lock'
    );
    assert(
      signals === 0 && resumes === 1,
      'Completed retry must resume the survivor without signaling the fenced generation'
    );
    await assertAuthoredCompletionMessages(fixture.agentId, text);
  });
}

export const authAssistanceProviderCompletionTests: TestCase[] = [
  [
    'completed auth retry refreshes its fence after the generation lock',
    testCompletedAuthRetryReadsFenceAfterGenerationLock,
  ],
  [
    'auth completion commits native task scope before signaling',
    testAuthoredCompletionScopeBeforeSignal,
  ],
  ['auth completion preserves explicit authored input once', () => testAuthoredCompletion(false)],
  [
    'authored input survives an automatic auth completion winning first',
    () => testAuthoredCompletion(true),
  ],
  ['a declined live_view request is not completed', testDeclineDoesNotCompleteAuthAssistance],
  ['POST /api/auth-assistance/:id/complete resumes Kernel live_view', testKernelCompletion],
  [
    'POST /api/auth-assistance/:id/complete resumes Browser Use live_view',
    testBrowserUseCompletion,
  ],
  [
    'POST /api/auth-assistance/:id/complete follows Steel-to-Kernel provider switch',
    testSteelToKernelSwitch,
  ],
  [
    'POST /api/auth-assistance/:id/complete follows Kernel-to-Steel provider switch',
    testKernelToSteelSwitch,
  ],
  [
    'POST /api/auth-assistance/:id/complete fails closed for Steel without a profile',
    testSteelWithoutProfileFailsClosed,
  ],
];
