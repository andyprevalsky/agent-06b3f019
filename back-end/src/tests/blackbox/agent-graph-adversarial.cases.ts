import { statSync, writeFileSync } from 'fs';

import { join } from 'path';

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

import {
  MAX_TRACKED_SENDERS,
  SEND_BURST,
  SEND_REFILL_PER_SECOND,
  takeSendBudget,
  trackedSenders,
} from '../../providers/agentGraph/sendBudget';

import { prepareAgentGraphWorkspace } from '../../providers/agentGraph/workspace';
import { mintAgentToolsToken } from '../../providers/agentTools/token';

import { deterministicMessageId } from '../../providers/messageIdempotency';
import { getTemporalClient } from '../../providers/temporal';
import { blackboxTemporalSignals } from '../../providers/temporalBlackboxFake';
import { askQuestion } from '../../domains/agents/agentGraphQuestionService';
import { sendGraphMessage } from '../../domains/agents/agentGraphSendService';
import type { GraphCaller } from '../../domains/agents/agentGraphService';

import {
  AdversarialContext,
  Res,
  assert,
  expectStatus,
  RUN,
  userX,
  userY,
  ids,
  call,
  graphToken,
  tokenClaims,
  a2aRowsFrom,
  a2aRowCount,
  awaitingParent,
  cliHome,
  cliEnv,
  runCli,
  testQuestionToBlockedSpawnerIsHandedOver,
} from './agent-graph-adversarial.support';
export { seedAdversarial, cleanupAdversarial } from './agent-graph-adversarial.support';
async function testMutualQuestionsBetweenSiblingsNeverDeadlock(
  ctx: AdversarialContext
): Promise<void> {
  const ask = (from: string, to: string, messageId: string, text: string) =>
    call(ctx, '/api/agent-graph/messages', {
      agentId: from,
      body: { to, text, message_id: messageId },
    });
  // Both ask each other at the same moment; neither delivery waits on the other.
  const [ab, ba] = await Promise.all([
    ask(ids.A1, ids.B1, `cyc-ab-${RUN}`, `A1 asks B1: which port? ${RUN}`),
    ask(ids.B1, ids.A1, `cyc-ba-${RUN}`, `B1 asks A1: which branch? ${RUN}`),
  ]);
  expectStatus(ab, 200, 'A1 → B1');
  expectStatus(ba, 200, 'B1 → A1');
  assert(ab.data.status === 'delivered' && ba.data.status === 'delivered', 'both delivered');
  // A ping-pong of answers and follow-up questions completes, once per message.
  const rounds = 8;
  for (let i = 0; i < rounds; i += 1) {
    expectStatus(await ask(ids.A1, ids.B1, `pp-a-${i}-${RUN}`, `A1 round ${i}`), 200, `A1 ${i}`);
    expectStatus(await ask(ids.B1, ids.A1, `pp-b-${i}-${RUN}`, `B1 round ${i}`), 200, `B1 ${i}`);
  }
  // A retried ask in the middle of the cycle is a duplicate, not a new turn.
  const retry = await ask(ids.A1, ids.B1, `cyc-ab-${RUN}`, `A1 asks B1: which port? ${RUN}`);
  assert(retry.data.status === 'duplicate', 'retry inside the cycle is a duplicate');
  assert(
    (await a2aRowsFrom(ids.B1, ids.A1)).length === rounds + 1,
    'B1 holds each of A1’s messages exactly once'
  );
  assert(
    (await a2aRowsFrom(ids.A1, ids.B1)).length === rounds + 1,
    'A1 holds each of B1’s messages exactly once'
  );
  // A code agent cannot be pointed at a sibling as its question target: the
  // route is always its spawner, whatever the body says.
  const sibling = await call(ctx, '/api/agent-graph/questions', {
    bearer: graphToken(ids.SX, ids.A1),
    body: { question: `cycle? ${RUN}`, message_id: `sx-q-${RUN}`, to: ids.B1 },
  });
  expectStatus(sibling, 200, 'SX asks');
  assert(sibling.data.agent_id === ids.A1, 'a code agent question goes to its spawner only');

  // Corrupt parent-link cycle: every walk is bounded and nothing hangs.
  const list = await call(ctx, '/api/agent-graph/agents', { agentId: ids.L1 });
  expectStatus(list, 200, 'list inside a parent cycle');
  assert((list.data.agents as unknown[]).length <= 2, 'cycle listing is bounded');
  const loop = await call(ctx, '/api/agent-graph/messages', {
    agentId: ids.L1,
    body: { to: ids.L2, text: 'loop', message_id: `loop-${RUN}` },
  });
  assert(loop.status === 200 || loop.status === 404, `cycle send answers: ${loop.status}`);
  const grep = await call(ctx, '/api/agent-graph/grep', {
    agentId: ids.L2,
    body: { pattern: 'loop' },
  });
  assert(grep.status === 200, `grep inside a parent cycle answers: ${grep.status}`);
}

