#!/usr/bin/env tsx
/**
 * Black-box tests for /api/agent-graph (code agents in the Rose agent graph,
 * Rose-builds-Rose C6 + question routing by spawner, UI ledger 47b).
 *
 * Domain surface:
 *   GET  /api/agent-graph/agents          tree listing incl. code agents
 *   POST /api/agent-graph/messages        A2A send (Rose agent | code agent)
 *   POST /api/agent-graph/grep            trajectory grep pinned to the tree
 *   GET  /api/agent-graph/question-route  { deliver_to, agent_id }
 *   POST /api/agent-graph/questions       removed: code agents cannot ask (404)
 *   POST /api/agent-graph/token           refresh a code-session token
 *
 * Fixture tree (user A):      R (root) ── C ── G      R2 (user B) ── S3
 *                             │           └ S1 (code, spawned by C)
 *                             ├ S2 (code, spawned by R)
 *                             └ S4 (code, spawned by R, live ws-server)
 *
 * Invariants covered:
 *   - send code → Rose agent: one USER row on the target + one "sent" chip in
 *     the code agent's own timeline; retry with the same id → duplicate, no
 *     new rows; `parent` alias resolves to the spawner
 *   - scope: other user's tree, other user's code agent, unknown id → 404;
 *     cross-tree grep agent_id → 404
 *   - token: missing / expired / wrong scope / tampered / deleted session → 401;
 *     refresh keeps the claims; API-key callers cannot refresh
 *   - code agents cannot ask: GET question-route is read-only and POST
 *     /questions is gone (404), sending nothing
 *   - root → running code agent (the production Claude ws-server.mjs with a
 *     scripted CLI): delivered once to the CLI as a user turn across a
 *     retried send, answered before the CLI exits; a finished session → 409
 *   - adversarial scenarios (agent-graph-adversarial.cases.ts): sibling message
 *     cycles, deep-chain routing, finished / deleted spawners, duplicate message
 *     ids, flooding, cross-tree isolation and stale tokens
 *
 * Usage: bash scripts/run-blackbox-tests.sh agent-graph
 */
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { createServer } from 'net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { mintAgentGraphToken } from '../../providers/agentGraph/token';
import { codeSessionTurnToken } from '../../providers/codeSessionTurns';
import { deterministicMessageId } from '../../providers/messageIdempotency';
import { testRoseAgentHasOneUiOnlySentReceipt, killCases } from './agent-graph-receipts.cases';
import {
  testCodeAgentListIsNewestFirstPerRoot,
  testCodeAgentProviderInTreeAndBatchedList,
} from './agent-graph-code-agents.cases';
import {
  adversarialCases,
  cleanupAdversarial,
  seedAdversarial,
} from './agent-graph-adversarial.cases';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const WS_SERVER = resolve(__dirname, '../../../../e2b-templates/claude-code/ws-server.mjs');

interface Res {
  status: number;
  data: Record<string, unknown>;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; bearer?: string; agentId?: string } = {}
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.bearer !== undefined) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.agentId !== undefined) {
    headers['X-API-Key'] = API_KEY;
    headers['X-Agent-Id'] = init.agentId;
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}

