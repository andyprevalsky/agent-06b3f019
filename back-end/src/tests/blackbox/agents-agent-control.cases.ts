/**
 * Agent-to-agent control contracts: POST /:id/kill-agent, waking a finished
 * agent with send-agent-message, the removed get_agent summary route, and
 * task_path on the FE tree endpoint.
 *
 * Signal assertions read the in-memory blackbox Temporal fake through the
 * capture-mode-only GET /api/test/temporal-signals/:workflowId route.
 */
import {
  BASE_URL,
  apiKeyHeaders,
  assert,
  assertStatus,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  prisma,
  randomUUID,
  request,
  test,
} from './agents-blackbox-harness';
import { TEMPORAL_CONTROL_RPC_TIMEOUT_MS } from '../../providers/temporal';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';

interface Tree {
  userId: string;
  rootId: string;
  childId: string;
  grandchildId: string;
}

async function createWorkflowAgent(userId: string, goal: string): Promise<string> {
  const agentId = await createTestAgent(userId, goal, { start_phase: 'execute' });
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(stored.temporalWorkflowId === agentId, 'fixture must own a running workflow');
  return agentId;
}

/** /root → /root/outreach → /root/outreach/napa (busId = root, as spawn_agent links them). */
async function createTree(label: string): Promise<Tree> {
  const session = await createAnonymousSession(label);
  const userId = session.user.id;
  const rootId = await createWorkflowAgent(userId, `Plan a team offsite (${label})`);
  const childId = await createWorkflowAgent(userId, 'Do outreach to venues for the offsite');
  const grandchildId = await createWorkflowAgent(userId, 'Email the Napa venue about dates');
  await prisma.agent.update({ where: { id: rootId }, data: { taskPath: '/root' } });
  await prisma.agent.update({
    where: { id: childId },
    data: {
      parentAgentId: rootId,
      parentWorkflowId: rootId,
      busId: rootId,
      depth: 1,
      taskPath: '/root/outreach',
    },
  });
  await prisma.agent.update({
    where: { id: grandchildId },
    data: {
      parentAgentId: childId,
      parentWorkflowId: childId,
      busId: rootId,
      depth: 2,
      taskPath: '/root/outreach/napa',
    },
  });
  return { userId, rootId, childId, grandchildId };
}

async function deleteTree(tree: Tree): Promise<void> {
  for (const id of [tree.grandchildId, tree.childId, tree.rootId]) {
    await deleteTestAgent(id, tree.userId);
  }
}

async function post(userId: string, senderId: string, route: string, body: unknown) {
  return request(`${BASE_URL}/api/agents/${senderId}/${route}`, {
    method: 'POST',
    headers: apiKeyHeaders(userId),
    body: JSON.stringify(body),
  });
}

