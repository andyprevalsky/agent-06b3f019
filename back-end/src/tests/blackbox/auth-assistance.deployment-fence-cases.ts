import { randomUUID } from 'crypto';
import {
  AUTH_ASSISTANCE_COMPLETED_RESPONSE,
  completeAuthAssistanceForUser,
} from '../../providers/authAssistanceCompletion';
import { prisma } from '../../providers/database';
import {
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  finalizeInterruptedWorkflowTools,
} from '../../providers/staleWorkflowTools';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

type TestCase = [string, () => Promise<void>];

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
  body: unknown
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'X-User-Id': userId,
    },
    body: JSON.stringify(body),
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

async function cleanupFixture(userId: string): Promise<void> {
  await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
  await prisma.browserContext.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

/**
 * A deploy replaces the root workflow and force-closes every in-flight tool call.
 * The paired attention request must be closed with it, or the user is left with an
 * inbox row nothing can answer: the browser status bar only renders the prompt while
 * the chip is IN_PROGRESS, and completing it later signals the terminated generation.
 *
 * Prod evidence: agents 2dc4c954-0af7-4f50-8336-11f9925f3c05 ("Sign in to amazon.com.mx")
 * and a87224a7-f9ac-4d09-b8c6-b758f37bac38 ("Sign in to microsoftonline.com") still have
 * userResponse IS NULL weeks after their chips were fenced DEPLOY_INTERRUPTED.
 */
async function testDeployFenceClosesPendingAuthAssistanceRequest(): Promise<void> {
  const userId = `auth-assist-deploy-fence-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId } });
  try {
    await runDeployFenceCase(userId);
  } finally {
    await cleanupFixture(userId);
  }
}

async function runDeployFenceCase(userId: string): Promise<void> {
  const agent = await prisma.agent.create({
    data: { userId, goal: 'Complete a login-gated browser task', status: 'PAUSED' },
  });
  // Before any replacement, an agent's workflow generation is its own id.
  await prisma.agent.update({ where: { id: agent.id }, data: { temporalWorkflowId: agent.id } });
  const context = await prisma.browserContext.create({
    data: { userId, contextId: `steel-profile-${randomUUID()}` },
  });
  const browserSession = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: agent.id,
      sessionId: `steel-session-${randomUUID()}`,
      debugUrl: 'https://debug.steel.dev/session/fence?interactive=false',
      status: 'ACTIVE',
      provider: 'steel',
      providerProfileId: `session-bound-profile-${randomUUID()}`,
      providerProfileSource: 'test_session_bound',
    },
  });

  const createRes = await request('/api/auth-assistance', userId, {
    agentId: agent.id,
    authRealm: 'https://www.amazon.com.mx/login',
    mode: 'live_view',
    steelSessionId: browserSession.sessionId,
  });
  assertStatus(createRes, 201);
  const requestId = String(asRecord(asRecord(createRes.data).request).id);

  // The chip the browser tool posts while it waits carries the request id under
  // requestUserAuthentication.requestId (agents/domains/spawn_browser_agent_v3/handler.py).
  const authToolCallId = `toolu_${randomUUID().slice(0, 12)}`;
  await prisma.message.create({
    data: {
      agentId: agent.id,
      workflowGeneration: agent.id,
      role: 'TOOL',
      text: '',
      timestamp: new Date(),
      metadata: {
        toolName: 'spawn_browser_agent',
        action_type: 'auth_assistance',
        toolCallId: authToolCallId,
        toolStatus: 'IN_PROGRESS',
        workflowGeneration: agent.id,
        requestUserAuthentication: {
          requestId,
          authRealm: 'amazon.com.mx',
          steelSessionId: browserSession.sessionId,
          handoffMode: 'same_steel_session_live_view',
        },
      },
    },
  });

  // Control: an approval-shaped request on the same agent, to prove the fence itself works.
  const approvalRequestId = randomUUID();
  await prisma.agentAttentionRequest.create({
    data: {
      id: approvalRequestId,
      userId,
      agentId: agent.id,
      workflowId: agent.id,
      question: 'Approve this purchase?',
      metadata: { attentionKind: 'approval' },
    },
  });
  const approvalToolCallId = `toolu_${randomUUID().slice(0, 12)}`;
  await prisma.message.create({
    data: {
      agentId: agent.id,
      workflowGeneration: agent.id,
      role: 'TOOL',
      text: '',
      timestamp: new Date(),
      metadata: {
        toolName: 'spawn_browser_agent',
        toolCallId: approvalToolCallId,
        toolStatus: 'IN_PROGRESS',
        workflowGeneration: agent.id,
        requestUserApproval: { writePermission: true, attentionRequestId: approvalRequestId },
      },
    },
  });

  // Safety fixture: a DEDUPED gate is a cross-agent fan-in point. Another agent
  // joined this row as a waiter, so fencing this agent must not answer it out from
  // under it — `resolveAndSignal` only signals waiters while userResponse IS NULL.
  const sharedGateRequestId = randomUUID();
  await prisma.agentAttentionRequest.create({
    data: {
      id: sharedGateRequestId,
      userId,
      agentId: agent.id,
      workflowId: agent.id,
      question: 'Connect Gmail',
      gateKey: `source_connect:gmail:${randomUUID()}`,
      metadata: {
        attentionKind: 'gate',
        gateWaiters: [{ agentId: randomUUID(), workflowId: randomUUID() }],
      },
    },
  });

  // Counter-fixture: a gate this generation solely occupies MUST be closed. The
  // partial unique index (userId, gateKey) WHERE userResponse IS NULL means leaving
  // it pending would block the replacement workflow from ever raising a fresh gate.
  const soleGateRequestId = randomUUID();
  await prisma.agentAttentionRequest.create({
    data: {
      id: soleGateRequestId,
      userId,
      agentId: agent.id,
      workflowId: agent.id,
      question: 'Connect Slack',
      gateKey: `source_connect:slack:${randomUUID()}`,
      metadata: { attentionKind: 'gate' },
    },
  });

  // The deploy cutover claims a new generation, then seals the old one.
  await prisma.agent.update({
    where: { id: agent.id },
    data: { temporalWorkflowId: `${agent.id}:replacement:${randomUUID()}` },
  });
  const fenceResult = await finalizeInterruptedWorkflowTools(agent.id, agent.id, []);
  assert(fenceResult.candidates >= 2, 'Deploy fence should see both in-flight tool calls');

  const fencedAuthChip = await prisma.message.findFirst({
    where: { agentId: agent.id, metadata: { path: ['toolCallId'], equals: authToolCallId } },
    orderBy: { timestamp: 'desc' },
  });
  assert(
    asRecord(fencedAuthChip?.metadata).errorCode === 'DEPLOY_INTERRUPTED',
    'Deploy fence should terminate the auth assistance tool chip'
  );

  const approval = await prisma.agentAttentionRequest.findUnique({
    where: { id: approvalRequestId },
  });
  assert(
    approval !== null && approval.userResponse === DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    `Control: deploy fence should close an approval attention request (userResponse=${String(approval?.userResponse)})`
  );

  const attention = await prisma.agentAttentionRequest.findUnique({ where: { id: requestId } });
  assert(
    attention !== null && attention.userResponse === DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    `Deploy fence closed the auth assistance chip but left its attention request pending (userResponse=${String(attention?.userResponse)})`
  );
  const authAssistance = await prisma.userAuthAssistanceRequest.findUnique({
    where: { id: requestId },
  });
  assert(authAssistance !== null, 'Auth assistance row should survive so the closure is auditable');

  const sharedGate = await prisma.agentAttentionRequest.findUnique({
    where: { id: sharedGateRequestId },
  });
  assert(
    sharedGate !== null && sharedGate.userResponse === null,
    `Deploy fence must not answer a deduped gate on behalf of live waiters (userResponse=${String(sharedGate?.userResponse)})`
  );

  const soleGate = await prisma.agentAttentionRequest.findUnique({
    where: { id: soleGateRequestId },
  });
  assert(
    soleGate !== null && soleGate.userResponse === DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    `Deploy fence must close a gate it solely occupies, or the replacement can never raise a fresh one (userResponse=${String(soleGate?.userResponse)})`
  );
}

/**
 * A user who finishes the sign-in after the deploy still helps us — the captured
 * credential is the whole point — but the completion must not erase the record that
 * the handoff died with its generation. `completeAuthAssistanceForUser` used an
 * unconditional `update`, so it overwrote DEPLOY_INTERRUPTED with the completion
 * sentinel and then signaled the terminated generation.
 */
async function testCompletionAfterFenceKeepsTheInterruptedMarker(): Promise<void> {
  const userId = `auth-assist-fence-complete-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId } });
  try {
    await runCompletionAfterFenceCase(userId);
  } finally {
    await cleanupFixture(userId);
  }
}