function expectStatus(res: Res, status: number, label: string): void {
  assert(
    res.status === status,
    `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN = randomUUID().slice(0, 8);
const userA = `a2a-a-${RUN}`;
const userB = `a2a-b-${RUN}`;
const ids = {
  R: randomUUID(),
  C: randomUUID(),
  G: randomUUID(),
  R2: randomUUID(),
  S1: randomUUID(),
  S2: randomUUID(),
  S3: randomUUID(),
  S4: randomUUID(),
};
const toolCallS1 = `tc-s1-${RUN}`;

async function seed(): Promise<void> {
  await prisma.user.create({ data: { userId: userA, name: 'Graph Owner' } });
  await prisma.user.create({ data: { userId: userB, name: 'Other Owner' } });
  // Running agents: a USER message is a workflow signal (the blackbox
  // backend's in-memory Temporal client), never a chat-mode LLM reply.
  const agent = (id: string, userId: string, parentAgentId: string | null, busId: string) =>
    prisma.agent.create({
      data: {
        id,
        userId,
        parentAgentId,
        busId,
        goal: `goal ${id}`,
        status: 'ACTIVE',
        temporalWorkflowId: id,
        parentWorkflowId: parentAgentId,
      },
    });
  await agent(ids.R, userA, null, ids.R);
  await agent(ids.C, userA, ids.R, ids.R);
  await agent(ids.G, userA, ids.C, ids.R);
  await agent(ids.R2, userB, null, ids.R2);
  const session = (id: string, agentId: string, streamUrl: string | null) =>
    prisma.claudeCodeSession.create({
      data: { id, agentId, sandboxId: `sb-${id}`, streamUrl, goal: `code ${id}`, status: 'ACTIVE' },
    });
  await session(ids.S1, ids.C, 'ws://127.0.0.1:9/unused');
  await session(ids.S2, ids.R, 'ws://127.0.0.1:9/unused');
  await session(ids.S3, ids.R2, 'ws://127.0.0.1:9/unused');
  // The spawn chip a code session renders under (provider + tool call id).
  await prisma.message.create({
    data: {
      agentId: ids.C,
      role: 'TOOL',
      text: 'Codex started',
      metadata: {
        toolCallId: toolCallS1,
        toolName: 'spawn_claude_code_agent',
        toolStatus: 'IN_PROGRESS',
        task_id: ids.S1,
        code_provider: 'codex',
      },
    },
  });
}

async function cleanup(): Promise<void> {
  const agentIds = [ids.G, ids.C, ids.R, ids.R2];
  await prisma.claudeCodeSession.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.message.deleteMany({ where: { agentId: { in: agentIds } } });
  for (const id of agentIds) await prisma.agent.deleteMany({ where: { id } });
  await prisma.user.deleteMany({ where: { userId: { in: [userA, userB] } } });
}

function codeToken(
  sessionId: string,
  ownerAgentId: string,
  options: { scope?: string; ttlSeconds?: number; nowSeconds?: number; userId?: string } = {}
): string {
  return mintAgentGraphToken(
    {
      sub: options.userId ?? userA,
      rootAgentId: ids.R,
      ownerAgentId,
      sessionId,
      provider: 'codex',
    },
    options
  ).token;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function testListIsScopedToTheTree(): Promise<void> {
  const res = await call('/api/agent-graph/agents', { bearer: codeToken(ids.S1, ids.C) });
  expectStatus(res, 200, 'list as S1');
  const agents = res.data.agents as Array<{ id: string; kind: string; relation: string }>;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const id of [ids.R, ids.C, ids.G, ids.S1, ids.S2]) {
    assert(byId.has(id), `list must include ${id}: ${JSON.stringify(agents)}`);
  }
  assert(!byId.has(ids.R2) && !byId.has(ids.S3), 'list must exclude the other user tree');
  assert(byId.get(ids.S1)?.relation === 'self', 'S1 is self');
  assert(byId.get(ids.C)?.relation === 'parent', 'C is the parent of S1');
  assert(byId.get(ids.R)?.relation === 'root', 'R is root');
  assert(byId.get(ids.S2)?.kind === 'code', 'S2 is listed as a code agent');
  assert(res.data.self_id === ids.S1 && res.data.root_agent_id === ids.R, 'self/root ids');

  const internal = await call('/api/agent-graph/agents', { agentId: ids.G });
  expectStatus(internal, 200, 'list as G via API key');
  const internalIds = (internal.data.agents as Array<{ id: string }>).map((agent) => agent.id);
  assert(
    internalIds.includes(ids.S1) && internalIds.includes(ids.S2),
    'Rose agents see code agents'
  );

  const tree = await fetch(`${BASE_URL}/api/agents/tree?busId=${ids.R}`, {
    headers: { 'X-API-Key': API_KEY },
  });
  const treeBody = (await tree.json()) as {
    agents: Array<{ agent_id: string }>;
    code_agents: Array<{ code_agent_id: string; owner_agent_id: string }>;
  };
  assert(tree.status === 200, `agent tree: ${tree.status}`);
  const codeIds = treeBody.code_agents.map(
    (code) => `${code.code_agent_id}:${code.owner_agent_id}`
  );
  assert(
    codeIds.includes(`${ids.S1}:${ids.C}`) && codeIds.includes(`${ids.S2}:${ids.R}`),
    `agent tree code_agents: ${JSON.stringify(treeBody.code_agents)}`
  );
  assert(treeBody.agents.length === 3, 'agent tree rows keep the Agent shape (3 Rose agents)');
}

async function countRows(agentId: string, a2aKey: string): Promise<number> {
  return prisma.message.count({
    where: { agentId, metadata: { path: ['idempotencyKey'], string_starts_with: a2aKey } },
  });
}

async function testCodeAgentMessagesRoseAgentOnce(): Promise<void> {
  const messageId = `m-${RUN}`;
  const token = codeToken(ids.S1, ids.C);
  const first = await call('/api/agent-graph/messages', {
    bearer: token,
    body: { to: ids.R, text: `build finished ${RUN}`, message_id: messageId },
  });
  expectStatus(first, 200, 'S1 → R');
  assert(first.data.status === 'delivered', `first send delivered: ${JSON.stringify(first.data)}`);
  const retry = await call('/api/agent-graph/messages', {
    bearer: token,
    body: { to: ids.R, text: `build finished ${RUN}`, message_id: messageId },
  });
  expectStatus(retry, 200, 'S1 → R retry');
  assert(retry.data.status === 'duplicate', 'retry with the same id is a duplicate');

  const key = `a2a:${ids.S1}:${messageId}`;
  const userRow = await prisma.message.findUnique({
    where: { id: deterministicMessageId(ids.R, key) },
  });
  assert(userRow !== null && userRow.role === 'USER', 'R has the USER message');
  assert(
    userRow.text.includes('Codex') && userRow.text.includes(`build finished ${RUN}`),
    'framed'
  );
  const meta = userRow.metadata as {
    a2a?: { from?: { id?: string; kind?: string }; text?: string };
  };
  assert(meta.a2a?.from?.id === ids.S1 && meta.a2a.from.kind === 'code', 'a2a sender metadata');
  assert(
    meta.a2a.text === `build finished ${RUN}`,
    `a2a.text is the sender's raw text without the LLM framing: ${JSON.stringify(meta.a2a.text)}`
  );
  assert((await countRows(ids.R, key)) === 1, 'exactly one USER row on R after retry');

  const sent = await prisma.message.findMany({
    where: { agentId: ids.C, metadata: { path: ['idempotencyKey'], equals: `${key}:sent` } },
  });
  assert(sent.length === 1, `exactly one sent chip in the code timeline (got ${sent.length})`);
  const sentMeta = sent[0].metadata as Record<string, unknown>;
  assert(sentMeta.subAgentId === ids.S1, 'sent chip is child-scoped to the code agent');
  assert(sentMeta.toolCallId === toolCallS1, 'sent chip renders under the spawn chip');
  assert(
    String(sentMeta.title).startsWith('Codex → '),
    `sent chip title ${String(sentMeta.title)}`
  );

  const parent = await call('/api/agent-graph/messages', {
    bearer: token,
    body: { to: 'parent', text: 'status?', message_id: `p-${RUN}` },
  });
  expectStatus(parent, 200, 'S1 → parent');
  assert((parent.data.to as { id: string }).id === ids.C, '`parent` resolves to the spawner');
}

