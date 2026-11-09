#!/usr/bin/env tsx
/**
 * Black-box tests for direct chat with a running code agent (Rose-builds-Rose C7).
 *
 * Covers:
 *   POST /api/agents/:id/code-agent/:taskId/messages  — owner types a turn to the CLI
 *   POST /api/agents/:id/code-agent/:taskId/hand-back — owner hands the CLI back to Rose
 *
 * The routes run in-process behind the real hybridAuth middleware. The code
 * session is the production `e2b-templates/claude-code/ws-server.mjs` on
 * localhost, running the stand-in CLI that the agents suite uses
 * (`agents/tests/fixtures/code_transcript/replay_cli.py`), so delivery, the
 * per-session token and turn dedupe are the real ones. Only persistence
 * (ClaudeCodeSession / Agent / Message rows) and the Supabase broadcast are
 * replaced, so the cases cannot touch a developer or production database.
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated → 401
 *   - tenant isolation: another user, or the session under another agent id → 404, nothing delivered
 *   - idempotency: the same client_message_id reaches the CLI once and returns the same message row
 *   - state: an invalid body → 400
 *   - resume: a stopped (closed) code agent never refuses a turn: its running
 *     owner wakes it (receive_agent_message {wake_task_id, continue_conversation,
 *     from_user}); a finished/paused owner or a foreground spawn starts
 *     CodeAgentResumeWorkflow on the stopped code session; a turn sent while
 *     that starts is queued in the spawn's startup row and delivered after it,
 *     with its files and settings; a later live run of the spawn takes turns
 *   - raw shared-state SQL (resume marker, startup row) uses the isolated local
 *     database the runner points DATABASE_URL at; the model rows stay mocked
 *   - observability: the persisted row is child-scoped (subAgentId) with action_type user_direct_turn
 *   - hand back: released once, then not_held
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import express from 'express';
import WebSocket from 'ws';
import { directTurnSchema } from '../../domains/claude-code/types';
import { prisma } from '../../providers/database';
import { codeSessionTurnToken } from '../../providers/codeSessionTurns';
import { getTemporalClient } from '../../providers/temporal';
import { blackboxTemporalSignals } from '../../providers/temporalBlackboxFake';
import { registerResumeRecoveryCases } from './claude-code-direct-chat.resume.cases';
import { deleteEphemeral, getEphemeral } from '../../providers/sharedState';
import {
  drainStartupTurns,
  forgetStartupTurns,
  startupTurnsKey,
} from '../../providers/codeSessions/startupTurns';

process.env.BACKEND_API_KEY ??= 'direct-chat-blackbox-key';
// The owner's workflow is the in-memory blackbox Temporal client: a resume
// signal is recorded, never sent to a real Temporal namespace.
process.env.BLACKBOX_TEST_FAKE_TEMPORAL = '1';
process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND = '1';
const API_KEY = process.env.BACKEND_API_KEY;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const wsServerPath = join(repoRoot, 'e2b-templates', 'claude-code', 'ws-server.mjs');
const replayCli = join(repoRoot, 'agents', 'tests', 'fixtures', 'code_transcript', 'replay_cli.py');
const python = ['python3', 'python'].find(
  (candidate) => spawnSync(candidate, ['--version']).status === 0
);

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = 'agent-direct-chat';
const TASK_ID = 'task-direct-chat';
const CLOSED_TASK_ID = 'task-direct-chat-closed';
const CLOSED_CODE_SESSION_ID = '6f8f8f4d-c670-4bc8-b5df-e2c785c4a908';

const fixtureDir = mkdtempSync(join(tmpdir(), 'direct-chat-blackbox-'));
const messages = new Map<string, Record<string, unknown>>();
// The code session's spawn chip row (first message with metadata.task_id).
let chipMetadata: Record<string, unknown> = { toolCallId: 'tc-spawn-1', code_provider: 'claude' };
let messageCreates = 0;
const OWNER_WORKFLOW = 'wf-owner-direct-chat';
// The owning Rose agent's run state + persisted background tasks (tree state).
const workflowStarts: Array<{ type: string; options: { workflowId: string; args?: unknown[] } }> =
  [];
let ownerState: Record<string, unknown> = {
  id: AGENT_ID,
  userId: OWNER,
  model: 'rose-labs/rose-1-ultra',
  status: 'ACTIVE',
  temporalWorkflowId: OWNER_WORKFLOW,
  backgroundTasks: [],
};
// Newest rows of the spawn tool call (findCodeSessionForToolCall).
let spawnRows: Array<{ metadata: Record<string, unknown> }> = [];
// A row that ended the spawn's resume (ERROR / refused / failed); null while it runs.
let resumeEndRow: { id: string } | null = null;
let sandbox: ChildProcess | undefined;
let sandboxUrl = '';
let api: Server | undefined;
let apiUrl = '';

const originals = {
  sessionFindUnique: prisma.claudeCodeSession.findUnique,
  agentFindUnique: prisma.agent.findUnique,
  agentFindFirst: prisma.agent.findFirst,
  messageFindUnique: prisma.message.findUnique,
  messageFindFirst: prisma.message.findFirst,
  messageFindMany: prisma.message.findMany,
  messageCreate: prisma.message.create,
  fetch: globalThis.fetch,
};

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

/** Turns the sandbox accepted, read from its replayable event history (what every viewer sees). */
async function sandboxUserTurns(
  types: string[] = ['user_turn']
): Promise<Array<{ turn_id: string; text: string }>> {
  return new Promise((resolveTurns, reject) => {
    const ws = new WebSocket(sandboxUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      resolveTurns([]);
    }, 2000);
    ws.on('message', (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; data?: unknown };
      if (msg.type !== 'code_agent_events' || !Array.isArray(msg.data)) return;
      clearTimeout(timer);
      ws.terminate();
      resolveTurns(
        (msg.data as Array<Record<string, unknown>>)
          .filter((event) => types.includes(String(event.type)))
          .map((event) => ({
            turn_id: String(event.client_message_id ?? event.turn_id),
            text: String(event.text),
          }))
      );
    });
    ws.on('error', reject);
  });
}

