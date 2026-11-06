/**
 * The sandbox ws-server says what it is doing while it starts, and never
 * blocks its event loop on the repo clone (run inside code-sessions.blackbox.ts).
 * RCA 2026-11-06-ws-server-ready-while-clone-blocks-event-loop: a root without a
 * Project cloned the 1.2 GB Rose repo with a synchronous `git clone` at module
 * top level. The port was bound, so the backend's `netstat` probe said ready
 * after 869 ms, while the event loop could not complete a handshake or
 * acknowledge a turn. The worker's connect timed out, the activity retried,
 * closed the "unreachable" task and created another (three children under one
 * spawn), and every message to the task failed with "no user_turn_ack".
 *
 * The production `e2b-templates/claude-code/ws-server.mjs` runs over a local
 * HOME with a `git` shim whose `clone` sleeps, then clones a local origin; the
 * probe is the production `waitForSandboxWsServer` through the fake sandbox.
 *
 *   start ─▶ GET / 503 {state:"cloning"} (event loop free; handshake refused 503)
 *         ─▶ clone finishes ─▶ rename into place ─▶ GET / 200 {state:"ready", clone_ms}
 *   SIGTERM mid-clone ─▶ no workspace dir, clone child stopped; next start repeats the clone
 *   finished clone ─▶ a restart reuses it (the shim sees one clone)
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import WebSocket from 'ws';
import type { Sandbox } from 'e2b';
import { probeWsServer, waitForSandboxWsServer } from '../../providers/e2bWsReady';
import type { CodeSessionLifecycleContext } from './code-sessions-lifecycle.cases';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const wsServerPath = join(repoRoot, 'e2b-templates', 'claude-code', 'ws-server.mjs');
const CLONE_SECONDS = 3;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

interface Fixture {
  home: string;
  binDir: string;
  origin: string;
  cloneLog: string;
}

/** A local origin, a `git` shim (slow `clone`, logged) and a stub `claude` in one directory. */
function fixture(root: string): Fixture {
  const dir = join(root, `ws-startup-${randomUUID()}`);
  const home = join(dir, 'home');
  const binDir = join(dir, 'bin');
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: seed, stdio: 'ignore' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  git('push', '-q', 'origin', 'main');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const cloneLog = join(dir, 'clones.log');
  writeFileSync(
    join(binDir, 'git'),
    `#!/bin/bash
if [ "$1" = "clone" ]; then
  echo "$3" >> "${cloneLog}"
  sleep "${CLONE_SECONDS}"
  exec "${realGit}" clone -q "${origin}" "$3"
fi
exec "${realGit}" "$@"
`,
    { mode: 0o755 }
  );
  writeFileSync(join(binDir, 'claude'), '#!/bin/sh\nexec cat\n', { mode: 0o755 });
  return { home, binDir, origin, cloneLog };
}

function startServer(fx: Fixture, port: number): ChildProcess {
  return spawn('node', [wsServerPath], {
    cwd: fx.home,
    detached: true,
    env: {
      PATH: `${fx.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: fx.home,
      PORT: String(port),
      CLAUDE_CODE_GOAL: 'Report the repo status',
      CLAUDE_CODE_MODEL: 'stub',
      ANTHROPIC_API_KEY: 'stub-key',
      GITHUB_REPO_URL: 'https://github.com/example/startup-fixture',
    },
    stdio: 'ignore',
  });
}

function stopServer(child: ChildProcess): void {
  try {
    process.kill(-(child.pid as number), 'SIGKILL');
  } catch {
    // already gone
  }
}

/** The production probe over a sandbox stand-in that runs the command on this host. */
function hostSandbox(home: string): Sandbox {
  const run = async (cmd: string) => {
    const out = execFileSync('bash', ['-c', cmd], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
    });
    return { exitCode: 0, stdout: out, stderr: '' };
  };
  return { sandboxId: 'host', commands: { run } } as unknown as Sandbox;
}

async function until(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function handshakeStatus(port: number): Promise<string> {
  return new Promise((resolveStatus) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?replay=0`);
    const settle = (status: string) => {
      ws.terminate();
      resolveStatus(status);
    };
    ws.once('open', () => settle('open'));
    ws.once('unexpected-response', (_req, res) => settle(`http ${res.statusCode}`));
    ws.once('error', () => settle('error'));
  });
}

async function exitsWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      new Promise<boolean>((done) => child.once('exit', () => done(true))),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cloneCount(fx: Fixture): number {
  return existsSync(fx.cloneLog)
    ? readFileSync(fx.cloneLog, 'utf8').split('\n').filter(Boolean).length
    : 0;
}

