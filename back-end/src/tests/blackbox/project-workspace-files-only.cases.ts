/**
 * `rose-sync push --files-only` (C9): exactly the named env files are written and the
 * stored git artifacts are neither replaced nor cleared, and the commands that cannot
 * honor the flag reject it. Called/registered by project-workspace.blackbox.ts, which
 * owns the fixture checkout, the shared CLI runner and the DB harness.
 *
 *   checkout ── push --files-only --include P ──► POST /api/projects/:id/sync
 *        │  named env files only; no dotenv discovery, bundle or patch
 *        │  retained bundle/patch keep their own git metadata (patch base, bundle kind)
 *        └─ an INTERNAL symlink is flattened: content under P, no target, no link record
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import { assert, type Session } from './projects-harness';

export interface SyncRun {
  revision: number;
  written: string[];
  unchanged: string[];
  deleted: string[];
  gitBundle: string;
  uncommittedPatch: string;
}

/** The git manifest fields a stored bundle or patch depends on to be restored. */
function snapshotGit(manifest: unknown) {
  const git = (manifest as { git: Record<string, unknown> }).git;
  return {
    headSha: git.headSha,
    branch: git.branch,
    unpushedCommits: git.unpushedCommits,
    dirtyPaths: git.dirtyPaths,
    bundleKind: git.bundleKind,
    bundleBranches: git.bundleBranches,
  };
}