function cliStdinTexts(): string[] {
  const log = join(fixtureDir, 'cli-stdin.jsonl');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parsed = JSON.parse(line) as { message: { content: Array<{ text: string }> } };
      return parsed.message.content[0].text;
    });
}

async function startSandbox(): Promise<void> {
  assert.ok(python, 'python3 is required for the stand-in CLI');
  const port = await freePort();
  const bin = join(fixtureDir, 'bin');
  const home = join(fixtureDir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${python}" "${replayCli}" "$@"\n`, {
    mode: 0o755,
  });
  sandboxUrl = `ws://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [wsServerPath], {
    cwd: fixtureDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      PORT: String(port),
      CLAUDE_CODE_GOAL: 'Fix the bug in calc.py',
      ANTHROPIC_API_KEY: 'replay-cli-key',
      CODE_SESSION_TURN_TOKEN: codeSessionTurnToken(TASK_ID),
      REPLAY_CLI_MODE: 'claude',
      REPLAY_CLI_STDIN_LOG: join(fixtureDir, 'cli-stdin.jsonl'),
      // Hold the autonomous turn open so the session stays live for every case.
      REPLAY_CLI_GATE: fixtureDir,
    },
  });
  sandbox = child;
  // The server logs one JSON line per event; "Server listening" means ready.
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('sandbox ws-server never listened')), 15_000);
    let seen = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes('"Server listening"')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`sandbox ws-server exited (${String(code)})`));
    });
  });
}

before(async () => {
  // The owner's real credit balance (hasCreditsRemaining reads Credit / ToolUsage).
  await prisma.user.upsert({
    where: { userId: OWNER },
    create: { userId: OWNER, isAnonymous: true },
    update: {},
  });
  await prisma.credit.create({ data: { userId: OWNER, amountCents: 100_000 } });
  await startSandbox();
  prisma.claudeCodeSession.findUnique = (async ({ where }: { where: { id: string } }) => {
    if (where.id === TASK_ID) {
      return { id: TASK_ID, agentId: AGENT_ID, status: 'ACTIVE', streamUrl: sandboxUrl };
    }
    if (where.id === CLOSED_TASK_ID) {
      return {
        id: CLOSED_TASK_ID,
        agentId: AGENT_ID,
        status: 'CLOSED',
        streamUrl: null,
        codeSessionId: CLOSED_CODE_SESSION_ID,
        taskName: 'remove_rose_card_border',
      };
    }
    return null;
  }) as unknown as typeof prisma.claudeCodeSession.findUnique;
  prisma.agent.findUnique = (async ({
    where,
    select,
  }: {
    where: { id: string };
    select?: Record<string, boolean>;
  }) => {
    if (where.id !== AGENT_ID) return null;
    return select?.temporalWorkflowId ? ownerState : { userId: OWNER };
  }) as unknown as typeof prisma.agent.findUnique;
  // The resume lookups skip deleted agents (where: { id, deletedAt: null }); this one is live.
  prisma.agent.findFirst = (async (args: {
    where: { id: string };
    select?: Record<string, boolean>;
  }) => prisma.agent.findUnique(args as never)) as unknown as typeof prisma.agent.findFirst;
  prisma.message.findMany = (async () => spawnRows) as unknown as typeof prisma.message.findMany;
  const temporal = await getTemporalClient();
  const start = temporal.workflow.start.bind(temporal.workflow);
  temporal.workflow.start = (async (type: string, options: { workflowId: string }) => {
    workflowStarts.push({ type, options });
    return start(type, options as never);
  }) as typeof temporal.workflow.start;
  await temporal.workflow.start('agentWorkflow', {
    workflowId: OWNER_WORKFLOW,
    taskQueue: 'blackbox',
    args: [],
  });
  prisma.message.findFirst = (async ({ where }: { where: Record<string, unknown> }) =>
    // findResumeEndRow (a refused / failed resume of the spawn) filters by time.
    where.timestamp !== undefined
      ? resumeEndRow
      : {
          metadata: { task_id: TASK_ID, ...chipMetadata },
        }) as unknown as typeof prisma.message.findFirst;
  prisma.message.findUnique = (async ({ where }: { where: { id: string } }) =>
    messages.get(where.id) ?? null) as unknown as typeof prisma.message.findUnique;
  prisma.message.create = (async ({ data }: { data: Record<string, unknown> }) => {
    messageCreates += 1;
    const row = { timestamp: new Date(), ...data, createdAt: new Date() };
    messages.set(String(data.id), row);
    return row;
  }) as unknown as typeof prisma.message.create;
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

  const { default: router, sessionScopedRouter } =
    await import('../../domains/claude-code/routesDirectChat');
  const app = express();
  app.use(express.json());
  app.use('/api/agents', router);
  app.use('/api/claude-code-session', sessionScopedRouter);
  await new Promise<void>((resolveListen) => {
    api = app.listen(0, '127.0.0.1', () => resolveListen());
  });
  apiUrl = `http://127.0.0.1:${(api?.address() as AddressInfo).port}`;
});

