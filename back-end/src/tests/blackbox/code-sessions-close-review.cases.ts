/** Lost close responses must replay one task's result without releasing a live owner's lease. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { closeClaudeCodeSession } from '../../providers/e2bCloseSession';
import { CodeSessionBusyError, resolveSpawnCodeSession } from '../../providers/codeSessions/spawn';

import { barrier, fixture, type Context } from './code-sessions-close-confirmation.cases';

export function registerCloseReviewCases(ctx: Context): void {
  test('close confirmation wrapper: retries transaction admission without replaying pause', async (t) => {
    const f = await fixture(ctx);
    const transaction = prisma.$transaction.bind(prisma);
    let attempts = 0;
    t.mock.method(prisma, '$transaction', async (...args: Parameters<typeof transaction>) => {
      attempts += 1;
      if (attempts === 1) throw new Error('Unable to start a transaction in the given time');
      assert.equal(args[1]?.timeout, attempts === 2 ? 65_000 : 10_000);
      return transaction(...args);
    });
    try {
      const result = await closeClaudeCodeSession(f.task.id);
      assert.equal(result.codeSession?.state, 'PAUSED');
      assert.equal(attempts, 3, 'retry admission once, then finalize once');
      assert.equal(f.fake.calls.paused, 1);
    } finally {
      ctx.restoreConnect();
    }
  });

  test('close confirmation wrapper: retryable-looking failure after dispatch is never replayed', async (t) => {
    const f = await fixture(ctx);
    const transaction = prisma.$transaction.bind(prisma);
    let attempts = 0;
    t.mock.method(prisma, '$transaction', async (...args: Parameters<typeof transaction>) => {
      attempts += 1;
      return transaction(...args);
    });
    f.fake.sandbox.pause = async (options) => {
      f.fake.calls.paused += 1;
      assert.equal(options?.requestTimeoutMs, 60_000);
      throw Object.assign(new Error('fixture connection lost after pause dispatch'), {
        code: 'P2024',
      });
    };
    t.mock.method(Sandbox, 'getInfo', async () => ({ state: 'running' }));
    try {
      await assert.rejects(
        closeClaudeCodeSession(f.task.id),
        /connection lost after pause dispatch/
      );
      assert.equal(attempts, 1, 'an entered transaction must never replay');
      assert.equal(f.fake.calls.paused, 1);
      await assert.rejects(closeClaudeCodeSession(f.task.id), /unconfirmed/);
      assert.equal(f.fake.calls.paused, 1, 'reconciliation only observes the uncertain pause');
    } finally {
      ctx.restoreConnect();
    }
  });

  test('close confirmation review: transaction admission failure before pause dispatch can retry', async (t) => {
    const f = await fixture(ctx);
    const transaction = prisma.$transaction.bind(prisma);
    let rejectAdmission = true;
    t.mock.method(prisma, '$transaction', async (...args: Parameters<typeof transaction>) => {
      if (rejectAdmission) {
        rejectAdmission = false;
        throw new Error('P2028 fixture transaction admission timeout');
      }
      return transaction(...args);
    });
    t.mock.method(Sandbox, 'getInfo', async () => ({ state: 'running' }));
    try {
      await assert.rejects(closeClaudeCodeSession(f.task.id), /transaction admission timeout/);
      assert.equal(f.fake.calls.paused, 0, 'admission failed before the provider call');
      const result = await closeClaudeCodeSession(f.task.id);
      assert.equal(result.codeSession?.state, 'PAUSED');
      assert.equal(f.fake.calls.paused, 1);
      assert.deepEqual(await closeClaudeCodeSession(f.task.id), result);
    } finally {
      ctx.restoreConnect();
    }
  });

  test('close confirmation review: stale pre-dispatch actor cannot pause after successor confirms autopause', async (t) => {
    const f = await fixture(ctx);
    const entered = barrier();
    const release = barrier();
    const execute = prisma.$executeRaw.bind(prisma);
    let blocked = false;
    t.mock.method(prisma, '$executeRaw', async (...args: Parameters<typeof execute>) => {
      const result = await execute(...args);
      const payload = args.find(
        (value) => typeof value === 'string' && value.startsWith('{"version":')
      );
      if (
        !blocked &&
        typeof payload === 'string' &&
        JSON.parse(payload).phase === 'pause_requested'
      ) {
        blocked = true;
        entered.release();
        await release.promise;
      }
      return result;
    });
    t.mock.method(Sandbox, 'getInfo', async () => ({ state: 'paused' }));
    const old = closeClaudeCodeSession(f.task.id);
    try {
      await Promise.race([
        entered.promise,
        old.then(() => {
          throw new Error('close skipped durable pause intent');
        }),
      ]);
      await prisma.$executeRaw`DELETE FROM "SharedEphemeralState" WHERE namespace = 'serialized-lock' AND key = ${`code-session-close:${f.task.id}`}`;
      const completed = await closeClaudeCodeSession(f.task.id);
      const next = await resolveSpawnCodeSession({
        agentId: ctx.rootAgentId,
        userId: ctx.userA,
        repoUrl: null,
        codeProvider: 'claude',
        codeSessionId: f.session.id,
        leaseOwner: 'next-owner',
      });
      assert.equal(next?.leaseOwner, 'next-owner');
      release.release();
      await assert.rejects(old, /custody lost/);
      assert.equal(
        f.fake.calls.paused,
        0,
        'old actor must not dispatch a pause after losing custody'
      );
      assert.deepEqual(await closeClaudeCodeSession(f.task.id), completed);
    } finally {
      release.release();
      await Promise.allSettled([old]);
      ctx.restoreConnect();
    }
  });

  test('close confirmation review: lost mutex fences writes and pre-dispatch recovery keeps custody', async () => {
    const f = await fixture(ctx);
    const entered = barrier();
    const finish = barrier();
    const run = f.fake.sandbox.commands.run.bind(f.fake.sandbox.commands);
    let block = true;
    f.fake.sandbox.commands.run = async (...args: Parameters<typeof run>) => {
      if (block && typeof args[0] === 'string' && args[0].includes('large.txt')) {
        block = false;
        entered.release();
        await finish.promise;
      }
      return run(...args);
    };
    const closing = closeClaudeCodeSession(f.task.id);
    try {
      await entered.promise;
      const before = await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: f.task.id } });
      await prisma.$executeRaw`UPDATE "SharedEphemeralState" SET value = '{"token":"replacement"}'::jsonb
        WHERE namespace = 'serialized-lock' AND key = ${`code-session-close:${f.task.id}`}`;
      finish.release();
      await assert.rejects(closing, /custody lost|lock lost/i);
      assert.equal(f.fake.calls.paused, 0);
      assert.deepEqual(
        (await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: f.task.id } }))
          .closeResult,
        before.closeResult
      );
      await assert.rejects(
        resolveSpawnCodeSession({
          agentId: ctx.rootAgentId,
          userId: ctx.userA,
          codeProvider: 'claude',
          repoUrl: null,
          codeSessionId: f.session.id,
          leaseOwner: 'other',
        }),
        CodeSessionBusyError
      );
      await prisma.$executeRaw`DELETE FROM "SharedEphemeralState" WHERE namespace = 'serialized-lock' AND key = ${`code-session-close:${f.task.id}`}`;
      const recovered = await closeClaudeCodeSession(f.task.id);
      assert.equal(recovered.codeSession?.state, 'PAUSED');
      assert.equal(f.fake.calls.paused, 1);
    } finally {
      finish.release();
      await Promise.allSettled([closing]);
      ctx.restoreConnect();
    }
  });

  test('close confirmation review: late pause after transaction timeout cannot reach a new owner', async (t) => {
    const f = await fixture(ctx);
    const entered = barrier();
    const release = barrier();
    const completed = barrier();
    let paused = false;
    f.fake.sandbox.pause = async () => {
      f.fake.calls.paused += 1;
      entered.release();
      await release.promise;
      paused = true;
      completed.release();
      return true;
    };
    t.mock.method(Sandbox, 'getInfo', async () => ({ state: paused ? 'paused' : 'running' }));
    const transaction = prisma.$transaction.bind(prisma);
    let disconnect = true;
    let transactionEntered = false;
    let interrupted: Promise<unknown> | undefined;
    // Model a lost DB transaction after the RPC was dispatched: the remote
    // pause continues after the caller gets its transaction failure.
    t.mock.method(prisma, '$transaction', async (...args: Parameters<typeof transaction>) => {
      if (disconnect && typeof args[0] === 'function') {
        disconnect = false;
        transactionEntered = true;
        interrupted = args[0](prisma);
        void interrupted.catch(() => undefined);
        await entered.promise;
        throw new Error('fixture transaction disconnected after dispatch');
      }
      return transaction(...args);
    });
    const closing = closeClaudeCodeSession(f.task.id);
    const rejected = assert.rejects(closing, /transaction disconnected/);
    try {
      await entered.promise;
      assert.equal(
        transactionEntered,
        true,
        'pause dispatch must be inside the guarded transition'
      );
      await rejected;
      await prisma.codeSession.update({
        where: { id: f.session.id },
        data: { leaseExpiresAt: new Date(0) },
      });
      await assert.rejects(
        resolveSpawnCodeSession({
          agentId: ctx.rootAgentId,
          userId: ctx.userA,
          repoUrl: null,
          codeProvider: 'claude',
          codeSessionId: f.session.id,
          leaseOwner: 'other',
        }),
        CodeSessionBusyError
      );
      await assert.rejects(closeClaudeCodeSession(f.task.id), /unconfirmed/);
      assert.equal(f.fake.calls.paused, 1, 'uncertain close must not dispatch another pause');
      release.release();
      await completed.promise;
      await interrupted?.catch(() => undefined);
      const result = await closeClaudeCodeSession(f.task.id);
      assert.equal(result.codeSession?.state, 'PAUSED');
      assert.equal(f.fake.calls.paused, 1);
    } finally {
      release.release();
      await Promise.allSettled([closing, rejected]);
      ctx.restoreConnect();
    }
  });

  test('close confirmation review: local helper finalization loss preserves the task receipt', async (t) => {
    const taskId = randomUUID();
    const home = `/tmp/claude-code-local/${taskId}`;
    mkdirSync(join(home, 'output'), { recursive: true });
    mkdirSync(join(home, '.rose'), { recursive: true });
    writeFileSync(join(home, 'output', 'result.txt'), 'local output');
    const content = JSON.stringify({ summary: 'local task result' });
    writeFileSync(join(home, '.rose', 'handoff.json'), content);
    writeFileSync(
      join(home, 'session.json'),
      JSON.stringify({ taskId, sandboxId: `local-${taskId}`, workDir: home, port: 0, pid: null })
    );
    await prisma.claudeCodeSession.create({
      data: {
        id: taskId,
        agentId: ctx.rootAgentId,
        sandboxId: `local-${taskId}`,
        goal: 'local close result',
      },
    });
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify({ Key: 'result.txt' }), { status: 200 })
    );
    const transaction = prisma.$transaction.bind(prisma);
    let fail = true;
    t.mock.method(prisma, '$transaction', async (...args: Parameters<typeof transaction>) => {
      if (fail) throw new Error('fixture local final transaction lost');
      return transaction(...args);
    });
    try {
      await assert.rejects(
        closeClaudeCodeSession(taskId, ctx.userA, ctx.rootAgentId),
        /fixture local final transaction lost/
      );
      fail = false;
      const result = await closeClaudeCodeSession(taskId, ctx.userA, ctx.rootAgentId);
      assert.equal(result.outputFiles.length, 1);
      assert.deepEqual(result.handoff, { status: 'present', content });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('close confirmation review: cleanup without caller identity preserves owner output for replay', async (t) => {
    const f = await fixture(ctx);
    mkdirSync(join(f.home, 'output'), { recursive: true });
    writeFileSync(join(f.home, 'output', 'result.txt'), 'owned output');
    let uploads = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      uploads += 1;
      return new Response(JSON.stringify({ Key: 'result.txt' }), { status: 200 });
    });
    try {
      const cleanup = await closeClaudeCodeSession(f.task.id);
      const replay = await closeClaudeCodeSession(f.task.id, ctx.userA, ctx.rootAgentId);
      assert.equal(replay.outputFiles.length, 1, 'cleanup must capture the task owner output');
      assert.deepEqual(replay, cleanup);
      assert.equal(uploads, 1);
    } finally {
      ctx.restoreConnect();
    }
  });

  test('close confirmation review: new ownership cannot enter after the final receipt save before pause', async (t) => {
    const f = await fixture(ctx);
    await prisma.codeSession.update({
      where: { id: f.session.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const execute = prisma.$executeRaw.bind(prisma);
    let attempted = false;
    t.mock.method(prisma, '$executeRaw', async (...args: Parameters<typeof execute>) => {
      const result = await execute(...args);
      const payload = args.find(
        (value) => typeof value === 'string' && value.startsWith('{"version":')
      );
      if (
        !attempted &&
        typeof payload === 'string' &&
        JSON.parse(payload).phase === 'pause_requested'
      ) {
        attempted = true;
        await assert.rejects(
          resolveSpawnCodeSession({
            agentId: ctx.rootAgentId,
            userId: ctx.userA,
            repoUrl: null,
            codeProvider: 'claude',
            codeSessionId: f.session.id,
            leaseOwner: 'tool:first',
          }),
          CodeSessionBusyError
        );
      }
      return result;
    });
    try {
      await closeClaudeCodeSession(f.task.id);
      assert.equal(attempted, true);
    } finally {
      ctx.restoreConnect();
    }
  });
}