// ---------------------------------------------------------------------------
// 3. Deep chain R → C → G → code agent: each level routes to its spawner
// ---------------------------------------------------------------------------

async function testDeepChainRoutesEachLevelToItsSpawner(ctx: AdversarialContext): Promise<void> {
  const route = async (sessionId: string, owner: string) =>
    (await call(ctx, '/api/agent-graph/question-route', { bearer: graphToken(sessionId, owner) }))
      .data;
  assert(
    JSON.stringify(await route(ids.SG, ids.G)) ===
      JSON.stringify({ deliver_to: 'agent', agent_id: ids.G }),
    'depth-3 code agent → its spawner G'
  );
  assert((await route(ids.SC, ids.C)).agent_id === ids.C, 'depth-2 code agent → C');
  const rootRoute = await route(ids.SR, ids.R);
  assert(rootRoute.deliver_to === 'user' && rootRoute.agent_id === ids.R, 'root-spawned → user');

  const counts = async () => ({
    R: await a2aRowCount(ids.R),
    C: await a2aRowCount(ids.C),
    G: await a2aRowCount(ids.G),
  });
  const base = await counts();
  const ask = (sessionId: string, owner: string, key: string) =>
    call(ctx, '/api/agent-graph/questions', {
      bearer: graphToken(sessionId, owner),
      body: { question: `deep ${key} ${RUN}?`, message_id: `deep-${key}-${RUN}` },
    });
  const fromSG = await ask(ids.SG, ids.G, 'sg');
  expectStatus(fromSG, 200, 'SG asks');
  assert(fromSG.data.deliver_to === 'agent' && fromSG.data.agent_id === ids.G, 'SG → G');
  let now = await counts();
  assert(now.G === base.G + 1 && now.C === base.C && now.R === base.R, 'only G got SG’s question');
  const fromSR = await ask(ids.SR, ids.R, 'sr');
  assert(fromSR.data.status === 'pin_for_user', 'root-spawned question pins for the user');
  now = await counts();
  assert(now.R === base.R, 'a pinned question sends nothing to the root');

  // Escalation up the chain with the `parent` alias lands one level up each time.
  const escalate = async (from: string, expected: string, key: string) => {
    const res = await call(ctx, '/api/agent-graph/messages', {
      agentId: from,
      body: { to: 'parent', text: `escalate ${key}`, message_id: `esc-${key}-${RUN}` },
    });
    expectStatus(res, 200, `${key} → parent`);
    assert((res.data.to as { id: string }).id === expected, `${key} parent is ${expected}`);
  };
  await escalate(ids.G, ids.C, 'g');
  await escalate(ids.C, ids.R, 'c');
  const fromRoot = await call(ctx, '/api/agent-graph/messages', {
    agentId: ids.R,
    body: { to: 'parent', text: 'nobody above', message_id: `esc-r-${RUN}` },
  });
  expectStatus(fromRoot, 400, 'the root has no parent');
  now = await counts();
  assert(
    now.G === base.G + 1 && now.C === base.C + 1 && now.R === base.R + 1,
    `each escalation landed exactly one level up: ${JSON.stringify({ base, now })}`
  );

  // The pinned display tool applies the same rule to Rose agents.
  const pin = (agentId: string, key: string) =>
    call(ctx, `/api/agent-tools/${agentId}/display`, {
      userId: userX,
      body: {
        caption: `pinned ${key} ${RUN}?`,
        placement: 'pinned',
        options: [{ label: 'Yes' }, { label: 'No' }],
        request_key: `deep-pin-${key}-${RUN}`,
      },
    });
  const gPin = (await pin(ids.G, 'g')).data.question as { deliver_to: string; agent_id: string };
  assert(gPin.deliver_to === 'agent' && gPin.agent_id === ids.C, 'depth-2 Rose agent → C');
  const cPin = (await pin(ids.C, 'c')).data.question as { deliver_to: string; agent_id: string };
  assert(cPin.deliver_to === 'user' && cPin.agent_id === ids.R, 'depth-1 Rose agent → user');
}

