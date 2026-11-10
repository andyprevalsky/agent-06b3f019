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
import { createWithCodeSession } from '../../providers/codeSessions/spawn';
import { MAX_STARTUP_TURNS } from '../../providers/codeSessions/startupTurns';
import { assert, assertStatus, prisma, sleep, test } from './agents-blackbox-harness';
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

/**
 * A code session's ws-server: acks every user_turn with `reason` (delivered when null).
 * `queueing` answers `queued` like the real server before its CLI has the task prompt.
 */
async function startCodeSession(
  reason: string | null,
  queueing = false
): Promise<{
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
          status:
            reason !== null
              ? 'rejected'
              : queueing
                ? 'queued'
                : duplicate
                  ? 'duplicate'
                  : 'delivered',
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
  return seedCodeSession(tree, taskId, streamUrl, 'ACTIVE');
}

/** One code session the spawn `taskId` ran, with the activity's chip row. */
async function seedCodeSession(
  tree: Tree,
  taskId: string,
  streamUrl: string | null,
  status: 'ACTIVE' | 'CLOSED'
): Promise<string> {
  const sessionId = randomUUID();
  await prisma.claudeCodeSession.create({
    data: {
      id: sessionId,
      agentId: tree.childId,
      sandboxId: `sb-${sessionId}`,
      goal: 'Add a README badge.',
      status,
      streamUrl,
      codeProvider: 'claude',
    },
  });
  // The activity's row (agents/domains/spawn_claude_code_agent/repo.py
  // save_claude_code_message): toolCallId = the background spawn's id.
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
    assert(
      error.startsWith(
        'Code agent session has finished its turn, so this message was not delivered.'
      ) && error.includes('continue_conversation=true'),
      `the refusal says what to do next: ${error}`
    );
    assert((await unreadTaskRows(tree.childId, taskId)) === 0, 'a refused send stores nothing');
  } finally {
    await session.close();
    await prisma.claudeCodeSession.deleteMany({ where: { agentId: tree.childId } });
    await deleteTree(tree);
  }
});

test('POST /:id/agent-messages — a woken code task run never gets the previous run session', async () => {
  const tree = await createTree('a2a-code-run2');
  const session = await startCodeSession(null);
  const taskId = `toolu_code_${randomUUID().slice(0, 8)}`;
  try {
    // Run 1 ended (its session CLOSED); run 2 was woken just now and has no session yet.
    await seedCodeSession(tree, taskId, null, 'CLOSED');
    await sleep(20);
    const run2Start = new Date().toISOString();
    await prisma.agent.update({
      where: { id: tree.childId },
      data: {
        backgroundTasks: [
          {
            address: `${taskId}.run2`,
            type: 'code',
            goal: 'Add a README badge.',
            status: 'running',
            task_name: 'coder',
            path: null,
            started_at: run2Start,
          },
        ],
      },
    });
    const send = (key: string) =>
      sendAgentMessage(tree.userId, tree.childId, {
        from_agent_id: tree.rootId,
        message: `Run 2 instruction (${key}).`,
        idempotency_key: key,
        recipient_task_id: `${taskId}.run2`,
      });
    // Run 2's session does not exist yet: the message waits for it, and is
    // never delivered to run 1's (closed) session.
    const early = await send(`run2-early-${randomUUID()}`);
    assertStatus(early.status, 201, early.data);
    const earlyBody = early.data as { queued?: boolean; delivered: boolean };
    assert(
      earlyBody.queued === true && earlyBody.delivered === false,
      `queued for run 2, not delivered to run 1: ${JSON.stringify(earlyBody)}`
    );
    await sleep(20);
    await seedCodeSession(tree, taskId, session.url, 'ACTIVE');
    // A burst past the inbox guard's 3-message burst: code turns write no inbox rows.
    for (let index = 0; index < 4; index += 1) {
      const res = await send(`run2-${index}-${randomUUID()}`);
      assertStatus(res.status, 201, res.data);
    }
    assert(
      session.turns.length === 4,
      `run 2's CLI got every turn: ${JSON.stringify(session.turns)}`
    );
  } finally {
    await session.close();
    await prisma.claudeCodeSession.deleteMany({ where: { agentId: tree.childId } });
    await deleteTree(tree);
  }
});

/** The owner's background code task `taskId` is running, but its session does not exist yet. */
async function seedStartingCodeTask(
  tree: Tree,
  address: string,
  startedAt: string | null
): Promise<void> {
  await prisma.agent.update({
    where: { id: tree.childId },
    data: {
      backgroundTasks: [
        {
          address,
          type: 'code',
          goal: 'Add a README badge.',
          status: 'running',
          task_name: 'coder',
          path: null,
          ...(startedAt !== null ? { started_at: startedAt } : {}),
        },
      ],
    },
  });
}

