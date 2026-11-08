/**
 * A code session's ws-server accepted an agent turn (`queued`: the code agent
 * was starting, or the user held it in direct chat) and never wrote it to the
 * CLI. The agents monitor reports the lost turn ids
 * (POST /:owner/code-turns-undelivered); whoever sent the message gets one
 * truthful notice (a Rose agent in its inbox, a code agent as its CLI's next
 * turn), keyed on the owner's received row, never a silent loss.
 */
import { randomUUID } from 'crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  apiKeyHeaders,
  assert,
  assertStatus,
  BASE_URL,
  prisma,
  request,
  test,
} from './agents-blackbox-harness';
import { createTree, deleteTree, sendAgentMessage } from './agents-agent-messages.fixtures';

/** A ws-server answering each new agent turn with `ack` (a repeated turn id: `duplicate`, like ws-server.mjs). */
async function startSession(
  ack: Record<string, string>
): Promise<{ url: string; turns: string[]; close: () => Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const turns: string[] = [];
  const seen = new Set<string>();
  server.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, string>;
      if (msg.type !== 'user_turn') return;
      if (seen.has(msg.id)) {
        socket.send(JSON.stringify({ type: 'user_turn_ack', id: msg.id, status: 'duplicate' }));
        return;
      }
      seen.add(msg.id);
      turns.push(msg.text);
      socket.send(JSON.stringify({ type: 'user_turn_ack', id: msg.id, ...ack }));
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    turns,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function reportLost(
  ownerId: string,
  userId: string,
  sessionId: string,
  turnIds: unknown[],
  reason: string
) {
  return request(`${BASE_URL}/api/agents/${ownerId}/code-turns-undelivered`, {
    method: 'POST',
    headers: apiKeyHeaders(userId),
    body: JSON.stringify({ session_id: sessionId, turn_ids: turnIds, reason }),
  });
}

/** The owner's received row of the message whose original text is `text`. */
async function receivedRow(ownerId: string, text: string) {
  const row = await prisma.message.findFirst({
    where: {
      agentId: ownerId,
      AND: [
        { metadata: { path: ['action_type'], equals: 'agent_message' } },
        { metadata: { path: ['a2a', 'text'], equals: text } },
      ],
    },
    select: { id: true, metadata: true },
  });
  const turnId = (row?.metadata as { code_turn_id?: string } | null)?.code_turn_id;
  assert(
    row !== null && typeof turnId === 'string',
    `the received row records its turn id: ${text}`
  );
  return { id: row.id, turnId };
}

test('POST /:id/code-turns-undelivered — the Rose agent that sent a held turn the session lost is told once, truthfully', async () => {
  const tree = await createTree('a2a-code-undelivered');
  const session = await startSession({ status: 'queued', reason: 'direct_hold' });
  const taskId = `toolu_code_${randomUUID().slice(0, 8)}`;
  const sessionId = randomUUID();
  try {
    await prisma.agent.update({
      where: { id: tree.childId },
      data: {
        backgroundTasks: [
          {
            address: taskId,
            type: 'code',
            goal: 'Add a README badge.',
            status: 'running',
            task_name: 'coder',
            path: null,
          },
        ],
      },
    });
    await prisma.claudeCodeSession.create({
      data: {
        id: sessionId,
        agentId: tree.childId,
        sandboxId: `sb-${sessionId}`,
        goal: 'Add a README badge.',
        status: 'ACTIVE',
        streamUrl: session.url,
        codeProvider: 'claude',
      },
    });
    await prisma.message.create({
      data: {
        agentId: tree.childId,
        role: 'TOOL',
        text: '',
        metadata: {
          toolCallId: taskId,
          toolName: 'spawn_claude_code_agent',
          toolStatus: 'IN_PROGRESS',
          title: 'Claude Code session started',
          task_id: sessionId,
          code_provider: 'claude',
          action_type: 'session_started',
        },
      },
    });
    for (const text of ['Also update CHANGELOG.md.', 'Second note.']) {
      const sent = await sendAgentMessage(tree.userId, tree.childId, {
        from_agent_id: tree.rootId,
        message: text,
        idempotency_key: `held-${randomUUID()}`,
        recipient_task_id: taskId,
      });
      assertStatus(sent.status, 201, sent.data);
      const body = sent.data as { queued?: boolean; queued_reason?: string };
      assert(
        body.queued === true && body.queued_reason === 'direct_hold',
        `a held turn is accepted with its reason: ${JSON.stringify(body)}`
      );
    }
    const first = await receivedRow(tree.childId, 'Also update CHANGELOG.md.');
    const ended = await reportLost(
      tree.childId,
      tree.userId,
      sessionId,
      [first.turnId, 'a2a-unknown-turn'],
      'session_ended'
    );
    assertStatus(ended.status, 200, ended.data);
    assert((ended.data as { notified: number }).notified === 1, JSON.stringify(ended.data));
    const notices = await prisma.message.findMany({
      where: { agentId: tree.rootId, role: 'USER', text: { contains: 'was not delivered' } },
      select: { text: true, metadata: true },
    });
    assert(notices.length === 1, `one notice for the sender: ${notices.length}`);
    assert(notices[0].text.includes('Also update CHANGELOG.md.'), 'the notice quotes the message');
    assert(notices[0].text.includes('session ended before it read it'), 'session_ended says so');
    // Keyed on the owner's received row (server-side, target-scoped), not the sender's key.
    assert(
      (notices[0].metadata as { idempotencyKey?: string }).idempotencyKey ===
        `${first.id}:undelivered`,
      JSON.stringify(notices[0].metadata)
    );
    const again = await reportLost(
      tree.childId,
      tree.userId,
      sessionId,
      [first.turnId],
      'session_ended'
    );
    assertStatus(again.status, 200, again.data);
    assert(
      (again.data as { notified: number }).notified === 0,
      'a repeated report notifies nothing new'
    );

    // A write failure that is not the end of the session is reported as what it was.
    const second = await receivedRow(tree.childId, 'Second note.');
    const failed = await reportLost(
      tree.childId,
      tree.userId,
      sessionId,
      [second.turnId],
      'settings_unconfirmed'
    );
    assertStatus(failed.status, 200, failed.data);
    const notice = await prisma.message.findFirst({
      where: { agentId: tree.rootId, role: 'USER', text: { contains: 'Second note.' } },
      select: { text: true },
    });
    assert(
      notice?.text.includes('could not be written to the code agent (settings_unconfirmed)') ===
        true && !notice.text.includes('session ended'),
      `a write failure is not called a session end: ${notice?.text}`
    );
  } finally {
    await session.close();
    await prisma.claudeCodeSession.deleteMany({ where: { agentId: tree.childId } });
    await deleteTree(tree);
  }
});

test('POST /:id/code-turns-undelivered — a code agent that sent the lost message gets the notice as its next turn', async () => {
  const tree = await createTree('a2a-code-undelivered-code-sender');
  const sender = await startSession({ status: 'delivered' });
  const senderSessionId = randomUUID();
  const lostSessionId = randomUUID();
  try {
    // The sending code agent (owned by the root) still runs; the lost turn's session ended.
    await prisma.claudeCodeSession.create({
      data: {
        id: senderSessionId,
        agentId: tree.rootId,
        sandboxId: `sb-${senderSessionId}`,
        goal: 'Coordinate.',
        status: 'ACTIVE',
        streamUrl: sender.url,
        codeProvider: 'claude',
      },
    });
    const turnId = `a2a-${randomUUID().replace(/-/g, '')}`;
    // The received row a code agent's graph send leaves on the owner (recordCodeTimelineRow).
    await prisma.message.create({
      data: {
        agentId: tree.childId,
        role: 'TOOL',
        text: 'Please also run the linter.',
        metadata: {
          a2a: {
            kind: 'message',
            message_id: `graph:${senderSessionId}:k1`,
            from: { id: senderSessionId, kind: 'code', label: 'Claude Code' },
            to: { id: lostSessionId, kind: 'code', label: 'Codex' },
            text: 'Please also run the linter.',
            direction: 'received',
          },
          action_type: 'agent_message',
          task_id: lostSessionId,
          code_turn_id: turnId,
        },
      },
    });
    const res = await reportLost(
      tree.childId,
      tree.userId,
      lostSessionId,
      [turnId],
      'session_ended'
    );
    assertStatus(res.status, 200, res.data);
    assert((res.data as { notified: number }).notified === 1, JSON.stringify(res.data));
    assert(
      sender.turns.length === 1 &&
        sender.turns[0].includes('was not delivered') &&
        sender.turns[0].includes('run the linter'),
      `the sending code agent's CLI gets the notice: ${JSON.stringify(sender.turns)}`
    );
    const repeat = await reportLost(
      tree.childId,
      tree.userId,
      lostSessionId,
      [turnId],
      'session_ended'
    );
    assert((repeat.data as { notified: number }).notified === 0, 'a repeat is a duplicate turn');

    // The notice itself is recorded on the sender's owner with a turn id. If the
    // sender's session loses it too, that is not a lost message: no notice bounces back.
    const noticeRow = await prisma.message.findFirst({
      where: {
        agentId: tree.rootId,
        AND: [
          { metadata: { path: ['action_type'], equals: 'agent_message' } },
          { metadata: { path: ['a2a', 'kind'], equals: 'notification' } },
        ],
      },
      select: { metadata: true },
    });
    const noticeTurn = (noticeRow?.metadata as { code_turn_id?: string } | null)?.code_turn_id;
    assert(typeof noticeTurn === 'string', 'the delivered notice carries its turn id');
    const usersBefore = await prisma.message.count({
      where: { agentId: { in: [tree.rootId, tree.childId] }, role: 'USER' },
    });
    const bounce = await reportLost(
      tree.rootId,
      tree.userId,
      senderSessionId,
      [noticeTurn],
      'session_ended'
    );
    assertStatus(bounce.status, 200, bounce.data);
    assert((bounce.data as { notified: number }).notified === 0, 'a lost notice notifies no one');
    assert(sender.turns.length === 1, 'no further turn reaches the sender');
    const usersAfter = await prisma.message.count({
      where: { agentId: { in: [tree.rootId, tree.childId] }, role: 'USER' },
    });
    assert(usersAfter === usersBefore, 'no inbox notice is written for a lost notice');
  } finally {
    await sender.close();
    await prisma.claudeCodeSession.deleteMany({ where: { agentId: tree.rootId } });
    await deleteTree(tree);
  }
});