// ---------------------------------------------------------------------------
// 4. Question to a spawner that already finished or was deleted
// ---------------------------------------------------------------------------

async function testQuestionToFinishedOrDeletedSpawnerFailsClearly(
  ctx: AdversarialContext
): Promise<void> {
  const before = await prisma.agent.findUnique({
    where: { id: ids.F },
    select: { status: true, temporalWorkflowId: true },
  });
  const finished = await call(ctx, '/api/agent-graph/questions', {
    bearer: graphToken(ids.SF, ids.F),
    body: { question: `still there ${RUN}?`, message_id: `fin-${RUN}` },
  });
  expectStatus(finished, 409, 'question to a finished spawner');
  assert(
    /finished/i.test(String(finished.data.error)),
    `clear error: ${String(finished.data.error)}`
  );
  assert(
    (await a2aRowsFrom(ids.F, ids.SF)).length === 0,
    'nothing delivered to the finished agent'
  );
  const after = await prisma.agent.findUnique({
    where: { id: ids.F },
    select: { status: true, temporalWorkflowId: true },
  });
  assert(
    after?.status === before?.status && after?.temporalWorkflowId === before?.temporalWorkflowId,
    `the finished agent is not revived: ${JSON.stringify({ before, after })}`
  );
  assert((await awaitingParent(ids.SF)) === null, 'no handoff mark for an unanswerable question');

  const deleted = await call(ctx, '/api/agent-graph/questions', {
    bearer: graphToken(ids.SD, ids.D),
    body: { question: `anyone ${RUN}?`, message_id: `del-${RUN}` },
  });
  expectStatus(deleted, 404, 'question to a deleted spawner');
  assert(typeof deleted.data.error === 'string' && deleted.data.error !== '', 'error text');
  assert((await a2aRowsFrom(ids.D, ids.SD)).length === 0, 'nothing delivered to the deleted agent');
  assert((await awaitingParent(ids.SD)) === null, 'no handoff mark');
  const parentGone = await call(ctx, '/api/agent-graph/messages', {
    bearer: graphToken(ids.SD, ids.D),
    body: { to: 'parent', text: 'hello?', message_id: `del-msg-${RUN}` },
  });
  expectStatus(parentGone, 404, 'message to a deleted parent');
}

// ---------------------------------------------------------------------------
// 5. Duplicate message_id: retries and concurrent attempts deliver once
// ---------------------------------------------------------------------------

