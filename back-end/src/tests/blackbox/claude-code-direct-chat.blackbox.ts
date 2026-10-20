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
 *   - state: a closed session → 409; an invalid body → 400
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
import { prisma } from '../../providers/database';
import { codeSessionTurnToken } from '../../providers/codeSessionTurns';

process.env.BACKEND_API_KEY ??= 'direct-chat-blackbox-key';
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

const fixtureDir = mkdtempSync(join(tmpdir(), 'direct-chat-blackbox-'));
const messages = new Map<string, Record<string, unknown>>();
let messageCreates = 0;
let sandbox: ChildProcess | undefined;
let sandboxUrl = '';
let api: Server | undefined;
let apiUrl = '';

const originals = {
  sessionFindUnique: prisma.claudeCodeSession.findUnique,
  agentFindUnique: prisma.agent.findUnique,
  messageFindUnique: prisma.message.findUnique,
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
async function sandboxUserTurns(): Promise<Array<{ turn_id: string; text: string }>> {
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
          .filter((event) => event.type === 'user_turn')
          .map((event) => ({ turn_id: String(event.turn_id), text: String(event.text) }))
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
  await startSandbox();
  prisma.claudeCodeSession.findUnique = (async ({ where }: { where: { id: string } }) => {
    if (where.id === TASK_ID) {
      return { id: TASK_ID, agentId: AGENT_ID, status: 'ACTIVE', streamUrl: sandboxUrl };
    }
    if (where.id === CLOSED_TASK_ID) {
      return { id: CLOSED_TASK_ID, agentId: AGENT_ID, status: 'CLOSED', streamUrl: null };
    }
    return null;
  }) as unknown as typeof prisma.claudeCodeSession.findUnique;
  prisma.agent.findUnique = (async ({ where }: { where: { id: string } }) =>
    where.id === AGENT_ID ? { userId: OWNER } : null) as unknown as typeof prisma.agent.findUnique;
  prisma.message.findUnique = (async ({ where }: { where: { id: string } }) =>
    messages.get(where.id) ?? null) as unknown as typeof prisma.message.findUnique;
  prisma.message.create = (async ({ data }: { data: Record<string, unknown> }) => {
    messageCreates += 1;
    const row = { ...data, createdAt: new Date() };
    messages.set(String(data.id), row);
    return row;
  }) as unknown as typeof prisma.message.create;
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

  const { default: router } = await import('../../domains/claude-code/directChatRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/agents', router);
  await new Promise<void>((resolveListen) => {
    api = app.listen(0, '127.0.0.1', () => resolveListen());
  });
  apiUrl = `http://127.0.0.1:${(api?.address() as AddressInfo).port}`;
});

after(async () => {
  prisma.claudeCodeSession.findUnique = originals.sessionFindUnique;
  prisma.agent.findUnique = originals.agentFindUnique;
  prisma.message.findUnique = originals.messageFindUnique;
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

test('closed session and invalid bodies are rejected before delivery', async () => {
  const closed = await post(turnPath(AGENT_ID, CLOSED_TASK_ID), {
    client_message_id: 'cm-closed-01',
    text: 'hello?',
  });
  assert.equal(closed.status, 409);
  assert.equal(closed.json.code, 'CODE_SESSION_CLOSED');
  const empty = await post(turnPath(), { client_message_id: 'cm-empty-01', text: '   ' });
  assert.equal(empty.status, 400);
  const noId = await post(turnPath(), { text: 'missing id' });
  assert.equal(noId.status, 400);
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
