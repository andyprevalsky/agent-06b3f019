/**
 * Task-path addressing: paths on create (sibling collision 409), the shared
 * address resolver (GET /:id/resolve-address), path-addressed delivery
 * (POST /:sender/send-agent-message) including another agent's in-flight
 * background task, and background tasks listed in the tree view.
 *
 * Reuses the agents-agent-tree fixture: root /root, outreach /root/outreach,
 * draftA /root/outreach/draft_a, aKid /root/outreach/draft_a/lookup, ...
 */
import {
  BASE_URL,
  apiKeyHeaders,
  assert,
  assertStatus,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  prepareTestParentWorkflow,
  prisma,
  randomUUID,
  request,
  test,
} from './agents-blackbox-harness';
import {
  type Fixture,
  createFixture,
  deleteFixture,
  getTree,
  getView,
  idsOf,
  same,
} from './agents-agent-tree.cases';

const SCAN_TASK = {
  address: 'bg_call-7',
  type: 'explore',
  goal: 'Scan venue news',
  status: 'running',
  started_at: new Date().toISOString(),
  task_name: 'scan',
  path: '/root/outreach/scan',
};

async function withScanTask(label: string): Promise<Fixture> {
  const fx = await createFixture(label);
  await prisma.agent.update({
    where: { id: fx.ids.outreach },
    data: {
      backgroundTasks: [
        SCAN_TASK,
        {
          ...SCAN_TASK,
          address: 'bg_done',
          task_name: 'old',
          path: '/root/outreach/old',
          status: 'completed',
        },
      ],
    },
  });
  return fx;
}

async function resolve(userId: string, callerId: string, address: string) {
  return request(
    `${BASE_URL}/api/agents/${callerId}/resolve-address?${new URLSearchParams({ address })}`,
    { headers: apiKeyHeaders(userId) }
  );
}

async function sendTo(userId: string, senderId: string, to: string, message: string) {
  return request(`${BASE_URL}/api/agents/${senderId}/send-agent-message`, {
    method: 'POST',
    headers: apiKeyHeaders(userId),
    body: JSON.stringify({ to, message, idempotency_key: `addr-${randomUUID()}` }),
  });
}

test('GET /:id/resolve-address — paths, parent, /root, ids and background tasks resolve within the tree', async () => {
  const fx = await withScanTask('addr-resolve');
  const other = await createFixture('addr-resolve-other');
  const { ids } = fx;
  try {
    const expectAgent = async (address: string, agentId: string, path: string) => {
      const res = await resolve(fx.userId, ids.draftA, address);
      assertStatus(res.status, 200, res.data);
      const body = res.data as { agent_id: string; path: string; recipient_task_id: string | null };
      assert(
        body.agent_id === agentId && body.path === path && body.recipient_task_id === null,
        `${address} → ${JSON.stringify(body)}`
      );
    };
    await expectAgent('/root/outreach/draft_a/lookup', ids.aKid, '/root/outreach/draft_a/lookup');
    await expectAgent('parent', ids.outreach, '/root/outreach');
    await expectAgent('/root', ids.root, '/root');
    await expectAgent(ids.research, ids.research, '/root/research');

    const task = await resolve(fx.userId, ids.draftA, '/root/outreach/scan');
    assertStatus(task.status, 200, task.data);
    assert(
      same(task.data, {
        agent_id: ids.outreach,
        recipient_task_id: 'bg_call-7',
        path: '/root/outreach/scan',
        type: 'explore',
      }),
      `background task path resolves to owner + task, got ${JSON.stringify(task.data)}`
    );
    const byOwnerId = await resolve(fx.userId, ids.draftA, `${ids.outreach}/bg_call-7`);
    assertStatus(byOwnerId.status, 200, byOwnerId.data);

    // A finished task stays addressable (its owner wakes it for another run).
    for (const finished of ['/root/outreach/old', `${ids.outreach}/bg_done`]) {
      const res = await resolve(fx.userId, ids.draftA, finished);
      assertStatus(res.status, 200, res.data);
      assert(
        (res.data as { recipient_task_id: string }).recipient_task_id === 'bg_done',
        `${finished} → ${JSON.stringify(res.data)}`
      );
    }
    const missing = await resolve(fx.userId, ids.draftA, '/root/nobody');
    assertStatus(missing.status, 404, missing.data);
    const bad = await resolve(fx.userId, ids.draftA, 'Root/Outreach');
    assertStatus(bad.status, 400, bad.data);
    const rootParent = await resolve(fx.userId, ids.root, 'parent');
    assertStatus(rootParent.status, 404, rootParent.data);

    // Same paths exist in the other tree; a path always resolves in the caller's tree.
    const isolated = await resolve(other.userId, other.ids.draftA, '/root/outreach');
    assert((isolated.data as { agent_id: string }).agent_id === other.ids.outreach, 'own tree');
    const crossTreeId = await resolve(fx.userId, ids.draftA, other.ids.outreach);
    assertStatus(crossTreeId.status, 404, crossTreeId.data);
    const stranger = await resolve(other.userId, ids.draftA, '/root');
    assertStatus(stranger.status, 404, stranger.data);
  } finally {
    await deleteFixture(other);
    await deleteFixture(fx);
  }
});