async function testDuplicateMessageIdDeliversExactlyOnce(ctx: AdversarialContext): Promise<void> {
  const token = graphToken(ids.SC, ids.C);
  const messageId = `dup-${RUN}`;
  const body = { to: ids.T, text: `deploy done ${RUN}`, message_id: messageId };
  // Eight attempts of one send in flight at once (a Temporal retry racing a
  // slow first attempt, or a CLI re-run).
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () => call(ctx, '/api/agent-graph/messages', { bearer: token, body }))
  );
  for (const attempt of attempts) expectStatus(attempt, 200, 'concurrent attempt');
  const statuses = attempts.map((attempt) => attempt.data.status);
  assert(
    statuses.filter((status) => status === 'delivered').length === 1,
    `exactly one attempt delivers: ${JSON.stringify(statuses)}`
  );
  const key = `a2a:${ids.SC}:${messageId}`;
  assert((await a2aRowsFrom(ids.T, ids.SC)).length === 1, 'one USER row on the target');
  const sentChips = await prisma.message.count({
    where: { agentId: ids.C, metadata: { path: ['idempotencyKey'], equals: `${key}:sent` } },
  });
  assert(sentChips === 1, `one sent chip in the code timeline (got ${sentChips})`);

  // The same attempts reach the target workflow once (in-process: this
  // process's in-memory Temporal client records the signals).
  const temporal = await getTemporalClient();
  await temporal.workflow.start('agentWorkflow', {
    workflowId: ids.T,
    taskQueue: 'a2a-adversarial',
    args: [],
  });
  const caller: GraphCaller = {
    userId: userX,
    rootAgentId: ids.R,
    self: { kind: 'code', id: ids.SC, ownerAgentId: ids.C, provider: 'claude' },
  };
  const inProcess = { to: ids.T, text: `in-process ${RUN}`, message_id: `dup-ip-${RUN}` };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => sendGraphMessage(caller, inProcess))
  );
  assert(
    results.filter((result) => result.status === 'delivered').length === 1,
    `one in-process attempt delivers: ${JSON.stringify(results.map((r) => r.status))}`
  );
  const signals = blackboxTemporalSignals(temporal, ids.T).filter(
    (signal) =>
      signal.name === 'receive_user_response' && String(signal.args[0]).includes('in-process')
  );
  assert(signals.length === 1, `the workflow is signaled once, got ${signals.length}`);

  // A retry that carries different text keeps the first delivery.
  const changed = await call(ctx, '/api/agent-graph/messages', {
    bearer: token,
    body: { ...body, text: 'a different retry body' },
  });
  assert(changed.data.status === 'duplicate', 'a changed retry is still a duplicate');
  const [row] = await a2aRowsFrom(ids.T, ids.SC);
  assert(
    deterministicMessageId(ids.T, key) === row.id && row.text.includes(`deploy done ${RUN}`),
    'the first text is kept'
  );
  // The same client id from another sender is a different message.
  const other = await call(ctx, '/api/agent-graph/messages', {
    agentId: ids.A1,
    body: { to: ids.T, text: 'from A1', message_id: messageId },
  });
  assert(other.data.status === 'delivered', 'ids are scoped by sender');
}

// ---------------------------------------------------------------------------
// 6. Flooding: one sender is capped without starving the others
// ---------------------------------------------------------------------------

async function testFloodingSenderIsCappedWithoutStarvingOthers(
  ctx: AdversarialContext
): Promise<void> {
  const token = graphToken(ids.SX, ids.A1);
  const total = 120;
  const started = Date.now();
  const results: Res[] = [];
  for (let batch = 0; batch < total; batch += 12) {
    results.push(
      ...(await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          call(ctx, '/api/agent-graph/messages', {
            bearer: token,
            body: {
              to: ids.B1,
              text: `flood ${batch + i}`,
              message_id: `flood-${batch + i}-${RUN}`,
            },
          })
        )
      ))
    );
  }
  const elapsedS = (Date.now() - started) / 1000;
  const delivered = results.filter((res) => res.status === 200);
  const limited = results.filter((res) => res.status === 429);
  assert(
    delivered.length + limited.length === total,
    `only 200 or 429: ${JSON.stringify(results.map((res) => res.status))}`
  );
  assert(
    limited.length > 0,
    `a flooding sender is capped (${delivered.length}/${total} delivered)`
  );
  assert(
    delivered.length <= SEND_BURST + Math.ceil(elapsedS * SEND_REFILL_PER_SECOND) + 1,
    `delivered ${delivered.length} in ${elapsedS}s exceeds the cap`
  );
  const retryAfter = Number(limited[0].headers.get('retry-after'));
  assert(Number.isFinite(retryAfter) && retryAfter >= 1, `Retry-After header: ${retryAfter}`);
  assert(
    /too many/i.test(String(limited[0].data.error)),
    `clear 429: ${String(limited[0].data.error)}`
  );
  const flooded = await a2aRowsFrom(ids.B1, ids.SX);
  assert(
    flooded.length === delivered.length,
    `every 200 is one row and no 429 wrote one (${flooded.length} vs ${delivered.length})`
  );

  // Other senders to the same recipient are not starved.
  const fromSibling = await call(ctx, '/api/agent-graph/messages', {
    agentId: ids.C,
    body: { to: ids.B1, text: 'still reachable', message_id: `not-starved-${RUN}` },
  });
  expectStatus(fromSibling, 200, 'another sender during the flood');
  const fromCode = await call(ctx, '/api/agent-graph/messages', {
    bearer: graphToken(ids.SR, ids.R),
    body: { to: ids.B1, text: 'me too', message_id: `not-starved-code-${RUN}` },
  });
  expectStatus(fromCode, 200, 'another code agent during the flood');
  // A retry of an already-delivered message is never rate limited.
  const retry = await call(ctx, '/api/agent-graph/messages', {
    bearer: token,
    body: { to: ids.B1, text: 'flood 0', message_id: `flood-0-${RUN}` },
  });
  expectStatus(retry, 200, 'retry of a delivered message under the cap');
  assert(retry.data.status === 'duplicate', 'the retry is a duplicate');

  // The limiter's memory is bounded however many agents send (10k rule).
  for (let i = 0; i < MAX_TRACKED_SENDERS + 5_000; i += 1) takeSendBudget(`bulk-${RUN}-${i}`);
  assert(trackedSenders() <= MAX_TRACKED_SENDERS, `tracked senders ${trackedSenders()}`);
}

