/**
 * One code-agent spawn starts one task, however often its create is retried
 * (run inside code-sessions.blackbox.ts). The agents activity is at-least-once:
 * a create that outlives the client's read (a fresh repo sandbox restores its
 * project for minutes) is retried with the same tool-call lease owner while the
 * first request keeps running server-side. RCA
 * 2026-11-06-code-spawn-create-retry-duplicated-sessions: three requests of one
 * spawn each started a task on the same sandbox, and each later one restarted
 * the CLI of the one before (attachLiveCodeCli's restart path), so the task the
 * agent attached to died during project startup.
 *
 *   create(tool:<agent>:<call>) ──┬─ first ─▶ create() ─▶ task T (stored for the lease owner)
 *                                 └─ retry ─▶ waits for the first ─▶ T (create() never runs)
 *   T closed (resize, usage limit) or the first create failed ─▶ the retry creates normally
 *   no tool lease owner (agent:<id>) ─▶ every create runs (distinct spawns)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import { createWithCodeSession } from '../../providers/codeSessions/spawn';
import { withClaudeCodeCreateSlot } from '../../providers/e2bCreateSlot';
import { putEphemeral } from '../../providers/sharedState';
import type { SpawnCodeSession } from '../../providers/codeSessions/usageLimit';

interface FakeTask {
  taskId: string;
  wsUrl: string;
  sandboxId: string;
  uploadedFiles: string[];
  resumedFrom: string;
}

/**
 * The production create's observable effects on one code session: under the
 * shared E2B create slot it starts a task on the session's sandbox and, when a
 * task of that session is already live there, restarts that task's CLI first
 * (the resume path that stopped the attached task in the incident).
 */
function fakeCreate(agentId: string, startMs: number) {
  const calls: string[] = [];
  const restartedLiveTasks: string[] = [];
  const create = (codeSession: SpawnCodeSession | null): Promise<FakeTask> =>
    withClaudeCodeCreateSlot(async () => {
      assert(codeSession);
      const sandboxId = `sb-replay-${codeSession.id}`;
      calls.push(codeSession.leaseOwner ?? '');
      const live = await prisma.claudeCodeSession.findMany({
        where: { codeSessionId: codeSession.id, status: 'ACTIVE' },
        select: { id: true },
      });
      restartedLiveTasks.push(...live.map((row) => row.id));
      await sleep(startMs);
      const task = await prisma.claudeCodeSession.create({
        data: {
          agentId,
          sandboxId,
          goal: 'Read-only repo status',
          status: 'ACTIVE',
          codeSessionId: codeSession.id,
          codeProvider: 'claude',
        },
      });
      return {
        taskId: task.id,
        wsUrl: `wss://3000-${sandboxId}.e2b.app`,
        sandboxId,
        uploadedFiles: [],
        resumedFrom: 'new',
      };
    });
  return { create, calls, restartedLiveTasks };
}

async function spawnAgent(userId: string, label: string): Promise<string> {
  const agentId = randomUUID();
  await prisma.agent.create({
    data: { id: agentId, userId, busId: agentId, goal: `Spawn replay ${label}` },
  });
  return agentId;
}

