#!/usr/bin/env tsx
/**
 * Black-box: a person's message to an agent that stopped resumes it, and the row
 * records that for the FE's resume state beside its time (agentMessageResume.ts).
 *
 *   Browser composer → paused background browser task: the message lands on the
 *     paused run's inbox and the owner is woken (receive_agent_message
 *     {wake_task_id, continue_conversation, from_user}); it does not fall back to
 *     the owner's own chat. A completed browser keeps the fallback to the owner.
 *   Rose agent PAUSED / COMPLETED: the row carries `resumedFrom`; a running
 *     agent's row does not.
 *
 * Real Postgres (the runner's isolated database) and postMessage (the route's
 * service); the owner's workflow is the in-memory blackbox Temporal client.
 */
process.env.BLACKBOX_TEST_FAKE_TEMPORAL = '1';
process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND = '1';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { prisma } from '../../providers/database';
import { getTemporalClient } from '../../providers/temporal';
import { blackboxTemporalSignals } from '../../providers/temporalBlackboxFake';
import { postMessage } from '../../domains/agents/agentMessageService';
import { stoppedAgentStatus } from '../../domains/agents/agentMessageResume';
import { findSubtreeAgentIds } from '../../domains/agents/repoMessageResume';
import { pauseAgent } from '../../domains/agents/agentControlService';
import { getEphemeral, putEphemeral } from '../../providers/sharedState';
import { applyResumeCost } from '../../domains/agents/agentResumeCostService';
import { startCodeAgentResumeWorkflow } from '../../providers/codeAgentResumeWorkflow';

const created = { users: [] as string[], agents: [] as string[] };

async function seed(
  status: string,
  workflowId: string | null,
  backgroundTasks: unknown[] = [],
  creditsCents = 10_000
) {
  const userId = randomUUID();
  const agentId = randomUUID();
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  if (creditsCents > 0) await prisma.credit.create({ data: { userId, amountCents: creditsCents } });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'Order breakfast',
      status: status as never,
      temporalWorkflowId: workflowId,
      backgroundTasks: backgroundTasks as never,
      verifier: { create: {} },
    },
  });
  created.users.push(userId);
  created.agents.push(agentId);
  if (workflowId !== null) {
    const temporal = await getTemporalClient();
    await temporal.workflow.start('agentWorkflow', { workflowId, taskQueue: 'blackbox', args: [] });
  }
  return { userId, agentId };
}

async function seedBrowser(agentId: string, userId: string, status: 'PAUSED' | 'CLOSED') {
  const context = await prisma.browserContext.create({ data: { userId } });
  const session = await prisma.browserSession.create({
    data: { contextId: context.id, agentId, status: status as never },
  });
  // The browser run's rows name its task id and the spawn tool call.
  await prisma.message.create({
    data: {
      agentId,
      role: 'TOOL',
      text: 'Browsing',
      metadata: { toolName: 'spawn_browser_agent', toolCallId: 'tc-browser', taskId: session.id },
    },
  });
  return session.id;
}

const browserTask = (status: string, wakeable = true) => ({
  address: 'tc-browser',
  type: 'browser',
  goal: 'Order breakfast',
  status,
  path: '/root/order_breakfast',
  ...(wakeable ? { wakeable: true } : {}),
});

async function signals(workflowId: string) {
  return blackboxTemporalSignals(await getTemporalClient(), workflowId);
}

const starts: Array<{ type: string; options: { workflowId: string; args?: unknown[] } }> = [];
let startsWrapped = false;
async function browserStarts() {
  if (!startsWrapped) {
    const temporal = await getTemporalClient();
    const start = temporal.workflow.start.bind(temporal.workflow);
    temporal.workflow.start = (async (type: string, options: { workflowId: string }) => {
      starts.push({ type, options });
      return start(type, options as never);
    }) as typeof temporal.workflow.start;
    startsWrapped = true;
  }
  return starts.filter((entry) => entry.type === 'BrowserAgentResumeWorkflow');
}

async function send(agentId: string, userId: string, browserTaskId: string, message: string) {
  const result = await postMessage(
    agentId,
    { message, browser_task_id: browserTaskId } as never,
    false,
    userId
  );
  assert.ok(!('error' in result), JSON.stringify(result));
  const row = await prisma.message.findUniqueOrThrow({ where: { id: result.message_id } });
  return { id: row.id, metadata: (row.metadata ?? {}) as Record<string, unknown> };
}