test("POST /:id/send-agent-message — path delivery to an agent and to another agent's background task", async () => {
  const fx = await withScanTask('addr-send');
  const { ids } = fx;
  try {
    const toTask = await sendTo(fx.userId, ids.draftA, '/root/outreach/scan', 'Skip Sonoma.');
    assertStatus(toTask.status, 201, toTask.data);
    const taskBody = toTask.data as {
      message_id: string;
      task_running: boolean;
      to: { agent_id: string };
    };
    assert(
      taskBody.task_running === true && taskBody.to.agent_id === ids.outreach,
      'task delivery'
    );
    const row = await prisma.message.findUniqueOrThrow({ where: { id: taskBody.message_id } });
    const meta = row.metadata as Record<string, unknown>;
    assert(row.agentId === ids.outreach, 'row lands on the owner');
    assert(
      meta.recipientTaskId === 'bg_call-7' &&
        meta.excludeFromModel === true &&
        meta.fromAgentPath === '/root/outreach/draft_a',
      `task row metadata ${JSON.stringify(meta)}`
    );
    const inbox = await request(
      `${BASE_URL}/api/agents/${ids.outreach}/agent-inbox?task_id=bg_call-7`,
      { headers: apiKeyHeaders(fx.userId) }
    );
    assertStatus(inbox.status, 200, inbox.data);
    const messages = (inbox.data as { messages: Array<{ text: string; from_agent_path: string }> })
      .messages;
    assert(
      messages.length === 1 && messages[0].from_agent_path === '/root/outreach/draft_a',
      `inbox exposes the sender path: ${JSON.stringify(messages)}`
    );

    const toAgent = await sendTo(fx.userId, ids.aKid, '/root/research', 'Napa is booked.');
    assertStatus(toAgent.status, 201, toAgent.data);
    const agentRow = await prisma.message.findUniqueOrThrow({
      where: { id: (toAgent.data as { message_id: string }).message_id },
    });
    const agentMeta = agentRow.metadata as Record<string, unknown>;
    assert(
      agentRow.agentId === ids.research &&
        agentMeta.excludeFromModel === undefined &&
        agentMeta.fromAgentPath === '/root/outreach/draft_a/lookup',
      'agent row is model-visible and names the sender path'
    );

    const self = await sendTo(fx.userId, ids.draftA, '/root/outreach/draft_a', 'hi');
    assertStatus(self.status, 400, self.data);
    const nowhere = await sendTo(fx.userId, ids.draftA, '/root/nobody', 'hi');
    assertStatus(nowhere.status, 404, nowhere.data);

    // A finished task: stored as its next task (NEW_TASK) and its owner asked to wake it.
    // The fixture owner has no running workflow, so the sender learns it was not woken.
    const toFinished = await sendTo(fx.userId, ids.draftA, '/root/outreach/old', 'Redo for 2027.');
    assertStatus(toFinished.status, 201, toFinished.data);
    const finishedBody = toFinished.data as {
      message_id: string;
      task_running: boolean;
      woke: boolean;
      wake_error: string;
    };
    assert(
      finishedBody.task_running === false &&
        finishedBody.woke === false &&
        finishedBody.wake_error === 'its owner agent is not running',
      `finished task delivery ${JSON.stringify(finishedBody)}`
    );
    const finishedRow = await prisma.message.findUniqueOrThrow({
      where: { id: finishedBody.message_id },
    });
    const finishedMeta = finishedRow.metadata as Record<string, unknown>;
    assert(
      finishedMeta.recipientTaskId === 'bg_done' &&
        finishedMeta.messageType === 'NEW_TASK' &&
        finishedMeta.toAgentPath === '/root/outreach/old',
      `finished task row ${JSON.stringify(finishedMeta)}`
    );
  } finally {
    await deleteFixture(fx);
  }
});

