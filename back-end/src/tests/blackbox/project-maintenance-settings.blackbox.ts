#!/usr/bin/env tsx
/**
 * Black-box tests for the project template sync settings API: settings
 * round-trip (script, timeout up to 8 minutes, nightly, GitHub watch),
 * validation, owner scoping, and the refusals that happen before any sandbox
 * could be created (so this suite never spends E2B).
 *
 * Usage: bash scripts/run-blackbox-tests.sh project-maintenance-settings
 */
// First import: refuses a non-local DATABASE_URL before any module can query.
import { anonymousSession, assert, call, expectStatus, type Session } from './projects-harness';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { prisma } from '../../providers/database';
import {
  templateSnapshotOf,
  syncSnapshotMatchesRepo,
  prepareProjectWorkspace,
  claimSyncRevision,
  commitSyncPush,
} from '../../providers/projects/store';
import {
  claimRun,
  findMaintenanceProject,
  publishSnapshot,
} from '../../providers/projects/maintenanceStore';

import { registerMaintenanceSchedulingCases } from './project-maintenance-scheduling.cases';

const userIds: string[] = [];
registerMaintenanceSchedulingCases(userIds);

after(async () => {
  await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.$disconnect();
});

async function api(session: Session, path: string, init: { method?: string; body?: unknown } = {}) {
  return call(path, { auth: session.token, ...init });
}

test('settings round-trip, validation and owner scoping over HTTP', async () => {
  const owner = await anonymousSession();
  userIds.push(owner.userId);
  const created = await api(owner, '/api/projects', {
    method: 'POST',
    body: { name: 'PJ-Maint-Http', repoUrl: null },
  });
  expectStatus(created, 201, 'create');
  const id = String(created.data.id);
  const defaults = created.data as {
    maintenance: { script: string | null; timeoutS: number; nightly: boolean };
    snapshot: unknown;
  };
  assert(defaults.maintenance.script === null && defaults.maintenance.timeoutS === 480, 'defaults');
  assert(defaults.snapshot === null, 'no snapshot yet');

  const updated = await api(owner, `/api/projects/${id}`, {
    method: 'PUT',
    body: {
      maintenance: {
        script: 'echo hi',
        timeoutS: 480,
        nightly: true,
        onGithubChange: true,
      },
    },
  });
  expectStatus(updated, 200, 'update');
  const m = (updated.data as { maintenance: Record<string, unknown> }).maintenance;
  assert(m.script === 'echo hi' && m.timeoutS === 480, 'script and timeout stored');
  assert(m.nightly === true && m.onGithubChange === true, 'triggers stored');
  assert(typeof m.nextRunAt === 'string' && m.running === false, 'next run time shown');
  const tooLong = await api(owner, `/api/projects/${id}`, {
    method: 'PUT',
    body: { maintenance: { timeoutS: 481 } },
  });
  expectStatus(tooLong, 400, 'timeout above 8 minutes');
  const unknown = await api(owner, `/api/projects/${id}`, {
    method: 'PUT',
    body: { maintenance: { cron: '* * * * *' } },
  });
  expectStatus(unknown, 400, 'unknown maintenance field');
  const cleared = await api(owner, `/api/projects/${id}`, {
    method: 'PUT',
    body: { maintenance: { script: null } },
  });
  assert(
    (cleared.data as { maintenance: { script: unknown } }).maintenance.script === null,
    'cleared'
  );
  const raw = await prisma.project.findUniqueOrThrow({ where: { id } });
  assert(
    raw.maintenanceScript === '',
    'a cleared script is stored as "" (null = never configured)'
  );

  const state = await api(owner, `/api/projects/${id}/maintenance`);
  expectStatus(state, 200, 'maintenance state');
  const view = state.data as {
    runs: unknown[];
    snapshot: unknown;
    running: boolean;
  };
  assert(view.runs.length === 0 && view.snapshot === null && view.running === false, 'empty state');
  // Run now is refused before any sandbox: no repository, then no script.
  const noRepo = await api(owner, `/api/projects/${id}/maintenance/runs`, {
    method: 'POST',
    body: {},
  });
  expectStatus(noRepo, 400, 'no repository');
  await api(owner, `/api/projects/${id}`, {
    method: 'PUT',
    body: { repoUrl: 'https://github.com/x/y' },
  });
  const noScript = await api(owner, `/api/projects/${id}/maintenance/runs`, {
    method: 'POST',
    body: {},
  });
  expectStatus(noScript, 400, 'no sync script');
  expectStatus(
    await api(owner, `/api/projects/${id}/maintenance/runs`, {
      method: 'POST',
      body: { mode: 'x' },
    }),
    400,
    'bad mode'
  );
  assert(
    (await prisma.projectMaintenanceRun.count({ where: { projectId: id } })) === 0,
    'refused triggers leave no rows'
  );

  const stranger = await anonymousSession();
  userIds.push(stranger.userId);
  expectStatus(
    await api(stranger, `/api/projects/${id}/maintenance`),
    404,
    'foreign project state'
  );
  expectStatus(
    await api(stranger, `/api/projects/${id}/maintenance/runs`, {
      method: 'POST',
      body: {},
    }),
    404,
    'foreign Run now'
  );
  expectStatus(
    await api(stranger, `/api/projects/${id}/maintenance/runs/${randomUUID()}`),
    404,
    'foreign run log'
  );
  expectStatus(await call(`/api/projects/${id}/maintenance`), 401, 'no credentials');
});