async function runCompletionAfterFenceCase(userId: string): Promise<void> {
  const agent = await prisma.agent.create({
    data: { userId, goal: 'Complete a login-gated browser task', status: 'PAUSED' },
  });
  await prisma.agent.update({ where: { id: agent.id }, data: { temporalWorkflowId: agent.id } });
  const context = await prisma.browserContext.create({
    data: { userId, contextId: `steel-profile-${randomUUID()}` },
  });
  const browserSession = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: agent.id,
      sessionId: `steel-session-${randomUUID()}`,
      debugUrl: 'https://debug.steel.dev/session/fence-complete?interactive=false',
      status: 'ACTIVE',
      provider: 'kernel',
      providerProfileId: `session-bound-profile-${randomUUID()}`,
      providerProfileSource: 'test_session_bound',
    },
  });

  const createRes = await request('/api/auth-assistance', userId, {
    agentId: agent.id,
    authRealm: 'https://www.amazon.com.mx/login',
    mode: 'live_view',
    browserSessionId: browserSession.id,
    steelSessionId: browserSession.sessionId,
  });
  assertStatus(createRes, 201);
  const requestId = String(asRecord(asRecord(createRes.data).request).id);

  // The deploy fences the generation that raised the request.
  await prisma.agent.update({
    where: { id: agent.id },
    data: { temporalWorkflowId: `${agent.id}:replacement:${randomUUID()}` },
  });
  await finalizeInterruptedWorkflowTools(agent.id, agent.id, []);
  const fenced = await prisma.agentAttentionRequest.findUnique({ where: { id: requestId } });
  assert(
    fenced !== null && fenced.userResponse === DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    'Fixture precondition: the fence must have answered the request first'
  );

  // The user finishes signing in afterwards.
  const completeRes = await request(`/api/auth-assistance/${requestId}/complete`, userId, {});
  assertStatus(completeRes, 200);

  const assistance = await prisma.userAuthAssistanceRequest.findUnique({
    where: { id: requestId },
  });
  assert(
    assistance !== null && assistance.completedAt !== null,
    'Completion should still capture the credential after a fence'
  );

  const attention = await prisma.agentAttentionRequest.findUnique({ where: { id: requestId } });
  assert(
    attention !== null && attention.userResponse === DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    `Completion overwrote the deploy-fence marker (userResponse=${String(attention?.userResponse)})`
  );

  // A client retry must preserve the same fence classification. Otherwise the
  // already-completed branch signals the dead generation even though the first
  // completion correctly skipped it.
  const retry = await completeAuthAssistanceForUser(requestId, userId);
  assert(
    retry.status === 'already_completed' && retry.interrupted,
    `Retry lost the deploy-fenced completion state (status=${retry.status})`
  );
}