// ---------------------------------------------------------------------------
// 7. Cross-tree and cross-user isolation
// ---------------------------------------------------------------------------

async function testTokensCannotReachAnotherTreeOrUser(ctx: AdversarialContext): Promise<void> {
  const token = graphToken(ids.SC, ids.C);
  const list = await call(ctx, '/api/agent-graph/agents', { bearer: token });
  expectStatus(list, 200, 'list');
  const listed = new Set((list.data.agents as Array<{ id: string }>).map((agent) => agent.id));
  for (const outside of [ids.R3, ids.S3x, ids.RY, ids.SY, ids.L1, ids.L2]) {
    assert(!listed.has(outside), `list leaks ${outside}`);
  }
  for (const [label, to] of [
    ['same user, other tree', ids.R3],
    ['same user, other tree code agent', ids.S3x],
    ['other user root', ids.RY],
    ['other user code agent', ids.SY],
  ] as const) {
    const res = await call(ctx, '/api/agent-graph/messages', {
      bearer: token,
      body: { to, text: 'hi', message_id: `iso-${to}` },
    });
    expectStatus(res, 404, label);
    const grep = await call(ctx, '/api/agent-graph/grep', {
      bearer: token,
      body: { pattern: 'goal', agent_id: to },
    });
    expectStatus(grep, 404, `grep ${label}`);
  }
  for (const outside of [ids.R3, ids.RY]) {
    assert((await a2aRowCount(outside)) === 0, `nothing written into ${outside}`);
  }
  const root = await call(ctx, '/api/agent-graph/messages', {
    bearer: token,
    body: { to: 'root', text: 'root alias', message_id: `iso-root-${RUN}` },
  });
  assert((root.data.to as { id: string }).id === ids.R, '`root` is always the own root');

  // Validly signed tokens whose claims do not match the session's real tree
  // or user (a minting bug, a moved session) are refused outright.
  const forgedRoot = graphToken(ids.SC, ids.C, { rootAgentId: ids.R3 });
  const forgedUser = graphToken(ids.SC, ids.C, { userId: userY });
  for (const [label, bearer] of [
    ['claims another tree', forgedRoot],
    ['claims another user', forgedUser],
  ] as const) {
    expectStatus(await call(ctx, '/api/agent-graph/agents', { bearer }), 401, `list: ${label}`);
    expectStatus(
      await call(ctx, '/api/agent-graph/grep', { bearer, body: { pattern: 'goal' } }),
      401,
      `grep: ${label}`
    );
    expectStatus(
      await call(ctx, '/api/agent-graph/messages', {
        bearer,
        body: { to: 'root', text: 'hi', message_id: `forged-${label.replace(/\s/g, '-')}` },
      }),
      401,
      `send: ${label}`
    );
  }
  // API-key callers can only act as a code session their own agent owns.
  expectStatus(
    await call(ctx, '/api/agent-graph/agents', { agentId: ids.RY, codeSessionId: ids.SC }),
    404,
    'another user’s agent acting as SC'
  );
  expectStatus(
    await call(ctx, '/api/agent-graph/agents', { agentId: ids.C, codeSessionId: ids.SY }),
    404,
    'own agent acting as another user’s session'
  );
  // The other tree's own token stays inside that tree.
  const otherTree = await call(ctx, '/api/agent-graph/messages', {
    bearer: graphToken(ids.S3x, ids.R3, { rootAgentId: ids.R3 }),
    body: { to: ids.R, text: 'hi', message_id: `iso-r3-${RUN}` },
  });
  expectStatus(otherTree, 404, 'tree R3 → tree R');
}

