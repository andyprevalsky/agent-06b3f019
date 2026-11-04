/**
 * Agent-to-agent messages addressed to a RUNNING code background task
 * (spawn_agent type=code, run_in_background). The code agent is a CLI in a
 * sandbox: nothing reads the owner's task inbox for it, so the message must
 * reach the live CLI as its next user turn (the ws-server user_turn
 * protocol), or the send must fail with the reason. A stored-but-unread row
 * reported as "delivered" is the bug this suite guards.
 *
 * The code session is a minimal ws-server stand-in speaking the real
 * user_turn / user_turn_ack protocol on localhost.
 */
import { randomUUID } from 'crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { assert, assertStatus, prisma, test } from './agents-blackbox-harness';
import {
  createTree,
  deleteTree,
  sendAgentMessage,
  type Tree,
} from './agents-agent-messages.fixtures';

interface Turn {
  id: string;
  text: string;
  sender: string;
}

/** A code session's ws-server: acks every user_turn with `reason` (delivered when null). */
async function startCodeSession(reason: string | null): Promise<{
  url: string;
  turns: Turn[];
  close: () => Promise<void>;
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const turns: Turn[] = [];
  server.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, string>;
      if (msg.type !== 'user_turn') return;
      // Like ws-server.mjs: a turn id is delivered once; a repeat acks "duplicate".
      const duplicate = turns.some((turn) => turn.id === msg.id);
      if (reason === null && !duplicate) {
        turns.push({ id: msg.id, text: msg.text, sender: msg.sender });
      }
      socket.send(
        JSON.stringify({
          type: 'user_turn_ack',
          id: msg.id,
          status: reason !== null ? 'rejected' : duplicate ? 'duplicate' : 'delivered',
          ...(reason === null ? {} : { reason }),
        })
      );
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    turns,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The owner (child) runs background code task `taskId` at /root/<child>/coder with a live session. */
async function seedRunningCodeTask(tree: Tree, taskId: string, streamUrl: string): Promise<string> {
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
  const sessionId = randomUUID();
  await prisma.claudeCodeSession.create({
    data: {
      id: sessionId,
      agentId: tree.childId,
      sandboxId: `sb-${sessionId}`,
      goal: 'Add a README badge.',
      status: 'ACTIVE',
      streamUrl,
      codeProvider: 'claude',
    },
  });
  // The activity's chip row: the code session runs under the spawn's tool call id.
  await prisma.message.create({
    data: {
      agentId: tree.childId,
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: taskId,
        toolName: 'spawn_agent',
        task_id: sessionId,
        code_provider: 'claude',
        action_type: 'session_started',
      },
    },
  });
  return sessionId;
}

async function unreadTaskRows(agentId: string, taskId: string): Promise<number> {
  return prisma.message.count({
    where: { agentId, metadata: { path: ['recipientTaskId'], equals: taskId } },
  });
}

test('POST /:id/agent-messages — a message to a running code task reaches its live CLI as a turn', async () => {
  const tree = await createTree('a2a-code-running');
  const session = await startCodeSession(null);
  const taskId = `toolu_code_${randomUUID().slice(0, 8)}`;
  try {
    await seedRunningCodeTask(tree, taskId, session.url);
    for (const [from, label] of [
      [tree.childId, 'owner'],
      [tree.rootId, 'peer'],
    ] as const) {
      const key = `code-turn-${label}-${randomUUID()}`;
      const text = `Also update CHANGELOG.md (${label}).`;
      const res = await sendAgentMessage(tree.userId, tree.childId, {
        from_agent_id: from,
        message: text,
        idempotency_key: key,
        recipient_task_id: taskId,
      });
      assertStatus(res.status, 201, res.data);
      const body = res.data as { delivered: boolean };
      assert(
        body.delivered === true,
        `${label}: a running code task must get the turn: ${JSON.stringify(body)}`
      );
      const turn = session.turns.find((t) => t.text.includes(text));
      assert(
        turn !== undefined,
        `${label}: the CLI never received the message: ${JSON.stringify(session.turns)}`
      );
      assert(turn.sender === 'agent', `${label}: agent turns are sent as sender=agent`);
      // A retry of the same send is delivered once.
      const retry = await sendAgentMessage(tree.userId, tree.childId, {
        from_agent_id: from,
        message: text,
        idempotency_key: key,
        recipient_task_id: taskId,
      });
      assertStatus(retry.status, 201, retry.data);
      assert(
        session.turns.filter((t) => t.text.includes(text)).length === 1,
        `${label}: a retried send must not write a second turn`
      );
    }
    assert(
      (await unreadTaskRows(tree.childId, taskId)) === 0,
      'nothing is left in an inbox no code agent reads'
    );
  } finally {
    await session.close();
    await prisma.claudeCodeSession.deleteMany({ where: { agentId: tree.childId } });
    await deleteTree(tree);
  }
});

test('POST /:id/agent-messages — a running code task whose CLI turn ended refuses with the reason', async () => {
  const tree = await createTree('a2a-code-ended');
  const session = await startCodeSession('session_ended');
  const taskId = `toolu_code_${randomUUID().slice(0, 8)}`;
  try {
    await seedRunningCodeTask(tree, taskId, session.url);
    const res = await sendAgentMessage(tree.userId, tree.childId, {
      from_agent_id: tree.childId,
      message: 'One more thing.',
      idempotency_key: `code-ended-${randomUUID()}`,
      recipient_task_id: taskId,
    });
    assertStatus(res.status, 409, res.data);
    const error = String((res.data as { error?: string }).error);
    assert(error === 'Code agent session has finished', `unexpected refusal: ${error}`);
    assert((await unreadTaskRows(tree.childId, taskId)) === 0, 'a refused send stores nothing');
  } finally {
    await session.close();
    await prisma.claudeCodeSession.deleteMany({ where: { agentId: tree.childId } });
    await deleteTree(tree);
  }
});
