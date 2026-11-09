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
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
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
}

const MIB = 1024 * 1024;
const CAP_ENV = 'CODE_SESSION_CHECKPOINT_MAX_ARTIFACT_BYTES';

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

  for (const legacy of [false, true]) {
    test(`managed reference sources (${legacy ? 'legacy metadata repair' : 'fresh clone'}) checkpoint below the cap and restore the exact pin and edits`, async () => {
      await withSession(async (session) => {
        const home = join(ctx.fixtureDir, `home-reference-${randomUUID()}`);
        const { workspace } = seedRepo(ctx.fixtureDir, home, 0);
        const sourceHome = join(ctx.fixtureDir, `source-reference-${randomUUID()}`);
        const { workspace: source, bigSha } = seedRepo(ctx.fixtureDir, sourceHome, 3 * MIB);
        const origin = git(source, 'remote', 'get-url', 'origin');
        const pinned = git(source, 'rev-parse', 'HEAD');
        const names = ['openclaw', 'hermes-agent', 'codex', 'prime-agent', 'kimi-code'];
        const urls = [
          'openclaw/openclaw',
          'nousresearch/hermes-agent',
          'openai/codex',
          'PrimeIntellect-ai/prime-agent',
          'MoonshotAI/kimi-code',
        ];
        const config = join(ctx.fixtureDir, `reference-git-${randomUUID()}.config`);
        writeFileSync(
          config,
          `[url "file://${origin}"]\n${urls.map((url) => `  insteadOf = https://github.com/${url}.git\n`).join('')}`
        );
        mkdirSync(join(workspace, 'scripts'));
        mkdirSync(join(workspace, 'prompt-review'));
        copyFileSync(
          new URL('../../../../scripts/sync-reference-repos.sh', import.meta.url),
          join(workspace, 'scripts/sync-reference-repos.sh')
        );
        writeFileSync(join(workspace, '.gitignore'), `local.env\n${names.join('/\n')}/\n`);
        git(workspace, 'add', '-A');
        git(workspace, 'commit', '-q', '-m', 'reference setup');
        git(workspace, 'push', '-q', 'origin', 'main');
        // Model an interrupted mv across the temporary/workspace filesystem boundary.
        // Linux uses real tmpfs; other hosts simulate that boundary at the same path.
        const tempBase = existsSync('/dev/shm') ? '/dev/shm' : ctx.fixtureDir;
        const moveBin = join(ctx.fixtureDir, `reference-mv-${randomUUID()}`);
        mkdirSync(moveBin);
        const realMv = execFileSync('bash', ['-c', 'command -v mv'], {
          encoding: 'utf8',
        }).trim();
        writeFileSync(
          join(moveBin, 'mv'),
          [
            '#!/usr/bin/env node',
            "const fs = require('node:fs');",
            "const { dirname } = require('node:path');",
            "const { spawnSync } = require('node:child_process');",
            'const [source, destination] = process.argv.slice(2);',
            `const externalTemp = ${JSON.stringify(tempBase + '/rose-reference.')};`,
            'if (source.startsWith(externalTemp) || fs.statSync(source).dev !== fs.statSync(dirname(destination)).dev) {',
            '  fs.mkdirSync(destination, { recursive: true });',
            "  fs.writeFileSync(destination + '/HEAD', 'partial metadata copy\\n');",
            "  process.stderr.write('simulated interrupted cross-filesystem metadata move\\n');",
            '  process.exit(1);',
            '}',
            `process.exit(spawnSync(${JSON.stringify(realMv)}, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1);`,
          ].join('\n') + '\n',
          { mode: 0o755 }
        );
        const sync = (...args: string[]): void => {
          execFileSync('bash', ['scripts/sync-reference-repos.sh', ...args], {
            cwd: workspace,
            env: {
              ...process.env,
              GIT_CONFIG_GLOBAL: config,
              GIT_CONFIG_NOSYSTEM: '1',
              ...(legacy
                ? {
                    TMPDIR: tempBase,
                    PATH: `${moveBin}:${process.env.PATH ?? ''}`,
                  }
                : {}),
            },
            stdio: 'pipe',
          });
        };
        sync();
        const reference = join(workspace, 'openclaw');
        writeFileSync(join(reference, 'keep.txt'), 'local reference edit\n');
        rmSync(join(reference, 'delete-me.txt'));
        writeFileSync(join(reference, 'scratch.txt'), 'untracked reference\n');
        writeFileSync(join(reference, 'local.env'), 'IGNORED=reference\n');
        if (legacy) {
          for (const name of names)
            rmSync(join(workspace, name, '.git'), { recursive: true, force: true });
          // Older directories can recover their missing pin from the saved tip record.
          rmSync(join(workspace, 'hermes-agent', '.ref-sha'));
          // The recorded pin must win over a subsequently advanced remote tip.
          writeFileSync(join(source, 'new-tip.txt'), 'new upstream version\n');
          git(source, 'add', '-A');
          git(source, 'commit', '-q', '-m', 'advance upstream');
          git(source, 'push', '-q', 'origin', 'main');
        }
        const before = porcelain(workspace);
        sync();
        assert.deepEqual(
          porcelain(workspace),
          before,
          'nested repo metadata must not change parent status'
        );
        assert.equal(sha(join(reference, 'data.bin')), bigSha, 'sync preserves reference contents');
        assert.equal(readFileSync(join(reference, '.ref-sha'), 'utf8').trim(), pinned);
        // Keep checkpoint IO entirely local after proving the real setup script.
        for (const name of names) {
          if (existsSync(join(workspace, name, '.git')))
            git(join(workspace, name), 'remote', 'set-url', 'origin', origin);
        }
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
          'managed reference data must be reproducible rather than exceed the checkpoint cap'
        );
        const { manifest } = await loadVerifiedCheckpoint(session.userId, session.id, stored.seq);
        assert.ok(manifest.artifacts['worktree.tar.gz'].size < 256 * 1024);
        for (const name of names) {
          const repo = manifest.repos.find((candidate) => candidate.path === `workspace/${name}`);
          assert.equal(repo?.head, pinned);
          assert.equal(repo?.worktreeFromGit, true);
          assert.equal(
            repo?.bundle,
            null,
            'a shallow pinned remote needs no full repository bundle'
          );
        }
        const restoredHome = join(ctx.fixtureDir, `home-reference-restored-${randomUUID()}`);
        mkdirSync(restoredHome);
        const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
        assert.ok(await restoreLatestCheckpoint(row, localSandboxFs(restoredHome)));
        const restored = join(restoredHome, 'workspace', 'openclaw');
        assert.equal(git(restored, 'rev-parse', 'HEAD'), pinned);
        assert.equal(sha(join(restored, 'data.bin')), bigSha);
        assert.equal(readFileSync(join(restored, 'keep.txt'), 'utf8'), 'local reference edit\n');
        assert.equal(existsSync(join(restored, 'delete-me.txt')), false);
        assert.equal(readFileSync(join(restored, 'scratch.txt'), 'utf8'), 'untracked reference\n');
        assert.equal(readFileSync(join(restored, 'local.env'), 'utf8'), 'IGNORED=reference\n');
        assert.equal(
          existsSync(join(restored, 'new-tip.txt')),
          false,
          'restore stays on the old pin'
        );
        assert.deepEqual(porcelain(join(restoredHome, 'workspace')), before);

        if (legacy) {
          const record = readFileSync(join(workspace, 'prompt-review/REF_SHAS.txt'), 'utf8');
          rmSync(join(reference, '.git'), { recursive: true });
          writeFileSync(join(reference, '.ref-sha'), 'invalid-revision\n');
          assert.throws(() => sync(), /invalid saved revision/, 'an unknown pin fails closed');
          assert.equal(existsSync(join(reference, '.git')), false);
          assert.equal(readFileSync(join(reference, 'keep.txt'), 'utf8'), 'local reference edit\n');
          assert.equal(readFileSync(join(workspace, 'prompt-review/REF_SHAS.txt'), 'utf8'), record);
          writeFileSync(join(reference, '.ref-sha'), `${pinned}\n`);
        }
        sync('--force');
        const latest = git(source, 'rev-parse', 'HEAD');
        const record = readFileSync(join(workspace, 'prompt-review/REF_SHAS.txt'), 'utf8');
        for (const name of names) {
          assert.equal(git(join(workspace, name), 'rev-parse', 'HEAD'), latest);
          assert.equal(readFileSync(join(workspace, name, '.ref-sha'), 'utf8').trim(), latest);
          assert.ok(record.includes(`${name} ${latest}\n`));
        }
        assert.equal(
          readFileSync(join(reference, 'keep.txt'), 'utf8'),
          'tracked, will be edited\n'
        );
        assert.equal(existsSync(join(reference, 'delete-me.txt')), true);
        assert.equal(existsSync(join(reference, 'scratch.txt')), false);
        assert.deepEqual(porcelain(workspace), before, 'force refresh also keeps parent status');
      });
    });
  }

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
}
