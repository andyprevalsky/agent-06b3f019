/**
 * A resumed code session keeps the CLI that was running when it paused (T8),
 * run inside code-sessions.blackbox.ts. The sandbox is the fake E2B sandbox over
 * a local HOME; the ws-server is the production
 * `e2b-templates/claude-code/ws-server.mjs` with a scripted `claude` CLI, and
 * the E2B pause is a SIGSTOP of its whole process tree (E2B freezes memory and
 * processes; live probe 2026-11-04):
 *
 *   spawn 1: ws-server ─► CLI ─► Bash tool (a loop writing counter.txt)
 *   pause:   SIGSTOP the tree (task closed resumably)
 *   spawn 2: connect (SIGCONT) ─► acquire ─► attachLiveCodeCli
 *              ├─ live CLI with stdin open + same credential ─► goal delivered as a turn;
 *              │    the loop keeps writing, the same CLI answers both turns
 *              └─ CLI finished / credential changed ─► stale ws-server stopped (restart path)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import {
  codeSessionTurnToken,
  deliverUserTurnToCodeSession,
} from '../../providers/codeSessionTurns';
import { markPaused } from '../../providers/codeSessions/store';
import { createWithCodeSession } from '../../providers/codeSessions/spawn';
import * as codeSessionSandbox from '../../providers/e2bCodeSessionSandbox';
import type { CodeSessionLifecycleContext } from './code-sessions-lifecycle.cases';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const wsServerPath = join(repoRoot, 'e2b-templates', 'claude-code', 'ws-server.mjs');
const LOOP_LINES = 120;

// Scripted Claude Code CLI (stream-json). Turn 1 runs a Bash tool: a loop
// appending 1..LOOP_LINES to counter.txt. A turn written while it runs is
// merged into it (one result, queued_turn_count 0), as Claude Code does. Like
// the real CLI, SIGTERM takes its shells with it. STUB_MODE=finish answers
// turn 1 at once (an autonomous run whose stdin then closes).
const STUB_CLI = String.raw`
const {createInterface}=require('node:readline');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const dir=process.env.STUB_DIR;
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
let loop=null,turn=0,queued=0;
process.on('SIGTERM',()=>{if(loop)loop.kill('SIGKILL');process.exit(143);});
const rl=createInterface({input:process.stdin});
rl.on('line',line=>{
 const msg=JSON.parse(line);
 if(msg.type==='control_request'){send({type:'control_response',response:{request_id:msg.request_id,subtype:'success',response:{models:[]}}});return;}
 if(msg.type!=='user')return;
 turn++;
 const text=msg.message.content.map(p=>p.text||'').join('');
 // A turn the ws-server acked as delivered is only written to this CLI's stdin:
 // a loaded host can schedule the CLI much later. Follow-up turns are recorded
 // late on purpose so a test must wait for the CLI, never read right after the ack.
 if(turn>1)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
 fs.appendFileSync(dir+'/turns.jsonl',JSON.stringify({turn,text,pid:process.pid})+'\n');
 if(turn===1){
  send({type:'system',subtype:'init',session_id:'stub-session',model:'stub'});
  if(process.env.STUB_MODE==='finish'){send({type:'result',subtype:'success',result:'done',queued_turn_count:0});return;}
  loop=spawn('sh',['-c','i=0; while [ $i -lt ${LOOP_LINES} ]; do i=$((i+1)); echo $i >> "$1"; sleep 0.03; done','sh',dir+'/counter.txt'],{stdio:'ignore'});
  send({type:'assistant',message:{content:[{type:'tool_use',id:'toolu_loop',name:'Bash',input:{command:'loop'}}]}});
  loop.on('exit',()=>{loop=null;send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu_loop',content:'loop done'}]}});send({type:'result',subtype:'success',result:'loop done; answered '+queued+' queued turn(s)',queued_turn_count:0});});
  return;
 }
 if(loop){queued++;return;}
 send({type:'result',subtype:'success',result:'turn answered',queued_turn_count:0});
});
rl.on('close',()=>{const done=()=>process.exit(0);if(loop)loop.on('exit',done);else done();});
`;

interface LiveServer {
  child: ChildProcess;
  port: number;
  dir: string;
  alive: () => boolean;
}

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start the ws-server as `node <home>/ws-server.mjs` (the sandbox's argv) with the stub CLI. */
async function startLiveServer(
  home: string,
  previousTaskId: string,
  env: Record<string, string> = {}
): Promise<LiveServer> {
  const dir = join(home, '.stub');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'claude.cjs'), STUB_CLI);
  writeFileSync(
    join(dir, 'bin', 'claude'),
    `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'claude.cjs')}'\n`,
    { mode: 0o755 }
  );
  if (!existsSync(join(home, 'ws-server.mjs')))
    symlinkSync(wsServerPath, join(home, 'ws-server.mjs'));
  const child = spawn('node', [join(home, 'ws-server.mjs')], {
    cwd: home,
    detached: true,
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
      PORT: '0',
      STUB_DIR: dir,
      CLAUDE_CODE_GOAL: 'Run the counter loop',
      CLAUDE_CODE_MODEL: 'stub',
      ANTHROPIC_API_KEY: 'stub-key',
      CODE_SESSION_TURN_TOKEN: codeSessionTurnToken(previousTaskId),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  for (let i = 0; i < 400; i++) {
    const listening = out
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as { message?: string; port?: number };
        } catch {
          return {};
        }
      })
      .find((line) => line.message === 'Server listening');
    if (listening?.port) {
      return { child, port: listening.port, dir, alive: () => processAlive(child.pid) };
    }
    await sleep(25);
  }
  child.kill('SIGKILL');
  throw new Error(`ws-server never listened:\n${out}`);
}

