/**
 * Agent-to-agent message guard (Prime agent_messaging.rs) and the explore
 * progress post's piggybacked inbox read (POST /:id/messages {inbox}).
 */
import {
  BASE_URL,
  apiKeyHeaders,
  assert,
  assertStatus,
  prisma,
  randomUUID,
  request,
  sleep,
  test,
} from './agents-blackbox-harness';
import { createTree, deleteTree, sendAgentMessage } from './agents-agent-messages.fixtures';

test('POST /:id/messages {inbox} — explore progress post returns its task inbox (pending_inbox)', async () => {
  const tree = await createTree('a2a-inbox-piggyback');
  try {
    const send = (sender: string, taskId: string | undefined, message: string) =>
      sendAgentMessage(tree.userId, tree.childId, {
        from_agent_id: sender,
        message,
        idempotency_key: `piggyback-${randomUUID()}`,
        ...(taskId !== undefined ? { recipient_task_id: taskId } : {}),
      });
    assertStatus(
      (await send(tree.grandchildId, 'explore-call-1', 'first for explore')).status,
      201
    );
    assertStatus((await send(tree.rootId, 'explore-call-2', 'for a sibling task')).status, 201);
    assertStatus((await send(tree.rootId, undefined, 'for the agent itself')).status, 201);

    const progress = (inbox?: Record<string, unknown>, headers = apiKeyHeaders()) =>
      request(`${BASE_URL}/api/agents/${tree.childId}/messages`, {
        method: 'POST',
        headers: { ...headers, 'X-Agent-Workflow-Generation': tree.childId },
        body: JSON.stringify({
          message: 'Searching venues',
          role: 'TOOL',
          metadata: {
            toolCallId: `explore-tool-${randomUUID()}`,
            toolName: 'web_search',
            taskId: 'task-1',
          },
          ...(inbox !== undefined ? { inbox } : {}),
        }),
      });
    const first = await progress({ task_id: 'explore-call-1' });
    assertStatus(first.status, 201, first.data);
    const pending = (
      first.data as {
        pending_inbox: Array<{
          id: string;
          text: string;
          created_at: string;
          from_agent_id: string;
        }>;
      }
    ).pending_inbox;
    assert(
      JSON.stringify(pending.map((m) => m.text)) === JSON.stringify(['first for explore']),
      `pending_inbox must hold only this task's rows: ${JSON.stringify(first.data)}`
    );
    assert(pending[0].from_agent_id === tree.grandchildId, 'pending_inbox rows name their sender');

    const later = await progress({ task_id: 'explore-call-1', since: pending[0].created_at });
    assertStatus(later.status, 201, later.data);
    assert(
      (later.data as { pending_inbox: unknown[] }).pending_inbox.length === 0,
      `since must exclude rows at or before the cursor: ${JSON.stringify(later.data)}`
    );

    const plain = await progress();
    assertStatus(plain.status, 201, plain.data);
    assert(
      !('pending_inbox' in (plain.data as object)),
      'posts without inbox return no pending_inbox'
    );

    const bad = await progress({ task_id: '' });
    assertStatus(bad.status, 400, bad.data);
  } finally {
    await deleteTree(tree);
  }
});

async function seedUnreadAgentMessages(
  agentId: string,
  senderId: string,
  count: number,
  taskId?: string
) {
  const base = Date.now() - 60_000;
  await prisma.message.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      agentId,
      role: 'USER' as const,
      text: `queued ${i}`,
      timestamp: new Date(base + i),
      metadata: {
        agentMessage: true,
        fromAgentId: senderId,
        idempotencyKey: `seed-${randomUUID()}`,
        ...(taskId !== undefined ? { recipientTaskId: taskId, excludeFromModel: true } : {}),
      },
    })),
  });
}