async function testScopeIsTheOwnTree(): Promise<void> {
  const token = codeToken(ids.S1, ids.C);
  for (const [label, to] of [
    ['other user root', ids.R2],
    ['other user code agent', ids.S3],
    ['unknown id', randomUUID()],
  ] as const) {
    const res = await call('/api/agent-graph/messages', {
      bearer: token,
      body: { to, text: 'hi', message_id: `x-${label.replace(/\s/g, '-')}` },
    });
    expectStatus(res, 404, `S1 → ${label}`);
  }
  const otherAgent = await call('/api/agent-graph/messages', {
    agentId: ids.R2,
    body: { to: ids.C, text: 'hi', message_id: `x-r2-${RUN}` },
  });
  expectStatus(otherAgent, 404, 'R2 (user B) → C');
  const grep = await call('/api/agent-graph/grep', {
    bearer: token,
    body: { pattern: 'goal', agent_id: ids.R2 },
  });
  expectStatus(grep, 404, 'grep into another tree');
  const self = await call('/api/agent-graph/messages', {
    bearer: token,
    body: { to: ids.S1, text: 'hi', message_id: `self-${RUN}` },
  });
  expectStatus(self, 400, 'cannot message yourself');
  // A forged claim for a session owned by another tree's agent is rejected
  // at the live-session check even with a valid signature.
  const forged = codeToken(ids.S3, ids.C);
  expectStatus(await call('/api/agent-graph/agents', { bearer: forged }), 401, 'forged owner');
}