function counterLines(dir: string): number[] {
  const path = join(dir, 'counter.txt');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(Number);
}

function turns(dir: string): Array<{ turn: number; text: string; pid: number }> {
  const path = join(dir, 'turns.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { turn: number; text: string; pid: number });
}

async function until(what: string, predicate: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** E2B pause / resume stand-ins: freeze and thaw the sandbox's whole process tree. */
function freeze(server: LiveServer): void {
  process.kill(-(server.child.pid as number), 'SIGSTOP');
}
function thaw(server: LiveServer): void {
  process.kill(-(server.child.pid as number), 'SIGCONT');
}

async function pausedSession(ctx: CodeSessionLifecycleContext, label: string) {
  const agentId = randomUUID();
  await prisma.agent.create({
    data: { id: agentId, userId: ctx.userA, busId: agentId, goal: `Live resume ${label}` },
  });
  const home = join(ctx.fixtureDir, `home-live-${label}`);
  mkdirSync(home, { recursive: true });
  const sandboxId = `sb-live-${label}-${randomUUID()}`;
  const session = await prisma.codeSession.create({
    data: {
      userId: ctx.userA,
      rootAgentId: agentId,
      ownerAgentId: agentId,
      repoKey: `live-${randomUUID()}`,
      sandboxKind: 'e2b',
      sandboxId,
      state: 'ACTIVE',
      leaseOwner: `tool:${agentId}:tc-${label}`,
      leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const previous = await prisma.claudeCodeSession.create({
    data: {
      agentId,
      sandboxId,
      goal: 'Run the counter loop',
      status: 'CLOSED',
      closedAt: new Date(),
      closeReason: 'cancel',
      codeSessionId: session.id,
      codeProvider: 'claude',
    },
  });
  await markPaused(session.id);
  // The spawn holds the resolved session under its tool call's lease (resolveSpawnCodeSession).
  const row = {
    ...(await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } })),
    leaseOwner: `tool:${agentId}:tc-resume-${label}`,
  };
  const fake = ctx.fakeSandbox(home, sandboxId);
  return { agentId, home, row, previous, fake };
}

type AttachLive = (
  sandbox: Sandbox,
  codeSession: unknown,
  params: {
    provider: 'claude';
    wsUrl: string;
    taskId: string;
    text: string;
    envs: Record<string, string>;
    credentialKeys: readonly string[];
  },
  turnToken?: (taskId: string) => string
) => Promise<{ attached: boolean; reason: string; historyEvents?: number }>;

function attachLiveCodeCli(): AttachLive {
  const attach = (codeSessionSandbox as unknown as { attachLiveCodeCli?: AttachLive })
    .attachLiveCodeCli;
  assert.equal(typeof attach, 'function', 'e2bCodeSessionSandbox exports attachLiveCodeCli');
  return attach as AttachLive;
}

const CLAUDE_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_CREDENTIALS',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

export function registerCodeSessionLiveResumeCases(ctx: CodeSessionLifecycleContext): void {
  test('resuming a paused session attaches to its live CLI: the in-flight loop keeps writing and the new goal reaches the same CLI', async () => {
    process.env.BACKEND_API_KEY ??= 'code-sessions-live-resume-key';
    const { home, row, previous, fake } = await pausedSession(ctx, 'attach');
    const server = await startLiveServer(home, previous.id);
    try {
      await until('the loop to start writing', () => counterLines(server.dir).length >= 5);
      freeze(server);
      const frozenAt = counterLines(server.dir).length;
      await sleep(300);
      assert.equal(counterLines(server.dir).length, frozenAt, 'a paused sandbox runs nothing');

      ctx.patchConnect(async () => {
        thaw(server);
        return fake.sandbox;
      });
      let acquired;
      try {
        acquired = await codeSessionSandbox.acquireCodeSessionSandbox(row, async () => {
          throw new Error('a paused sandbox is resumed, never replaced');
        });
      } finally {
        ctx.restoreConnect();
      }
      assert.equal(acquired.resumedFrom, 'paused_sandbox');
      await sleep(200);
      assert.ok(server.alive(), 'resuming the sandbox must not stop the live ws-server');

      const newTaskId = randomUUID();
      const attached = await attachLiveCodeCli()(acquired.sandbox, row, {
        provider: 'claude',
        wsUrl: `ws://127.0.0.1:${server.port}`,
        taskId: newTaskId,
        text: 'Task:\nReport how many lines counter.txt has',
        envs: { ANTHROPIC_API_KEY: 'stub-key' },
        credentialKeys: CLAUDE_KEYS,
      });
      assert.equal(attached.attached, true);
      assert.equal(attached.reason, 'delivered');
      assert.ok(
        Number.isInteger(attached.historyEvents) && (attached.historyEvents ?? 0) > 0,
        'the earlier turns are history to the new spawn'
      );
      // A retried create of the same tool call (same lease owner) never repeats the goal.
      const retried = await attachLiveCodeCli()(acquired.sandbox, row, {
        provider: 'claude',
        wsUrl: `ws://127.0.0.1:${server.port}`,
        taskId: randomUUID(),
        text: 'Task:\nReport how many lines counter.txt has',
        envs: { ANTHROPIC_API_KEY: 'stub-key' },
        credentialKeys: CLAUDE_KEYS,
      });
      assert.deepEqual(retried, {
        attached: true,
        reason: 'duplicate',
        historyEvents: attached.historyEvents,
      });
      // The adopted token: the new task id addresses the live CLI (direct chat, agent relays).
      const relay = await deliverUserTurnToCodeSession({
        wsUrl: `ws://127.0.0.1:${server.port}`,
        taskId: newTaskId,
        turnId: 'relay-after-attach',
        text: 'are you done?',
        sender: 'agent',
      });
      assert.equal(relay.status, 'delivered', 'the new task id is authorized on the live CLI');
      const afterAttach = counterLines(server.dir).length;
      await until(
        'the loop to keep writing after the resume',
        () => counterLines(server.dir).length > afterAttach + 5
      );
      await until('the loop to finish', () => counterLines(server.dir).length >= LOOP_LINES);
      assert.deepEqual(
        counterLines(server.dir),
        Array.from({ length: LOOP_LINES }, (_, i) => i + 1),
        'the loop ran once, start to finish, across the pause'
      );
      await until('the CLI to read the goal and the relay', () => turns(server.dir).length >= 3);
      const seen = turns(server.dir);
      assert.deepEqual(
        seen.map((turn) => turn.text),
        [
          '/goal Task:\nRun the counter loop',
          'Task:\nReport how many lines counter.txt has',
          'are you done?',
        ],
        'the new goal is a turn of the same CLI conversation'
      );
      assert.equal(
        new Set(seen.map((turn) => turn.pid)).size,
        1,
        'one CLI process answers every turn'
      );
      // One merged result answers every queued turn; the autonomous run then
      // closes stdin and the CLI exits (the ws-server keeps serving the result).
      await until('the CLI to finish its merged turn and exit', () => !processAlive(seen[0].pid));
      assert.ok(
        server.alive(),
        'the ws-server serves the final buffer for the reattached activity'
      );
    } finally {
      server.child.kill('SIGKILL');
      try {
        process.kill(-(server.child.pid as number), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  test('duplicate creates of one spawn that attached to the live CLI create once and never restart it', async () => {
    // RCA 2026-11-06-code-spawn-create-retry-duplicated-sessions x the live attach: the agents
    // activity retries a create that outlives its read while the first request keeps running.
    // Each duplicate used to repeat the attach (a second goal turn) or, when the CLI was
    // still starting, take the restart path that stops the CLI the first request started.
    process.env.BACKEND_API_KEY ??= 'code-sessions-live-resume-key';
    const { agentId, home, row, previous, fake } = await pausedSession(ctx, 'dup-create');
    const server = await startLiveServer(home, previous.id);
    let creates = 0;
    try {
      await until('the loop to start writing', () => counterLines(server.dir).length >= 5);
      freeze(server);
      ctx.patchConnect(async () => {
        thaw(server);
        return fake.sandbox;
      });
      const goal = 'Task:\nReport how many lines counter.txt has';
      // The production create for a paused sandbox: resume it, attach the goal to its
      // live CLI, record the task.
      const create = async (
        codeSession: Parameters<typeof codeSessionSandbox.acquireCodeSessionSandbox>[0]
      ) => {
        creates += 1;
        const acquired = await codeSessionSandbox.acquireCodeSessionSandbox(
          codeSession,
          async () => {
            throw new Error('a paused sandbox is resumed, never replaced');
          }
        );
        const taskId = randomUUID();
        const wsUrl = `ws://127.0.0.1:${server.port}`;
        const attached = await attachLiveCodeCli()(acquired.sandbox, codeSession, {
          provider: 'claude',
          wsUrl,
          taskId,
          text: goal,
          envs: { ANTHROPIC_API_KEY: 'stub-key' },
          credentialKeys: CLAUDE_KEYS,
        });
        assert.equal(attached.attached, true, 'the live CLI takes the goal');
        await prisma.claudeCodeSession.create({
          data: {
            id: taskId,
            agentId,
            sandboxId: acquired.sandbox.sandboxId,
            goal,
            status: 'ACTIVE',
            codeSessionId: codeSession?.id,
            codeProvider: 'claude',
          },
        });
        return { taskId, wsUrl, resumedFrom: 'live_cli' as const };
      };
      const params = {
        agentId,
        userId: ctx.userA,
        repoUrl: null,
        codeProvider: 'claude' as const,
        codeSessionId: row.id,
        leaseOwner: `tool:${agentId}:tc-dup-create`,
      };
      const results = await Promise.all([
        createWithCodeSession(params, create as never),
        createWithCodeSession(params, create as never),
        createWithCodeSession(params, create as never),
      ]);
      assert.equal(creates, 1, 'one spawn runs its create once');
      assert.equal(new Set(results.map((result) => result.session.taskId)).size, 1);
      assert.equal(fake.calls.killed, 0, 'no sandbox is killed or replaced');
      await until('the CLI to read the goal', () => turns(server.dir).length >= 2);
      await until('the loop to finish', () => counterLines(server.dir).length >= LOOP_LINES);
      assert.deepEqual(
        counterLines(server.dir),
        Array.from({ length: LOOP_LINES }, (_, i) => i + 1),
        'the in-flight loop ran once, start to finish: the CLI was never restarted'
      );
      const seen = turns(server.dir);
      assert.deepEqual(
        seen.map((turn) => turn.text),
        ['/goal Task:\nRun the counter loop', goal],
        'the goal reached the CLI exactly once'
      );
      assert.equal(new Set(seen.map((turn) => turn.pid)).size, 1, 'one CLI process');
      assert.ok(server.alive(), 'the live ws-server was never stopped');
    } finally {
      ctx.restoreConnect();
      try {
        process.kill(-(server.child.pid as number), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  test('two resumed spawns of one agent without a tool lease owner each deliver their own goal', async () => {
    process.env.BACKEND_API_KEY ??= 'code-sessions-live-resume-key';
    const { home, row, previous, fake } = await pausedSession(ctx, 'agent-owner');
    const server = await startLiveServer(home, previous.id);
    try {
      await until('the loop to start writing', () => counterLines(server.dir).length >= 3);
      const agentOwned = { ...row, leaseOwner: `agent:${row.ownerAgentId}` };
      for (const goal of ['Task:\nfirst follow-up', 'Task:\nsecond follow-up']) {
        const attached = await attachLiveCodeCli()(fake.sandbox, agentOwned, {
          provider: 'claude',
          wsUrl: `ws://127.0.0.1:${server.port}`,
          taskId: randomUUID(),
          text: goal,
          envs: { ANTHROPIC_API_KEY: 'stub-key' },
          credentialKeys: CLAUDE_KEYS,
        });
        assert.equal(attached.attached, true, goal);
        assert.equal(attached.reason, 'delivered', goal);
      }
      // `delivered` means written to the CLI's stdin; wait for the CLI to read both.
      await until('the CLI to read both follow-up turns', () => turns(server.dir).length >= 3);
      assert.deepEqual(
        turns(server.dir).map((turn) => turn.text),
        ['/goal Task:\nRun the counter loop', 'Task:\nfirst follow-up', 'Task:\nsecond follow-up']
      );
    } finally {
      try {
        process.kill(-(server.child.pid as number), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  test('a resume restarts a CLI whose ws-server predates attach (delivered without attached: true)', async () => {
    process.env.BACKEND_API_KEY ??= 'code-sessions-live-resume-key';
    const { home, row, fake } = await pausedSession(ctx, 'old-server');
    // A ws-server started before this support acks every turn as delivered and
    // ignores `attach`: no credential check, no adopted token.
    writeFileSync(
      join(home, 'ws-server.mjs'),
      `import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(${JSON.stringify(join(repoRoot, 'package.json'))})('ws');
const wss = new WebSocketServer({ port: 0 });
wss.on('listening', () => console.log(JSON.stringify({ message: 'Server listening', port: wss.address().port })));
wss.on('connection', (ws) => ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'user_turn') ws.send(JSON.stringify({ type: 'user_turn_ack', id: msg.id, status: 'delivered' }));
}));
`
    );
    const child = spawn('node', [join(home, 'ws-server.mjs')], {
      cwd: home,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    try {
      await until('the old ws-server to listen', () => out.includes('Server listening'));
      const port = (JSON.parse(out.split('\n')[0]) as { port: number }).port;
      const attached = await attachLiveCodeCli()(fake.sandbox, row, {
        provider: 'claude',
        wsUrl: `ws://127.0.0.1:${port}`,
        taskId: randomUUID(),
        text: 'Task:\nContinue',
        envs: { ANTHROPIC_API_KEY: 'stub-key' },
        credentialKeys: CLAUDE_KEYS,
      });
      assert.deepEqual(attached, { attached: false, reason: 'attach_unsupported' });
      await until('the old ws-server to stop', () => !processAlive(child.pid), 8_000);
    } finally {
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  for (const failure of [
    {
      label: 'no-token',
      why: 'no turn token can be minted (BACKEND_API_KEY unset)',
      // codeSessionTurnToken's own error, injected: the env is shared by concurrent cases.
      turnToken: (): string => {
        throw new Error('BACKEND_API_KEY is required to address a code session');
      },
      failLookup: false,
      reason: 'attach_error: BACKEND_API_KEY is required to address a code session',
    },
    {
      label: 'lookup-error',
      why: 'the previous-task lookup fails',
      turnToken: undefined,
      failLookup: true,
      reason: 'attach_error: transient lookup failure',
    },
  ]) {
    test(`a resume falls back to the restart path when ${failure.why}`, async () => {
      process.env.BACKEND_API_KEY ??= 'code-sessions-live-resume-key';
      const { home, row, previous, fake } = await pausedSession(ctx, failure.label);
      const server = await startLiveServer(home, previous.id);
      const delegate = prisma.claudeCodeSession as unknown as {
        findFirst: (args: { where?: { codeSessionId?: string } }) => Promise<unknown>;
      };
      const findFirst = delegate.findFirst;
      if (failure.failLookup) {
        // Only this session's lookup fails; concurrent cases keep the real one.
        delegate.findFirst = (args) =>
          args.where?.codeSessionId === row.id
            ? Promise.reject(new Error('transient lookup failure'))
            : findFirst.call(prisma.claudeCodeSession, args);
      }
      try {
        await until('the loop to start writing', () => counterLines(server.dir).length >= 3);
        const attached = await attachLiveCodeCli()(
          fake.sandbox,
          row,
          {
            provider: 'claude',
            wsUrl: `ws://127.0.0.1:${server.port}`,
            taskId: randomUUID(),
            text: 'Task:\nContinue',
            envs: { ANTHROPIC_API_KEY: 'stub-key' },
            credentialKeys: CLAUDE_KEYS,
          },
          failure.turnToken
        );
        assert.deepEqual(attached, { attached: false, reason: failure.reason });
        await until('the stale ws-server to stop', () => !server.alive(), 8_000);
        assert.equal(turns(server.dir).length, 1, 'nothing reached the old CLI');
      } finally {
        delegate.findFirst = findFirst;
        try {
          process.kill(-(server.child.pid as number), 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });
  }

  for (const scenario of [
    {
      label: 'finished',
      why: 'its CLI already finished (stdin closed after an autonomous turn)',
      env: { STUB_MODE: 'finish' },
      envs: { ANTHROPIC_API_KEY: 'stub-key' },
      reason: 'session_ended',
    },
    {
      label: 'credential',
      why: 'the spawn leased another credential than the live CLI holds',
      env: {},
      envs: { ANTHROPIC_API_KEY: 'a-fresh-lease' },
      reason: 'credential_changed',
    },
    {
      label: 'settings',
      why: 'the live CLI cannot take the settings the spawn asks for',
      env: {},
      envs: { ANTHROPIC_API_KEY: 'stub-key', CLAUDE_CODE_MODEL: 'a-model-this-cli-lacks' },
      reason: 'unsupported_settings',
    },
  ]) {
    test(`a resume restarts the CLI (stale ws-server stopped, nothing delivered) when ${scenario.why}`, async () => {
      process.env.BACKEND_API_KEY ??= 'code-sessions-live-resume-key';
      const { home, row, previous, fake } = await pausedSession(ctx, scenario.label);
      const server = await startLiveServer(home, previous.id, scenario.env);
      try {
        if (scenario.label === 'finished') {
          await until('the autonomous turn to finish', () => turns(server.dir).length === 1);
          await sleep(300);
        } else {
          await until('the loop to start writing', () => counterLines(server.dir).length >= 3);
        }
        const attached = await attachLiveCodeCli()(fake.sandbox, row, {
          provider: 'claude',
          wsUrl: `ws://127.0.0.1:${server.port}`,
          taskId: randomUUID(),
          text: 'Task:\nContinue',
          envs: scenario.envs,
          credentialKeys: CLAUDE_KEYS,
        });
        assert.deepEqual(attached, { attached: false, reason: scenario.reason });
        await until('the stale ws-server to stop', () => !server.alive(), 8_000);
        assert.equal(turns(server.dir).length, 1, 'the refused goal never reached the old CLI');
      } finally {
        try {
          process.kill(-(server.child.pid as number), 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });
  }
}
