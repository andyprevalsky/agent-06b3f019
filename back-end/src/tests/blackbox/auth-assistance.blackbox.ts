#!/usr/bin/env tsx
/**
 * Black-box tests for /api/auth-assistance.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/auth-assistance.blackbox.ts
 */

import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { prisma } from '../../providers/database';
import { authAssistanceDeploymentFenceTests } from './auth-assistance.deployment-fence-cases';
import { authAssistanceProviderCompletionTests } from './auth-assistance.provider-cases';
import { authAssistanceNativeTests } from './auth-assistance.native-cases';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

const trackedUserIds = new Set<string>();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

function apiHeaders(userId: string): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-User-Id': userId,
  };
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

async function createUser(label: string): Promise<string> {
  const userId = `auth-assist-${label}-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  trackedUserIds.add(userId);
  await prisma.user.create({ data: { userId } });
  return userId;
}

async function createAgent(userId: string, status: 'ACTIVE' | 'PAUSED' = 'PAUSED') {
  return prisma.agent.create({
    data: {
      userId,
      goal: 'Complete a login-gated browser task',
      status,
      temporalWorkflowId: null,
    },
  });
}

async function createBrowserSession(params: {
  userId: string;
  agentId: string;
  debugUrl: string;
  sessionId?: string;
}) {
  const context = await prisma.browserContext.create({
    data: {
      userId: params.userId,
      contextId: `steel-profile-${randomUUID()}`,
    },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: params.agentId,
      sessionId: params.sessionId ?? `steel-session-${randomUUID()}`,
      debugUrl: params.debugUrl,
      status: 'ACTIVE',
      provider: 'steel',
      providerProfileId: `session-bound-profile-${randomUUID()}`,
      providerProfileSource: 'test_session_bound',
      providerProfilePersist: true,
    },
    include: { context: true },
  });
  return session;
}

async function testRefreshLiveViewReturnsInteractiveSessionAndMetadata(): Promise<void> {
  const userId = await createUser('refresh-live');
  const agent = await createAgent(userId);
  const browserSession = await createBrowserSession({
    userId,
    agentId: agent.id,
    sessionId: `local-${randomUUID()}`,
    debugUrl: 'http://localhost:9222/session/local-refresh?interactive=false',
  });

  const createRes = await request(`${BASE_URL}/api/auth-assistance`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify({
      agentId: agent.id,
      authRealm: 'amazon.com',
      mode: 'live_view',
      browserSessionId: browserSession.id,
      steelSessionId: browserSession.sessionId,
    }),
  });
  assertStatus(createRes.status, 201, createRes.data);
  const requestId = String(asRecord(asRecord(createRes.data).request).id);

  const refreshRes = await request(`${BASE_URL}/api/auth-assistance/${requestId}/refresh-session`, {
    method: 'POST',
    headers: apiHeaders(userId),
  });
  assertStatus(refreshRes.status, 200, refreshRes.data);
  const body = asRecord(refreshRes.data);
  assert(body.refreshed === false, 'Local session refresh should not create a new session');
  const handoff = asRecord(body.handoff);
  assert(handoff.steelSessionId === browserSession.sessionId, 'Handoff should keep session id');
  const liveViewUrl = new URL(String(body.liveViewUrl));
  assert(liveViewUrl.searchParams.get('interactive') === 'true', 'Refresh should return live URL');
  assert(
    liveViewUrl.searchParams.get('showControls') === 'true',
    'Refresh should include browser controls'
  );

  const persisted = await prisma.userAuthAssistanceRequest.findUnique({
    where: { id: requestId },
  });
  assert(
    persisted?.steelSessionId === browserSession.sessionId,
    'Refresh should preserve the request session id'
  );
  const attentionRequest = await prisma.agentAttentionRequest.findUnique({
    where: { id: requestId },
  });
  const metadata = asRecord(attentionRequest?.metadata);
  const authMetadata = asRecord(metadata.authAssistance);
  assert(
    authMetadata.liveViewUrl === String(body.liveViewUrl),
    'Refresh should keep attention metadata aligned with returned URL'
  );
}

async function testRefreshLiveViewUsesStableBrowserSessionIdAfterSteelSessionChanges(): Promise<void> {
  const userId = await createUser('refresh-stable-task');
  const agent = await createAgent(userId);
  const browserSession = await createBrowserSession({
    userId,
    agentId: agent.id,
    sessionId: `local-old-${randomUUID()}`,
    debugUrl: 'http://localhost:9222/session/old?interactive=false',
  });

  const createRes = await request(`${BASE_URL}/api/auth-assistance`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify({
      agentId: agent.id,
      authRealm: 'amazon.com',
      mode: 'live_view',
      browserSessionId: browserSession.id,
      steelSessionId: browserSession.sessionId,
    }),
  });
  assertStatus(createRes.status, 201, createRes.data);
  const requestId = String(asRecord(asRecord(createRes.data).request).id);

  await prisma.browserSession.update({
    where: { id: browserSession.id },
    data: {
      sessionId: `local-new-${randomUUID()}`,
      debugUrl: 'http://localhost:9222/session/new?interactive=false',
    },
  });
  const updatedSession = await prisma.browserSession.findUniqueOrThrow({
    where: { id: browserSession.id },
  });

  const refreshRes = await request(`${BASE_URL}/api/auth-assistance/${requestId}/refresh-session`, {
    method: 'POST',
    headers: apiHeaders(userId),
  });
  assertStatus(refreshRes.status, 200, refreshRes.data);
  const body = asRecord(refreshRes.data);
  const handoff = asRecord(body.handoff);
  assert(
    handoff.steelSessionId === updatedSession.sessionId,
    'Refresh should resolve the current Steel session through the stable browser session id'
  );
  assert(
    String(body.liveViewUrl).includes('/session/new?'),
    'Refresh should return the current debug URL for the stable browser session'
  );

  const persisted = await prisma.userAuthAssistanceRequest.findUnique({
    where: { id: requestId },
  });
  assert(
    persisted?.browserSessionId === browserSession.id,
    'Request should retain stable browser session id'
  );
}

function asRecord(data: unknown): Record<string, unknown> {
  assert(typeof data === 'object' && data !== null, 'Expected object response');
  return data as Record<string, unknown>;
}

async function cleanup(): Promise<void> {
  for (const userId of trackedUserIds) {
    await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}

async function testCreateLiveViewReturnsPersistedRequestAndHandoff(): Promise<void> {
  const userId = await createUser('create-live');
  const agent = await createAgent(userId);
  const browserSession = await createBrowserSession({
    userId,
    agentId: agent.id,
    debugUrl: 'https://debug.steel.dev/session/abc?interactive=false',
  });

  const res = await request(`${BASE_URL}/api/auth-assistance`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify({
      agentId: agent.id,
      authRealm: 'https://www.amazon.com/login',
      mode: 'live_view',
      steelSessionId: browserSession.sessionId,
      currentUrl:
        'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fcheckout',
    }),
  });

  assertStatus(res.status, 201, res.data);
  const body = asRecord(res.data);
  const persisted = asRecord(body.request);
  const handoff = asRecord(body.handoff);

  assert(persisted.agentId === agent.id, 'Request should be scoped to the agent');
  assert(persisted.userId === userId, 'Request should be scoped to the user');
  assert(persisted.authRealm === 'amazon.com', 'Request should persist canonical auth realm');
  assert(
    persisted.steelSessionId === browserSession.sessionId,
    'Request should persist Steel session ID'
  );
  assert(persisted.completedAt === null, 'New request should not be completed');
  assert(handoff.type === 'live_view', 'Handoff should identify live_view mode');
  const liveViewUrl = new URL(String(handoff.liveViewUrl));
  assert(liveViewUrl.origin === 'https://debug.steel.dev', 'Live-view URL should preserve origin');
  assert(liveViewUrl.pathname === '/session/abc', 'Live-view URL should preserve path');
  assert(
    liveViewUrl.searchParams.get('interactive') === 'true',
    'Live-view URL should be interactive'
  );

  const attentionRequest = await prisma.agentAttentionRequest.findUnique({
    where: { id: String(persisted.id) },
  });
  assert(attentionRequest !== null, 'Auth assistance should create an attention request parent');
  assert(
    attentionRequest?.id === persisted.id,
    'Auth assistance row should share the attention request id'
  );
  assert(attentionRequest?.userId === userId, 'Attention request should be scoped to the user');
  assert(attentionRequest?.agentId === agent.id, 'Attention request should be scoped to the agent');
  assert(attentionRequest?.userResponse === null, 'New attention request should be unanswered');
  const metadata = asRecord(attentionRequest?.metadata);
  assert(metadata.attentionKind === 'auth_assistance', 'Attention metadata should mark auth kind');
  const authMetadata = asRecord(metadata.authAssistance);
  assert(
    authMetadata.liveViewUrl === handoff.liveViewUrl,
    'Attention metadata should carry the same live-view URL'
  );
  assert(
    authMetadata.currentUrl ===
      'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fcheckout',
    'Attention metadata should carry the current browser URL'
  );
  const updatedBrowserSession = await prisma.browserSession.findUnique({
    where: { id: browserSession.id },
  });
  assert(
    updatedBrowserSession?.currentUrl ===
      'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fcheckout',
    'Auth assistance creation should persist current URL for later Steel session refresh'
  );

  const listRes = await request(`${BASE_URL}/api/attention-requests`, {
    headers: apiHeaders(userId),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const requests = asRecord(listRes.data).requests;
  assert(Array.isArray(requests), 'Attention list should return requests');
  assert(
    requests.some((request) => asRecord(request).id === persisted.id),
    'Auth assistance should appear in the attention inbox list'
  );
}

async function testCompleteLiveViewUpsertsSteelAuthAndIsIdempotent(): Promise<void> {
  const userId = await createUser('complete-live');
  const agent = await createAgent(userId, 'PAUSED');
  const browserSession = await createBrowserSession({
    userId,
    agentId: agent.id,
    debugUrl: 'https://debug.steel.dev/session/def?interactive=false',
  });
  await prisma.browserSession.update({
    where: { id: browserSession.id },
    data: { providerProfileSource: 'steel_session_auth_invalidated' },
  });

  const createRes = await request(`${BASE_URL}/api/auth-assistance`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify({
      agent_id: agent.id,
      auth_realm: 'example.com',
      mode: 'live_view',
      steel_session_id: browserSession.sessionId,
    }),
  });
  assertStatus(createRes.status, 201, createRes.data);
  const requestId = String(asRecord(asRecord(createRes.data).request).id);

  await prisma.browserContext.update({
    where: { id: browserSession.contextId },
    data: { contextId: null },
  });
  await prisma.browserProviderProfile.create({
    data: {
      contextId: browserSession.contextId,
      provider: 'steel',
      profileId: `stale-profile-${randomUUID()}`,
    },
  });

  const completeRes = await request(`${BASE_URL}/api/auth-assistance/${requestId}/complete`, {
    method: 'POST',
    headers: apiHeaders(userId),
  });
  assertStatus(completeRes.status, 200, completeRes.data);
  assert(asRecord(completeRes.data).alreadyCompleted === false, 'First complete should do work');

  const steelAuth = await prisma.steelSessionAuth.findUnique({
    where: {
      userId_contextId_authRealm: {
        userId,
        contextId: browserSession.providerProfileId!,
        authRealm: 'example.com',
      },
    },
  });
  assert(steelAuth !== null, 'Completion should upsert SteelSessionAuth');
  assert(steelAuth?.disabledAt === null, 'Completion should clear disabledAt');
  assert(steelAuth?.disabledReason === null, 'Completion should clear disabledReason');
  const reboundContext = await prisma.browserContext.findUnique({
    where: { id: browserSession.contextId },
  });
  assert(
    reboundContext?.contextId === browserSession.providerProfileId,
    'Completion should rebind the authenticated Steel profile to future browser sessions'
  );
  const reboundProviderProfile = await prisma.browserProviderProfile.findUnique({
    where: {
      contextId_provider: {
        contextId: browserSession.contextId,
        provider: 'steel',
      },
    },
  });
  assert(
    reboundProviderProfile?.profileId === browserSession.providerProfileId,
    'Completion should restore the provider-specific Steel profile index'
  );
  const reboundSession = await prisma.browserSession.findUnique({
    where: { id: browserSession.id },
  });
  assert(
    reboundSession?.providerProfileId === browserSession.providerProfileId &&
      reboundSession.providerProfileSource === 'steel_session_auth',
    'Completion should reactivate an invalidated sibling profile lineage'
  );
  const credentialMessage = await prisma.message.findFirst({
    where: {
      agentId: agent.id,
      metadata: {
        path: ['credential_ref', 'kind'],
        equals: 'steel_session',
      },
    },
  });
  assert(credentialMessage !== null, 'Completion should log Steel credential ref message');

  const completedRequest = await prisma.userAuthAssistanceRequest.findUnique({
    where: { id: requestId },
  });
  assert(completedRequest?.completedAt !== null, 'Completion should persist completedAt');
  const answeredAttention = await prisma.agentAttentionRequest.findUnique({
    where: { id: requestId },
  });
  assert(
    answeredAttention?.userResponse === '__AUTH_ASSISTANCE_COMPLETED__',
    'Completion should mark the parent attention request answered'
  );

  const resumedAgent = await prisma.agent.findUnique({ where: { id: agent.id } });
  assert(resumedAgent?.status === 'ACTIVE', 'Completion should resume the paused agent');

  await prisma.steelSessionAuth.update({
    where: {
      userId_contextId_authRealm: {
        userId,
        contextId: browserSession.providerProfileId!,
        authRealm: 'example.com',
      },
    },
    data: { disabledAt: new Date(), disabledReason: 'test sentinel' },
  });

  const secondComplete = await request(`${BASE_URL}/api/auth-assistance/${requestId}/complete`, {
    method: 'POST',
    headers: apiHeaders(userId),
  });
  assertStatus(secondComplete.status, 200, secondComplete.data);
  assert(
    asRecord(secondComplete.data).alreadyCompleted === true,
    'Second complete should be a no-op'
  );

  const afterSecond = await prisma.steelSessionAuth.findUnique({
    where: {
      userId_contextId_authRealm: {
        userId,
        contextId: browserSession.providerProfileId!,
        authRealm: 'example.com',
      },
    },
  });
  assert(
    afterSecond?.disabledReason === 'test sentinel',
    'Second complete should not re-upsert auth'
  );
}

async function testAttentionRespondCompletesAuthAssistance(): Promise<void> {
  const userId = await createUser('respond-live');
  const agent = await createAgent(userId, 'PAUSED');
  const browserSession = await createBrowserSession({
    userId,
    agentId: agent.id,
    debugUrl: 'https://debug.steel.dev/session/respond?interactive=false',
  });

  const createRes = await request(`${BASE_URL}/api/auth-assistance`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify({
      agentId: agent.id,
      authRealm: 'https://www.amazon.com/ap/signin',
      mode: 'live_view',
      steelSessionId: browserSession.sessionId,
    }),
  });
  assertStatus(createRes.status, 201, createRes.data);
  const requestId = String(asRecord(asRecord(createRes.data).request).id);

  const respondRes = await request(`${BASE_URL}/api/attention-requests/${requestId}/respond`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify({ response: 'Authentication complete' }),
  });
  assertStatus(respondRes.status, 200, respondRes.data);
  assert(asRecord(respondRes.data).success === true, 'Attention respond should succeed');

  const completedRequest = await prisma.userAuthAssistanceRequest.findUnique({
    where: { id: requestId },
  });
  assert(completedRequest?.completedAt !== null, 'Respond should persist completedAt');

  const answeredAttention = await prisma.agentAttentionRequest.findUnique({
    where: { id: requestId },
  });
  assert(
    answeredAttention?.userResponse === '__AUTH_ASSISTANCE_COMPLETED__',
    'Respond should mark the parent attention request answered with the auth sentinel'
  );

  const steelAuth = await prisma.steelSessionAuth.findUnique({
    where: {
      userId_contextId_authRealm: {
        userId,
        contextId: browserSession.providerProfileId!,
        authRealm: 'amazon.com',
      },
    },
  });
  assert(steelAuth !== null, 'Respond should upsert SteelSessionAuth for the live context');
  assert(steelAuth?.disabledAt === null, 'Respond should clear disabledAt');

  const resumedAgent = await prisma.agent.findUnique({ where: { id: agent.id } });
  assert(resumedAgent?.status === 'ACTIVE', 'Respond should resume the paused agent');

  await prisma.agent.update({ where: { id: agent.id }, data: { status: 'PAUSED' } });
  const secondRespond = await request(`${BASE_URL}/api/attention-requests/${requestId}/respond`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify({ response: 'Authentication complete' }),
  });
  assertStatus(secondRespond.status, 200, secondRespond.data);
  const resumedAgain = await prisma.agent.findUnique({ where: { id: agent.id } });
  assert(resumedAgain?.status === 'ACTIVE', 'Repeated respond should re-run idempotent resume');
}

async function testManualModeCompletesWithoutSteelAuth(): Promise<void> {
  const userId = await createUser('manual');
  const agent = await createAgent(userId, 'PAUSED');

  const createRes = await request(`${BASE_URL}/api/auth-assistance`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify({
      agentId: agent.id,
      authRealm: 'manual.example',
      mode: 'manual_step',
    }),
  });
  assertStatus(createRes.status, 201, createRes.data);
  const created = asRecord(asRecord(createRes.data).request);
  assert(created.steelSessionId === '', 'Manual mode should not require a Steel session');

  const completeRes = await request(
    `${BASE_URL}/api/auth-assistance/${String(created.id)}/complete`,
    {
      method: 'POST',
      headers: apiHeaders(userId),
    }
  );
  assertStatus(completeRes.status, 200, completeRes.data);

  const steelAuthCount = await prisma.steelSessionAuth.count({ where: { userId } });
  assert(steelAuthCount === 0, 'Manual completion should not create SteelSessionAuth');
}

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    [
      'POST /api/auth-assistance live_view returns request + handoff',
      testCreateLiveViewReturnsPersistedRequestAndHandoff,
    ],
    [
      'POST /api/auth-assistance/:id/refresh-session returns live handoff',
      testRefreshLiveViewReturnsInteractiveSessionAndMetadata,
    ],
    [
      'POST /api/auth-assistance/:id/refresh-session follows stable browser session id',
      testRefreshLiveViewUsesStableBrowserSessionIdAfterSteelSessionChanges,
    ],
    [
      'POST /api/auth-assistance/:id/complete upserts Steel auth idempotently',
      testCompleteLiveViewUpsertsSteelAuthAndIsIdempotent,
    ],
    ...authAssistanceProviderCompletionTests,
    ...authAssistanceNativeTests,
    [
      'POST /api/attention-requests/:id/respond completes auth assistance',
      testAttentionRespondCompletesAuthAssistance,
    ],
    ['manual_step completion does not require Steel auth', testManualModeCompletesWithoutSteelAuth],
    ...authAssistanceDeploymentFenceTests,
  ];

  const results = [];
  for (const [name, fn] of tests) {
    results.push(await runTest(name, fn));
  }

  let failed = 0;
  for (const result of results) {
    const icon = result.passed ? '✓' : '✗';
    console.log(`${icon} ${result.name} (${result.duration}ms)`);
    if (!result.passed) {
      failed++;
      console.error(`  ${result.error}`);
    }
  }
  console.log(`\nPassed ${results.length - failed}/${results.length} auth-assistance test(s).`);

  await cleanup();
  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup();
  process.exit(1);
});