test('repository changes invalidate snapshot use while retaining cleanup custody', async () => {
  const owner = await anonymousSession();
  userIds.push(owner.userId);
  const created = await api(owner, '/api/projects', {
    method: 'POST',
    body: { name: 'Repo-Rebind', repoUrl: 'https://github.com/fixture/old' },
  });
  expectStatus(created, 201, 'create rebind fixture');
  const id = String(created.data.id);
  await prisma.project.update({
    where: { id },
    data: {
      templateSnapshotId: 'held-current',
      templatePrevSnapshotId: 'held-previous',
      templateSnapshotAt: new Date(),
      templateSnapshotSha: 'a'.repeat(40),
      templateSnapshotRunId: 'old-run',
      templateSnapshotSize: { cpu: 2, memoryGb: 4 },
      maintenanceWatchedSha: 'a'.repeat(40),
      maintenanceWatchCheckedAt: new Date(),
      maintenanceRunId: 'active-run',
      maintenanceLeaseUntil: new Date(Date.now() + 60_000),
    },
  });
  const replacement = { repoUrl: 'https://github.com/fixture/new' };
  expectStatus(
    await api(owner, `/api/projects/${id}`, {
      method: 'PUT',
      body: replacement,
    }),
    409,
    'active run retains repository custody'
  );
  expectStatus(
    await api(owner, '/api/projects', {
      method: 'PUT',
      body: { name: 'Repo-Rebind', ...replacement },
    }),
    409,
    'upsert cannot bypass active custody'
  );
  let row = await prisma.project.findUniqueOrThrow({ where: { id } });
  assert(
    row.repoUrl?.endsWith('/old') && row.maintenanceRunId === 'active-run',
    'rejection changes nothing'
  );
  await prisma.project.update({
    where: { id },
    data: { maintenanceRunId: null, maintenanceLeaseUntil: null },
  });
  expectStatus(
    await api(owner, `/api/projects/${id}`, {
      method: 'PUT',
      body: replacement,
    }),
    200,
    'change repo'
  );
  row = await prisma.project.findUniqueOrThrow({ where: { id } });
  assert(
    row.templateSnapshotId === 'held-current' && row.templatePrevSnapshotId === 'held-previous',
    'both cleanup references retained'
  );
  assert(
    row.templateSnapshotAt === null &&
      row.templateSnapshotSha === null &&
      row.templateSnapshotRunId === null &&
      row.templateSnapshotSize === null,
    'snapshot validity metadata cleared'
  );
  assert(
    row.maintenanceWatchedSha === null && row.maintenanceWatchCheckedAt === null,
    'old repository watch cleared'
  );
  assert(templateSnapshotOf(row) === null, 'sessions cannot use quarantined snapshot');
  await prisma.projectSyncSnapshot.create({
    data: {
      projectId: id,
      revision: 1,
      manifest: {
        version: 1,
        git: { remoteUrl: 'https://github.com/fixture/old' },
      },
      encryptedGitBundle: 'must-not-decrypt',
      encryptedUncommittedPatch: 'must-not-decrypt',
      gitBundleFingerprint: 'a'.repeat(64),
      patchFingerprint: 'b'.repeat(64),
    },
  });
  assert(row.syncRevision === 1, 'repository replacement invalidates old sync revisions');
  assert(
    (await claimSyncRevision(id, 0, { repoUrl: 'https://github.com/fixture/old' }, null)) === null,
    'pre-change null-project auto-binding cannot claim'
  );
  assert(
    (await claimSyncRevision(
      id,
      row.syncRevision,
      { repoUrl: 'https://github.com/fixture/old' },
      null
    )) === null,
    'repository identity is checked even at a matching revision'
  );
  assert(
    (await commitSyncPush(id, 0, null, { repoUrl: 'https://github.com/fixture/old' }, [], [], {
      manifest: { version: 1 },
      encryptedGitBundle: 'stale',
      gitBundleFingerprint: 'a'.repeat(64),
      encryptedUncommittedPatch: null,
      patchFingerprint: null,
    })) === null,
    'post-settings stale sync cannot publish files or snapshot'
  );
  assert(
    (
      await prisma.projectSyncSnapshot.findUniqueOrThrow({
        where: { projectId: id },
      })
    ).encryptedGitBundle === 'must-not-decrypt',
    'rejected stale sync preserves stored ciphertext'
  );
  const key = await api(owner, '/api/projects/sync-key');
  expectStatus(key, 200, 'sync key');
  for (const artifacts of [
    { gitBundle: { fingerprint: 'a'.repeat(64) }, uncommittedPatch: null },
    {},
  ]) {
    const resend = await api(owner, `/api/projects/${id}/sync`, {
      method: 'POST',
      body: {
        keyId: key.data.keyId,
        baseRevision: row.syncRevision,
        files: [],
        manifest: { version: 1, git: { remoteUrl: replacement.repoUrl } },
        ...artifacts,
      },
    });
    expectStatus(
      resend,
      409,
      'cross-repository fingerprint/omission cannot rebind stored ciphertext'
    );
  }
  const workspace = await prepareProjectWorkspace(owner.userId, id);
  assert(
    workspace.manifest === null &&
      workspace.gitBundle === null &&
      workspace.uncommittedPatch === null,
    'stale synced checkout is quarantined before decryption'
  );
  assert(
    (
      await prisma.projectSyncSnapshot.findUniqueOrThrow({
        where: { projectId: id },
      })
    ).encryptedGitBundle === 'must-not-decrypt',
    'encrypted user data remains stored'
  );

  assert(
    (await findMaintenanceProject(id))?.templateSnapshotAt === null,
    'maintenance sees invalid snapshot'
  );
  const stale = await claimRun({
    projectId: id,
    expectedRepoUrl: 'https://github.com/fixture/old',
    trigger: 'manual',
    mode: 'sync',
    fromSnapshotId: 'held-current',
    leaseMs: 60_000,
    now: new Date(),
  });
  assert(stale.kind === 'busy', 'start read before repo change cannot claim afterwards');
  assert(
    (await prisma.projectMaintenanceRun.count({ where: { projectId: id } })) === 0,
    'stale claim rolls back'
  );
  const run = await claimRun({
    projectId: id,
    expectedRepoUrl: replacement.repoUrl,
    trigger: 'manual',
    mode: 'sync',
    fromSnapshotId: null,
    leaseMs: 60_000,
    now: new Date(),
  });
  assert(run.kind === 'claimed', 'new-repo maintenance may claim');
  if (run.kind !== 'claimed') throw new Error('new-repo claim missing');
  const published = await publishSnapshot({
    projectId: id,
    runId: run.run.id,
    snapshotId: 'new-current',
    sha: 'b'.repeat(40),
    size: null,
    now: new Date(),
  });
  assert(
    published.published && published.dropSnapshotId === 'held-previous',
    'existing cleanup retires oldest'
  );
  row = await prisma.project.findUniqueOrThrow({ where: { id } });
  assert(
    row.templatePrevSnapshotId === 'held-current' && templateSnapshotOf(row)?.id === 'new-current',
    'new valid snapshot retains former current for later cleanup'
  );
});