/**
 * The spawn's sandbox create, held until `released` resolves; it then stores the
 * task the way the real create does (the code-agent ws-server is `wsUrl`).
 */
function startCreate(tree: Tree, taskId: string, wsUrl: string, released: Promise<void>) {
  return createWithCodeSession(
    {
      agentId: tree.childId,
      userId: tree.userId,
      repoUrl: null,
      codeProvider: 'claude',
      leaseOwner: `tool:${tree.childId}:${taskId}`,
    },
    async () => {
      await released;
      const task = await prisma.claudeCodeSession.create({
        data: {
          agentId: tree.childId,
          sandboxId: `sb-${randomUUID()}`,
          goal: 'Add a README badge.',
          status: 'ACTIVE',
          streamUrl: wsUrl,
          codeProvider: 'claude',
        },
      });
      return { taskId: task.id, wsUrl, sandboxId: task.sandboxId, resumedFrom: 'new' };
    }
  );
}

function gate(): { released: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release };
}

async function cleanupStartingTask(tree: Tree, sessions: Array<{ close: () => Promise<void> }>) {
  await Promise.all(sessions.map((session) => session.close()));
  await prisma.claudeCodeSession.deleteMany({ where: { agentId: tree.childId } });
  await prisma.codeSession.deleteMany({ where: { ownerAgentId: tree.childId } });
  await deleteTree(tree);
}

function sendToTask(tree: Tree, address: string, from: string, key: string, text: string) {
  return sendAgentMessage(tree.userId, tree.childId, {
    from_agent_id: from,
    message: text,
    idempotency_key: key,
    recipient_task_id: address,
  });
}

test('POST /:id/agent-messages — a message to a code task still starting is queued, then reaches its CLI in order exactly once', async () => {
  const tree = await createTree('a2a-code-startup');
  const session = await startCodeSession(null);
  const taskId = `toolu_code_${randomUUID().slice(0, 8)}`;
  const { released, release } = gate();
  try {
    await seedStartingCodeTask(tree, taskId, null);
    const creating = startCreate(tree, taskId, session.url, released);
    await sleep(100);
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    const first = await sendToTask(tree, taskId, tree.rootId, keys[0], 'First: add a badge.');
    assertStatus(first.status, 201, first.data);
    const firstBody = first.data as { queued?: boolean; delivered: boolean; task_running: boolean };
    assert(
      firstBody.queued === true && firstBody.delivered === false && firstBody.task_running,
      `a send before the session exists is accepted as queued: ${JSON.stringify(firstBody)}`
    );
    // A retry of the queued send neither queues it twice nor is refused.
    const retried = await sendToTask(tree, taskId, tree.rootId, keys[0], 'First: add a badge.');
    assertStatus(retried.status, 201, retried.data);
    assert((retried.data as { queued?: boolean }).queued === true, 'a queued retry stays queued');
    const second = await sendToTask(tree, taskId, tree.childId, keys[1], 'Second: add a license.');
    assertStatus(second.status, 201, second.data);
    assert(session.turns.length === 0, 'nothing reaches a CLI that does not exist yet');

    release();
    await creating;
    const texts = session.turns.map((turn) => turn.text);
    assert(
      texts.length === 2 &&
        texts[0].includes('First: add a badge.') &&
        texts[1].includes('Second: add a license.') &&
        session.turns.every((turn) => turn.sender === 'agent'),
      `the queued messages reach the CLI once each, in arrival order: ${JSON.stringify(session.turns)}`
    );

    // The create returned but the activity has posted no row yet: a send goes straight to the CLI.
    const third = await sendToTask(tree, taskId, tree.rootId, keys[2], 'Third: bump the version.');
    assertStatus(third.status, 201, third.data);
    assert((third.data as { delivered: boolean }).delivered === true, 'delivered once it exists');
    assert(session.turns.length === 3, `${JSON.stringify(session.turns)}`);
    // A retry of a message the drain delivered is a duplicate at the CLI, not a second turn.
    const again = await sendToTask(tree, taskId, tree.rootId, keys[0], 'First: add a badge.');
    assertStatus(again.status, 201, again.data);
    assert(session.turns.length === 3, 'a retry after the drain writes no second turn');
    const rows = await prisma.message.findMany({
      where: {
        agentId: tree.childId,
        metadata: { path: ['action_type'], equals: 'agent_message' },
      },
    });
    const received = rows.filter((row) => {
      const meta = row.metadata as Record<string, unknown>;
      return (
        String(meta.idempotencyKey).endsWith(':received') && typeof meta.code_turn_id === 'string'
      );
    });
    assert(received.length === 3, `one timeline row per message: ${received.length}`);
    assert((await unreadTaskRows(tree.childId, taskId)) === 0, 'no inbox rows for a CLI task');
  } finally {
    release();
    await cleanupStartingTask(tree, [session]);
  }
});

