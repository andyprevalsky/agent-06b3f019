import {
  assert,
  createAnonymousSession,
  createTestAgent,
  prisma,
  randomUUID,
  test,
} from './agents-blackbox-harness';
import { prepareAgentWorkflowReplacement } from '../../domains/agents/agentRestartService';

/**
 * A deploy cutover must CLOSE a live sub-agent, not leave it running.
 *
 * `migrate-open-agent-workflows.ts` replaces an agent's root workflow by calling
 * `prepareAgentWorkflowReplacement` + `startPreparedAgentWorkflowReplacement` —
 * the same pair behind `POST /api/agents/:id/restart`. Replacement keeps the
 * agent ACTIVE under a new generation, so it never performs a terminal status
 * transition.
 *
 * That matters because browser-session release hangs off exactly three triggers
 * (`providers/agentCleanup.ts::releaseAgentBrowserSessions`): a terminal status
 * transition (`agentStatusService`), the liveness reconciler, and agent
 * deletion. A cutover is none of them. And the Python browser activity's own
 * `POST /api/browser-session/close` sits in a `try` body rather than a
 * `finally`, so the Temporal TERMINATE that seals the old generation skips it
 * (see the header of `agents-terminal-browser-release.cases.ts`).
 *
 * Net effect observed in prod on agent 219dd80e-c2ed-4dc1-a40e-b2b9ea7e0a87: the
 * browser agent was never closed. It kept stepping on a replaced generation for
 * minutes, and every step it wrote was converted into a red
 * "Tool interrupted by deployment" chip instead of the whole sub-agent being
 * torn down and restarted. A replaced generation also kept issuing 71 distinct
 * live `spawn_agent` tool calls over 90 minutes.
 *
 * These cases pin the intended contract: after a cutover, a live sub-agent's
 * rented resources are released and its work is sealed exactly once.
 */

async function seedLiveBrowserSession(userId: string, agentId: string): Promise<string> {
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
      debugUrl: 'http://localhost:9222/session/cutover-close?interactive=false',
      status: 'ACTIVE',
      provider: 'steel',
      providerProfileId: `cutover-profile-${randomUUID()}`,
      providerProfileSource: 'test_cutover',
    },
  });
  return session.id;
}

/** Register a browser tool call as in-flight in the agent's current generation. */
async function seedInFlightBrowserToolCall(
  agentId: string,
  generation: string,
  toolCallId: string
): Promise<void> {
  await prisma.message.create({
    data: {
      agentId,
      workflowGeneration: generation,
      role: 'TOOL',
      text: '',
      timestamp: new Date(),
      metadata: {
        toolCallId,
        toolName: 'spawn_browser_agent',
        toolStatus: 'IN_PROGRESS',
        workflowGeneration: generation,
      },
    },
  });
}

test('deploy cutover releases a live browser sub-agent instead of leaving it running', async () => {
  const session = await createAnonymousSession('cutover-browser-close');
  const agentId = await createTestAgent(session.user.id, 'Cutover browser close test');
  await prisma.agent.update({
    where: { id: agentId },
    data: { temporalWorkflowId: agentId, status: 'ACTIVE' },
  });
  const browserSessionId = await seedLiveBrowserSession(session.user.id, agentId);
  await seedInFlightBrowserToolCall(agentId, agentId, `call_${randomUUID().slice(0, 12)}`);

  // Exactly what a deploy does to this agent.
  await prepareAgentWorkflowReplacement(agentId, session.user.id);

  const browserSession = await prisma.browserSession.findUniqueOrThrow({
    where: { id: browserSessionId },
  });
  assert(
    browserSession.status !== 'ACTIVE' || browserSession.closedAt !== null,
    `a deploy cutover must close the live browser sub-agent's rented session, but it is still ` +
      `status=${browserSession.status} closedAt=${String(browserSession.closedAt)} — the browser ` +
      `agent keeps running on a replaced generation and its every step is clobbered into a ` +
      `"Tool interrupted by deployment" chip`
  );
});

test('deploy cutover seals a live browser tool call exactly once', async () => {
  const session = await createAnonymousSession('cutover-browser-seal-once');
  const agentId = await createTestAgent(session.user.id, 'Cutover browser seal test');
  await prisma.agent.update({
    where: { id: agentId },
    data: { temporalWorkflowId: agentId, status: 'ACTIVE' },
  });
  const toolCallId = `call_${randomUUID().slice(0, 12)}`;
  await seedInFlightBrowserToolCall(agentId, agentId, toolCallId);

  await prepareAgentWorkflowReplacement(agentId, session.user.id);

  // A closed sub-agent produces ONE terminal result for its tool call. A
  // sub-agent left alive produces one per step it keeps taking.
  const terminal = await prisma.message.findMany({
    where: {
      agentId,
      role: 'TOOL',
      metadata: { path: ['toolCallId'], equals: toolCallId },
    },
  });
  const interrupted = terminal.filter(
    (message) =>
      (message.metadata as { errorCode?: unknown } | null)?.errorCode === 'DEPLOY_INTERRUPTED'
  );
  assert(
    interrupted.length <= 1,
    `a cutover must seal a tool call once, got ${interrupted.length} DEPLOY_INTERRUPTED rows for ${toolCallId}`
  );
});

test('deploy cutover closes a live explore sub-agent', async () => {
  const session = await createAnonymousSession('cutover-explore-close');
  const rootAgentId = await createTestAgent(session.user.id, 'Cutover explore close test');
  await prisma.agent.update({
    where: { id: rootAgentId },
    data: { temporalWorkflowId: rootAgentId, status: 'ACTIVE' },
  });

  const childAgentId = await createTestAgent(session.user.id, 'Explore child');
  await prisma.agent.update({
    where: { id: childAgentId },
    data: {
      parent: { connect: { id: rootAgentId } },
      temporalWorkflowId: childAgentId,
      status: 'ACTIVE',
    },
  });

  await prepareAgentWorkflowReplacement(rootAgentId, session.user.id);

  const child = await prisma.agent.findUniqueOrThrow({ where: { id: childAgentId } });
  assert(
    child.status === 'COMPLETED' || child.status === 'FAILED',
    `a deploy cutover must close the root's live explore sub-agent, but the child is still ` +
      `status=${child.status} — it keeps running on a replaced generation`
  );
});