test('synced checkout binding preserves same-repo and explicitly local bundles only', () => {
  const manifest = (remoteUrl: string | null) => ({
    version: 1 as const,
    git: {
      remoteUrl,
      branch: 'main',
      headSha: null,
      unpushedCommits: 0,
      dirtyPaths: [],
    },
  });
  assert(
    syncSnapshotMatchesRepo('./Repo', manifest('./Repo')),
    'same relative local repository stays reusable'
  );
  assert(
    !syncSnapshotMatchesRepo('./Repo', manifest('./repo')),
    'relative local path case is significant'
  );
  assert(
    !syncSnapshotMatchesRepo('Work/Repo', manifest('work/repo')),
    'two-component local path case is significant'
  );
  assert(
    !syncSnapshotMatchesRepo('Work/Repo', manifest('https://github.com/work/repo')),
    'relative local paths are not implicit GitHub URLs'
  );
  assert(
    syncSnapshotMatchesRepo(
      'https://github.com/org/repo',
      manifest('https://github.com/org/repo.git')
    ),
    'same normalized repository stays reusable'
  );
  assert(
    syncSnapshotMatchesRepo('https://github.com/org/repo', manifest('git@github.com:org/repo.git')),
    'scp SSH alias preserved'
  );
  assert(
    syncSnapshotMatchesRepo(
      'https://github.com/org/repo',
      manifest('ssh://git@github.com/org/repo.git')
    ),
    'SSH URL alias preserved'
  );
  assert(
    syncSnapshotMatchesRepo('/tmp/local-repo', manifest('/tmp/local-repo')),
    'same local repository preserved'
  );
  assert(syncSnapshotMatchesRepo(null, manifest(null)), 'unconfigured local-only bundle preserved');
  assert(
    !syncSnapshotMatchesRepo('https://github.com/org/new', manifest('https://github.com/org/old')),
    'different repository refused'
  );
  assert(
    !syncSnapshotMatchesRepo('https://github.com/org/new', manifest(null)),
    'local-only work cannot bind implicitly to a new repo'
  );
  assert(
    !syncSnapshotMatchesRepo(null, manifest('https://github.com/org/old')),
    'removing repository cannot retain its old bundle'
  );
  assert(
    !syncSnapshotMatchesRepo('https://github.com/org/new', { version: 1 }),
    'legacy unknown binding refused'
  );
});