test('POST /:id/agent-messages — the startup queue is bounded and a finished session is never reported queued', async () => {
  const tree = await createTree('a2a-code-startup-bounds');
  const session = await startCodeSession(null);
  const taskId = `toolu_code_${randomUUID().slice(0, 8)}`;
  const { released, release } = gate();
  try {
    await seedStartingCodeTask(tree, taskId, null);
    const creating = startCreate(tree, taskId, session.url, released);
    await sleep(100);
    const keys: string[] = [];
    for (let index = 0; index < MAX_STARTUP_TURNS; index += 1) {
      keys.push(randomUUID());
      const res = await sendToTask(tree, taskId, tree.rootId, keys[index], `Waiting ${index}.`);
      assertStatus(res.status, 201, res.data);
    }
    const over = await sendToTask(tree, taskId, tree.rootId, randomUUID(), 'One too many.');
    assertStatus(over.status, 409, over.data);
    const error = String((over.data as { error?: string }).error);
    assert(
      error ===
        'Code agent is still starting and its queue of waiting messages is full; send again once it runs',
      error
    );
    const retry = await sendToTask(tree, taskId, tree.rootId, keys[0], 'Waiting 0.');
    assertStatus(retry.status, 201, retry.data);
    release();
    const created = await creating;
    assert(
      session.turns.length === MAX_STARTUP_TURNS &&
        !session.turns.some((turn) => turn.text.includes('One too many.')),
      `only the queued messages were delivered: ${session.turns.length}`
    );
    // The task finished: a send is the truthful refusal, never "queued".
    await prisma.claudeCodeSession.update({
      where: { id: created.session.taskId },
      data: { status: 'CLOSED', closedAt: new Date(), closeReason: 'close' },
    });
    const finished = await sendToTask(tree, taskId, tree.rootId, randomUUID(), 'Too late.');
    assertStatus(finished.status, 409, finished.data);
    assert(
      String((finished.data as { error?: string }).error) === 'Code agent session is not running',
      JSON.stringify(finished.data)
    );
    assert(!('queued' in (finished.data as object)), 'a finished session is not "queued"');
  } finally {
    release();
    await cleanupStartingTask(tree, [session]);
  }
});

test("POST /:id/agent-messages — a woken run queues for its own session, never the previous run's", async () => {
  const tree = await createTree('a2a-code-startup-run2');
  const run1 = await startCodeSession(null);
  const run2 = await startCodeSession(null);
  const taskId = `toolu_code_${randomUUID().slice(0, 8)}`;
  const never = gate();
  try {
    await seedStartingCodeTask(tree, taskId, null);
    const first = await startCreate(tree, taskId, run1.url, Promise.resolve());
    await prisma.claudeCodeSession.update({
      where: { id: first.session.taskId },
      data: { status: 'CLOSED', closedAt: new Date(), closeReason: 'close' },
    });
    await sleep(30);
    await seedStartingCodeTask(tree, `${taskId}.run2`, new Date().toISOString());
    const queued = await sendToTask(
      tree,
      `${taskId}.run2`,
      tree.rootId,
      randomUUID(),
      'For run 2.'
    );
    assertStatus(queued.status, 201, queued.data);
    assert((queued.data as { queued?: boolean }).queued === true, JSON.stringify(queued.data));
    await startCreate(tree, taskId, run2.url, Promise.resolve());
    assert(
      run2.turns.length === 1 && run2.turns[0].text.includes('For run 2.'),
      `run 2's CLI got the message: ${JSON.stringify(run2.turns)}`
    );
    assert(run1.turns.length === 0, "run 1's session never got it");
  } finally {
    never.release();
    await cleanupStartingTask(tree, [run1, run2]);
  }
});

test('POST /:id/agent-messages — a code CLI that holds the turn until its task starts is reported queued', async () => {
  const tree = await createTree('a2a-code-ws-queued');
  const session = await startCodeSession(null, true);
  const taskId = `toolu_code_${randomUUID().slice(0, 8)}`;
  try {
    await seedRunningCodeTask(tree, taskId, session.url);
    const key = randomUUID();
    const res = await sendToTask(tree, taskId, tree.rootId, key, 'Hold this for the CLI.');
    assertStatus(res.status, 201, res.data);
    const body = res.data as { queued?: boolean; delivered: boolean };
    assert(
      body.queued === true && body.delivered === false,
      `the ws-server's queued ack is surfaced: ${JSON.stringify(body)}`
    );
    const retry = await sendToTask(tree, taskId, tree.rootId, key, 'Hold this for the CLI.');
    assertStatus(retry.status, 201, retry.data);
    assert(session.turns.length === 1, 'a retry never writes a second turn');
  } finally {
    await cleanupStartingTask(tree, [session]);
  }
});