async function cleanup(agentId: string): Promise<void> {
  await prisma.claudeCodeSession.deleteMany({ where: { agentId } });
  await prisma.codeSession.deleteMany({ where: { ownerAgentId: agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
}

export function registerSpawnReplayCases(userId: string): void {
  test('concurrent creates of one spawn start one task, and no retry restarts its CLI', async () => {
    const agentId = await spawnAgent(userId, 'concurrent');
    const params = {
      agentId,
      userId,
      repoUrl: `https://github.com/example/replay-${randomUUID()}`,
      codeProvider: 'claude' as const,
      leaseOwner: `tool:${agentId}:toolu_replay_concurrent`,
    };
    const fake = fakeCreate(agentId, 400);
    try {
      // The first request is still starting when the activity's retries arrive.
      const first = createWithCodeSession(params, fake.create);
      await sleep(100);
      const retries = [
        createWithCodeSession(params, fake.create),
        createWithCodeSession(params, fake.create),
      ];
      const results = await Promise.all([first, ...retries]);
      const taskIds = results.map((result) => result.session.taskId);
      assert.equal(fake.calls.length, 1, 'one spawn runs the sandbox create once');
      assert.deepEqual(fake.restartedLiveTasks, [], 'a retry never restarts the live CLI');
      assert.equal(new Set(taskIds).size, 1, 'every request of the spawn gets the same task');
      const tasks = await prisma.claudeCodeSession.findMany({ where: { agentId } });
      assert.equal(tasks.length, 1, 'one task row (one code-agent child in the sidebar)');
      assert.equal(tasks[0].id, taskIds[0]);
      assert.deepEqual(
        results.map((result) => result.fields.code_session_id),
        results.map(() => results[0].fields.code_session_id)
      );
    } finally {
      await cleanup(agentId);
    }
  });

  test('a retry after the first create returned gets the same task', async () => {
    const agentId = await spawnAgent(userId, 'sequential');
    const params = {
      agentId,
      userId,
      repoUrl: null,
      codeProvider: 'claude' as const,
      leaseOwner: `tool:${agentId}:toolu_replay_sequential`,
    };
    const fake = fakeCreate(agentId, 10);
    try {
      const first = await createWithCodeSession(params, fake.create);
      const retried = await createWithCodeSession(params, fake.create);
      assert.equal(fake.calls.length, 1);
      assert.equal(retried.session.taskId, first.session.taskId);
      assert.equal(retried.session.wsUrl, first.session.wsUrl);
      assert.equal(retried.fields.branch, first.fields.branch);
    } finally {
      await cleanup(agentId);
    }
  });

  test('a stored create that cannot name its task is not replayed, and the create runs', async () => {
    // Stored rows outlive a run (6 h) and a create may return no task id; a unique lookup on it threw a Prisma
    // validation error out of every later retry of the same lease owner.
    const agentId = await spawnAgent(userId, 'nameless');
    const leaseOwner = `tool:${agentId}:toolu_replay_nameless`;
    const params = {
      agentId,
      userId,
      repoUrl: null,
      codeProvider: 'claude' as const,
      leaseOwner,
    };
    const fake = fakeCreate(agentId, 10);
    try {
      await putEphemeral(
        'code-spawn-create',
        leaseOwner,
        { session: { resumedFrom: 'checkpoint' }, fields: { code_provider: 'claude' } },
        60_000
      );
      const created = await createWithCodeSession(params, fake.create);
      assert.equal(fake.calls.length, 1, 'the create ran');
      assert.ok(created.session.taskId, 'and returned its task');
    } finally {
      await cleanup(agentId);
    }
  });

  test('a closed task or a failed create is never replayed; other spawns are never merged', async () => {
    const agentId = await spawnAgent(userId, 'fresh');
    const leaseOwner = `tool:${agentId}:toolu_replay_fresh`;
    const params = {
      agentId,
      userId,
      repoUrl: null,
      codeProvider: 'claude' as const,
      leaseOwner,
    };
    const fake = fakeCreate(agentId, 10);
    try {
      // A failed first create leaves nothing to replay: the retry creates.
      await assert.rejects(
        createWithCodeSession(params, async () => {
          throw new Error('fixture sandbox start failed');
        }),
        /fixture sandbox start failed/
      );
      const created = await createWithCodeSession(params, fake.create);
      assert.equal(fake.calls.length, 1);
      // Resize and a usage-limit switch close the spawn's task before they
      // create again under the same lease owner: that create runs.
      await prisma.claudeCodeSession.update({
        where: { id: created.session.taskId },
        data: { status: 'CLOSED', closedAt: new Date(), closeReason: 'resize' },
      });
      const resized = await createWithCodeSession(params, fake.create);
      assert.equal(fake.calls.length, 2);
      assert.notEqual(resized.session.taskId, created.session.taskId);
      // Spawns without a tool-call lease owner are distinct spawns of the agent.
      await prisma.claudeCodeSession.update({
        where: { id: resized.session.taskId },
        data: { status: 'CLOSED', closedAt: new Date(), closeReason: 'close' },
      });
      const agentOwned = { ...params, leaseOwner: undefined };
      const one = await createWithCodeSession(agentOwned, fake.create);
      await prisma.claudeCodeSession.update({
        where: { id: one.session.taskId },
        data: { status: 'CLOSED', closedAt: new Date(), closeReason: 'close' },
      });
      const two = await createWithCodeSession(agentOwned, fake.create);
      assert.equal(fake.calls.length, 4);
      assert.notEqual(one.session.taskId, two.session.taskId);
    } finally {
      await cleanup(agentId);
    }
  });
}
