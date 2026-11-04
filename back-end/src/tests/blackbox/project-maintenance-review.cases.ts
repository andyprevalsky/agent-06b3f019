import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assert } from './projects-harness';
import { prisma } from '../../providers/database';
import { runMaintenanceTick } from '../../domains/projects/maintenanceService';
import * as store from '../../providers/projects/maintenanceStore';
import type { ProjectWorkspace } from '../../providers/projects/types';
import {
  registerWorkspaceExecutor,
  unregisterWorkspaceExecutor,
} from '../../providers/projects/workspaceExecutor';
import { e2bWorkspaceExecutor, restoreWorkspace } from '../../providers/projects/workspace';
type Fixtures = Pick<
  typeof import('./project-maintenance.blackbox'),
  'fixture' | 'runOnce' | 'lastRun' | 'projectRow' | 'git' | 'SYNC_SCRIPT'
>;
export function registerMaintenanceReviewCases({
  fixture,
  runOnce,
  lastRun,
  projectRow,
  git,
  SYNC_SCRIPT,
}: Fixtures): void {
  test('GitHub watch rebuilds repeated head transitions once and publishes each current snapshot', async () => {
    // The sync script owns checkout policy; unlike ff-only it deliberately supports resets.
    const f = await fixture('watch-revisited-head', {
      script: `set -euo pipefail
cd "$ROSE_PROJECT_DIR"
git fetch --quiet origin "$ROSE_DEFAULT_BRANCH"
git checkout --quiet -B "$ROSE_DEFAULT_BRANCH" "origin/$ROSE_DEFAULT_BRANCH"
`,
    });
    const seed = git(f.work, 'rev-parse', 'HEAD');
    const a = f.pushCommit('HEAD.txt', 'A\n');
    const b = f.pushCommit('HEAD.txt', 'B\n');
    let head = seed;
    git(f.work, 'push', '--force', '-q', 'origin', `${head}:main`);
    await prisma.project.update({
      where: { id: f.projectId },
      data: { maintenanceOnGithubChange: true },
    });
    const deps = { ...f.deps, headSha: async () => head };
    const poll = async () => {
      await prisma.project.update({
        where: { id: f.projectId },
        data: { maintenanceWatchCheckedAt: null },
      });
      const tick = await runMaintenanceTick(deps);
      await Promise.all(tick.done);
      return tick;
    };
    assert((await poll()).github === 0, 'first observation only seeds');
    let previousSnapshot: string | null = null;
    let delayedToken: Date | null = null;
    for (const next of [a, b, a, b, a]) {
      head = next;
      git(f.work, 'push', '--force', '-q', 'origin', `${head}:main`);
      assert((await poll()).github === 1, 'each observed transition starts a new run');
      const row = await projectRow(f.projectId);
      if (delayedToken === null) delayedToken = row.maintenanceWatchCheckedAt;
      assert(row.maintenanceWatchedSha === head, 'claimed head remembered');
      assert(row.templateSnapshotSha === head, 'current head actually rebuilt and published');
      assert(
        row.templateSnapshotId !== previousSnapshot,
        'revisiting a SHA creates a fresh snapshot'
      );
      assert(row.templatePrevSnapshotId === previousSnapshot, 'previous snapshot retained');
      previousSnapshot = row.templateSnapshotId;
      assert((await poll()).github === 0, 'same head does not run twice');
    }
    const count = await prisma.projectMaintenanceRun.count({ where: { projectId: f.projectId } });
    assert(count === 5 && f.fake.created.length === 5, 'one run and sandbox per transition');

    const beforeDelayed = await prisma.projectMaintenanceRun.count({
      where: { projectId: f.projectId },
    });
    assert(delayedToken !== null, 'first A observation token retained');
    const delayed = await store.claimRun({
      projectId: f.projectId,
      trigger: 'github',
      mode: 'sync',
      previousWatchedSha: a,
      watchedSha: b,
      watchCheckedAt: delayedToken,
      fromSnapshotId: null,
      leaseMs: 60_000,
      now: new Date(),
    });
    assert(delayed.kind === 'busy', 'old A-to-B observation stays rejected after complete A-B-A');
    assert(
      (await prisma.projectMaintenanceRun.count({ where: { projectId: f.projectId } })) ===
        beforeDelayed,
      'old observation creates no row'
    );
    assert(
      (await projectRow(f.projectId)).templateSnapshotSha === a,
      'delayed observation cannot replace current A'
    );
    const clock = new Date();
    const token1 = await store.markWatchChecked(f.projectId, clock);
    const token2 = await store.markWatchChecked(f.projectId, clock);
    const token3 = await store.markWatchChecked(f.projectId, new Date(clock.getTime() - 1000));
    assert(token1 !== null && token2 !== null && token3 !== null, 'project tokens exist');
    assert(
      token2.getTime() > token1.getTime() && token3.getTime() > token2.getTime(),
      'identical and backwards clocks cannot reuse a token'
    );

    head = b;
    git(f.work, 'push', '--force', '-q', 'origin', `${head}:main`);
    await prisma.project.update({
      where: { id: f.projectId },
      data: { maintenanceWatchCheckedAt: null },
    });
    const ticks = await Promise.all([
      runMaintenanceTick(deps),
      runMaintenanceTick(deps),
      runMaintenanceTick(deps),
    ]);
    await Promise.all(ticks.flatMap((tick) => tick.done));
    assert(
      ticks.reduce((sum, tick) => sum + tick.github, 0) === 1,
      'concurrent watchers admit once'
    );
    assert(f.fake.created.length === 6, 'concurrent watchers create one sandbox');
    const beforeStale = await prisma.projectMaintenanceRun.count({
      where: { projectId: f.projectId },
    });
    const stale = await store.claimRun({
      projectId: f.projectId,
      trigger: 'github',
      mode: 'sync',
      previousWatchedSha: a,
      watchedSha: b,
      fromSnapshotId: null,
      leaseMs: 60_000,
      now: new Date(),
    });
    assert(stale.kind === 'busy', 'completed transition still rejects its stale predecessor');
    assert(
      (await prisma.projectMaintenanceRun.count({ where: { projectId: f.projectId } })) ===
        beforeStale,
      'rejected stale transition leaves no run row'
    );
    const row = await projectRow(f.projectId);
    assert(
      row.templateSnapshotSha === b && row.maintenanceWatchedSha === b,
      'latest snapshot remains current'
    );
    assert(row.maintenanceRunId === null, 'stale claim does not acquire a lease');
  });

  test('maintenance fresh restore excludes synced local work and scrubs only generated refs and stashes', async () => {
    const f = await fixture('local-work-isolation', {
      script: [
        'set -euo pipefail',
        '! git show-ref --verify --quiet refs/heads/rose-sync/local-only',
        '! git stash list | grep -q "rose-sync uncommitted"',
        SYNC_SCRIPT,
        'git config user.name fixture; git config user.email fixture@example.com',
        'echo unrelated >> package.json; git stash push -qm "unrelated user stash"',
        'echo generated >> package.json; git stash push -qm "rose-sync uncommitted (r7, local-only)"',
        'git branch rose-sync/generated HEAD',
      ].join('\n'),
    });
    git(f.work, 'checkout', '-qb', 'local-only');
    writeFileSync(join(f.work, 'LOCAL_ONLY.txt'), 'private local commit\n');
    git(f.work, 'add', '-A');
    git(f.work, 'commit', '-qm', 'local-only');
    git(f.work, 'checkout', '-q', 'main');
    const bundle = join(f.work, '..', 'local.bundle');
    git(f.work, 'bundle', 'create', bundle, '--all');
    writeFileSync(join(f.work, 'package.json'), '{"local":"uncommitted"}\n');
    const workspace: ProjectWorkspace = {
      ...f.workspace(),
      revision: 7,
      manifest: {
        version: 1,
        git: {
          remoteUrl: f.remote,
          branch: 'main',
          headSha: git(f.work, 'rev-parse', 'HEAD'),
          unpushedCommits: 1,
          dirtyPaths: ['package.json'],
          bundleKind: 'full',
          bundleBranches: ['main', 'local-only'],
        },
      },
      gitBundle: readFileSync(bundle),
      uncommittedPatch: Buffer.from(git(f.work, 'diff', '--binary', 'HEAD') + '\n'),
    };
    f.deps.prepareWorkspace = async () => workspace;
    await runOnce(f);
    const run = await lastRun(f.projectId);
    assert(run.status === 'SUCCEEDED', `maintenance isolation: ${run.status}: ${run.error}`);
    const repo = join(f.fake.home, '..', 'snapshots', run.snapshotId!, 'workspace');
    assert(
      git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/rose-sync/') === '',
      'no generated refs published'
    );
    const stashes = git(repo, 'stash', 'list');
    assert(!stashes.includes('rose-sync uncommitted'), 'synced stash absent from snapshot');
    assert(stashes.includes('unrelated user stash'), 'unrelated stash preserved');

    // Ordinary fresh sessions still restore the same local branches and patch.
    const ordinary = await f.fake.createSandbox('base-template');
    const ordinaryId = `ordinary-local-${randomBytes(4).toString('hex')}`;
    registerWorkspaceExecutor(ordinaryId, e2bWorkspaceExecutor(ordinary, f.fake.home));
    try {
      const report = await restoreWorkspace(ordinaryId, workspace);
      assert(
        report.localWork.branches.includes('rose-sync/local-only'),
        'ordinary local branch restored'
      );
      assert(report.localWork.stash?.includes('rose-sync uncommitted'), 'ordinary patch stashed');
    } finally {
      unregisterWorkspaceExecutor(ordinaryId);
    }

    // Disabling local work must not disable the full-bundle clone fallback.
    const fallback = await f.fake.createSandbox('base-template');
    const fallbackId = `maintenance-bundle-${randomBytes(4).toString('hex')}`;
    registerWorkspaceExecutor(fallbackId, e2bWorkspaceExecutor(fallback, f.fake.home));
    try {
      const report = await restoreWorkspace(
        fallbackId,
        { ...workspace, cloneUrl: null, project: { ...workspace.project, repoUrl: null } },
        { restoreLocalWork: false }
      );
      assert(
        report.checkout.source === 'bundle' && report.checkout.cloned,
        'full bundle still restores checkout'
      );
      assert(
        report.localWork.branches.length === 0 && report.localWork.stash === null,
        'no local-work replay'
      );
      assert(
        existsSync(join(f.fake.home, 'workspace', 'package.json')),
        'bundle checkout files retained'
      );
    } finally {
      unregisterWorkspaceExecutor(fallbackId);
    }
  });

  test('snapshot refresh persists authenticated origin for subsequent fetches', async () => {
    const f = await fixture('authenticated-origin');
    await runOnce(f);
    const head = f.pushCommit('AUTH_LATER.md', 'new head\n');
    const sandbox = await f.fake.createSandbox('snap-1');
    const repo = join(f.fake.home, 'workspace');
    const authenticated = 'https://fixture-user:fixture-token@fixture.invalid/project.git';
    // Rewrite the fake authenticated URL to the local bare fixture. No remote service.
    git(repo, 'config', `url.file://${f.remote}.insteadOf`, authenticated);
    const id = `authenticated-origin-${randomBytes(4).toString('hex')}`;
    registerWorkspaceExecutor(id, e2bWorkspaceExecutor(sandbox, f.fake.home));
    try {
      const report = await restoreWorkspace(id, {
        ...f.workspace(),
        cloneUrl: authenticated,
        startedFromSnapshot: true,
      });
      assert(
        report.checkout.headSha === head,
        'snapshot fast-forwards through authenticated source'
      );
      assert(
        git(repo, 'config', '--get', 'remote.origin.url') === authenticated,
        'authenticated origin persists'
      );
      git(repo, 'fetch', '--quiet', 'origin', 'main');
      assert(git(repo, 'rev-parse', 'origin/main') === head, 'subsequent origin fetch succeeds');
    } finally {
      unregisterWorkspaceExecutor(id);
    }
  });
}
