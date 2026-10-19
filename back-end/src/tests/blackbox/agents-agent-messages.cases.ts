/**
 * Agent-to-agent messaging contracts: POST /:id/agent-messages,
 * GET /:id/tree, GET /:id/agent-inbox.
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
  deleteTestAgent,
  prisma,
  randomUUID,
  request,
  sleep,
  test,
} from './agents-blackbox-harness';
import {
  createTree,
  createWorkflowAgent,
  deleteTree,
  sendAgentMessage,
} from './agents-agent-messages.fixtures';

async function signalsFor(workflowId: string): Promise<Array<{ name: string; args: unknown[] }>> {
  const res = await request(`${BASE_URL}/api/test/temporal-signals/${workflowId}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { signals: Array<{ name: string; args: unknown[] }> }).signals;
}

test('POST /:id/agent-messages — same-tree message is stored on the target and signals receive_agent_message', async () => {
  const tree = await createTree('a2a-deliver');
  try {
    const text = 'The user says: skip Napa, focus on Sonoma venues.';
    const key = `deliver-${randomUUID()}`;
    const res = await sendAgentMessage(tree.userId, tree.grandchildId, {
      from_agent_id: tree.rootId,
      message: text,
      idempotency_key: key,
    });
    assertStatus(res.status, 201, res.data);
    const body = res.data as { message_id: string; delivered: boolean };
    assert(body.delivered === true, `a running target must be signaled, got ${body.delivered}`);

    const row = await prisma.message.findUniqueOrThrow({ where: { id: body.message_id } });
    const metadata = row.metadata as Record<string, unknown>;
    // "Task name" of the Codex body: the recipient's own task path.
    const recipient = await prisma.agent.findUniqueOrThrow({ where: { id: tree.grandchildId } });
    const recipientPath = recipient.taskPath ?? null;
    assert(row.agentId === tree.grandchildId, 'row must land on the target agent');
    assert(row.role === 'USER' && row.text === text, 'row must be a USER row with the raw text');
    assert(
      metadata.agentMessage === true &&
        metadata.fromAgentId === tree.rootId &&
        typeof metadata.fromGoal === 'string' &&
        metadata.fromGoal.startsWith('Plan a team offsite') &&
        metadata.idempotencyKey === key &&
        metadata.messageType === 'MESSAGE' &&
        metadata.toAgentPath === recipientPath &&
        metadata.fromAgentPath === '/root' &&
        metadata.excludeFromModel === undefined &&
        metadata.recipientTaskId === undefined,
      `unexpected metadata ${JSON.stringify(metadata)}`
    );

    const signals = await signalsFor(tree.grandchildId);
    const agentSignals = signals.filter((s) => s.name === 'receive_agent_message');
    assert(
      agentSignals.length === 1 &&
        JSON.stringify(agentSignals[0].args) ===
          JSON.stringify([
            { message_id: body.message_id, from_agent_id: tree.rootId, from_agent_path: '/root' },
          ]),
      `expected one receive_agent_message {message_id, from_agent_id, from_agent_path}, got ${JSON.stringify(signals)}`
    );
    assert(
      !signals.some((s) => s.name === 'receive_user_response' || s.name === 'resume'),
      `agent messages must not use user-response or resume signals, got ${JSON.stringify(signals)}`
    );
    const senderSignals = await signalsFor(tree.rootId);
    assert(senderSignals.length === 0, 'the sender workflow must not be signaled');
  } finally {
    await deleteTree(tree);
  }
});

test('POST /:id/agent-messages — a message to a PAUSED target does not lift the pause', async () => {
  const tree = await createTree('a2a-paused');
  try {
    await prisma.agent.update({ where: { id: tree.childId }, data: { status: 'PAUSED' } });
    const res = await sendAgentMessage(tree.userId, tree.childId, {
      from_agent_id: tree.grandchildId,
      message: 'Napa replied: available in May.',
      idempotency_key: `paused-${randomUUID()}`,
    });
    assertStatus(res.status, 201, res.data);
    await sleep(200);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: tree.childId } });
    assert(stored.status === 'PAUSED', `agent messages must not resume, got ${stored.status}`);
  } finally {
    await deleteTree(tree);
  }
});

test('POST /:id/agent-messages — cross-tree and cross-user senders are rejected with 403', async () => {
  const tree = await createTree('a2a-cross-tree');
  const otherRootId = await createWorkflowAgent(tree.userId, 'Unrelated: renew passport');
  const stranger = await createAnonymousSession('a2a-stranger');
  const strangerRootId = await createWorkflowAgent(stranger.user.id, 'Stranger agent');
  try {
    const before = await prisma.message.count({ where: { agentId: tree.childId } });
    const crossTree = await sendAgentMessage(tree.userId, tree.childId, {
      from_agent_id: otherRootId,
      message: 'hello from another tree',
      idempotency_key: `cross-${randomUUID()}`,
    });
    assertStatus(crossTree.status, 403, crossTree.data);

    const crossUser = await sendAgentMessage(stranger.user.id, tree.childId, {
      from_agent_id: strangerRootId,
      message: 'hello from another user',
      idempotency_key: `stranger-${randomUUID()}`,
    });
    assert(
      crossUser.status === 404 || crossUser.status === 403,
      `another user's agent must not be addressable, got ${crossUser.status}`
    );
    const unknownSender = await sendAgentMessage(tree.userId, tree.childId, {
      from_agent_id: randomUUID(),
      message: 'hello from nowhere',
      idempotency_key: `unknown-${randomUUID()}`,
    });
    assertStatus(unknownSender.status, 403, unknownSender.data);

    const blank = await sendAgentMessage(tree.userId, tree.childId, {
      from_agent_id: tree.rootId,
      message: '   ',
      idempotency_key: `blank-${randomUUID()}`,
    });
    assertStatus(blank.status, 400, blank.data);

    const after = await prisma.message.count({ where: { agentId: tree.childId } });
    assert(after === before, `rejected sends must not write rows (${before} → ${after})`);
    const signals = await signalsFor(tree.childId);
    assert(signals.length === 0, `rejected sends must not signal, got ${JSON.stringify(signals)}`);
  } finally {
    await deleteTestAgent(otherRootId, tree.userId);
    await deleteTestAgent(strangerRootId, stranger.user.id);
    await deleteTree(tree);
  }
});

test('POST /:id/agent-messages — the same idempotency key returns the existing row', async () => {
  const tree = await createTree('a2a-idempotent');
  try {
    const payload = {
      from_agent_id: tree.childId,
      message: 'Outreach status: 3 venues contacted.',
      idempotency_key: `retry-${randomUUID()}`,
    };
    const first = await sendAgentMessage(tree.userId, tree.rootId, payload);
    const second = await sendAgentMessage(tree.userId, tree.rootId, payload);
    assertStatus(first.status, 201, first.data);
    assertStatus(second.status, 201, second.data);
    const firstId = (first.data as { message_id: string }).message_id;
    const secondId = (second.data as { message_id: string }).message_id;
    assert(firstId === secondId, `retry must return the same row (${firstId} vs ${secondId})`);
    const rows = await prisma.message.count({
      where: {
        agentId: tree.rootId,
        metadata: { path: ['idempotencyKey'], equals: payload.idempotency_key },
      },
    });
    assert(rows === 1, `one row per idempotency key, got ${rows}`);
  } finally {
    await deleteTree(tree);
  }
});

test('POST /:id/agent-messages — recipient_task_id rows are excluded from the model and not signaled', async () => {
  const tree = await createTree('a2a-task');
  try {
    const res = await sendAgentMessage(tree.userId, tree.childId, {
      from_agent_id: tree.rootId,
      message: 'Explore: also check venue parking.',
      idempotency_key: `task-${randomUUID()}`,
      recipient_task_id: 'explore-call-1',
    });
    assertStatus(res.status, 201, res.data);
    const body = res.data as { message_id: string; delivered: boolean };
    assert(body.delivered === false, 'task-addressed rows are polled, not signaled');
    const row = await prisma.message.findUniqueOrThrow({ where: { id: body.message_id } });
    const metadata = row.metadata as Record<string, unknown>;
    assert(
      row.agentId === tree.childId &&
        metadata.recipientTaskId === 'explore-call-1' &&
        metadata.excludeFromModel === true,
      `unexpected task row ${JSON.stringify(metadata)}`
    );
    const signals = await signalsFor(tree.childId);
    assert(signals.length === 0, `task-addressed rows must not signal: ${JSON.stringify(signals)}`);
  } finally {
    await deleteTree(tree);
  }
});

test('GET /:id/tree — any member sees its tree (node view), never another tree', async () => {
  const tree = await createTree('a2a-tree');
  const otherRootId = await createWorkflowAgent(tree.userId, 'Unrelated tree root');
  try {
    const res = await request(
      `${BASE_URL}/api/agents/${tree.grandchildId}/tree?node=${tree.rootId}&depth=2`,
      { headers: apiKeyHeaders(tree.userId) }
    );
    assertStatus(res.status, 200, res.data);
    const body = res.data as {
      root_agent_id: string;
      nodes: Array<{ agent_id: string; parent_agent_id: string | null; depth: number }>;
    };
    assert(body.root_agent_id === tree.rootId, `root must be ${tree.rootId}`);
    const ids = body.nodes.map((n) => n.agent_id);
    for (const id of [tree.rootId, tree.childId, tree.grandchildId]) {
      assert(ids.includes(id), `tree view must list ${id}, got ${JSON.stringify(ids)}`);
    }
    const grandchild = body.nodes.find((n) => n.agent_id === tree.grandchildId);
    assert(
      grandchild?.parent_agent_id === tree.childId && grandchild.depth === 2,
      'grandchild must carry its parent and depth'
    );
    assert(!ids.includes(otherRootId), 'another tree must not leak into the listing');

    const stranger = await createAnonymousSession('a2a-tree-stranger');
    const denied = await request(`${BASE_URL}/api/agents/${tree.rootId}/tree`, {
      headers: apiKeyHeaders(stranger.user.id),
    });
    assertStatus(denied.status, 404, denied.data);
  } finally {
    await deleteTestAgent(otherRootId, tree.userId);
    await deleteTree(tree);
  }
});

test('GET /:id/agent-inbox — returns only the task rows after since', async () => {
  const tree = await createTree('a2a-inbox');
  try {
    const send = (taskId: string | undefined, message: string, from = tree.grandchildId) =>
      sendAgentMessage(tree.userId, tree.childId, {
        from_agent_id: from,
        message,
        idempotency_key: `inbox-${randomUUID()}`,
        ...(taskId !== undefined ? { recipient_task_id: taskId } : {}),
      });
    const first = await send('browser-call-7', 'first for browser');
    assertStatus(first.status, 201, first.data);
    await send('browser-call-8', 'for another task');
    // A different sender: one sender's burst is 3 messages (Prime guard).
    await send(undefined, 'for the agent itself', tree.rootId);
    await sleep(20);
    const second = await send('browser-call-7', 'second for browser');
    assertStatus(second.status, 201, second.data);

    const inboxUrl = `${BASE_URL}/api/agents/${tree.childId}/agent-inbox?task_id=browser-call-7`;
    const all = await request(inboxUrl, { headers: apiKeyHeaders(tree.userId) });
    assertStatus(all.status, 200, all.data);
    const messages = (
      all.data as {
        messages: Array<{ id: string; text: string; from_agent_id: string; created_at: string }>;
      }
    ).messages;
    assert(
      JSON.stringify(messages.map((m) => m.text)) ===
        JSON.stringify(['first for browser', 'second for browser']),
      `inbox must hold only this task's rows, oldest first: ${JSON.stringify(messages)}`
    );
    assert(messages[0].from_agent_id === tree.grandchildId, 'inbox rows name their sender');
    const typed = messages[0] as unknown as Record<string, unknown>;
    assert(
      typed.message_type === 'MESSAGE' && 'to_agent_path' in typed,
      `inbox rows carry the Codex message type and recipient path: ${JSON.stringify(typed)}`
    );

    const since = encodeURIComponent(messages[0].created_at);
    const later = await request(`${inboxUrl}&since=${since}`, {
      headers: apiKeyHeaders(tree.userId),
    });
    assertStatus(later.status, 200, later.data);
    const laterTexts = (later.data as { messages: Array<{ text: string }> }).messages.map(
      (m) => m.text
    );
    assert(
      JSON.stringify(laterTexts) === JSON.stringify(['second for browser']),
      `since must exclude rows at or before the cursor: ${JSON.stringify(laterTexts)}`
    );

    const missingTask = await request(`${BASE_URL}/api/agents/${tree.childId}/agent-inbox`, {
      headers: apiKeyHeaders(tree.userId),
    });
    assertStatus(missingTask.status, 400, missingTask.data);
  } finally {
    await deleteTree(tree);
  }
});

async function postWorkflowUserRow(agentId: string, message: string, metadata: object) {
  return request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Agent-Workflow-Generation': agentId },
    body: JSON.stringify({ message, role: 'USER', metadata }),
  });
}

test('POST /:id/messages — workflow-posted agentNotification is idempotent and never echoed as receive_user_response', async () => {
  const session = await createAnonymousSession('a2a-notification-echo');
  const agentId = await createWorkflowAgent(session.user.id, 'Plan a trip to Tokyo');
  try {
    const key = `${agentId}:toolu_${randomUUID().slice(0, 8)}:notification`;
    const text =
      'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/tokyo\nPayload:\ndone';
    const metadata = {
      agentNotification: true,
      toolName: 'agent_notification',
      idempotencyKey: key,
    };
    const first = await postWorkflowUserRow(agentId, text, metadata);
    const retry = await postWorkflowUserRow(agentId, text, metadata);
    assertStatus(first.status, 201, first.data);
    assertStatus(retry.status, 201, retry.data);
    const firstId = (first.data as { message_id: string }).message_id;
    assert(
      (retry.data as { message_id: string }).message_id === firstId,
      'a retried notification post must land on the same row'
    );
    const rows = await prisma.message.findMany({ where: { agentId, text } });
    assert(rows.length === 1, `expected one notification row, got ${rows.length}`);

    // Control: an ordinary workflow-authored USER row on the same agent is still
    // signaled, so the absence above is the metadata flag, not a dead fake.
    const control = await postWorkflowUserRow(agentId, 'OTP relay: 181818', {});
    assertStatus(control.status, 201, control.data);
    const signals = await signalsFor(agentId);
    const userResponses = signals.filter((s) => s.name === 'receive_user_response');
    assert(
      userResponses.length === 1 &&
        JSON.stringify(userResponses[0].args) === JSON.stringify(['OTP relay: 181818']),
      `only the control row may signal receive_user_response, got ${JSON.stringify(signals)}`
    );
  } finally {
    await deleteTestAgent(agentId, session.user.id);
  }
});

async function postWorkflowToolRow(agentId: string, message: string, metadata: object) {
  return request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Agent-Workflow-Generation': agentId },
    body: JSON.stringify({ message, role: 'TOOL', metadata }),
  });
}

test("POST /:id/messages — rows under a background spawn's tool-call id are stamped excludeFromModel", async () => {
  const session = await createAnonymousSession('a2a-background-rows');
  const agentId = await createWorkflowAgent(session.user.id, 'Plan a trip to Tokyo');
  try {
    const toolCallId = `toolu_${randomUUID().slice(0, 8)}`;
    // Control: an ordinary call's rows are untouched.
    const plainId = `toolu_${randomUUID().slice(0, 8)}`;
    const plain = await postWorkflowToolRow(agentId, 'searching', {
      toolCallId: plainId,
      toolName: 'web_search',
      toolStatus: 'IN_PROGRESS',
    });
    assertStatus(plain.status, 201, plain.data);
    const started = await postWorkflowToolRow(
      agentId,
      'Started explore agent in background. Address: /root/tokyo.',
      {
        toolCallId,
        toolName: 'spawn_agent',
        toolStatus: 'FINISHED',
        runInBackground: true,
        hidden: true,
      }
    );
    assertStatus(started.status, 201, started.data);
    // The executor's rows (an activity writes these directly) under the SAME id.
    for (const [status, text] of [
      ['IN_PROGRESS', 'Exploring'],
      ['FINISHED', 'Tokyo has 14,303,513 residents.'],
    ]) {
      const res = await postWorkflowToolRow(agentId, text, {
        toolCallId,
        toolName: 'spawn_agent',
        toolStatus: status,
        agentType: 'explore',
      });
      assertStatus(res.status, 201, res.data);
    }
    const rows = await prisma.message.findMany({
      where: { agentId, role: 'TOOL', metadata: { path: ['toolCallId'], equals: toolCallId } },
      orderBy: { createdAt: 'asc' },
    });
    const metas = rows.map((row) => row.metadata as Record<string, unknown>);
    assert(rows.length === 3, `expected started + 2 executor rows, got ${rows.length}`);
    assert(
      metas[0].runInBackground === true && metas[0].excludeFromModel === undefined,
      `the started row stays the model's result: ${JSON.stringify(metas[0])}`
    );
    assert(
      metas
        .slice(1)
        .every((meta) => meta.excludeFromModel === true && meta.agentType === 'explore'),
      `executor rows must be FE-only: ${JSON.stringify(metas)}`
    );
    const plainRow = await prisma.message.findFirstOrThrow({
      where: { agentId, metadata: { path: ['toolCallId'], equals: plainId } },
    });
    assert(
      (plainRow.metadata as Record<string, unknown>).excludeFromModel === undefined,
      'rows of ordinary tool calls are never stamped'
    );
  } finally {
    await deleteTestAgent(agentId, session.user.id);
  }
});

test('POST /:id/messages — workflow-posted environmentContext row is idempotent and never echoed', async () => {
  const session = await createAnonymousSession('a2a-environment-echo');
  const agentId = await createWorkflowAgent(session.user.id, 'Coordinate venue outreach');
  try {
    const text =
      '<environment>\nCurrent date: 2026-10-19 (UTC)\nYou are /root, the root agent.\n</environment>';
    const metadata = {
      environmentContext: true,
      hidden: true,
      idempotencyKey: `environment:${randomUUID()}`,
    };
    const first = await postWorkflowUserRow(agentId, text, metadata);
    const retry = await postWorkflowUserRow(agentId, text, metadata);
    assertStatus(first.status, 201, first.data);
    assertStatus(retry.status, 201, retry.data);
    assert(
      (retry.data as { message_id: string }).message_id ===
        (first.data as { message_id: string }).message_id,
      'a retried environment post must land on the same row'
    );
    const rows = await prisma.message.findMany({ where: { agentId, text } });
    assert(rows.length === 1, `expected one environment row, got ${rows.length}`);
    const signals = await signalsFor(agentId);
    assert(
      !signals.some((s) => s.name === 'receive_user_response'),
      `environmentContext rows must not signal receive_user_response, got ${JSON.stringify(signals)}`
    );
  } finally {
    await deleteTestAgent(agentId, session.user.id);
  }
});

test('POST /:id/messages — workflow-posted agentMessage row is not echoed as receive_user_response', async () => {
  const session = await createAnonymousSession('a2a-message-echo');
  const agentId = await createWorkflowAgent(session.user.id, 'Coordinate venue outreach');
  try {
    const res = await postWorkflowUserRow(agentId, 'Napa replied: available in May.', {
      agentMessage: true,
      idempotencyKey: `echo-${randomUUID()}`,
    });
    assertStatus(res.status, 201, res.data);
    const signals = await signalsFor(agentId);
    assert(
      !signals.some((s) => s.name === 'receive_user_response'),
      `agentMessage rows must not signal receive_user_response, got ${JSON.stringify(signals)}`
    );
  } finally {
    await deleteTestAgent(agentId, session.user.id);
  }
});
