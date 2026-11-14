/**
 * Close is bounded (prod 2026-11-08, code session 2256e1eb): a 366 MB archive
 * was downloaded before the cap check, the read aborted at the SDK's 60 s default
 * after ~206 s of close, and the worker's 180 s close call timed out with no
 * handoff while the lease stayed held. Here the fake E2B sandbox downloads
 * worktree.tar.gz like the SDK: aborting at its request timeout. Registered by
 * code-sessions.blackbox.ts.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { closeClaudeCodeSession } from '../../providers/e2bCloseSession';
import { seedRepo } from './code-sessions-checkpoint-size.cases';

export interface CloseBoundContext {
  fixtureDir: string;
  patchConnect: (impl: (id: string) => Promise<Sandbox>) => void;
  originalConnect: (id: string) => Promise<Sandbox>;
}

const MIB = 1024 * 1024;
const CAP_ENV = 'CODE_SESSION_CHECKPOINT_MAX_ARTIFACT_BYTES';
const CLOSE_BUDGET_ENV = 'CODE_SESSION_CLOSE_CHECKPOINT_BUDGET_MS';

async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/**
 * E2B stand-in over a local HOME (/home/user -> home). Reading worktree.tar.gz
 * records the request timeout it was given; with `stallArchive` the download
 * never completes and aborts like the SDK at that timeout (default 60 s).
 */
function closeFakeSandbox(home: string, sandboxId: string, stallArchive: boolean) {
  const map = (value: string) => value.split('/home/user').join(home);
  const calls = { connects: 0, paused: 0, killed: 0, archiveReadTimeouts: [] as number[] };
  const sandbox = {
    sandboxId,
    commands: {
      run: async (cmd: string, opts?: { cwd?: string; timeoutMs?: number }) => {
        const result = spawnSync('bash', ['-c', map(cmd)], {
          cwd: map(opts?.cwd ?? '/home/user'),
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_TERMINAL_PROMPT: '0' },
          maxBuffer: 64 * MIB,
          ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        });
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
    },
    files: {
      exists: async (path: string) => existsSync(map(path)),
      remove: async (path: string) => rmSync(map(path), { force: true }),
      read: async (path: string, opts?: { format?: string; requestTimeoutMs?: number }) => {
        if (path.endsWith('/worktree.tar.gz')) {
          const timeoutMs = opts?.requestTimeoutMs ?? 60_000;
          calls.archiveReadTimeouts.push(timeoutMs);
          if (stallArchive) {
            await new Promise((_resolve, reject) =>
              setTimeout(
                () => reject(new Error('The operation was aborted due to timeout')),
                timeoutMs
              )
            );
          }
        }
        const data = readFileSync(map(path));
        return opts?.format === 'text' ? data.toString('utf8') : new Uint8Array(data);
      },
      write: async (path: string, data: ArrayBuffer | string) => {
        mkdirSync(dirname(map(path)), { recursive: true });
        writeFileSync(
          map(path),
          typeof data === 'string' ? Buffer.from(data) : Buffer.from(new Uint8Array(data))
        );
      },
    },
    pause: async () => {
      calls.paused += 1;
      return true;
    },
    kill: async () => {
      calls.killed += 1;
    },
  };
  return { sandbox: sandbox as unknown as Sandbox, calls };
}