export async function verifyFilesOnlyPush(ctx: {
  s: Session;
  checkout: string;
  projectId: string;
  runSync: (s: Session, args: string[]) => Promise<SyncRun>;
  sh: (cwd: string, cmd: string) => string;
}): Promise<void> {
  const { s, checkout, projectId, runSync, sh } = ctx;
  // --files-only pushes the named env files and nothing else: a new unpushed branch
  // is not bundled and the stored artifacts are neither replaced nor cleared.
  const snapshotBefore = await prisma.projectSyncSnapshot.findUniqueOrThrow({
    where: { projectId },
  });
  sh(
    checkout,
    `git branch files-only-extra $(git -c user.name=t -c user.email=t@example.com commit-tree -m extra -p HEAD 'HEAD^{tree}')`
  );
  // HEAD moves to a commit the retained patch and bundle know nothing about.
  sh(checkout, 'git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m moved');
  const movedHead = sh(checkout, 'git rev-parse HEAD').trim();
  writeFileSync(join(checkout, 'app', '.env.local'), 'APP_MODE=files-only\n');
  // A discoverable env file that is NOT named: --files-only must not auto-discover it.
  writeFileSync(join(checkout, 'app', '.env.discovered'), 'DISCOVERED=1\n');
  const filesOnly = await runSync(s, [
    'push',
    '--dir',
    checkout,
    '--project',
    projectId,
    '--files-only',
    '--include',
    'app/.env.local',
  ]);
  assert(
    JSON.stringify(filesOnly.written) === JSON.stringify(['app/.env.local']),
    `files-only writes the changed env file: ${filesOnly.written}`
  );
  assert(
    filesOnly.gitBundle === 'unchanged' && filesOnly.uncommittedPatch === 'unchanged',
    `files-only leaves the stored artifacts alone: ${filesOnly.gitBundle}/${filesOnly.uncommittedPatch}`
  );
  assert(filesOnly.deleted.length === 0, 'files-only never prunes');
  assert(
    !filesOnly.written.includes('app/.env.discovered') &&
      !filesOnly.unchanged.includes('app/.env.discovered'),
    `files-only pushed an env file it was not asked for: ${filesOnly.written}`
  );
  rmSync(join(checkout, 'app', '.env.discovered'));
  const snapshotAfter = await prisma.projectSyncSnapshot.findUniqueOrThrow({
    where: { projectId },
  });
  assert(
    snapshotAfter.gitBundleFingerprint === snapshotBefore.gitBundleFingerprint &&
      snapshotAfter.patchFingerprint === snapshotBefore.patchFingerprint,
    'files-only did not upload the new unpushed branch'
  );
  // The retained bundle and patch keep their own git metadata: restoration finds the
  // patch base (headSha), the bundle kind and the bundled branches of THAT snapshot,
  // not of the HEAD this files-only push happened to run at.
  const gitBefore = snapshotGit(snapshotBefore.manifest);
  const gitAfter = snapshotGit(snapshotAfter.manifest);
  assert(
    gitBefore.headSha !== movedHead && gitBefore.bundleKind === 'unpushed',
    `fixture moved HEAD past a stored unpushed bundle: ${gitBefore.headSha} ${gitBefore.bundleKind}`
  );
  assert(
    JSON.stringify(gitAfter) === JSON.stringify(gitBefore),
    `files-only kept the retained artifacts' git metadata: ${JSON.stringify(gitAfter)} vs ${JSON.stringify(gitBefore)}`
  );

  // An INTERNAL symlink named by --include carries its content under the selected path;
  // its target is not a selected file, so it is not synced and no link is recorded.
  writeFileSync(join(checkout, 'app', '.env.shared'), 'ALIASED_VALUE=1\n');
  symlinkSync('.env.shared', join(checkout, 'app', '.env.alias'));
  const aliased = await runSync(s, [
    'push',
    '--dir',
    checkout,
    '--project',
    projectId,
    '--files-only',
    '--include',
    'app/.env.alias',
  ]);
  assert(
    JSON.stringify(aliased.written) === JSON.stringify(['app/.env.alias']),
    `files-only syncs the selected symlink path only: ${aliased.written}`
  );
  assert(
    !aliased.unchanged.includes('app/.env.shared') && aliased.deleted.length === 0,
    `files-only synced the symlink target: ${aliased.unchanged}`
  );
  const aliasRow = await prisma.projectEnvFile.findUniqueOrThrow({
    where: { projectId_path: { projectId, path: 'app/.env.alias' } },
  });
  assert(
    aliasRow.linkTarget === null &&
      JSON.stringify(aliasRow.variables) === JSON.stringify([{ name: 'ALIASED_VALUE' }]),
    `the selected path holds the linked content: ${aliasRow.linkTarget} ${JSON.stringify(aliasRow.variables)}`
  );
  const targetRow = await prisma.projectEnvFile.findUnique({
    where: { projectId_path: { projectId, path: 'app/.env.shared' } },
  });
  assert(targetRow === null, 'the symlink target was never selected, so it is not stored');
  const snapshotAliased = await prisma.projectSyncSnapshot.findUniqueOrThrow({
    where: { projectId },
  });
  assert(
    JSON.stringify(snapshotGit(snapshotAliased.manifest)) === JSON.stringify(gitBefore),
    'consecutive files-only pushes keep the same retained git metadata'
  );
  assert(
    ((snapshotAliased.manifest as { symlinks?: unknown[] }).symlinks ?? []).length === 0,
    'files-only records no link structure for a symlink it flattened'
  );
  rmSync(join(checkout, 'app', '.env.alias'));
  rmSync(join(checkout, 'app', '.env.shared'));
  sh(checkout, 'git reset -q --soft HEAD~1');
  sh(checkout, 'git branch -D files-only-extra');
  writeFileSync(join(checkout, 'app', '.env.local'), 'APP_MODE=staging\n');
  await runSync(s, ['push', '--dir', checkout, '--project', projectId]);
}

export function registerFilesOnlyRejectionCase(ctx: {
  fixture: string;
  roseSync: string;
  sh: (cwd: string, cmd: string) => string;
  runChild: (
    file: string,
    args: string[],
    env?: NodeJS.ProcessEnv
  ) => Promise<{ status: number | null; stdout: string; stderr: string }>;
}): void {
  const { fixture, roseSync, sh, runChild } = ctx;
  test('--files-only is rejected by every command that would ignore it', async () => {
    const checkout = join(fixture, 'files-only-rejected');
    mkdirSync(checkout);
    sh(checkout, 'git init -q -b main');
    for (const command of ['seed-rose', 'onboard', 'status']) {
      const out = await runChild(
        process.execPath,
        [roseSync, command, '--files-only', '--dir', checkout, '--json'],
        { ...process.env, ROSE_TOKEN: '', ROSE_API_KEY: '', ROSE_USER_ID: '' }
      );
      assert(
        out.status === 1 &&
          out.stderr.includes(`--files-only is only supported by push, not ${command}`) &&
          out.stdout === '',
        `${command} --files-only must fail before capturing or uploading: ${out.status} ${out.stderr}${out.stdout}`
      );
    }
  });
}