export function registerWsStartupCases(ctx: Pick<CodeSessionLifecycleContext, 'fixtureDir'>): void {
  test('the ws-server reports cloning while the clone runs off the event loop, then serves with its clone time', async () => {
    const fx = fixture(ctx.fixtureDir);
    const port = await freePort();
    const child = startServer(fx, port);
    const sandbox = hostSandbox(fx.home);
    try {
      await until(
        'the port to answer',
        async () => (await probeWsServer(sandbox, port)).state !== 'down'
      );
      const during = await probeWsServer(sandbox, port);
      assert.equal(during.state, 'cloning', 'the event loop answers while the repo downloads');
      assert.equal(
        await handshakeStatus(port),
        'http 503',
        'a handshake before serving is refused, not dropped'
      );
      assert.equal(
        existsSync(join(fx.home, 'workspace')),
        false,
        'the workspace appears only once complete'
      );

      const ready = await waitForSandboxWsServer(sandbox, {
        port,
        timeoutMs: 5_000,
        pollMs: 50,
        startupBudgetMs: 60_000,
      });
      assert.equal(ready.ready, true);
      assert.equal(ready.state, 'ready');
      assert.ok(
        ready.cloneMs !== null && ready.cloneMs >= CLONE_SECONDS * 1000 - 500,
        `the clone duration is reported as a startup phase (got ${ready.cloneMs})`
      );
      assert.ok(
        existsSync(join(fx.home, 'workspace', '.git', 'HEAD')) &&
          existsSync(join(fx.home, 'workspace', 'README.md')),
        'ready means the repo is complete'
      );
      assert.equal(
        readdirSync(fx.home).filter((n) => n.startsWith('.workspace-cloning-')).length,
        0
      );
      assert.equal(await handshakeStatus(port), 'open', 'handshakes are served once ready');
      const phases = readFileSync('/tmp/ws-server.log', 'utf8')
        .split('\n')
        .filter((line) => line.includes('"Startup phase"') && line.includes('"clone"'));
      assert.ok(phases.length >= 1, 'the clone is logged as a named startup phase');
    } finally {
      stopServer(child);
    }
  });

  test('a clone interrupted by a signal leaves no workspace, and the next start clones again', async () => {
    const fx = fixture(ctx.fixtureDir);
    const port = await freePort();
    const first = startServer(fx, port);
    const sandbox = hostSandbox(fx.home);
    try {
      await until(
        'the clone to start',
        async () => (await probeWsServer(sandbox, port)).state === 'cloning'
      );
      first.kill('SIGTERM');
      assert.equal(await exitsWithin(first, 10_000), true, 'the server stops mid-clone');
      assert.equal(existsSync(join(fx.home, 'workspace')), false, 'no half-written workspace');

      const second = startServer(fx, port);
      try {
        const ready = await waitForSandboxWsServer(sandbox, {
          port,
          timeoutMs: 5_000,
          pollMs: 50,
          startupBudgetMs: 60_000,
        });
        assert.equal(ready.ready, true, `restarted server is ${ready.state}`);
        assert.equal(
          cloneCount(fx),
          2,
          'the interrupted clone is repeated, not resumed from debris'
        );
        assert.ok(existsSync(join(fx.home, 'workspace', '.git', 'HEAD')));
        assert.equal(
          readdirSync(fx.home).filter((n) => n.startsWith('.workspace-cloning-')).length,
          0
        );
      } finally {
        stopServer(second);
      }
    } finally {
      stopServer(first);
    }
  });

  test('a finished clone is reused on resume, and the readiness waits tell a dead server from a busy one', async () => {
    const fx = fixture(ctx.fixtureDir);
    const port = await freePort();
    const sandbox = hostSandbox(fx.home);
    const first = startServer(fx, port);
    try {
      const ready = await waitForSandboxWsServer(sandbox, {
        port,
        timeoutMs: 5_000,
        pollMs: 50,
        startupBudgetMs: 60_000,
      });
      assert.equal(ready.ready, true);
    } finally {
      stopServer(first);
    }
    await until(
      'the first server to release the port',
      async () => (await probeWsServer(sandbox, port)).state === 'down'
    );
    const second = startServer(fx, port);
    try {
      const resumed = await waitForSandboxWsServer(sandbox, {
        port,
        timeoutMs: 5_000,
        pollMs: 50,
        startupBudgetMs: 60_000,
      });
      assert.equal(resumed.ready, true);
      assert.equal(cloneCount(fx), 1, 'the second start reuses the finished clone');
      assert.equal(resumed.cloneMs, null, 'no clone phase on a resume');
    } finally {
      stopServer(second);
    }

    // The Codex ws-server has no state endpoint: a plain `ws` server answers HTTP with 426, and
    // any answer means its event loop serves.
    const plainPort = await freePort();
    const plain = spawn(
      'node',
      [
        '-e',
        `const { WebSocketServer } = require(${JSON.stringify(join(repoRoot, 'node_modules', 'ws'))}); new WebSocketServer({ port: ${plainPort} });`,
      ],
      { detached: true, stdio: 'ignore' }
    );
    try {
      const plainReady = await waitForSandboxWsServer(sandbox, {
        port: plainPort,
        timeoutMs: 5_000,
        pollMs: 50,
        startupBudgetMs: 60_000,
      });
      assert.deepEqual(
        [plainReady.ready, plainReady.state, plainReady.cloneMs],
        [true, 'ready', null]
      );
    } finally {
      stopServer(plain);
    }

    // Nothing ever binds: the old fail-fast bound applies, typed as down.
    const deadPort = await freePort();
    const dead = await waitForSandboxWsServer(sandbox, {
      port: deadPort,
      timeoutMs: 600,
      pollMs: 50,
      startupBudgetMs: 60_000,
    });
    assert.deepEqual([dead.ready, dead.state], [false, 'down']);

    // A server that is up but still cloning outlives timeoutMs, and is bounded by the startup budget.
    const slow = fixture(ctx.fixtureDir);
    const slowPort = await freePort();
    const slowChild = startServer(slow, slowPort);
    try {
      const budgeted = await waitForSandboxWsServer(hostSandbox(slow.home), {
        port: slowPort,
        timeoutMs: 400,
        pollMs: 50,
        startupBudgetMs: 1_500,
      });
      assert.deepEqual(
        [budgeted.ready, budgeted.state],
        [false, 'cloning'],
        'typed as cloning, not unreachable'
      );
    } finally {
      stopServer(slowChild);
    }
  });
}