after(async () => {
  await prisma.credit.deleteMany({ where: { userId: OWNER } });
  await prisma.user.deleteMany({ where: { userId: OWNER } });
  prisma.claudeCodeSession.findUnique = originals.sessionFindUnique;
  prisma.agent.findUnique = originals.agentFindUnique;
  prisma.agent.findFirst = originals.agentFindFirst;
  prisma.message.findUnique = originals.messageFindUnique;
  prisma.message.findFirst = originals.messageFindFirst;
  prisma.message.findMany = originals.messageFindMany;
  prisma.message.create = originals.messageCreate;
  globalThis.fetch = originals.fetch;
  await new Promise<void>((resolveClose) =>
    api ? api.close(() => resolveClose()) : resolveClose()
  );
  if (sandbox?.pid !== undefined) {
    try {
      process.kill(-sandbox.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(fixtureDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

async function post(
  path: string,
  body: Record<string, unknown>,
  userId: string | null = OWNER
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (userId !== null) {
    headers['X-API-Key'] = API_KEY ?? '';
    headers['X-User-Id'] = userId;
  }
  const res = await originals.fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const turnPath = (agentId = AGENT_ID, taskId = TASK_ID) =>
  `/api/agents/${agentId}/code-agent/${taskId}/messages`;

test('unauthenticated direct message is rejected', async () => {
  const res = await post(turnPath(), { client_message_id: 'cm-unauth-1', text: 'hi' }, null);
  assert.equal(res.status, 401);
});

test('owner message reaches the CLI once and retries return the same row', async () => {
  const body = { client_message_id: 'cm-owner-0001', text: 'also add a docstring' };
  const first = await post(turnPath(), body);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.status, 'delivered');
  assert.equal(first.json.agent_id, AGENT_ID);
  assert.equal(first.json.task_id, TASK_ID);
  const retry = await post(turnPath(), body);
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.equal(retry.json.status, 'duplicate');
  assert.equal(retry.json.message_id, first.json.message_id);
  assert.equal(messageCreates, 1, 'a retried turn must not persist a second row');
  assert.deepEqual(await sandboxUserTurns(), [
    { turn_id: 'cm-owner-0001', text: 'also add a docstring' },
  ]);
  const row = messages.get(String(first.json.message_id));
  const metadata = row?.metadata as Record<string, unknown>;
  assert.equal(row?.role, 'TOOL');
  assert.equal(metadata.action_type, 'user_direct_turn');
  assert.equal(metadata.subAgentId, TASK_ID, 'the row stays out of the parent planner context');
  assert.equal(metadata.direct_turn_id, 'cm-owner-0001');
  assert.equal(metadata.code_provider, 'claude');
  assert.equal(metadata.toolCallId, 'tc-spawn-1');
});

test('another user or another agent id cannot address the session', async () => {
  const before = (await sandboxUserTurns()).length;
  const stranger = await post(
    turnPath(),
    { client_message_id: 'cm-stranger-1', text: 'rm -rf /' },
    STRANGER
  );
  assert.equal(stranger.status, 404);
  assert.equal(stranger.json.code, 'CODE_SESSION_NOT_FOUND');
  const wrongAgent = await post(turnPath('agent-someone-else'), {
    client_message_id: 'cm-wrong-agent-1',
    text: 'rm -rf /',
  });
  assert.equal(wrongAgent.status, 404);
  assert.equal((await sandboxUserTurns()).length, before, 'nothing may reach the CLI');
  assert.ok(!cliStdinTexts().includes('rm -rf /'));
});

async function ownerSignals() {
  return blackboxTemporalSignals(await getTemporalClient(), OWNER_WORKFLOW).filter(
    (signal) => signal.name === 'receive_agent_message'
  );
}

function withOwner(status: string, task: Record<string, unknown> | null) {
  ownerState = {
    id: AGENT_ID,
    userId: OWNER,
    model: 'rose-labs/rose-1-ultra',
    status,
    temporalWorkflowId: OWNER_WORKFLOW,
    ownCostCents: 12,
    treeCostCents: 30,
    priceLimitCents: 500,
    backgroundTasks: task === null ? [] : [task],
  };
}

// `wakeable`: the owner's workflow holds a wake record for it (agents background_tree_entries).
const codeTask = (status: string, wakeable = true) => ({
  address: 'tc-spawn-1',
  type: 'code',
  goal: 'Remove the rose border',
  status,
  path: '/root/remove_rose_card_border',
  ...(wakeable ? { wakeable: true } : {}),
});

/** A fresh spawn state for each case: no resume in flight, an empty startup row. */
async function resetResumeState() {
  const key = startupTurnsKey(AGENT_ID, 'tc-spawn-1');
  await deleteEphemeral('code-agent-resume', key);
  await forgetStartupTurns(key);
}

const resumeStarts = () =>
  workflowStarts.filter((start) => start.type === 'CodeAgentResumeWorkflow');

test('a message to a stopped code agent resumes it through its running owner', async () => {
  for (const [status, clientId] of [
    ['paused', 'cm-closed-01'],
    ['completed', 'cm-closed-02'],
  ] as const) {
    await resetResumeState();
    withOwner('ACTIVE', codeTask(status));
    const signalsBefore = (await ownerSignals()).length;
    const turnsBefore = (await sandboxUserTurns()).length;
    const body = { client_message_id: clientId, text: `continue (${status})` };
    const res = await post(turnPath(AGENT_ID, CLOSED_TASK_ID), body);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.status, 'queued');
    assert.equal(res.json.resuming, true);
    assert.equal(res.json.task_id, CLOSED_TASK_ID);
    const signals = await ownerSignals();
    assert.equal(signals.length, signalsBefore + 1, 'one wake of the owner');
    assert.deepEqual(signals.at(-1)?.args[0], {
      message_id: res.json.message_id,
      wake_task_id: 'tc-spawn-1',
      message: `continue (${status})`,
      continue_conversation: true,
      from_user: true,
    });
    const metadata = messages.get(String(res.json.message_id))?.metadata as Record<string, unknown>;
    assert.equal(metadata.action_type, 'user_direct_turn');
    assert.equal(metadata.resume_requested, true, 'the FE shows the resume next to the timestamp');
    assert.equal(metadata.task_id, CLOSED_TASK_ID);
    assert.equal(metadata.toolCallId, 'tc-spawn-1');
    assert.equal((await sandboxUserTurns()).length, turnsBefore, 'nothing reached a CLI yet');
    const creates = messageCreates;
    const retry = await post(turnPath(AGENT_ID, CLOSED_TASK_ID), body);
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(retry.json.message_id, res.json.message_id, 'a retry keeps the same row');
    assert.equal(messageCreates, creates, 'a retry persists nothing new');
  }
});

test('an owner that finished or is paused, or a foreground spawn (listed or not), still resumes the code agent', async () => {
  const cases = [
    { owner: 'COMPLETED', task: codeTask('paused') },
    { owner: 'PAUSED', task: codeTask('completed') },
    { owner: 'ACTIVE', task: null },
    // Listed but not wakeable: a foreground spawn, or an older record with no wake.
    { owner: 'ACTIVE', task: codeTask('completed', false) },
  ];
  for (const [index, item] of cases.entries()) {
    await resetResumeState();
    withOwner(item.owner, item.task);
    const signalsBefore = (await ownerSignals()).length;
    const startsBefore = resumeStarts().length;
    const res = await post(turnPath(AGENT_ID, CLOSED_TASK_ID), {
      client_message_id: `cm-supervised-${index}`,
      text: `pick up where you left off ${index}`,
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.status, 'queued');
    assert.equal((await ownerSignals()).length, signalsBefore, 'the owner cannot run it');
    assert.equal(resumeStarts().length, startsBefore + 1, 'the supervising workflow runs it');
    const start = resumeStarts().at(-1);
    assert.equal(start?.options.workflowId, `code-resume:${AGENT_ID}:${res.json.message_id}`);
    assert.deepEqual(start?.options.args?.[0], {
      agent_id: AGENT_ID,
      user_id: OWNER,
      model: 'rose-labs/rose-1-ultra',
      tool_call_id: 'tc-spawn-1',
      task_name: 'remove_rose_card_border',
      code_session_id: CLOSED_CODE_SESSION_ID,
      code_provider: 'claude',
      message: `pick up where you left off ${index}`,
      message_id: res.json.message_id,
      attachments: [],
    });
  }
});

test('a second message while the resume starts is queued and follows the first, in order', async () => {
  await resetResumeState();
  withOwner('COMPLETED', codeTask('paused'));
  const first = await post(turnPath(AGENT_ID, CLOSED_TASK_ID), {
    client_message_id: 'cm-order-first',
    text: 'first: resume',
  });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const startsAfterFirst = resumeStarts().length;
  const pointer = {
    id: 'file-q',
    storage_path: `${OWNER}/queued.txt`,
    original_filename: 'queued.txt',
    mime_type: 'text/plain',
    size_bytes: 2,
    created_at: '2026-11-08T00:00:00Z',
  };
  const second = await post(turnPath(AGENT_ID, CLOSED_TASK_ID), {
    client_message_id: 'cm-order-second',
    text: 'second: also this',
    attachments: [pointer],
    speed: 'fast',
  });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.status, 'queued', 'never CODE_SESSION_STARTING');
  assert.equal(resumeStarts().length, startsAfterFirst, 'no second run');
  const key = startupTurnsKey(AGENT_ID, 'tc-spawn-1');
  const row = await getEphemeral<{ turns: Array<Record<string, unknown>> }>(
    'code-startup-turns',
    key
  );
  assert.deepEqual(
    row?.turns.map((turn) => (turn.user as Record<string, unknown>).clientMessageId),
    ['cm-order-second']
  );
  const queued = row?.turns[0].user as Record<string, unknown>;
  assert.deepEqual(queued.settings, { speed: 'fast' }, 'its per-turn settings ride along');
  assert.deepEqual(queued.attachments, [pointer], 'and its files');
  const metadata = messages.get(String(second.json.message_id))?.metadata as Record<
    string,
    unknown
  >;
  assert.equal(metadata.resume_requested, true);
  // The resumed run's create returns: the queued turn reaches its CLI with its own id.
  await drainStartupTurns(key, TASK_ID);
  // Written to the CLI, or held by the ws-server behind the person's own direct
  // chat (an agent-sender turn waits for the hand back): accepted either way.
  assert.ok(
    (await sandboxUserTurns(['user_turn', 'user_turn_queued'])).some(
      (turn) => turn.turn_id === 'cm-order-second'
    ),
    'the queued turn was delivered after the resume (its unsupported speed is not applied)'
  );
});

registerResumeRecoveryCases({
  post: (path, body, userId) => post(path, body, userId),
  closedTurnPath: () => turnPath(AGENT_ID, CLOSED_TASK_ID),
  owner: OWNER,
  stranger: STRANGER,
  agentId: AGENT_ID,
  startFinishedOwner: async () => {
    await resetResumeState();
    withOwner('COMPLETED', codeTask('paused'));
  },
  resetResumeState,
  resumeStarts,
  setResumeEndRow: (row) => {
    resumeEndRow = row;
  },
  setOwner: (status, task) => withOwner(status, task),
  codeTask,
  seedRow: (id, row) => {
    messages.set(id, row);
  },
  closedTaskId: CLOSED_TASK_ID,
});

test('a later live run of the same spawn takes the turn', async () => {
  spawnRows = [{ metadata: { task_id: TASK_ID, toolCallId: 'tc-spawn-1' } }];
  try {
    const res = await post(turnPath(AGENT_ID, CLOSED_TASK_ID), {
      client_message_id: 'cm-later-run-1',
      text: 'now on the resumed run',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.status, 'delivered');
    assert.equal(res.json.task_id, TASK_ID, 'delivered to the live run');
    assert.ok(
      (await sandboxUserTurns()).some((turn) => turn.text === 'now on the resumed run'),
      'the live CLI got the turn'
    );
  } finally {
    spawnRows = [];
  }
});

test('invalid bodies are rejected before delivery', async () => {
  const empty = await post(turnPath(), { client_message_id: 'cm-empty-01', text: '   ' });
  assert.equal(empty.status, 400);
  const noId = await post(turnPath(), { text: 'missing id' });
  assert.equal(noId.status, 400);
});

test('session route turns persist the provider and chip of a Codex session', async () => {
  chipMetadata = { toolCallId: 'tc-spawn-codex', code_provider: 'codex' };
  try {
    const res = await post(`/api/claude-code-session/${TASK_ID}/turns`, {
      client_message_id: 'cm-codex-0001',
      text: 'codex: also run the linter',
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.code_provider, 'codex');
    const row = messages.get(String(res.json.message_id));
    const metadata = row?.metadata as Record<string, unknown>;
    assert.equal(metadata.code_provider, 'codex', 'a Codex session row must not say claude');
    assert.equal(metadata.toolCallId, 'tc-spawn-codex', 'the row groups under the spawn chip');
    const stranger = await post(
      `/api/claude-code-session/${TASK_ID}/turns`,
      { client_message_id: 'cm-codex-stranger', text: 'hi' },
      STRANGER
    );
    assert.equal(stranger.status, 404);
  } finally {
    chipMetadata = { toolCallId: 'tc-spawn-1', code_provider: 'claude' };
  }
});

test('hand back releases the hold once', async () => {
  const path = `/api/agents/${AGENT_ID}/code-agent/${TASK_ID}/hand-back`;
  const first = await post(path, {});
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.status, 'released');
  const again = await post(path, {});
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'not_held');
});

test('direct turns reject foreign attachments before any storage read or delivery', async () => {
  const beforeTurns = await sandboxUserTurns();
  const response = await originals.fetch(`${apiUrl}/api/claude-code-session/${TASK_ID}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY, 'X-User-Id': OWNER },
    body: JSON.stringify({
      client_message_id: 'foreign-attachment',
      text: '',
      attachments: [
        {
          id: 'file-one',
          storage_path: `${STRANGER}/notes.txt`,
          original_filename: 'notes.txt',
          mime_type: 'text/plain',
          size_bytes: 2,
          created_at: '2026-10-20T00:00:00Z',
        },
      ],
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { code: string }).code, 'INVALID_ATTACHMENT');
  assert.deepEqual(await sandboxUserTurns(), beforeTurns);
});

// Provider catalog tier IDs must survive the HTTP boundary unchanged.
test('direct-turn validation accepts the advertised native priority tier and rejects invented tiers', () => {
  const turn = { client_message_id: 'native-priority-tier', text: 'continue', speed: 'priority' };
  const parsed = directTurnSchema.safeParse(turn);
  assert.equal(parsed.success, true, JSON.stringify(parsed));
  if (parsed.success) assert.equal(parsed.data.speed, 'priority');
  assert.equal(directTurnSchema.safeParse({ ...turn, speed: 'invented-tier' }).success, false);
});
