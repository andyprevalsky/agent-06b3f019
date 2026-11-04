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
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sandbox, SandboxNotFoundError } from 'e2b';
import { prisma } from '../../providers/database';
import {
  cleanupAgentSessions,
  releaseTerminatedWorkflowResources,
} from '../../providers/agentCleanup';
import { NO_CODE_RESOURCES } from '../../providers/codeSessions/sandboxResources';
import { keepAliveCodeTask, resolveSpawnCodeSession } from '../../providers/codeSessions/spawn';
import { markPaused } from '../../providers/codeSessions/store';
import { acquireCodeSessionSandbox } from '../../providers/e2bCodeSessionSandbox';

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

  test('archiving the agent that owns a code session retires it: sandbox killed, session RETIRED', async (t) => {
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
    assert.ok(
      killed.includes(sandboxId) || fake.calls.killed > 0,
      'the archived owner’s sandbox is killed'
    );
    const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSession.id } });
    assert.equal(row.state, 'RETIRED', 'the archived owner’s session never stays ACTIVE');
    assert.equal(row.leaseOwner, null);
    const closed = await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(closed.status, 'CLOSED');
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
}