test('POST /:id/send-agent-message — per-sender burst of 3 then 1/s; retries are free (Prime guard)', async () => {
  const tree = await createTree('a2a-rate');
  try {
    const sendTo = (key: string) =>
      request(`${BASE_URL}/api/agents/${tree.grandchildId}/send-agent-message`, {
        method: 'POST',
        headers: apiKeyHeaders(tree.userId),
        body: JSON.stringify({ to: 'parent', message: `update ${key}`, idempotency_key: key }),
      });
    const keys = [1, 2, 3].map(() => `rate-${randomUUID()}`);
    const sent = [];
    for (const key of keys) {
      const res = await sendTo(key);
      assertStatus(res.status, 201, res.data);
      sent.push((res.data as { message_id: string }).message_id);
    }
    const limited = await sendTo(`rate-${randomUUID()}`);
    assertStatus(limited.status, 429, limited.data);
    assert(
      (limited.data as { error: string }).error ===
        'Message rate limit: wait a moment before messaging parent again.',
      `actionable rate-limit error: ${JSON.stringify(limited.data)}`
    );
    // An idempotent retry of an already-delivered message never spends budget.
    const retry = await sendTo(keys[0]);
    assertStatus(retry.status, 201, retry.data);
    assert(
      (retry.data as { message_id: string }).message_id === sent[0],
      'retry lands on the same row'
    );
    const rows = await prisma.message.count({
      where: { agentId: tree.childId, metadata: { path: ['agentMessage'], equals: true } },
    });
    assert(rows === 3, `refused sends store nothing (got ${rows} rows)`);
    await sleep(1_100);
    assertStatus((await sendTo(`rate-${randomUUID()}`)).status, 201);
  } finally {
    await deleteTree(tree);
  }
});

test('POST /:id/agent-messages — at most 20 unread per recipient; its own read consumes them', async () => {
  const tree = await createTree('a2a-unread');
  try {
    const send = (sender: string, taskId?: string) =>
      sendAgentMessage(tree.userId, tree.childId, {
        from_agent_id: sender,
        message: 'one more thing',
        idempotency_key: `unread-${randomUUID()}`,
        ...(taskId !== undefined ? { recipient_task_id: taskId } : {}),
      });
    await seedUnreadAgentMessages(tree.childId, tree.rootId, 20);
    const full = await send(tree.grandchildId);
    assertStatus(full.status, 429, full.data);
    const expected = `${(await prisma.agent.findUniqueOrThrow({ where: { id: tree.childId } })).taskPath ?? tree.childId}`;
    assert(
      (full.data as { error: string }).error ===
        `${expected} has 20 unread messages; wait for it to catch up before messaging it again.`,
      `actionable unread-cap error: ${JSON.stringify(full.data)}`
    );
    // The recipient's workflow poll (internal incremental read) delivers them.
    const poll = await request(
      `${BASE_URL}/api/agents/${tree.childId}?since=${encodeURIComponent(new Date(0).toISOString())}`,
      { headers: apiKeyHeaders() }
    );
    assertStatus(poll.status, 200, poll.data);
    assertStatus((await send(tree.grandchildId)).status, 201);

    // Task inbox: rows addressed to a task count separately and its inbox read consumes them.
    await seedUnreadAgentMessages(tree.childId, tree.rootId, 20, 'browser-call-9');
    const taskFull = await send(tree.rootId, 'browser-call-9');
    assertStatus(taskFull.status, 429, taskFull.data);
    assertStatus((await send(tree.rootId, 'browser-call-10')).status, 201);
    const inbox = await request(
      `${BASE_URL}/api/agents/${tree.childId}/agent-inbox?task_id=browser-call-9`,
      { headers: apiKeyHeaders(tree.userId) }
    );
    assertStatus(inbox.status, 200, inbox.data);
    await sleep(1_100); // rootId's bucket: 2 sends above
    assertStatus((await send(tree.rootId, 'browser-call-9')).status, 201);
  } finally {
    await deleteTree(tree);
  }
});