// ---------------------------------------------------------------------------
// 8. Expired or rotated token mid-session; the spawn mints a fresh one
// ---------------------------------------------------------------------------

/** A spawn (resume) mints a fresh token bound to the new task. */
async function spawnMintedToken(): Promise<string> {
  const workspace = await prepareAgentGraphWorkspace({
    userId: userX,
    ownerAgentId: ids.C,
    sessionId: ids.SC,
    provider: 'claude',
  });
  const minted = workspace?.envs.ROSE_AGENTS_TOKEN ?? '';
  const claims = tokenClaims(minted);
  assert(
    claims.sessionId === ids.SC && claims.rootAgentId === ids.R,
    'spawn token binds the new task'
  );
  assert(claims.exp - Date.now() / 1000 > 100 * 60, 'spawn token has a full lifetime');
  return minted;
}

async function testEndedTaskTokenIsRefused(ctx: AdversarialContext): Promise<void> {
  await spawnMintedToken();
  const ended = graphToken(ids.SCold, ids.C);
  for (const [path, body] of [
    ['/api/agent-graph/agents', undefined],
    ['/api/agent-graph/questions', { question: 'stale?', message_id: `ended-q-${RUN}` }],
    ['/api/agent-graph/token', {}],
  ] as const) {
    const res = await call(ctx, path, { bearer: ended, body });
    expectStatus(res, 401, `ended task token on ${path}`);
  }
  assert((await a2aRowsFrom(ids.C, ids.SCold)).length === 0, 'the ended task sent nothing');
}