/** Rejects when `promise` has not settled within `ms`; never leaves the timer running. */
async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not return within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function registerCloseBoundCases(params: CloseBoundContext): void {
  const ctx = {
    fixtureDir: params.fixtureDir,
    patchConnect: params.patchConnect,
    restoreConnect: () => params.patchConnect(params.originalConnect),
  };
  const withCap = <T>(bytes: number, fn: () => Promise<T>): Promise<T> =>
    withEnv(CAP_ENV, String(bytes), fn);

  /** A leased E2B code session with a task, a handoff file and a pushed repo in HOME. */
  async function withE2bClose(
    label: string,
    stallArchive: boolean,
    fn: (setup: {
      task: { id: string };
      codeSessionId: string;
      home: string;
      workspace: string;
      handoff: string;
      fake: ReturnType<typeof closeFakeSandbox>;
    }) => Promise<void>
  ): Promise<void> {
    const userId = `code-session-close-${randomUUID()}`;
    await prisma.user.create({ data: { userId, name: 'Code Session Close' } });
    const agentId = randomUUID();
    const sandboxId = `sb-${randomUUID()}`;
    const home = join(ctx.fixtureDir, `home-close-${label}-${randomUUID()}`);
    const { workspace } = seedRepo(ctx.fixtureDir, home, 0);
    const handoff = JSON.stringify({ sentinel: `HANDOFF_${label}`, summary: 'done' });
    mkdirSync(join(home, '.rose'), { recursive: true });
    writeFileSync(join(home, '.rose', 'handoff.json'), handoff);
    const codeSession = await prisma.codeSession.create({
      data: {
        userId,
        rootAgentId: agentId,
        ownerAgentId: agentId,
        repoKey: `e2b-${randomUUID()}`,
        branch: 'main',
        mergeTarget: 'main',
        sandboxKind: 'e2b',
        sandboxId,
        leaseOwner: `tool:${agentId}:1`,
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const task = await prisma.claudeCodeSession.create({
      data: { agentId, sandboxId, goal: 'g', codeSessionId: codeSession.id },
    });
    const fake = closeFakeSandbox(home, sandboxId, stallArchive);
    ctx.patchConnect(async () => {
      fake.calls.connects += 1;
      return fake.sandbox;
    });
    try {
      await fn({ task, codeSessionId: codeSession.id, home, workspace, handoff, fake });
    } finally {
      ctx.restoreConnect();
      await prisma.claudeCodeSession.deleteMany({ where: { id: task.id } });
      await prisma.codeSession.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { userId } });
    }
  }

  async function assertReleased(codeSessionId: string, fake: ReturnType<typeof closeFakeSandbox>) {
    assert.equal(fake.calls.paused, 1, 'close pauses the sandbox even when its checkpoint fails');
    assert.equal(fake.calls.killed, 0, 'a persistent session is never killed by close');
    const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSessionId } });
    assert.equal(row.state, 'PAUSED');
    assert.equal(row.leaseOwner, null, 'the lease is released for the next spawn');
    assert.equal(row.latestCheckpointSeq, 0, 'no partial checkpoint is committed');
  }

  test('close bounds a stalled worktree download: it returns the handoff and releases the lease within its checkpoint budget', async () => {
    await withE2bClose('stall', true, async ({ task, codeSessionId, handoff, fake }) => {
      const budgetMs = 3_000;
      const started = Date.now();
      const closed = await withEnv(CLOSE_BUDGET_ENV, String(budgetMs), () =>
        within(
          budgetMs + 7_000,
          'close with a stalled worktree download',
          closeClaudeCodeSession(task.id, undefined, undefined, [], { reason: 'close' })
        )
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < budgetMs + 7_000, `close took ${elapsed} ms`);
      assert.equal(fake.calls.archiveReadTimeouts.length, 1, 'the archive download was attempted');
      assert.ok(
        fake.calls.archiveReadTimeouts[0] <= budgetMs,
        `the archive download gets the remaining budget as its timeout, got ${fake.calls.archiveReadTimeouts[0]} ms`
      );
      assert.deepEqual(closed.handoff, { status: 'present', content: handoff });
      assert.equal(closed.codeSession?.state, 'PAUSED');
      await assertReleased(codeSessionId, fake);

      const retried = await closeClaudeCodeSession(task.id, undefined, undefined, [], {
        reason: 'close',
      });
      assert.deepEqual(retried.handoff, closed.handoff, 'a retried close returns the same handoff');
      assert.deepEqual(retried.outputFiles, closed.outputFiles);
      assert.equal(fake.calls.connects, 1, 'a retried close never reconnects the paused sandbox');
    });
  });

  test('close refuses an over-cap worktree archive before downloading it, and a retried close returns the same handoff', async () => {
    await withE2bClose(
      'overcap',
      false,
      async ({ task, codeSessionId, workspace, handoff, fake }) => {
        // Untracked and incompressible: it belongs in the archive, which outgrows the cap.
        writeFileSync(join(workspace, 'scratch.bin'), randomBytes(3 * MIB));
        const closed = await withCap(1 * MIB, () =>
          within(
            30_000,
            'close with an over-cap archive',
            closeClaudeCodeSession(task.id, undefined, undefined, [], { reason: 'close' })
          )
        );
        assert.deepEqual(
          fake.calls.archiveReadTimeouts,
          [],
          'an archive over the cap is never downloaded'
        );
        assert.deepEqual(closed.handoff, { status: 'present', content: handoff });
        await assertReleased(codeSessionId, fake);

        const retried = await closeClaudeCodeSession(task.id, undefined, undefined, [], {
          reason: 'close',
        });
        assert.deepEqual(retried.handoff, { status: 'present', content: handoff });
        assert.deepEqual(retried.outputFiles, closed.outputFiles);
        assert.equal(retried.codeSession?.state, 'PAUSED');
        assert.equal(fake.calls.connects, 1, 'a retried close never reconnects the paused sandbox');
      }
    );
  });
}