async function testTokenScopeAndExpiry(): Promise<void> {
  expectStatus(await call('/api/agent-graph/agents'), 401, 'no credentials');
  const now = Math.floor(Date.now() / 1000);
  const expired = codeToken(ids.S1, ids.C, { nowSeconds: now - 7200, ttlSeconds: 60 });
  const expiredRes = await call('/api/agent-graph/agents', { bearer: expired });
  expectStatus(expiredRes, 401, 'expired token');
  assert(String(expiredRes.data.error).includes('expired'), 'expired reason');
  const wrongScope = codeToken(ids.S1, ids.C, { scope: 'user-ui-publish' });
  expectStatus(await call('/api/agent-graph/agents', { bearer: wrongScope }), 401, 'wrong scope');
  const valid = codeToken(ids.S1, ids.C);
  const tampered = `${valid.slice(0, -4)}${valid.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
  expectStatus(await call('/api/agent-graph/agents', { bearer: tampered }), 401, 'tampered');
  const gone = codeToken(randomUUID(), ids.C);
  expectStatus(await call('/api/agent-graph/agents', { bearer: gone }), 401, 'unknown session');

  // A token minted 90 minutes ago (still valid, 30 minutes left) is swapped
  // for one with a later expiry.
  const aging = codeToken(ids.S1, ids.C, { nowSeconds: now - 90 * 60 });
  const refreshed = await call('/api/agent-graph/token', { method: 'POST', bearer: aging });
  expectStatus(refreshed, 200, 'refresh');
  const next = String(refreshed.data.token);
  const expiry = (token: string): number =>
    (
      JSON.parse(Buffer.from(token.slice(4).split('.')[0], 'base64url').toString('utf8')) as {
        exp: number;
      }
    ).exp;
  assert(next.startsWith('rag.') && expiry(next) > expiry(aging), 'refresh extends the expiry');
  assert(
    new Date(String(refreshed.data.expires_at)).getTime() === expiry(next) * 1000,
    'expires_at matches the new token'
  );
  const asNext = await call('/api/agent-graph/agents', { bearer: next });
  expectStatus(asNext, 200, 'refreshed token works');
  assert(asNext.data.self_id === ids.S1, 'refreshed token keeps the session claims');
  const internalRefresh = await call('/api/agent-graph/token', { method: 'POST', agentId: ids.R });
  expectStatus(internalRefresh, 400, 'API-key callers cannot refresh');
}

async function testQuestionRoutingBySpawner(): Promise<void> {
  const fromRootSpawned = await call('/api/agent-graph/question-route', {
    bearer: codeToken(ids.S2, ids.R),
  });
  expectStatus(fromRootSpawned, 200, 'route S2');
  assert(
    fromRootSpawned.data.deliver_to === 'user' && fromRootSpawned.data.agent_id === ids.R,
    `root-spawned → user: ${JSON.stringify(fromRootSpawned.data)}`
  );
  const fromChildSpawned = await call('/api/agent-graph/question-route', {
    bearer: codeToken(ids.S1, ids.C),
  });
  expectStatus(fromChildSpawned, 200, 'route S1');
  assert(
    fromChildSpawned.data.deliver_to === 'agent' && fromChildSpawned.data.agent_id === ids.C,
    `non-root-spawned → spawner: ${JSON.stringify(fromChildSpawned.data)}`
  );

  // Code agents cannot ask: the questions route is gone, whoever spawned them.
  const before = {
    R: await prisma.message.count({ where: { agentId: ids.R } }),
    C: await prisma.message.count({ where: { agentId: ids.C } }),
  };
  for (const [sessionId, owner] of [
    [ids.S2, ids.R],
    [ids.S1, ids.C],
  ] as const) {
    const asked = await call('/api/agent-graph/questions', {
      bearer: codeToken(sessionId, owner),
      body: { question: `Postgres or SQLite ${RUN}?`, message_id: `q-${sessionId}-${RUN}` },
    });
    // The route is gone: the request falls through to the generic API auth.
    assert(
      asked.status === 401 || asked.status === 404,
      `${sessionId} cannot ask: ${asked.status}`
    );
  }
  assert(
    (await prisma.message.count({ where: { agentId: ids.R } })) === before.R &&
      (await prisma.message.count({ where: { agentId: ids.C } })) === before.C,
    'a refused question sends nothing'
  );
}

async function testGrepIsPinnedToTheTree(): Promise<void> {
  const res = await call('/api/agent-graph/grep', {
    bearer: codeToken(ids.S1, ids.C),
    body: { pattern: `build finished ${RUN}` },
  });
  expectStatus(res, 200, 'grep own tree');
  const matches = (res.data.matches ?? []) as Array<{ path: string }>;
  assert(
    matches.every((match) => match.path.startsWith(`agent_trajectories/${ids.R}`)),
    `grep paths stay in the tree: ${JSON.stringify(matches).slice(0, 300)}`
  );
}

// ---------------------------------------------------------------------------
// Live code agent: the production ws-server with a scripted Claude CLI
// ---------------------------------------------------------------------------

const STUB_CLAUDE = String.raw`
const fs = require('fs');
const path = require('path');
const gate = process.env.STUB_GATE;
const record = (entry) => fs.appendFileSync(path.join(gate, 'turns.jsonl'), JSON.stringify(entry) + '\n');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const queue = [];
let busy = false;
let ended = false;
let first = true;
async function waitFor(name) {
  while (!fs.existsSync(path.join(gate, name))) await new Promise((r) => setTimeout(r, 50));
}
async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length > 0) {
    const message = queue.shift();
    const text = message.message.content.map((part) => part.text).join('');
    record({ text });
    if (first) {
      first = false;
      emit({ type: 'system', subtype: 'init', session_id: 'stub', cwd: process.cwd(), model: 'stub', tools: [] });
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on the task' }] } });
      await waitFor('release');
    } else {
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'got: ' + text.slice(-40) }] } });
    }
    emit({ type: 'result', subtype: 'success', result: 'turn done', usage: {} });
  }
  busy = false;
  if (ended) process.exit(0);
}
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === 'control_request') {
      emit({ type: 'control_response', response: {
        subtype: 'success', request_id: message.request_id,
        response: message.request.subtype === 'initialize' ? { models: [{
          value: 'sonnet', supportedEffortLevels: ['medium'], supportsFastMode: true,
        }] } : {},
      } });
    } else queue.push(message);
  }
  void drain();
});
process.stdin.on('end', () => {
  ended = true;
  if (!busy) process.exit(0);
});
`;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
    server.on('error', reject);
  });
}

async function waitUntil(
  check: () => boolean,
  label: string,
  deadline = Date.now() + 15_000
): Promise<void> {
  if (check()) return;
  if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  return waitUntil(check, label, deadline);
}

async function testRootMessagesRunningCodeAgentOnce(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-sandbox-'));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(dir, 'stub-claude.js'), STUB_CLAUDE);
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\nexec "${process.execPath}" "${dir}/stub-claude.js"\n`,
    {
      mode: 0o755,
    }
  );
  const port = await freePort();
  let server: ChildProcess | null = null;
  try {
    server = spawn(process.execPath, [WS_SERVER], {
      cwd: home,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        PORT: String(port),
        CLAUDE_CODE_GOAL: 'Write answer.txt',
        ANTHROPIC_API_KEY: 'stub-key',
        CODE_SESSION_TURN_TOKEN: codeSessionTurnToken(ids.S4),
        STUB_GATE: dir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const logChunks: string[] = [];
    server.stdout?.on('data', (chunk: Buffer) => logChunks.push(chunk.toString()));
    server.stderr?.on('data', (chunk: Buffer) => logChunks.push(chunk.toString()));
    const turnsFile = join(dir, 'turns.jsonl');
    const turns = (): Array<{ text: string }> =>
      existsSync(turnsFile)
        ? readFileSync(turnsFile, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { text: string })
        : [];
    await waitUntil(() => turns().length === 1, 'the CLI to start the task turn');

    await prisma.claudeCodeSession.create({
      data: {
        id: ids.S4,
        agentId: ids.R,
        sandboxId: `sb-${ids.S4}`,
        streamUrl: `ws://127.0.0.1:${port}`,
        goal: 'live code agent',
        status: 'ACTIVE',
      },
    });

    const body = { to: ids.S4, text: `use port ${RUN}`, message_id: `root-${RUN}` };
    const first = await call('/api/agent-graph/messages', { agentId: ids.R, body });
    expectStatus(first, 200, 'R → S4');
    assert(first.data.status === 'delivered', `delivered: ${JSON.stringify(first.data)}`);
    const retry = await call('/api/agent-graph/messages', { agentId: ids.R, body });
    expectStatus(retry, 200, 'R → S4 retry');
    assert(
      retry.data.status === 'duplicate',
      `retry is a duplicate: ${JSON.stringify(retry.data)}`
    );

    // The message arrived mid-run: the CLI answers it after the task turn,
    // before stdin closes, and exactly once.
    writeFileSync(join(dir, 'release'), '');
    await waitUntil(() => turns().length >= 2, 'the agent turn to reach the CLI');
    await waitUntil(
      () => logChunks.join('').includes('Claude Code CLI exited'),
      'the CLI to exit after both turns'
    );
    const delivered = turns().filter((turn) => turn.text.includes(`use port ${RUN}`));
    assert(delivered.length === 1, `CLI got the message once: ${JSON.stringify(turns())}`);
    assert(delivered[0].text.startsWith('[Message from Root agent'), 'framed for a code agent');
    assert(delivered[0].text.includes(`rose-agents send ${ids.R}`), 'tells the CLI how to reply');

    const key = `a2a:${ids.R}:root-${RUN}`;
    const chips = await prisma.message.findMany({
      where: { agentId: ids.R, metadata: { path: ['idempotencyKey'], equals: `${key}:received` } },
    });
    assert(chips.length === 1, `one received chip on the owner (got ${chips.length})`);
    assert((chips[0].metadata as Record<string, unknown>).subAgentId === ids.S4, 'child-scoped');

    const late = await call('/api/agent-graph/messages', {
      agentId: ids.R,
      body: { to: ids.S4, text: 'too late', message_id: `late-${RUN}` },
    });
    expectStatus(late, 409, 'finished session');
  } finally {
    if (server?.pid !== undefined) {
      try {
        process.kill(-server.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

const cases: Array<[string, () => Promise<void>]> = [
  ['list is scoped to the tree and includes code agents', testListIsScopedToTheTree],
  ['code agent messages a Rose agent once', testCodeAgentMessagesRoseAgentOnce],
  [
    'Rose agent sent receipt is UI-only and idempotent',
    () =>
      testRoseAgentHasOneUiOnlySentReceipt({ baseUrl: BASE_URL, apiKey: API_KEY, ids, run: RUN }),
  ],
  ['scope is the own tree (cross-tree 404)', testScopeIsTheOwnTree],
  ['token scope, expiry and refresh', testTokenScopeAndExpiry],
  ['question route is read-only; code agents cannot ask', testQuestionRoutingBySpawner],
  ['grep is pinned to the tree', testGrepIsPinnedToTheTree],
  ['root messages a running code agent once', testRootMessagesRunningCodeAgentOnce],
  [
    'code agents report their provider in the tree and the batched list',
    () =>
      testCodeAgentProviderInTreeAndBatchedList({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        userA,
        userB,
        ids,
      }),
  ],
  [
    'the batched code-agent list is newest first, at most 50 per root',
    () =>
      testCodeAgentListIsNewestFirstPerRoot({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        userA,
        userB,
        ids,
      }),
  ],
  ...adversarialCases({ baseUrl: BASE_URL, apiKey: API_KEY }),
];

async function main(): Promise<void> {
  assert(API_KEY !== '', 'BACKEND_API_KEY is required');
  let failed = 0;
  try {
    await seed();
    await seedAdversarial();
    for (const [name, fn] of cases.concat(killCases(BASE_URL, API_KEY, ids, userA, codeToken))) {
      try {
        await fn();
        process.stdout.write(`  ✅ ${name}\n`);
      } catch (err) {
        failed += 1;
        process.stdout.write(`  ❌ ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } finally {
    await cleanup();
    await cleanupAdversarial();
    await prisma.$disconnect();
  }
  process.stdout.write(`\n${cases.length - failed}/${cases.length} agent-graph cases passed\n`);
  if (failed > 0) process.exit(1);
}

void main();