after(async () => {
  await prisma.credit.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.message.deleteMany({ where: { agentId: { in: created.agents } } });
  await prisma.browserSession.deleteMany({ where: { agentId: { in: created.agents } } });
  await prisma.browserContext.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.verifier.deleteMany({ where: { agent: { id: { in: created.agents } } } });
  await prisma.agent.deleteMany({ where: { id: { in: created.agents } } });
  await prisma.user.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.$disconnect();
});

test('a paused background browser under a running owner resumes in its conversation', async () => {
  await browserStarts();
  const workflowId = `wf-${randomUUID()}`;
  const { userId, agentId } = await seed('ACTIVE', workflowId, [browserTask('paused')]);
  const browserTaskId = await seedBrowser(agentId, userId, 'PAUSED');
  const row = await send(agentId, userId, browserTaskId, 'Use the second login.');
  assert.equal(row.metadata.browserResume, true);
  assert.equal(row.metadata.recipientTaskId, 'tc-browser', "the paused run's inbox");
  assert.equal(row.metadata.excludeFromModel, true, "never the owner's own instruction");
  const wake = (await signals(workflowId)).filter(
    (signal) => signal.name === 'receive_agent_message'
  );
  assert.equal(wake.length, 1);
  assert.deepEqual(
    { ...(wake[0].args[0] as Record<string, unknown>), message_id: undefined },
    {
      message_id: undefined,
      wake_task_id: 'tc-browser',
      message: 'Use the second login.',
      continue_conversation: true,
      from_user: true,
    }
  );
  // A second message while it starts joins the run's inbox; nothing new starts.
  const second = await send(agentId, userId, browserTaskId, 'And skip the upsell.');
  assert.equal(second.metadata.recipientTaskId, 'tc-browser');
  assert.equal(
    (await signals(workflowId)).filter((signal) => signal.name === 'receive_agent_message').length,
    1
  );
});

test('a finished background browser under a running owner resumes on a fresh conversation', async () => {
  const workflowId = `wf-${randomUUID()}`;
  const { userId, agentId } = await seed('ACTIVE', workflowId, [browserTask('completed')]);
  const browserTaskId = await seedBrowser(agentId, userId, 'CLOSED');
  const row = await send(agentId, userId, browserTaskId, 'One more thing.');
  assert.equal(row.metadata.browserResume, true);
  assert.equal(row.metadata.agentMessage, undefined, 'its text rides the fresh goal');
  const wake = (await signals(workflowId)).filter(
    (signal) => signal.name === 'receive_agent_message'
  );
  assert.equal((wake[0].args[0] as Record<string, unknown>).continue_conversation, false);
});

test('a browser whose owner finished, or a foreground browser, resumes under its own run', async () => {
  const cases = [
    {
      owner: 'COMPLETED',
      wf: null,
      task: browserTask('paused'),
      session: 'PAUSED',
      mode: 'continue',
    },
    {
      owner: 'COMPLETED',
      wf: null,
      task: browserTask('completed'),
      session: 'CLOSED',
      mode: 'fresh',
    },
    {
      owner: 'ACTIVE',
      wf: `wf-${randomUUID()}`,
      task: browserTask('completed', false),
      session: 'CLOSED',
      mode: 'fresh',
    },
    { owner: 'PAUSED', wf: `wf-${randomUUID()}`, task: null, session: 'PAUSED', mode: 'continue' },
  ] as const;
  for (const item of cases) {
    const before = (await browserStarts()).length;
    const { userId, agentId } = await seed(
      item.owner,
      item.wf,
      item.task === null ? [] : [item.task]
    );
    const browserTaskId = await seedBrowser(agentId, userId, item.session);
    await prisma.message.create({
      data: {
        agentId,
        role: 'TOOL',
        text: 'Ordered the oat latte.',
        metadata: {
          toolName: 'spawn_browser_agent',
          toolCallId: 'tc-browser',
          toolStatus: 'FINISHED',
        },
      },
    });
    const row = await send(agentId, userId, browserTaskId, 'Now add a croissant.');
    const started = await browserStarts();
    assert.equal(started.length, before + 1, JSON.stringify(item));
    const start = started.at(-1);
    assert.equal(start?.options.workflowId, `code-resume:${agentId}:browser:${row.id}`);
    const request = start?.options.args?.[0] as Record<string, unknown>;
    assert.equal(request.mode, item.mode, JSON.stringify(item));
    assert.equal(request.tool_call_id, 'tc-browser');
    assert.equal(request.message, 'Now add a croissant.');
    // The worker stamps this root on every activity so resumed LLM records land
    // in the tree's root archive bundle.
    assert.equal(request.root_agent_id, agentId, 'resume request carries the archive root');
    if (item.mode === 'continue') {
      assert.equal(request.inbox_address, 'tc-browser');
      assert.equal(row.metadata.recipientTaskId, 'tc-browser');
    } else {
      assert.equal(request.previous_result, 'Ordered the oat latte.');
      assert.notEqual(request.inbox_address, 'tc-browser', 'a fresh run reads a new inbox');
    }
  }
});

