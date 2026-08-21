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

/**
 * NOTE ON SCOPE: browser and explore "sub-agents" are NOT descendants. Both are
 * activities of the ROOT workflow that share the parent's agent_id
 * (`spawn_browser_agent_v3/handler.py` `agent_id = workflow_instance.agent_id`;
 * `spawn_agent/handler.py` starts `spawn_explore_agent_activity` the same way).
 * They own no Agent row, so `cleanupNonterminalDescendantWorkflows` cannot see
 * them and neither is closed or restarted by a cutover. Proving that requires a
 * live worker — it is covered by the e2e cutover test, not here.
 *
 * The two cases below cover the only sub-agent construct that DOES own an Agent
 * row: a `spawn_sub_agents` child.
 */
test('deploy cutover closes a live spawn_sub_agents descendant', async () => {
  const session = await createAnonymousSession('cutover-descendant-close');
  const rootAgentId = await createTestAgent(session.user.id, 'Cutover descendant close test');
  await prisma.agent.update({
    where: { id: rootAgentId },
    data: { temporalWorkflowId: rootAgentId, status: 'ACTIVE' },
  });

  const childAgentId = await createTestAgent(session.user.id, 'Descendant child');
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
    `a deploy cutover must close the root's live descendant, but the child is still ` +
      `status=${child.status} — it keeps running on a replaced generation`
  );
});

test("deploy cutover releases a closed descendant's browser session", async () => {
  // `completeDescendantCleanup` marks the child FAILED with a raw
  // `tx.agent.updateMany`, which bypasses `updateAgentStatus` and therefore its
  // terminal hook `releaseTerminalBrowserSessions`. So a descendant that held a
  // rented browser is marked dead while its browser keeps running and billing.
  // `workflowLivenessReconciler` carries an explicit compensation comment for
  // this same bypass hazard; `completeDescendantCleanup` has no equivalent.
  const session = await createAnonymousSession('cutover-descendant-browser');
  const rootAgentId = await createTestAgent(session.user.id, 'Cutover descendant browser test');
  await prisma.agent.update({
    where: { id: rootAgentId },
    data: { temporalWorkflowId: rootAgentId, status: 'ACTIVE' },
  });

  const childAgentId = await createTestAgent(session.user.id, 'Descendant holding a browser');
  await prisma.agent.update({
    where: { id: childAgentId },
    data: {
      parent: { connect: { id: rootAgentId } },
      temporalWorkflowId: childAgentId,
      status: 'ACTIVE',
    },
  });
  const childSessionId = await seedLiveBrowserSession(session.user.id, childAgentId);

  await prepareAgentWorkflowReplacement(rootAgentId, session.user.id);

  const childSession = await prisma.browserSession.findUniqueOrThrow({
    where: { id: childSessionId },
  });
  assert(
    childSession.status !== 'ACTIVE' || childSession.closedAt !== null,
    `closing a descendant must release its rented browser, but it is still ` +
      `status=${childSession.status} closedAt=${String(childSession.closedAt)} — ` +
      `completeDescendantCleanup's raw updateMany skips the terminal release hook`
  );
});

test('deploy seal is call-scoped so the top-level chip can terminate', async () => {
  // The front-end only terminates the top-level Browser Agent chip from a row
  // with no subAgentId and no task_id/action_type (useMessageRouting
  // `isBrowserAgentChipMessage`). The seal used to inherit the call's LAST
  // in-progress row -- a sub-step carrying all three -- so the chip rendered
  // "in progress" forever beside the replacement's new one: two live-looking
  // browser agents for one that was actually dead.
  const session = await createAnonymousSession('cutover-seal-scope');
  const agentId = await createTestAgent(session.user.id, 'Cutover seal scope test');
  await prisma.agent.update({
    where: { id: agentId },
    data: { temporalWorkflowId: agentId, status: 'ACTIVE' },
  });
  const toolCallId = `call_${randomUUID().slice(0, 12)}`;
  const subAgentId = randomUUID();
  // Open at parent scope, then advance to a sub-step -- the real browser shape.
  await seedInFlightBrowserToolCall(agentId, agentId, toolCallId);
  await prisma.message.create({
    data: {
      agentId,
      workflowGeneration: agentId,
      role: 'TOOL',
      text: '',
      timestamp: new Date(),
      metadata: {
        toolCallId,
        toolName: 'spawn_browser_agent',
        toolStatus: 'IN_PROGRESS',
        workflowGeneration: agentId,
        subAgentId,
        task_id: subAgentId,
        action_type: 'goto',
      },
    },
  });

  await prepareAgentWorkflowReplacement(agentId, session.user.id);

  const seal = await prisma.message.findFirstOrThrow({
    where: {
      agentId,
      role: 'TOOL',
      metadata: { path: ['toolCallId'], equals: toolCallId },
      AND: [{ metadata: { path: ['errorCode'], equals: 'DEPLOY_INTERRUPTED' } }],
    },
    orderBy: { createdAt: 'desc' },
  });
  const meta = (seal.metadata ?? {}) as Record<string, unknown>;
  assert(
    meta.subAgentId === undefined && meta.task_id === undefined && meta.action_type === undefined,
    `the deploy seal must be call-scoped so the top-level chip terminates, got ` +
      `subAgentId=${String(meta.subAgentId)} task_id=${String(meta.task_id)} ` +
      `action_type=${String(meta.action_type)}`
  );
});