async function testCompetingCompletionIsNotMisclassifiedAsDeployInterruption(): Promise<void> {
  const userId = `auth-assist-competing-completion-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId } });
  try {
    const agent = await prisma.agent.create({
      data: { userId, goal: 'Complete a competing login handoff', status: 'PAUSED' },
    });
    await prisma.agent.update({
      where: { id: agent.id },
      data: { temporalWorkflowId: agent.id },
    });
    const context = await prisma.browserContext.create({
      data: { userId, contextId: `kernel-profile-${randomUUID()}` },
    });
    const browserSession = await prisma.browserSession.create({
      data: {
        contextId: context.id,
        agentId: agent.id,
        sessionId: `kernel-session-${randomUUID()}`,
        debugUrl: 'https://debug.kernel.test/session/competing-completion',
        status: 'ACTIVE',
        provider: 'kernel',
      },
    });
    const createRes = await request('/api/auth-assistance', userId, {
      agentId: agent.id,
      authRealm: 'https://example.com/login',
      mode: 'live_view',
      browserSessionId: browserSession.id,
      steelSessionId: browserSession.sessionId,
    });
    assertStatus(createRes, 201);
    const requestId = String(asRecord(asRecord(createRes.data).request).id);

    // Model a competing resolver winning the attention-row CAS without yet
    // marking the auth-assistance row complete.
    await prisma.agentAttentionRequest.update({
      where: { id: requestId },
      data: { userResponse: AUTH_ASSISTANCE_COMPLETED_RESPONSE },
    });

    let signaledWorkflowId: string | null = null;
    let resumedAgentId: string | null = null;
    const result = await completeAuthAssistanceForUser(requestId, userId, new Date(), {
      signalCompleted: async (workflowId: string) => {
        signaledWorkflowId = workflowId;
      },
      resumeAgent: async (id: string) => {
        resumedAgentId = id;
      },
    });

    assert(result.status === 'completed', `expected completed result, got ${result.status}`);
    assert(!result.interrupted, 'a competing completion sentinel is not a deploy interruption');
    assert(
      signaledWorkflowId === agent.id,
      'the live workflow generation should still be signaled'
    );
    assert(resumedAgentId === agent.id, 'the agent should still be resumed after completion');
  } finally {
    await cleanupFixture(userId);
  }
}

async function testConcurrentCompletionsRunExternalSideEffectsOnce(): Promise<void> {
  const userId = `auth-assist-concurrent-completion-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId } });
  try {
    const agent = await prisma.agent.create({
      data: { userId, goal: 'Complete one concurrent login handoff', status: 'PAUSED' },
    });
    await prisma.agent.update({
      where: { id: agent.id },
      data: { temporalWorkflowId: agent.id },
    });
    const context = await prisma.browserContext.create({
      data: { userId, contextId: `kernel-profile-${randomUUID()}` },
    });
    const browserSession = await prisma.browserSession.create({
      data: {
        contextId: context.id,
        agentId: agent.id,
        sessionId: `kernel-session-${randomUUID()}`,
        debugUrl: 'https://debug.kernel.test/session/concurrent-completion',
        status: 'ACTIVE',
        provider: 'kernel',
      },
    });
    const createRes = await request('/api/auth-assistance', userId, {
      agentId: agent.id,
      authRealm: 'https://example.com/login',
      mode: 'live_view',
      browserSessionId: browserSession.id,
      steelSessionId: browserSession.sessionId,
    });
    assertStatus(createRes, 201);
    const requestId = String(asRecord(asRecord(createRes.data).request).id);

    let arrivals = 0;
    let releaseBarrier: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const beforeCompletionClaim = async (): Promise<void> => {
      arrivals++;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    };
    let signalCount = 0;
    let resumeCount = 0;
    const dependencies = {
      beforeCompletionClaim,
      signalCompleted: async () => {
        signalCount++;
      },
      resumeAgent: async () => {
        resumeCount++;
      },
    };

    const results = await Promise.all([
      completeAuthAssistanceForUser(requestId, userId, new Date(), dependencies),
      completeAuthAssistanceForUser(requestId, userId, new Date(), dependencies),
    ]);
    const completed = results.filter((result) => result.status === 'completed');
    const raced = results.find((result) => result.status === 'already_completed');

    assert(
      completed.length === 1,
      `exactly one caller should claim completion, got ${completed.length}`
    );
    assert(
      raced?.status === 'already_completed' && !raced.retrySideEffects,
      'the caller that loses the completion claim must suppress retry side effects'
    );
    assert(signalCount === 1, `completion signaling must run once, got ${signalCount}`);
    assert(resumeCount === 1, `workflow resume must run once, got ${resumeCount}`);
  } finally {
    await cleanupFixture(userId);
  }
}

export const authAssistanceDeploymentFenceTests: TestCase[] = [
  [
    'deploy fence closes the pending auth assistance request with its tool chip',
    testDeployFenceClosesPendingAuthAssistanceRequest,
  ],
  [
    'completion after a deploy fence keeps the interrupted marker',
    testCompletionAfterFenceKeepsTheInterruptedMarker,
  ],
  [
    'competing completion is not misclassified as a deploy interruption',
    testCompetingCompletionIsNotMisclassifiedAsDeployInterruption,
  ],
  [
    'concurrent completions run external side effects exactly once',
    testConcurrentCompletionsRunExternalSideEffectsOnce,
  ],
];