test('an owner at its cost limit: the browser does not resume, the message says why', async () => {
  const before = (await browserStarts()).length;
  const { userId, agentId } = await seed('COST_LIMIT_REACHED', null, [browserTask('paused')]);
  const browserTaskId = await seedBrowser(agentId, userId, 'PAUSED');
  await send(agentId, userId, browserTaskId, 'Continue.');
  assert.equal((await browserStarts()).length, before);
  const failure = await prisma.message.findFirst({
    where: { agentId, metadata: { path: ['browserResume'], equals: 'failed' } },
  });
  assert.ok(failure !== null && failure.text.includes('cost limit'), JSON.stringify(failure));
});

test("a finished owner-woken browser's marker names its next run's inbox; a resumed run that finished releases its marker", async () => {
  const workflowId = `wf-${randomUUID()}`;
  const owned = await seed('ACTIVE', workflowId, [browserTask('completed')]);
  const ownedBrowser = await seedBrowser(owned.agentId, owned.userId, 'CLOSED');
  await send(owned.agentId, owned.userId, ownedBrowser, 'One more.');
  const ownedMarker = await getEphemeral<{ inbox: string; runWorkflowId?: string }>(
    'browser-agent-resume',
    `${owned.agentId}:tc-browser`
  );
  assert.equal(ownedMarker?.inbox, 'tc-browser.run2', "the owner's fresh run reads <id>.run<n+1>");
  assert.equal(ownedMarker?.runWorkflowId, undefined, 'an owner wake has no supervised run');

  const { userId, agentId } = await seed('COMPLETED', null, [browserTask('paused')]);
  const browserTaskId = await seedBrowser(agentId, userId, 'PAUSED');
  const before = (await browserStarts()).length;
  await send(agentId, userId, browserTaskId, 'Resume.');
  assert.equal((await browserStarts()).length, before + 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await prisma.message.create({
    data: {
      agentId,
      role: 'TOOL',
      text: 'Done.',
      metadata: {
        toolName: 'spawn_browser_agent',
        toolCallId: 'tc-browser',
        action_type: 'task_complete',
        toolStatus: 'FINISHED',
      },
    },
  });
  const later = await send(agentId, userId, browserTaskId, 'And one more thing.');
  assert.equal((await browserStarts()).length, before + 2, 'a new resume, not a dead inbox');
  assert.ok(later.metadata.browserResume === true);
});

test('two quick messages to a stopped browser start one resume; the later one joins its inbox', async () => {
  // Supervised (the owner finished): one BrowserAgentResumeWorkflow, not two.
  const { userId, agentId } = await seed('COMPLETED', null, [browserTask('completed')]);
  const browserTaskId = await seedBrowser(agentId, userId, 'CLOSED');
  const rows = await Promise.all([
    send(agentId, userId, browserTaskId, 'Add a croissant.'),
    send(agentId, userId, browserTaskId, 'And a juice.'),
  ]);
  const started = (await browserStarts()).filter((entry) =>
    entry.options.workflowId.startsWith(`code-resume:${agentId}:`)
  );
  assert.equal(started.length, 1, 'one run drives the browser profile');
  const runInbox = (started[0].options.args?.[0] as Record<string, unknown>).inbox_address;
  assert.equal(
    rows.filter((row) => row.metadata.recipientTaskId === runInbox).length,
    1,
    "the other message is read on the started run's inbox"
  );

  // Owner wake on a fresh conversation: one wake; the later message lands on its run's inbox.
  const workflowId = `wf-${randomUUID()}`;
  const owned = await seed('ACTIVE', workflowId, [browserTask('completed')]);
  const ownedBrowser = await seedBrowser(owned.agentId, owned.userId, 'CLOSED');
  const ownedRows = await Promise.all([
    send(owned.agentId, owned.userId, ownedBrowser, 'One more.'),
    send(owned.agentId, owned.userId, ownedBrowser, 'And another.'),
  ]);
  const wakes = (await signals(workflowId)).filter(
    (signal) => signal.name === 'receive_agent_message'
  );
  assert.equal(wakes.length, 1, 'one wake, never an unanswered second one');
  assert.deepEqual(
    ownedRows.map((row) => row.metadata.recipientTaskId ?? null).sort(),
    ['tc-browser.run2', null].sort(),
    "the first rides the fresh goal; the second reads on the woken run's inbox"
  );
});

test('a supervised fresh browser resume carries its output schema and files; no credits refuses', async () => {
  const { userId, agentId } = await seed('COMPLETED', null, [browserTask('completed')]);
  const browserTaskId = await seedBrowser(agentId, userId, 'CLOSED');
  const schema = { type: 'object', properties: { total: { type: 'number' } } };
  await prisma.message.create({
    data: {
      agentId,
      role: 'TOOL',
      text: 'Started browser agent in background',
      metadata: {
        toolName: 'spawn_agent',
        backgroundTaskId: 'tc-browser',
        runInBackground: true,
        backgroundSpawnArgs: {
          goal: 'Order breakfast from the cafe',
          output_schema: schema,
          attachments: ['menu.pdf'],
        },
      },
    },
  });
  const pointer = {
    id: 'f-menu',
    storage_path: `${userId}/menu.pdf`,
    original_filename: 'menu.pdf',
  };
  await prisma.message.create({ data: { agentId, role: 'USER', text: '', filePointer: pointer } });
  await send(agentId, userId, browserTaskId, 'Same order again.');
  const request = (await browserStarts()).at(-1)?.options.args?.[0] as Record<string, unknown>;
  assert.equal(request.goal, 'Order breakfast from the cafe');
  assert.deepEqual(request.output_schema, schema);
  assert.deepEqual(request.attachments, [pointer]);

  const broke = await seed('COMPLETED', null, [browserTask('paused')], 0);
  const brokeBrowser = await seedBrowser(broke.agentId, broke.userId, 'PAUSED');
  const starts = (await browserStarts()).length;
  await send(broke.agentId, broke.userId, brokeBrowser, 'Continue.');
  assert.equal((await browserStarts()).length, starts, 'nothing spends without credits');
  const failure = await prisma.message.findFirst({
    where: { agentId: broke.agentId, metadata: { path: ['browserResume'], equals: 'failed' } },
  });
  assert.ok(failure !== null && failure.text.includes('out of credits'), JSON.stringify(failure));
});

test("the user's pause commits and signals the owner before the resume runs are paused", async () => {
  const order: string[] = [];
  const temporal = await getTemporalClient();
  const getHandle = temporal.workflow.getHandle.bind(temporal.workflow);
  temporal.workflow.getHandle = ((id: string, ...rest: unknown[]) => {
    const handle = getHandle(id, ...(rest as []));
    return {
      ...handle,
      signal: async (name: string, ...args: unknown[]) => {
        order.push(`${id}:${name}`);
        return handle.signal(name as never, ...(args as []));
      },
    };
  }) as typeof temporal.workflow.getHandle;
  try {
    const workflowId = `wf-${randomUUID()}`;
    const { agentId } = await seed('ACTIVE', workflowId);
    const run = await startCodeAgentResumeWorkflow({
      agent_id: agentId,
      user_id: 'u',
      model: 'm',
      tool_call_id: 'tc',
      task_name: null,
      code_session_id: null,
      code_provider: 'claude',
      message: 'go',
      message_id: 'm-pause-order',
      attachments: [],
    });
    await pauseAgent(agentId);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert.equal(stored.status, 'PAUSED', 'committed before pauseAgent returns');
    // The resume runs pause in the background, after pauseAgent returned.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ownerAt = order.indexOf(`${workflowId}:pause`);
    const runAt = order.indexOf(`${run.workflowId}:pause`);
    assert.ok(
      ownerAt >= 0 && runAt > ownerAt,
      `owner first, then the resume run: ${JSON.stringify(order)}`
    );
  } finally {
    temporal.workflow.getHandle = getHandle as typeof temporal.workflow.getHandle;
  }
});

test('a resume run reports its total: the tree grows by the growth only, up the tree; the root limit holds', async () => {
  const root = await seed('COMPLETED', null);
  await prisma.agent.update({
    where: { id: root.agentId },
    data: { treeCostCents: 40, priceLimitCents: 50 },
  });
  const ownerId = randomUUID();
  await prisma.agent.create({
    data: {
      id: ownerId,
      userId: root.userId,
      goal: 'sub-agent owner',
      status: 'COMPLETED',
      parentAgentId: root.agentId,
      busId: root.agentId,
      treeCostCents: 10,
      ownCostCents: 10,
      verifier: { create: {} },
    },
  });
  created.agents.push(ownerId);
  const first = await applyResumeCost(ownerId, { key: 'resume:wf-1', total_cents: 15 });
  assert.deepEqual(first, { limit_reached: true }, "the root's limit, not the owner's");
  // A resend and a reordered older total change nothing.
  await applyResumeCost(ownerId, { key: 'resume:wf-1', total_cents: 15 });
  await applyResumeCost(ownerId, { key: 'resume:wf-1', total_cents: 9 });
  // Two runs reporting at once both count (each by its growth).
  await Promise.all([
    applyResumeCost(ownerId, { key: 'resume:wf-1', total_cents: 17 }),
    applyResumeCost(ownerId, { key: 'resume:wf-2', total_cents: 3 }),
  ]);
  const owner = await prisma.agent.findUniqueOrThrow({ where: { id: ownerId } });
  const top = await prisma.agent.findUniqueOrThrow({ where: { id: root.agentId } });
  assert.equal(owner.ownCostCents, 10, 'resume spend never lands in own cost');
  assert.equal(owner.treeCostCents, 30);
  assert.equal(top.treeCostCents, 60, "the root carries the sub-agent owner's resume spend");
  const bad = await applyResumeCost(ownerId, { key: 'not-a-resume-key', total_cents: 1 });
  assert.ok('error' in bad);
});

test('a browser resume whose start never confirmed does not hold later messages', async () => {
  const { userId, agentId } = await seed('COMPLETED', null, [browserTask('paused')]);
  const browserTaskId = await seedBrowser(agentId, userId, 'PAUSED');
  await putEphemeral(
    'browser-agent-resume',
    `${agentId}:tc-browser`,
    { inbox: 'tc-browser', since: new Date(Date.now() - 5 * 60_000).toISOString() },
    60 * 60_000
  );
  const before = (await browserStarts()).length;
  await send(agentId, userId, browserTaskId, 'Try again.');
  assert.equal((await browserStarts()).length, before + 1, 'a new resume, not a crashed one');
  const marker = await getEphemeral<{ started?: boolean }>(
    'browser-agent-resume',
    `${agentId}:tc-browser`
  );
  assert.equal(marker?.started, true, 'the new run confirmed its start');
});

test("the paused tree's agents are all found for the pause", async () => {
  const root = await seed('ACTIVE', null);
  const childId = randomUUID();
  await prisma.agent.create({
    data: {
      id: childId,
      userId: root.userId,
      goal: 'child',
      status: 'ACTIVE',
      parentAgentId: root.agentId,
      busId: root.agentId,
      verifier: { create: {} },
    },
  });
  created.agents.push(childId);
  assert.deepEqual(await findSubtreeAgentIds(root.agentId), [root.agentId, childId]);
});

test('a message to a paused or finished Rose agent records what it resumed from', async () => {
  const workflowId = `wf-${randomUUID()}`;
  const paused = await seed('PAUSED', workflowId);
  const result = await postMessage(
    paused.agentId,
    { message: 'Keep going.' } as never,
    false,
    paused.userId
  );
  assert.ok(!('error' in result), JSON.stringify(result));
  const row = await prisma.message.findUniqueOrThrow({ where: { id: result.message_id } });
  assert.equal((row.metadata as Record<string, unknown>).resumedFrom, 'PAUSED');
  for (const status of ['COMPLETED', 'FAILED']) {
    const finished = await seed(status, null);
    assert.equal(await stoppedAgentStatus(finished.agentId), status);
  }
  const running = await seed('ACTIVE', `wf-${randomUUID()}`);
  const live = await postMessage(
    running.agentId,
    { message: 'hi' } as never,
    false,
    running.userId
  );
  assert.ok(!('error' in live), JSON.stringify(live));
  const liveRow = await prisma.message.findUniqueOrThrow({ where: { id: live.message_id } });
  assert.equal(((liveRow.metadata ?? {}) as Record<string, unknown>).resumedFrom, undefined);
});
