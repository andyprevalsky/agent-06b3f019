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

const userIds: string[] = [];

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
      maintenance: { script: 'echo hi', timeoutS: 480, nightly: true, onGithubChange: true },
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
  const view = state.data as { runs: unknown[]; snapshot: unknown; running: boolean };
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
    await api(stranger, `/api/projects/${id}/maintenance/runs`, { method: 'POST', body: {} }),
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
