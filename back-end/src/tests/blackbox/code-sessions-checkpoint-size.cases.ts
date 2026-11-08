/**
 * Checkpoint size cases, run inside code-sessions.blackbox.ts with its local
 * object store (CODE_SESSION_STORAGE_LOCAL_DIR):
 *
 *   HOME/<repo> ──checkpoint──► worktree.tar.gz holds ONLY what git cannot
 *                               reproduce: modified, untracked and ignored files
 *   restore ──► repo restore (remote + bundle + refs) ──► git checkout-index puts
 *               the omitted tracked files back, recorded deletions stay deleted.
 *
 * The incident: a Rose checkout grew past the per-artifact cap because every
 * close re-stored the unchanged tracked working tree (benchmark history ledgers
 * alone are >1 GB uncompressed), so `Checkpoint worktree is 210456698 bytes
 * (cap 209715200); refusing to store` failed every close. The cap stays; the
 * fixture here scales it down (1 MiB cap, 3 MiB of incompressible tracked data).
 *
 * Close is bounded too (prod 2026-11-08, code session 2256e1eb): a 366 MB archive
 * was downloaded before the cap check, the read aborted at the SDK's 60 s default
 * after ~206 s of close, and the worker's 180 s close call timed out with no
 * handoff while the lease stayed held. Here the fake E2B sandbox downloads
 * worktree.tar.gz like the SDK: aborting at its request timeout.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { closeClaudeCodeSession } from '../../providers/e2bCloseSession';
import {
  type CheckpointRepo,
  loadVerifiedCheckpoint,
} from '../../providers/codeSessions/checkpoint';
import {
  checkpointCodeSession,
  restoreLatestCheckpoint,
} from '../../providers/codeSessions/lifecycle';
import { localSandboxFs } from '../../providers/codeSessions/sandboxFs';

export interface CheckpointSizeContext {
  fixtureDir: string;
  patchConnect: (impl: (id: string) => Promise<Sandbox>) => void;
  restoreConnect: () => void;
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A pushed clone with tracked data of `bigBytes`, then local edits on top. */
function seedRepo(
  fixtureDir: string,
  home: string,
  bigBytes: number
): { workspace: string; bigSha: string } {
  const origin = join(fixtureDir, `origin-size-${randomUUID()}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const workspace = join(home, 'workspace');
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['clone', '-q', origin, workspace], { stdio: 'ignore' });
  git(workspace, 'config', 'user.name', 'Test');
  git(workspace, 'config', 'user.email', 'test@example.com');
  git(workspace, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(workspace, 'docs'), { recursive: true });
  // Incompressible bytes: the gzip stays as large as the file, like real ledgers' churn.
  if (bigBytes > 0) writeFileSync(join(workspace, 'data.bin'), randomBytes(bigBytes));
  writeFileSync(join(workspace, 'keep.txt'), 'tracked, will be edited\n');
  writeFileSync(join(workspace, 'delete-me.txt'), 'tracked, will be deleted\n');
  writeFileSync(join(workspace, 'docs', 'notes.md'), '# unchanged tracked file\n');
  writeFileSync(join(workspace, '.gitignore'), 'local.env\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'initial');
  git(workspace, 'push', '-q', 'origin', 'main');
  return { workspace, bigSha: bigBytes > 0 ? sha(join(workspace, 'data.bin')) : '' };
}

function porcelain(workspace: string): string[] {
  return execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
    cwd: workspace,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .sort();
}

export function registerCheckpointSizeCases(ctx: CheckpointSizeContext): void {
  async function withSession(
    fn: (session: Awaited<ReturnType<typeof prisma.codeSession.create>>) => Promise<void>
  ): Promise<void> {
    const userId = `code-session-size-${randomUUID()}`;
    await prisma.user.create({ data: { userId, name: 'Code Session Size' } });
    const owner = randomUUID();
    const session = await prisma.codeSession.create({
      data: {
        userId,
        rootAgentId: owner,
        ownerAgentId: owner,
        repoKey: `local-${randomUUID()}`,
        branch: 'main',
        mergeTarget: 'main',
        sandboxKind: 'local',
        sandboxId: `local-${randomUUID()}`,
      },
    });
    try {
      await fn(session);
    } finally {
      await prisma.codeSession.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { userId } });
    }
  }

  async function withCap<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
    const saved = process.env[CAP_ENV];
    process.env[CAP_ENV] = String(bytes);
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env[CAP_ENV];
      else process.env[CAP_ENV] = saved;
    }
  }

  test('a pushed repo whose unchanged tracked files exceed the cap still checkpoints, stores only what git cannot reproduce, and restores the exact tree', async () => {
    await withSession(async (session) => {
      const home = join(ctx.fixtureDir, `home-size-${randomUUID()}`);
      const { workspace, bigSha } = seedRepo(ctx.fixtureDir, home, 3 * MIB);
      writeFileSync(join(workspace, 'keep.txt'), 'edited after the commit\n');
      rmSync(join(workspace, 'delete-me.txt'));
      writeFileSync(join(workspace, 'scratch.txt'), 'untracked\n');
      writeFileSync(join(workspace, 'local.env'), 'IGNORED=but-needed\n');
      const before = porcelain(workspace);

      const stored = await withCap(1 * MIB, () =>
        checkpointCodeSession({
          session,
          fs: localSandboxFs(home),
          reason: 'close',
          agentId: session.rootAgentId,
        })
      );
      assert.ok(
        stored,
        'the close checkpoint must be stored: the 3 MiB of unchanged tracked data is git content, not session state'
      );
      const manifest = (await loadVerifiedCheckpoint(session.userId, session.id, stored.seq))
        .manifest;
      const worktreeBytes = manifest.artifacts['worktree.tar.gz'].size;
      assert.ok(
        worktreeBytes < 256 * 1024,
        `worktree.tar.gz must hold only modified/untracked/ignored files, got ${worktreeBytes} bytes`
      );

      const restoredHome = join(ctx.fixtureDir, `home-size-restored-${randomUUID()}`);
      mkdirSync(restoredHome, { recursive: true });
      const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
      assert.ok(await restoreLatestCheckpoint(row, localSandboxFs(restoredHome)));
      const restored = join(restoredHome, 'workspace');
      assert.equal(sha(join(restored, 'data.bin')), bigSha, 'unchanged tracked data comes back');
      assert.equal(
        readFileSync(join(restored, 'docs', 'notes.md'), 'utf8'),
        '# unchanged tracked file\n'
      );
      assert.equal(readFileSync(join(restored, 'keep.txt'), 'utf8'), 'edited after the commit\n');
      assert.equal(existsSync(join(restored, 'delete-me.txt')), false, 'a deletion stays deleted');
      assert.equal(readFileSync(join(restored, 'scratch.txt'), 'utf8'), 'untracked\n');
      assert.equal(readFileSync(join(restored, 'local.env'), 'utf8'), 'IGNORED=but-needed\n');
      assert.deepEqual(porcelain(restored), before, 'git sees the same working tree after restore');
    });
  });

  test('a skip-worktree (sparse) file is never resurrected by restore', async () => {
    await withSession(async (session) => {
      const home = join(ctx.fixtureDir, `home-size-sparse-${randomUUID()}`);
      const { workspace } = seedRepo(ctx.fixtureDir, home, 0);
      git(workspace, 'update-index', '--skip-worktree', 'docs/notes.md');
      rmSync(join(workspace, 'docs', 'notes.md'));
      const stored = await checkpointCodeSession({
        session,
        fs: localSandboxFs(home),
        reason: 'close',
        agentId: session.rootAgentId,
      });
      assert.ok(stored, 'checkpoint must succeed');
      const restoredHome = join(ctx.fixtureDir, `home-size-sparse-restored-${randomUUID()}`);
      mkdirSync(restoredHome, { recursive: true });
      const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
      assert.ok(await restoreLatestCheckpoint(row, localSandboxFs(restoredHome)));
      const restored = join(restoredHome, 'workspace');
      assert.equal(
        existsSync(join(restored, 'docs', 'notes.md')),
        false,
        'a file the checkpointed tree did not have on disk is not created by restore'
      );
      assert.equal(readFileSync(join(restored, 'keep.txt'), 'utf8'), 'tracked, will be edited\n');
    });
  });

  async function checkpointAndRestore(
    session: Awaited<ReturnType<typeof prisma.codeSession.create>>,
    home: string
  ): Promise<{ repo: CheckpointRepo | undefined; restored: string }> {
    const stored = await checkpointCodeSession({
      session,
      fs: localSandboxFs(home),
      reason: 'close',
      agentId: session.rootAgentId,
    });
    assert.ok(stored, 'checkpoint must succeed');
    const manifest = (await loadVerifiedCheckpoint(session.userId, session.id, stored.seq))
      .manifest;
    const restoredHome = join(ctx.fixtureDir, `home-size-restored-${randomUUID()}`);
    mkdirSync(restoredHome, { recursive: true });
    const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.ok(await restoreLatestCheckpoint(row, localSandboxFs(restoredHome)));
    return {
      repo: manifest.repos.find((candidate) => candidate.path === 'workspace'),
      restored: join(restoredHome, 'workspace'),
    };
  }

  test('a repo git cannot replay exactly keeps its whole working tree in the archive: content-filter attribute', async () => {
    await withSession(async (session) => {
      const home = join(ctx.fixtureDir, `home-size-filter-${randomUUID()}`);
      const { workspace } = seedRepo(ctx.fixtureDir, home, 0);
      writeFileSync(join(workspace, '.gitattributes'), '*.sec filter=testfilter\n');
      writeFileSync(join(workspace, 'token.sec'), 'content a filter would transform\n');
      git(workspace, 'add', '-A');
      git(workspace, 'commit', '-q', '-m', 'filtered file');
      git(workspace, 'push', '-q', 'origin', 'main');
      const { repo, restored } = await checkpointAndRestore(session, home);
      assert.notEqual(repo?.worktreeFromGit, true, 'a filtered repo is never rebuilt from git');
      assert.equal(
        readFileSync(join(restored, 'token.sec'), 'utf8'),
        'content a filter would transform\n'
      );
    });
  });

  test('a repo git cannot replay exactly keeps its whole working tree in the archive: a path git quotes', async () => {
    await withSession(async (session) => {
      const home = join(ctx.fixtureDir, `home-size-quoted-${randomUUID()}`);
      const { workspace } = seedRepo(ctx.fixtureDir, home, 0);
      writeFileSync(join(workspace, 'we"ird.txt'), 'quoted by git ls-files\n');
      git(workspace, 'add', '-A');
      git(workspace, 'commit', '-q', '-m', 'odd name');
      git(workspace, 'push', '-q', 'origin', 'main');
      const { repo, restored } = await checkpointAndRestore(session, home);
      assert.notEqual(repo?.worktreeFromGit, true, 'a quoted path cannot be matched or replayed');
      assert.equal(readFileSync(join(restored, 'we"ird.txt'), 'utf8'), 'quoted by git ls-files\n');
    });
  });

  test('a repo that is HOME itself omits and rebuilds its unchanged tracked files too', async () => {
    await withSession(async (session) => {
      const origin = join(ctx.fixtureDir, `origin-size-${randomUUID()}.git`);
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      const home = join(ctx.fixtureDir, `home-size-root-${randomUUID()}`);
      mkdirSync(home, { recursive: true });
      execFileSync('git', ['clone', '-q', origin, home], { stdio: 'ignore' });
      git(home, 'config', 'user.name', 'Test');
      git(home, 'config', 'user.email', 'test@example.com');
      git(home, 'checkout', '-q', '-b', 'main');
      writeFileSync(join(home, 'data.bin'), randomBytes(2 * MIB));
      writeFileSync(join(home, 'keep.txt'), 'tracked\n');
      git(home, 'add', '-A');
      git(home, 'commit', '-q', '-m', 'initial');
      git(home, 'push', '-q', 'origin', 'main');
      const bigSha = sha(join(home, 'data.bin'));
      writeFileSync(join(home, 'keep.txt'), 'edited\n');
      const stored = await withCap(1 * MIB, () =>
        checkpointCodeSession({
          session,
          fs: localSandboxFs(home),
          reason: 'close',
          agentId: session.rootAgentId,
        })
      );
      assert.ok(stored, 'a HOME-level repo checkpoints under the cap too');
      const restoredHome = join(ctx.fixtureDir, `home-size-root-restored-${randomUUID()}`);
      mkdirSync(restoredHome, { recursive: true });
      const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
      assert.ok(await restoreLatestCheckpoint(row, localSandboxFs(restoredHome)));
      assert.equal(sha(join(restoredHome, 'data.bin')), bigSha);
      assert.equal(readFileSync(join(restoredHome, 'keep.txt'), 'utf8'), 'edited\n');
      assert.deepEqual(porcelain(restoredHome), [' M keep.txt']);
    });
  });

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
