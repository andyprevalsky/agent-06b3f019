import { randomUUID } from 'crypto';
import { prisma } from '../../providers/database';

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

function asRecord(value: unknown): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null, 'Expected object response');
  return value as Record<string, unknown>;
}

async function request(
  path: string,
  userId: string,
  method = 'POST'
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'X-User-Id': userId,
    },
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
  return String(asRecord(asRecord(data).request).id);
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

export const authAssistanceProviderCompletionTests: TestCase[] = [
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