async function testStaleTokenOnDiskLosesToTheSpawnMintedToken(
  ctx: AdversarialContext
): Promise<void> {
  const minted = await spawnMintedToken();
  const now = Math.floor(Date.now() / 1000);
  const cases: Array<[string, string]> = [
    // A token refreshed by the previous task, still valid, left on disk.
    [
      'refreshed token of the previous task',
      graphToken(ids.SCold, ids.C, { nowSeconds: now - 600 }),
    ],
    // This task's own token, expired while the session was paused.
    ['expired token', graphToken(ids.SC, ids.C, { nowSeconds: now - 7200, ttlSeconds: 60 })],
  ];
  for (const [label, stale] of cases) {
    const cli = cliHome();
    try {
      writeFileSync(join(cli.home, '.rose', 'agents-token'), `${stale}\n`, { mode: 0o600 });
      const env = cliEnv(ctx, cli.home, { ROSE_AGENTS_TOKEN: minted });
      const listed = await runCli(cli.roseAgents, ['list', '--json'], env);
      assert(listed.code === 0, `${label}: rose-agents list exits 0: ${listed.stderr}`);
      const self = (JSON.parse(listed.stdout) as { self_id: string }).self_id;
      assert(self === ids.SC, `${label}: acts as the live task, got ${self}`);
    } finally {
      cli.cleanup();
    }
  }

  // The shipped `rose` CLI picks the same token, so a question from the live
  // task reaches the blocked spawn instead of marking the ended task.
  const cli = cliHome();
  try {
    writeFileSync(join(cli.home, '.rose', 'agents-token'), `${cases[0][1]}\n`, { mode: 0o600 });
    await prisma.claudeCodeSession.update({
      where: { id: ids.SC },
      data: { awaitingParent: Prisma.DbNull },
    });
    const env = cliEnv(ctx, cli.home, {
      ROSE_TOOLS_URL: `${ctx.baseUrl}/api/agent-tools/${ids.C}`,
      ROSE_TOOLS_TOKEN: mintAgentToolsToken(userX, ids.C, {
        provider: 'claude',
        taskId: ids.SC,
      }).token,
      ROSE_AGENTS_TOKEN: minted,
    });
    const question = `after resume ${RUN}?`;
    const asked = await runCli(cli.rose, ['display', '--pinned', '--caption', question], env);
    assert(asked.code === 0, `rose display exits 0: ${asked.stderr}`);
    assert(
      (await awaitingParent(ids.SC))?.question === question,
      'the live task is marked for its blocked spawn'
    );
  } finally {
    cli.cleanup();
  }

  // A near-expiry token is refreshed once into ~/.rose/agents-token (0600).
  const aging = cliHome();
  try {
    const near = graphToken(ids.SC, ids.C, { nowSeconds: now - 110 * 60 });
    const env = cliEnv(ctx, aging.home, { ROSE_AGENTS_TOKEN: near });
    const first = await runCli(aging.roseAgents, ['list', '--json'], env);
    assert(first.code === 0, `near-expiry list exits 0: ${first.stderr}`);
    const file = join(aging.home, '.rose', 'agents-token');
    assert((statSync(file).mode & 0o777) === 0o600, 'refreshed token is private');
    const second = await runCli(aging.roseAgents, ['list', '--json'], env);
    assert(second.code === 0, 'the refreshed token keeps working');
  } finally {
    aging.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 10. The parent is cancelled (paused by the user) while the child asks
// ---------------------------------------------------------------------------

async function testCancelledParentStaysCancelledWhenItsChildAsks(
  ctx: AdversarialContext
): Promise<void> {
  const paused = await call(ctx, `/api/agents/${ids.P}/pause`, { userId: userX, body: {} });
  expectStatus(paused, 200, 'user pauses P');
  // P's workflow is live in this process's in-memory Temporal client, so a
  // resume attempt would really succeed (the HTTP backend has no workflow).
  const temporal = await getTemporalClient();
  await temporal.workflow.start('agentWorkflow', {
    workflowId: ids.P,
    taskQueue: 'a2a-adversarial',
    args: [],
  });
  const caller: GraphCaller = {
    userId: userX,
    rootAgentId: ids.R,
    self: { kind: 'code', id: ids.SP, ownerAgentId: ids.P, provider: 'claude' },
  };
  const asked = await askQuestion(caller, {
    question: `continue ${RUN}?`,
    message_id: `paused-q-${RUN}`,
  });
  assert(asked.deliver_to === 'agent' && asked.agent_id === ids.P, 'routed to the paused spawner');
  assert((await a2aRowsFrom(ids.P, ids.SP)).length === 1, 'the question is durable for the resume');
  const parent = await prisma.agent.findUnique({ where: { id: ids.P }, select: { status: true } });
  const signals = blackboxTemporalSignals(temporal, ids.P).map((signal) => signal.name);
  assert(
    parent?.status === 'PAUSED' && !signals.includes('resume'),
    `a child's question must not lift the user's pause (status ${parent?.status}, signals ${JSON.stringify(signals)})`
  );
  assert(
    signals.filter((name) => name === 'receive_user_response').length === 1,
    `the question reaches the paused workflow once: ${JSON.stringify(signals)}`
  );
}

export function adversarialCases(ctx: AdversarialContext): Array<[string, () => Promise<void>]> {
  return [
    [
      'adversarial: a question to a blocked spawner is handed over once',
      () => testQuestionToBlockedSpawnerIsHandedOver(ctx),
    ],
    [
      'adversarial: mutual questions between siblings never deadlock',
      () => testMutualQuestionsBetweenSiblingsNeverDeadlock(ctx),
    ],
    [
      'adversarial: a deep chain routes each level to its spawner',
      () => testDeepChainRoutesEachLevelToItsSpawner(ctx),
    ],
    [
      'adversarial: a question to a finished or deleted spawner fails clearly',
      () => testQuestionToFinishedOrDeletedSpawnerFailsClearly(ctx),
    ],
    [
      'adversarial: a duplicate message id delivers exactly once',
      () => testDuplicateMessageIdDeliversExactlyOnce(ctx),
    ],
    [
      'adversarial: a flooding sender is capped without starving others',
      () => testFloodingSenderIsCappedWithoutStarvingOthers(ctx),
    ],
    [
      'adversarial: tokens cannot reach another tree or user',
      () => testTokensCannotReachAnotherTreeOrUser(ctx),
    ],
    ['adversarial: an ended task’s token is refused', () => testEndedTaskTokenIsRefused(ctx)],
    [
      'adversarial: a stale token on disk loses to the spawn-minted token',
      () => testStaleTokenOnDiskLosesToTheSpawnMintedToken(ctx),
    ],
    [
      'adversarial: a cancelled parent stays cancelled when its child asks',
      () => testCancelledParentStaysCancelledWhenItsChildAsks(ctx),
    ],
  ];
}