test('GET /:id/tree — paths, path nodes and background tasks (running and finished) of listed agents', async () => {
  const fx = await withScanTask('addr-tree');
  const { ids } = fx;
  try {
    const view = await getView(fx.userId, ids.draftA);
    const byId = new Map(view.nodes.map((node) => [node.agent_id, node]));
    assert(byId.get(ids.outreach)?.path === '/root/outreach', 'agent nodes carry paths');
    const scan = byId.get('/root/outreach/scan') as
      (TreeNodeLike & { type: string; task_id: string }) | undefined;
    assert(
      scan !== undefined &&
        scan.type === 'explore' &&
        scan.parent_agent_id === ids.outreach &&
        scan.task_id === 'bg_call-7',
      `running task listed under its owner: ${JSON.stringify(scan)}`
    );
    assert(
      byId.get('/root/outreach/old')?.status === 'completed',
      'finished tasks stay listed as completed'
    );
    assert(
      same(
        view.caller_path.map((entry) => entry.path),
        ['/root', '/root/outreach', '/root/outreach/draft_a']
      ),
      'caller_path carries paths'
    );

    const byPath = await getView(fx.userId, ids.aKid, { node: '/root/outreach', depth: '2' });
    assert(byPath.node_path.at(-1)?.agent_id === ids.outreach, 'node accepts a path');
    assert(idsOf(byPath.nodes).includes(ids.aKid), 'path node expands');
    const taskNode = await getTree(fx.userId, ids.aKid, { node: '/root/outreach/scan' });
    assertStatus(taskNode.status, 400, taskNode.data);

    const prefix = await getView(fx.userId, ids.root, { path_prefix: '/root/outreach' });
    assert(
      same(idsOf(prefix.matches ?? []), [ids.outreach, ids.draftA, ids.draftB, ids.aKid]),
      `path_prefix lists that subtree only: ${JSON.stringify(idsOf(prefix.matches ?? []))}`
    );

    await prisma.agent.update({ where: { id: ids.outreach }, data: { status: 'COMPLETED' } });
    const ended = await getView(fx.userId, ids.draftA);
    assert(
      !idsOf(ended.nodes).includes('/root/outreach/scan') &&
        idsOf(ended.nodes).includes('/root/outreach/old'),
      'a terminal owner lists no stale running task, only its finished ones'
    );
  } finally {
    await deleteFixture(fx);
  }
});

interface TreeNodeLike {
  agent_id: string;
  parent_agent_id: string | null;
}

test('POST /api/agents — task_name sets the child path; a live sibling with the same name is 409', async () => {
  const session = await createAnonymousSession('addr-create');
  const userId = session.user.id;
  const rootId = await createTestAgent(userId, 'Path root', { start_phase: 'execute' });
  await prepareTestParentWorkflow(rootId);
  const child = (taskName: string, parentId: string) => ({
    agent_id: randomUUID(),
    goal: `Child ${taskName}`,
    model: 'rose-labs/rose-1-flash',
    parent_agent_id: parentId,
    parent_workflow_id: parentId,
    bus_id: rootId,
    depth: 1,
    start_phase: 'execute',
    task_name: taskName,
    response_schema: { fields: [{ name: 'v', type: 'str', required: true, description: 'x' }] },
  });
  const post = (body: unknown) =>
    request(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: apiKeyHeaders(userId),
      body: JSON.stringify(body),
    });
  try {
    const root = await prisma.agent.findUniqueOrThrow({ where: { id: rootId } });
    assert(root.taskPath === '/root', `root path, got ${root.taskPath}`);

    const first = child('venues', rootId);
    const created = await post(first);
    assertStatus(created.status, 201, created.data);
    assert((created.data as { task_path: string }).task_path === '/root/venues', 'child path');
    const retry = await post(first);
    assert(retry.status === 200 || retry.status === 201, `idempotent retry, got ${retry.status}`);

    const clash = await post(child('venues', rootId));
    assertStatus(clash.status, 409, clash.data);
    assert(
      String((clash.data as { error: string }).error).includes('/root/venues'),
      'collision names the taken path'
    );

    const batchClash = await request(`${BASE_URL}/api/agents/batch`, {
      method: 'POST',
      headers: apiKeyHeaders(userId),
      body: JSON.stringify({ agents: [child('venues', rootId)] }),
    });
    assertStatus(batchClash.status, 409, batchClash.data);

    await prisma.agent.update({ where: { id: first.agent_id }, data: { deletedAt: new Date() } });
    const reuse = await post(child('venues', rootId));
    assertStatus(reuse.status, 201, reuse.data);

    const bad = await post({ ...child('Bad Name', rootId) });
    assertStatus(bad.status, 400, bad.data);
  } finally {
    await deleteTestAgent(rootId, userId);
  }
});