async function signalsFor(workflowId: string): Promise<Array<{ name: string; args: unknown[] }>> {
  const res = await request(`${BASE_URL}/api/test/temporal-signals/${workflowId}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { signals: Array<{ name: string; args: unknown[] }> }).signals;
}

test('POST /:id/send-agent-message — a finished agent wakes with the message as its next task', async () => {
  const tree = await createTree('a2a-wake');
  try {
    await prisma.agent.update({
      where: { id: tree.grandchildId },
      data: { status: 'COMPLETED', progress: 1, structuredResponse: { venue: 'Napa' } },
    });
    const text = 'Now also ask the Napa venue about parking.';
    const body = {
      to: '/root/outreach/napa',
      message: text,
      idempotency_key: `wake-${randomUUID()}`,
    };
    const res = await post(tree.userId, tree.childId, 'send-agent-message', body);
    assertStatus(res.status, 201, res.data);
    const sent = res.data as { message_id: string; delivered: boolean; woke?: boolean };
    assert(
      sent.woke === true && sent.delivered === true,
      `expected a wake, got ${JSON.stringify(sent)}`
    );

    const woken = await prisma.agent.findUniqueOrThrow({ where: { id: tree.grandchildId } });
    assert(woken.status === 'ACTIVE', `woken agent must be ACTIVE, got ${woken.status}`);
    assert(
      woken.temporalWorkflowId === `${tree.grandchildId}:wake:${sent.message_id}`,
      `wake must start a message-keyed run, got ${woken.temporalWorkflowId}`
    );
    assert(woken.goal === text, 'the message becomes the next task (Agent.goal)');
    assert(woken.structuredResponse === null && woken.progress === 0, 'derived run state resets');
    assert(woken.parentAgentId === tree.childId && woken.depth === 2, 'tree position is kept');

    const row = await prisma.message.findUniqueOrThrow({ where: { id: sent.message_id } });
    const rowMetadata = row.metadata as Record<string, unknown>;
    assert(
      rowMetadata.agentMessage === true &&
        rowMetadata.messageType === 'NEW_TASK' &&
        rowMetadata.toAgentPath === '/root/outreach/napa',
      `row stays an agent message, typed NEW_TASK (Codex): ${JSON.stringify(rowMetadata)}`
    );

    const again = await post(tree.userId, tree.childId, 'send-agent-message', body);
    assertStatus(again.status, 201, again.data);
    const retried = await prisma.agent.findUniqueOrThrow({ where: { id: tree.grandchildId } });
    assert(
      retried.temporalWorkflowId === woken.temporalWorkflowId,
      'a retried send must not start a second run'
    );
  } finally {
    await deleteTree(tree);
  }
});

test('POST /:id/send-agent-message — a failed wake start restores the finished agent', async () => {
  const tree = await createTree('a2a-wake-fail');
  try {
    const before = await prisma.agent.update({
      where: { id: tree.grandchildId },
      data: {
        status: 'COMPLETED',
        progress: 1,
        structuredResponse: { venue: 'Napa' },
        statusMessage: 'Booked the Napa venue',
        toolsInUse: ['gmail_send'],
      },
    });
    const text = 'Now also ask the Napa venue about parking.';
    // Hold the target's workflow-generation lock past the start-admission
    // deadline: the wake reactivates the row, then its workflow start fails.
    let pending: ReturnType<typeof post> | undefined;
    await prisma.$transaction(
      async (tx) => {
        await lockAgentWorkflowGeneration(tx, tree.grandchildId);
        pending = post(tree.userId, tree.childId, 'send-agent-message', {
          to: '/root/outreach/napa',
          message: text,
          idempotency_key: `wake-fail-${randomUUID()}`,
        });
        pending.catch(() => undefined);
        await new Promise((resolve) =>
          setTimeout(resolve, TEMPORAL_CONTROL_RPC_TIMEOUT_MS + 1_000)
        );
      },
      { maxWait: 10_000, timeout: TEMPORAL_CONTROL_RPC_TIMEOUT_MS + 30_000 }
    );
    assert(pending !== undefined, 'send must have been issued');
    const res = await pending;
    assertStatus(res.status, 201, res.data);
    const sent = res.data as { message_id: string; woke?: boolean; wake_error?: string };
    assert(
      sent.woke === false && typeof sent.wake_error === 'string' && sent.wake_error.length > 0,
      `expected a failed wake, got ${JSON.stringify(sent)}`
    );

    const after = await prisma.agent.findUniqueOrThrow({ where: { id: tree.grandchildId } });
    const snapshot = (agent: typeof before) => ({
      status: agent.status,
      temporalWorkflowId: agent.temporalWorkflowId,
      temporalFirstExecutionRunId: agent.temporalFirstExecutionRunId,
      goal: agent.goal,
      progress: agent.progress,
      structuredResponse: agent.structuredResponse,
      responseSchema: agent.responseSchema,
      statusMessage: agent.statusMessage,
      toolsInUse: agent.toolsInUse,
    });
    assert(
      JSON.stringify(snapshot(after)) === JSON.stringify(snapshot(before)),
      `a failed wake must leave the finished agent as it was: before ${JSON.stringify(
        snapshot(before)
      )}, after ${JSON.stringify(snapshot(after))}`
    );
    const row = await prisma.message.findUniqueOrThrow({ where: { id: sent.message_id } });
    assert(row.text === text, 'the message stays stored for a later wake');
  } finally {
    await deleteTree(tree);
  }
});

test('POST /:id/kill-agent — kills descendants only and signals kill', async () => {
  const tree = await createTree('a2a-kill');
  try {
    const key = `kill-${randomUUID()}`;
    const res = await post(tree.userId, tree.rootId, 'kill-agent', {
      to: '/root/outreach/napa',
      idempotency_key: key,
    });
    assertStatus(res.status, 200, res.data);
    const killed = res.data as { killed: boolean; status: string; to: { agent_id: string } };
    assert(
      killed.killed === true &&
        killed.status === 'KILLING' &&
        killed.to.agent_id === tree.grandchildId,
      JSON.stringify(killed)
    );
    const signals = (await signalsFor(tree.grandchildId)).filter((s) => s.name === 'kill');
    assert(
      signals.length === 1 &&
        JSON.stringify(signals[0].args) ===
          JSON.stringify([
            { by_agent_id: tree.rootId, by_agent_path: '/root', idempotency_key: key },
          ]),
      `expected one kill signal from the root, got ${JSON.stringify(signals)}`
    );

    const self = await post(tree.userId, tree.childId, 'kill-agent', {
      to: '/root/outreach',
      idempotency_key: `self-${randomUUID()}`,
    });
    assertStatus(self.status, 400, self.data);
    const ancestor = await post(tree.userId, tree.grandchildId, 'kill-agent', {
      to: 'parent',
      idempotency_key: `anc-${randomUUID()}`,
    });
    assertStatus(ancestor.status, 403, ancestor.data);
    assert(
      (await signalsFor(tree.childId)).every((s) => s.name !== 'kill'),
      'a rejected kill must not signal'
    );

    await prisma.agent.update({ where: { id: tree.grandchildId }, data: { status: 'COMPLETED' } });
    const finished = await post(tree.userId, tree.rootId, 'kill-agent', {
      to: tree.grandchildId,
      idempotency_key: `done-${randomUUID()}`,
    });
    assertStatus(finished.status, 200, finished.data);
    assert(
      (finished.data as { killed: boolean }).killed === false,
      'a finished agent is not killed again'
    );

    // The old stop/interrupt routes are gone (interrupt_agent was removed).
    for (const removed of ['stop-agent', 'interrupt-agent']) {
      const gone = await post(tree.userId, tree.rootId, removed, {
        to: '/root/outreach',
        message: 'x',
        idempotency_key: `gone-${randomUUID()}`,
      });
      assertStatus(gone.status, 404, gone.data);
    }

    const stranger = await createAnonymousSession('a2a-kill-stranger');
    const denied = await post(stranger.user.id, tree.rootId, 'kill-agent', {
      to: tree.grandchildId,
      idempotency_key: `str-${randomUUID()}`,
    });
    assertStatus(denied.status, 404, denied.data);
  } finally {
    await deleteTree(tree);
  }
});

test('GET /:id/agent-summary — removed with get_agent (no summary route)', async () => {
  const tree = await createTree('a2a-summary-removed');
  try {
    const res = await request(
      `${BASE_URL}/api/agents/${tree.grandchildId}/agent-summary?address=parent`,
      { headers: apiKeyHeaders(tree.userId) }
    );
    assertStatus(res.status, 404, res.data);
  } finally {
    await deleteTree(tree);
  }
});

test('GET /tree?busId= — FE tree nodes carry task_path', async () => {
  const tree = await createTree('a2a-fe-tree');
  try {
    const res = await request(`${BASE_URL}/api/agents/tree?busId=${tree.rootId}`, {
      headers: apiKeyHeaders(tree.userId),
    });
    assertStatus(res.status, 200, res.data);
    const agents = (res.data as { agents: Array<{ agent_id: string; task_path: string | null }> })
      .agents;
    const byId = new Map(agents.map((a) => [a.agent_id, a.task_path]));
    assert(
      byId.get(tree.childId) === '/root/outreach',
      `child path, got ${JSON.stringify(agents)}`
    );
    assert(byId.get(tree.grandchildId) === '/root/outreach/napa', 'grandchild path');
  } finally {
    await deleteTree(tree);
  }
});

test('user control revision orders pause/resume independently of unrelated updates', async () => {
  const session = await createAnonymousSession('user-control-revision');
  const userId = session.user.id;
  const agentId = await createWorkflowAgent(userId, 'Pause and resume ordering');
  const route = `${BASE_URL}/api/agents/${agentId}`;
  const get = async () => {
    const response = await request(route, { headers: apiKeyHeaders(userId) });
    assertStatus(response.status, 200, response.data);
    return (response.data as { agent: { user_control_revision: number; status: string } }).agent;
  };
  try {
    const baseline = (await get()).user_control_revision;
    assert(typeof baseline === 'number', 'agent detail must expose durable user control revision');
    const pause = await request(`${route}/pause`, {
      method: 'POST',
      headers: apiKeyHeaders(userId),
    });
    assertStatus(pause.status, 200, pause.data);
    const paused = (pause.data as { user_control_revision: number }).user_control_revision;
    assert(paused > baseline, 'accepted pause must acknowledge its locked revision');
    assert(
      (await get()).user_control_revision === paused,
      'detail must match pause acknowledgment'
    );
    await prisma.agent.update({
      where: { id: agentId },
      data: { title: 'Unrelated title update' },
    });
    assert(
      (await get()).user_control_revision === paused,
      'unrelated writes must preserve control ordering'
    );
    const resume = await request(`${route}/resume`, {
      method: 'POST',
      headers: apiKeyHeaders(userId),
    });
    assertStatus(resume.status, 200, resume.data);
    const resumed = await get();
    assert(
      resumed.status === 'ACTIVE' && resumed.user_control_revision > paused,
      'external resume must outrank pause even if the client missed PAUSED'
    );
    const list = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(userId) });
    assertStatus(list.status, 200, list.data);
    const row = (
      list.data as { agents: Array<{ agent_id: string; user_control_revision: number }> }
    ).agents.find((a) => a.agent_id === agentId);
    assert(
      row?.user_control_revision === resumed.user_control_revision,
      'sidebar must carry the same durable revision'
    );
  } finally {
    await deleteTestAgent(agentId, userId);
  }
});
