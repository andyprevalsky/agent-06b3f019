/**
 * Code-sessions lifecycle cases for multi-day runs (T3), run inside
 * code-sessions.blackbox.ts with its fake E2B sandbox over a local HOME:
 *
 *   agent cutover / descendant ──releaseTerminatedWorkflowResources──► checkpoint + pause (never kill)
 *   agent archive (owner)      ──cleanupAgentSessions──────────────► session RETIRED + sandbox killed
 *   keepalive ──► lease extended even when the E2B timeout call fails
 *   keepalive ──► periodic checkpoint; pause/resume before E2B's continuous-runtime cap
 *   resume    ──► only a missing sandbox falls back to a new one (transient errors throw)
 *   repo key  ──► `.git` / trailing slash variants name the same session
 *   TTL       ──► an expired session is only ever RETIRED by the retire path (sandbox killed)
 *   resume    ──► the stale ws-server stop command does not kill its own shell
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sandbox, SandboxNotFoundError } from 'e2b';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import {
  cleanupAgentSessions,
  releaseTerminatedWorkflowResources,
} from '../../providers/agentCleanup';
import { NO_CODE_RESOURCES } from '../../providers/codeSessions/sandboxResources';
import { keepAliveCodeTask, resolveSpawnCodeSession } from '../../providers/codeSessions/spawn';
import { markPaused } from '../../providers/codeSessions/store';
import {
  checkpointCodeSession,
  sweepExpiredCodeSessions,
} from '../../providers/codeSessions/lifecycle';
import { acquireCodeSessionSandbox } from '../../providers/e2bCodeSessionSandbox';
import { closeClaudeCodeSession } from '../../providers/e2bCloseSession';
import { localSandboxFs } from '../../providers/codeSessions/sandboxFs';
import { stopSandboxCli } from '../../providers/codeSessions/sandboxResize';
import {
  CheckpointIntegrityError,
  loadVerifiedCheckpoint,
} from '../../providers/codeSessions/checkpoint';

export interface CodeSessionLifecycleContext {
  userA: string;
  fixtureDir: string;
  seedWorkspace: (home: string) => unknown;
  fakeSandbox: (
    home: string,
    sandboxId: string
  ) => { sandbox: Sandbox; calls: { paused: number; killed: number } };
  patchConnect: (impl: (id: string) => Promise<Sandbox>) => void;
  restoreConnect: () => void;
}

async function liveTask(ctx: CodeSessionLifecycleContext, label: string) {
  const agentId = randomUUID();
  await prisma.agent.create({
    data: { id: agentId, userId: ctx.userA, busId: agentId, goal: `Lifecycle ${label}` },
  });
  const home = join(ctx.fixtureDir, `home-lifecycle-${label}`);
  ctx.seedWorkspace(home);
  const sandboxId = `sb-${label}-${randomUUID()}`;
  const codeSession = await prisma.codeSession.create({
    data: {
      userId: ctx.userA,
      rootAgentId: agentId,
      ownerAgentId: agentId,
      repoKey: `lifecycle-${randomUUID()}`,
      branch: 'rose/feature-1',
      mergeTarget: 'main',
      sandboxKind: 'e2b',
      sandboxId,
      state: 'ACTIVE',
      leaseOwner: `tool:${label}:1`,
      leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const task = await prisma.claudeCodeSession.create({
    data: {
      agentId,
      sandboxId,
      goal: `Lifecycle ${label}`,
      status: 'ACTIVE',
      codeSessionId: codeSession.id,
      codeProvider: 'claude',
    },
  });
  const fake = ctx.fakeSandbox(home, sandboxId);
  return { agentId, home, sandboxId, codeSession, task, fake };
}

export function registerCodeSessionLifecycleCases(ctx: CodeSessionLifecycleContext): void {
  test('a terminated workflow (cutover / descendant) checkpoints and pauses its code session instead of killing it; the retried spawn resumes the same session', async (t) => {
    const { agentId, sandboxId, codeSession, task, fake } = await liveTask(ctx, 'cutover');
    const killed: string[] = [];
    t.mock.method(Sandbox, 'kill', async (id: string) => {
      killed.push(id);
      return true;
    });
    ctx.patchConnect(async () => fake.sandbox);
    try {
      await releaseTerminatedWorkflowResources(agentId, 'Cutover');
    } finally {
      ctx.restoreConnect();
    }
    assert.deepEqual(killed, [], 'a persistent session sandbox is never killed by a cutover');
    assert.equal(fake.calls.killed, 0);
    assert.equal(fake.calls.paused, 1, 'the sandbox is paused (fs + memory kept)');
    const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSession.id } });
    assert.equal(row.state, 'PAUSED', 'the session is released, not left ACTIVE and leased');
    assert.equal(row.leaseOwner, null);
    assert.ok(row.latestCheckpointSeq >= 1, 'the work is checkpointed before the pause');
    assert.notEqual(row.cliSessionId, null, 'the CLI conversation is recorded for --resume');
    const closed = await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.closeReason, 'cancel', 'the interrupted task closes resumably');

    const retried = await resolveSpawnCodeSession({
      agentId,
      userId: ctx.userA,
      repoUrl: null,
      codeProvider: 'claude',
      codeSessionId: codeSession.id,
      leaseOwner: 'tool:cutover:retry',
    });
    assert.equal(retried?.id, codeSession.id);
    assert.equal(retried?.sandboxId, sandboxId, 'the retry resumes the paused sandbox');
  });

  test('archiving an agent pauses its code session with a checkpoint (reversible: unarchive can resume it), never leaves it ACTIVE', async (t) => {
    const { agentId, sandboxId, codeSession, task, fake } = await liveTask(ctx, 'archive');
    const killed: string[] = [];
    t.mock.method(Sandbox, 'kill', async (id: string) => {
      killed.push(id);
      return true;
    });
    ctx.patchConnect(async () => fake.sandbox);
    try {
      await cleanupAgentSessions(agentId);
    } finally {
      ctx.restoreConnect();
    }
    assert.deepEqual(killed, [], 'archive never destroys the session sandbox');
    assert.equal(fake.calls.killed, 0);
    assert.equal(fake.calls.paused, 1, 'the archived agent’s sandbox stops running (paused)');
    const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSession.id } });
    assert.equal(row.state, 'PAUSED', 'the archived owner’s session never stays ACTIVE');
    assert.equal(row.leaseOwner, null);
    assert.ok(row.latestCheckpointSeq >= 1, 'its work is checkpointed');
    assert.equal(row.sandboxId, sandboxId);
    const closed = await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.closeReason, 'cancel');
  });

  test('keepalive extends the session lease even when the E2B timeout call fails', async () => {
    const { codeSession, task } = await liveTask(ctx, 'keepalive');
    const stale = new Date(Date.now() + 60 * 1000);
    await prisma.codeSession.update({
      where: { id: codeSession.id },
      data: { leaseExpiresAt: stale },
    });
    await assert.rejects(
      keepAliveCodeTask(
        task.id,
        async () => {
          throw new Error('E2B 503 Service Unavailable');
        },
        NO_CODE_RESOURCES
      ),
      /503/
    );
    const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSession.id } });
    assert.ok(
      (row.leaseExpiresAt?.getTime() ?? 0) > stale.getTime() + 30 * 60 * 1000,
      'a failed E2B call must not let the lease lapse under a live CLI'
    );
  });

  test('an attached session is checkpointed periodically and cycled (pause + resume) before the E2B runtime cap', async () => {
    const { codeSession, task, fake, sandboxId } = await liveTask(ctx, 'periodic');
    const start = Date.now();
    let clock = start;
    const jobs: Array<Promise<unknown>> = [];
    const events: string[] = [];
    const pause = fake.sandbox.pause.bind(fake.sandbox);
    (fake.sandbox as unknown as { pause: () => Promise<boolean> }).pause = async () => {
      events.push('pause');
      return pause();
    };
    let startedAt = new Date(start);
    const maintenance = {
      now: () => clock,
      random: () => 0,
      schedule: (job: () => Promise<unknown>) => {
        jobs.push(job());
      },
      sandboxInfo: async () => ({ startedAt }),
      connect: async (id: string) => {
        events.push(`connect:${id}`);
        return fake.sandbox;
      },
    };
    const keepalive = async () => {
      await (keepAliveCodeTask as unknown as (...args: unknown[]) => Promise<unknown>)(
        task.id,
        async () => undefined,
        NO_CODE_RESOURCES,
        maintenance
      );
      await Promise.all(jobs.splice(0));
    };
    const seq = async () =>
      (await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSession.id } }))
        .latestCheckpointSeq;

    await keepalive();
    const first = await seq();
    clock += 2 * 60 * 1000;
    await keepalive();
    assert.equal(await seq(), first, 'no checkpoint between two close keepalives');
    clock += 31 * 60 * 1000;
    await keepalive();
    const periodic = await seq();
    assert.equal(first, 0);
    assert.equal(periodic, 1, 'an attached session is checkpointed every interval');
    assert.equal(fake.calls.paused, 0, 'a young sandbox is not cycled');

    // 23.5 hours into one continuous run: save, pause and resume to reset E2B's cap.
    startedAt = new Date(clock - 23 * 60 * 60 * 1000);
    clock += 31 * 60 * 1000;
    events.splice(0);
    await keepalive();
    assert.ok((await seq()) > periodic, 'the cycle saves the session first');
    assert.equal(fake.calls.paused, 1, 'the sandbox is paused before the cap');
    assert.deepEqual(
      events,
      [`connect:${sandboxId}`, 'pause', `connect:${sandboxId}`],
      'saved through the held sandbox, then paused and resumed right away (same sandbox)'
    );
    assert.equal(fake.calls.killed, 0);
  });

  test('resume: only a missing sandbox falls back to a new one; a transient E2B error never orphans the paused sandbox', async () => {
    const { codeSession } = await liveTask(ctx, 'resume');
    await markPaused(codeSession.id);
    const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSession.id } });
    let created = 0;
    const create = async () => {
      created += 1;
      throw new Error('create must not run');
    };
    ctx.patchConnect(async () => {
      throw new Error('Request timed out (E2B 502 Bad Gateway)');
    });
    try {
      await assert.rejects(acquireCodeSessionSandbox(row, create), /502/);
      assert.equal(created, 0, 'a transient connect failure never creates a replacement');
      ctx.patchConnect(async (id) => {
        throw new SandboxNotFoundError(`Paused sandbox ${id} not found`);
      });
      await assert.rejects(acquireCodeSessionSandbox(row, create), /create must not run/);
      assert.equal(created, 1, 'a missing sandbox is replaced (and restored)');
    } finally {
      ctx.restoreConnect();
    }
  });

  test('repo URL variants (.git suffix, trailing slash) resolve to the same code session', async () => {
    const agentId = randomUUID();
    await prisma.agent.create({
      data: { id: agentId, userId: ctx.userA, busId: agentId, goal: 'Repo key' },
    });
    const name = `repo-key-${randomUUID().slice(0, 8)}`;
    const first = await resolveSpawnCodeSession({
      agentId,
      userId: ctx.userA,
      repoUrl: `https://github.com/rose-test/${name}`,
      codeProvider: 'claude',
      leaseOwner: 'tool:repo-key:1',
    });
    assert.ok(first);
    await markPaused(first.id);
    for (const variant of [
      `https://github.com/rose-test/${name}.git`,
      `https://github.com/rose-test/${name}/`,
      ` https://github.com/rose-test/${name}.git/ `,
    ]) {
      const again = await resolveSpawnCodeSession({
        agentId,
        userId: ctx.userA,
        repoUrl: variant,
        codeProvider: 'claude',
        leaseOwner: `tool:repo-key:${variant}`,
      });
      assert.equal(again?.id, first.id, `${JSON.stringify(variant)} must not fork a new session`);
      await markPaused(first.id);
    }
  });

  test('an expired session is never marked RETIRED with its sandbox alive (sweep or no sweep)', async (t) => {
    const userId = `code-session-ttl-${randomUUID()}`;
    await prisma.user.create({ data: { userId, name: 'Code Session TTL' } });
    const owner = randomUUID();
    await prisma.agent.create({ data: { id: owner, userId, busId: owner, goal: 'TTL' } });
    const killed: string[] = [];
    t.mock.method(Sandbox, 'kill', async (id: string) => {
      killed.push(id);
      return true;
    });
    const day = 24 * 60 * 60 * 1000;
    const expired = (ownerAgentId: string, ageDays: number, sandboxId: string | null) =>
      prisma.codeSession.create({
        data: {
          userId,
          rootAgentId: ownerAgentId,
          ownerAgentId,
          repoKey: '',
          state: 'PAUSED',
          sandboxKind: sandboxId === null ? null : 'e2b',
          sandboxId,
          lastActiveAt: new Date(Date.now() - ageDays * day),
        },
      });
    try {
      // The bounded sweep (5 oldest per spawn) is busy with older sessions.
      await Promise.all([30, 31, 32, 33, 34].map((age) => expired(randomUUID(), age, null)));
      const target = await expired(owner, 20, `sb-ttl-${randomUUID()}`);
      const fresh = await resolveSpawnCodeSession({
        agentId: owner,
        userId,
        repoUrl: null,
        codeProvider: 'claude',
        leaseOwner: 'tool:ttl:1',
      });
      assert.notEqual(fresh?.id, target.id, 'an expired session is never resumed');
      // resolve itself must never retire the expired session behind the sweep's back.
      const afterSpawn = await prisma.codeSession.findUniqueOrThrow({ where: { id: target.id } });
      if (afterSpawn.state === 'RETIRED') {
        assert.ok(killed.includes(target.sandboxId ?? ''), 'RETIRED without killing its sandbox');
      }
      // Later sweeps (once the older sessions are retired) reach it and kill its sandbox.
      const swept = await retryWithBackoff(
        async () => {
          await sweepExpiredCodeSessions(userId);
          return prisma.codeSession.findUniqueOrThrow({ where: { id: target.id } });
        },
        {
          maxRetries: 20,
          fixedDelays: Array.from({ length: 20 }, () => 50),
          shouldRetryResult: (row) => row.state !== 'RETIRED',
          component: 'CodeSessionTtlTest',
        }
      );
      assert.equal(swept.state, 'RETIRED');
      assert.ok(killed.includes(target.sandboxId ?? ''), 'the expired sandbox is killed');
    } finally {
      await prisma.codeSession.deleteMany({ where: { userId } });
      await prisma.agent.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { userId } });
    }
  });

  test('resuming a paused sandbox stops its stale ws-server without killing the stop command itself', async () => {
    const { codeSession, home, fake } = await liveTask(ctx, 'stale-ws');
    await markPaused(codeSession.id);
    const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSession.id } });
    writeFileSync(join(home, 'ws-server.mjs'), 'setInterval(() => undefined, 1000);\n');
    const stale = spawn('node', [join(home, 'ws-server.mjs')], { stdio: 'ignore' });
    const staleExit = once(stale, 'exit').then(() => true);
    const runs: Array<{ cmd: string; exitCode: number; signal: string | null }> = [];
    const map = (value: string) => value.split('/home/user').join(home);
    (fake.sandbox as unknown as { commands: { run: unknown } }).commands.run = async (
      cmd: string
    ) => {
      const result = spawnSync('bash', ['-c', map(cmd)], { encoding: 'utf8' });
      runs.push({ cmd, exitCode: result.status ?? -1, signal: result.signal });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    };
    ctx.patchConnect(async () => fake.sandbox);
    try {
      const acquired = await acquireCodeSessionSandbox(row, async () => {
        throw new Error('a paused sandbox is resumed, never replaced');
      });
      assert.equal(acquired.resumedFrom, 'paused_sandbox');
      assert.equal(
        await Promise.race([staleExit, sleep(5_000).then(() => false)]),
        true,
        'the stale ws-server is stopped'
      );
    } finally {
      ctx.restoreConnect();
      stale.kill('SIGKILL');
    }
    const stop = runs.find((run) => run.cmd.includes('ws-server.mjs'));
    assert.ok(stop, 'the resume stops the stale ws-server');
    assert.deepEqual(
      { exitCode: stop.exitCode, signal: stop.signal },
      { exitCode: 0, signal: null },
      'the stop command must finish (and wait for the port), not be killed by its own pkill'
    );
  });

  test('the runtime cycle never pauses or resumes a sandbox whose close has started', async () => {
    const { task, fake } = await liveTask(ctx, 'cycle-close');
    let clock = Date.now();
    const events: string[] = [];
    const pause = fake.sandbox.pause.bind(fake.sandbox);
    (fake.sandbox as unknown as { pause: () => Promise<boolean> }).pause = async () => {
      events.push('pause');
      return pause();
    };
    const jobs: Array<Promise<unknown>> = [];
    const maintenance = {
      now: () => clock,
      random: () => 0,
      schedule: (job: () => Promise<unknown>) => {
        jobs.push(job());
      },
      sandboxInfo: async () => ({ startedAt: new Date(clock - 23.5 * 60 * 60 * 1000) }),
      connect: async (id: string) => {
        events.push(`connect:${id}`);
        return fake.sandbox;
      },
    };
    const keepalive = async () => {
      await (keepAliveCodeTask as unknown as (...args: unknown[]) => Promise<unknown>)(
        task.id,
        async () => undefined,
        NO_CODE_RESOURCES,
        maintenance
      );
      await Promise.all(jobs.splice(0));
    };
    await keepalive();
    // A user pause is closing this task (close sets closeReason first, CLOSED last).
    await prisma.claudeCodeSession.update({
      where: { id: task.id },
      data: { closeReason: 'cancel' },
    });
    clock += 31 * 60 * 1000;
    await keepalive();
    assert.equal(events.includes('pause'), false, 'never paused under a running close');
    assert.equal(
      events.filter((event) => event.startsWith('connect:')).length <= 1,
      true,
      'never resumed after the close paused it'
    );
  });

  test('closing a stale task whose session moved to another sandbox never connects to (and so resumes) the old one', async () => {
    const { task, codeSession, fake } = await liveTask(ctx, 'superseded-close');
    await prisma.codeSession.update({
      where: { id: codeSession.id },
      data: { sandboxId: `sb-newer-${randomUUID()}` },
    });
    const connected: string[] = [];
    ctx.patchConnect(async (id) => {
      connected.push(id);
      return fake.sandbox;
    });
    try {
      await closeClaudeCodeSession(task.id, undefined, undefined, undefined, { reason: 'cancel' });
    } finally {
      ctx.restoreConnect();
    }
    assert.deepEqual(connected, [], 'a superseded sandbox stays paused');
    const closed = await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(closed.status, 'CLOSED');
  });

  test('periodic saves keep a bounded number of checkpoints per session', async () => {
    const { codeSession, home, agentId } = await liveTask(ctx, 'prune');
    for (let i = 0; i < 8; i += 1) {
      writeFileSync(join(home, 'workspace', `save-${i}.txt`), `${i}\n`);
      const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSession.id } });
      const saved = await checkpointCodeSession({
        session: row,
        fs: localSandboxFs(home),
        reason: 'periodic',
        agentId,
      });
      assert.equal(saved?.seq, i + 1);
    }
    await assert.rejects(
      loadVerifiedCheckpoint(ctx.userA, codeSession.id, 1),
      CheckpointIntegrityError
    );
    await assert.rejects(
      loadVerifiedCheckpoint(ctx.userA, codeSession.id, 3),
      CheckpointIntegrityError
    );
    for (const seq of [4, 5, 6, 7, 8]) {
      assert.equal(
        (await loadVerifiedCheckpoint(ctx.userA, codeSession.id, seq)).manifest.seq,
        seq
      );
    }
  });

  test('the resize CLI stop does not kill its own shell', async () => {
    const { home, fake, sandboxId } = await liveTask(ctx, 'resize-stop');
    writeFileSync(join(home, 'ws-server.mjs'), 'setInterval(() => undefined, 1000);\n');
    const stale = spawn('node', [join(home, 'ws-server.mjs')], { stdio: 'ignore' });
    const staleExit = once(stale, 'exit').then(() => true);
    const runs: Array<{ exitCode: number; signal: string | null }> = [];
    const map = (value: string) => value.split('/home/user').join(home);
    (fake.sandbox as unknown as { commands: { run: unknown } }).commands.run = async (
      cmd: string
    ) => {
      const result = spawnSync('bash', ['-c', map(cmd)], { encoding: 'utf8' });
      runs.push({ exitCode: result.status ?? -1, signal: result.signal });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    };
    ctx.patchConnect(async () => fake.sandbox);
    try {
      await stopSandboxCli(sandboxId);
      assert.equal(await Promise.race([staleExit, sleep(5_000).then(() => false)]), true);
    } finally {
      ctx.restoreConnect();
      stale.kill('SIGKILL');
    }
    assert.deepEqual(runs, [{ exitCode: 0, signal: null }]);
  });
}
