/**
 * Rose out of the box (PJ4), default startup script upgrades: a Rose project
 * still holding exactly an earlier checked-in default script
 * (agents/benchmarks/fixtures/projects/rose-startup-previous/) gets the current
 * default and, when unchanged, the Rose startup timeout; an edited script or
 * timeout is never overwritten. Registered by projects.blackbox.ts.
 */
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  applyRoseProjectSetup,
  planRoseProjectSetup,
  ROSE_PREVIOUS_STARTUP_SCRIPTS_DIR,
  roseSyncScript,
  readPreviousStartupScripts,
  ROSE_PROJECT_STARTUP_TIMEOUT_S,
  type RoseSetupDeps,
} from '../../domains/projects/roseProject';
import { updateProject } from '../../domains/projects/service';
import { prisma } from '../../providers/database';
import { assert } from './projects-harness';

interface RoseOwner {
  userId: string;
  deps: RoseSetupDeps;
  rose: () => Promise<{
    id: string;
    startupScript: string | null;
    startupTimeoutS: number;
    updatedAt: string | Date;
  }>;
  cleanup: () => Promise<void>;
}

export function registerRoseStartupUpgradeCases(ctx: {
  roseOwner: () => Promise<RoseOwner>;
  roseRepo: string;
  roseStartup: string;
}): void {
  const { roseOwner, roseRepo, roseStartup } = ctx;
  test('optional previous defaults tolerate only a missing directory', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'rose-previous-defaults-'));
    try {
      assert(
        readPreviousStartupScripts(resolve(dir, 'missing')).length === 0,
        'missing history is empty'
      );
      writeFileSync(resolve(dir, 'z.sh'), 'last');
      writeFileSync(resolve(dir, 'a.sh'), 'first');
      writeFileSync(resolve(dir, 'ignored.txt'), 'ignored');
      assert(
        JSON.stringify(readPreviousStartupScripts(dir)) === JSON.stringify(['first', 'last']),
        'shell scripts retain sorted full contents'
      );
      let error: unknown;
      try {
        readPreviousStartupScripts(resolve(dir, 'a.sh'));
      } catch (caught) {
        error = caught;
      }
      assert(
        (error as NodeJS.ErrnoException)?.code === 'ENOTDIR',
        'non-ENOENT directory errors propagate'
      );
      mkdirSync(resolve(dir, 'bad.sh'));
      error = undefined;
      try {
        readPreviousStartupScripts(dir);
      } catch (caught) {
        error = caught;
      }
      assert((error as NodeJS.ErrnoException)?.code === 'EISDIR', 'script read errors propagate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** The Rose default as first shipped (2026-10-20): what Andy's prod project still stores. */
  const ROSE_STARTUP_2026_10_20 = readFileSync(
    resolve(__dirname, '../../../..', ROSE_PREVIOUS_STARTUP_SCRIPTS_DIR, '2026-10-20.sh'),
    'utf8'
  );

  test('Rose out of the box: an unedited earlier default script is upgraded, an edited one is kept', async () => {
    assert(
      ROSE_STARTUP_2026_10_20 !== roseStartup,
      'the previous default differs from the current'
    );
    assert(
      ROSE_STARTUP_2026_10_20.includes('sudo service postgresql start') &&
        !ROSE_STARTUP_2026_10_20.includes('npm install'),
      'fixture is the 2026-10-20 default'
    );
    const owner = await roseOwner();
    try {
      // Configured by the 2026-10-20 setup: the old default script and timeout.
      const created = await prisma.project.create({
        data: {
          userId: owner.userId,
          name: 'Rose',
          syncSalt: 'blackbox-salt',
          repoUrl: roseRepo,
          startupScript: ROSE_STARTUP_2026_10_20,
          syncRevision: 3,
        },
      });
      const rose = await owner.rose();
      assert(rose.id === created.id, 'same project');
      assert(rose.startupScript === roseStartup, 'old default replaced by the current default');
      assert(
        rose.startupTimeoutS === ROSE_PROJECT_STARTUP_TIMEOUT_S,
        `still-default timeout upgraded, got ${rose.startupTimeoutS}`
      );
      // Idempotent: the upgraded project is steady state.
      const again = await owner.rose();
      assert(again.updatedAt === rose.updatedAt, 'no rewrite on re-list');
      const rows = await prisma.project.findMany({
        where: { userId: owner.userId },
        include: { _count: { select: { envFiles: true } } },
      });
      assert(
        planRoseProjectSetup(owner.userId, rows, new Set([roseRepo]), owner.deps.isOwner) === null,
        'nothing left to plan'
      );
    } finally {
      await owner.cleanup();
    }

    // An edited script (even one line off the old default) and an edited
    // timeout are the user's: never overwritten.
    const edited = `${ROSE_STARTUP_2026_10_20}echo my own step\n`;
    const owner2 = await roseOwner();
    try {
      await prisma.project.create({
        data: {
          userId: owner2.userId,
          name: 'Rose',
          syncSalt: 'blackbox-salt',
          repoUrl: roseRepo,
          startupScript: edited,
          startupTimeoutS: 120,
        },
      });
      const rose = await owner2.rose();
      assert(rose.startupScript === edited, 'edited script kept');
      assert(
        rose.startupTimeoutS === 120,
        `timeout untouched with an edited script: ${rose.startupTimeoutS}`
      );
    } finally {
      await owner2.cleanup();
    }
    const owner3 = await roseOwner();
    try {
      await prisma.project.create({
        data: {
          userId: owner3.userId,
          name: 'Rose',
          syncSalt: 'blackbox-salt',
          repoUrl: roseRepo,
          startupScript: ROSE_STARTUP_2026_10_20,
          startupTimeoutS: 300,
        },
      });
      const rose = await owner3.rose();
      assert(rose.startupScript === roseStartup, 'unedited old script upgraded');
      assert(rose.startupTimeoutS === 300, `user-set timeout kept, got ${rose.startupTimeoutS}`);
    } finally {
      await owner3.cleanup();
    }
  });

  test('Rose out of the box: the unedited 2026-11-08 startup default upgrades while user edits survive', async () => {
    // A captured input permits a RED run without its production registry entry.
    const previous = readFileSync(
      process.env.ROSE_STARTUP_PREVIOUS_2026_11_08_FIXTURE ??
        resolve(__dirname, '../../../..', ROSE_PREVIOUS_STARTUP_SCRIPTS_DIR, '2026-11-08.sh'),
      'utf8'
    );
    assert(
      createHash('sha256').update(previous).digest('hex') ===
        '20c78c65019a2d2e8567014d6c6add0824db2965602d54c5994f68a9b8254ee3',
      'fixture is the byte-exact 2026-11-08 default before reference metadata repair'
    );
    assert(previous !== roseStartup, 'the old default differs from the current startup');
    const owner = await roseOwner();
    try {
      const created = await prisma.project.create({
        data: {
          userId: owner.userId,
          name: 'Rose',
          syncSalt: 'blackbox-salt',
          repoUrl: roseRepo,
          startupScript: previous,
          syncRevision: 3,
        },
      });
      const upgraded = await owner.rose();
      assert(upgraded.id === created.id, 'upgrade keeps the existing project');
      assert(upgraded.startupScript === roseStartup, 'old November 8 startup default is replaced');
      assert(
        upgraded.startupTimeoutS === ROSE_PROJECT_STARTUP_TIMEOUT_S,
        'default timeout upgrades'
      );
      const persisted = await prisma.project.findUniqueOrThrow({ where: { id: created.id } });
      assert(persisted.startupScript === roseStartup, 'upgrade is persisted');
      assert((await owner.rose()).updatedAt === upgraded.updatedAt, 'second list does not rewrite');
      const edited = `${previous}echo my own step\n`;
      await updateProject(owner.userId, created.id, {
        startupScript: edited,
        startupTimeoutS: 300,
      });
      const custom = await owner.rose();
      assert(
        custom.startupScript === edited && custom.startupTimeoutS === 300,
        'user edits survive listing'
      );
      await updateProject(owner.userId, created.id, { startupScript: previous });
      const customTimeout = await owner.rose();
      assert(
        customTimeout.startupScript === roseStartup,
        'unedited old script upgrades with a custom timeout'
      );
      assert(customTimeout.startupTimeoutS === 300, 'custom timeout survives upgrade');
    } finally {
      await owner.cleanup();
    }
  });

  test('Rose out of the box: a stale upgrade plan never overwrites a script edited after the list read', async () => {
    const owner = await roseOwner();
    try {
      const created = await prisma.project.create({
        data: {
          userId: owner.userId,
          name: 'Rose',
          syncSalt: 'blackbox-salt',
          repoUrl: roseRepo,
          startupScript: ROSE_STARTUP_2026_10_20,
        },
      });
      const rows = await prisma.project.findMany({
        where: { userId: owner.userId },
        include: { _count: { select: { envFiles: true } } },
      });
      const plan = planRoseProjectSetup(
        owner.userId,
        rows,
        new Set([roseRepo]),
        owner.deps.isOwner
      );
      assert(plan?.upgradeScriptProjectId === created.id, 'planned the upgrade');
      await updateProject(owner.userId, created.id, { startupScript: 'echo edited meanwhile\n' });
      await applyRoseProjectSetup(owner.userId, plan, owner.deps);
      const row = await prisma.project.findUniqueOrThrow({ where: { id: created.id } });
      assert(
        row.startupScript === 'echo edited meanwhile\n',
        `edit wins, got ${row.startupScript}`
      );
      assert(row.startupTimeoutS === 120, `timeout untouched, got ${row.startupTimeoutS}`);
    } finally {
      await owner.cleanup();
    }
  });

  /** The first slimmed default (2026-10-28): what a project that picked up the previous branch holds. */
  const ROSE_STARTUP_2026_10_28 = readFileSync(
    resolve(__dirname, '../../../..', ROSE_PREVIOUS_STARTUP_SCRIPTS_DIR, '2026-10-28.sh'),
    'utf8'
  );

  test('Rose out of the box: the sync script is filled once (new, pristine and configured Rose projects); a cleared one stays cleared', async () => {
    const syncScript = roseSyncScript();
    assert(
      syncScript.includes('npm install --include=dev') && syncScript.includes('3.11.9'),
      'the default sync script installs JS deps and Python 3.11.9 deps'
    );
    // 1. A Rose project configured before template sync existed: column never set.
    const owner = await roseOwner();
    try {
      const created = await prisma.project.create({
        data: {
          userId: owner.userId,
          name: 'Rose',
          syncSalt: 'blackbox-salt',
          repoUrl: roseRepo,
          startupScript: ROSE_STARTUP_2026_10_28,
        },
      });
      const rose = await owner.rose();
      assert(rose.id === created.id, 'same project');
      const row = await prisma.project.findUniqueOrThrow({ where: { id: created.id } });
      assert(row.maintenanceScript === syncScript, 'default sync script filled');
      assert(row.maintenanceTimeoutS === 480, `sync timeout ${row.maintenanceTimeoutS}`);
      assert(!row.maintenanceNightly && !row.maintenanceOnGithubChange, 'triggers stay off');
      assert(row.startupScript === roseStartup, 'the 2026-10-28 startup default is upgraded too');
      // 2. The user clears it: stored as "", never refilled.
      await updateProject(owner.userId, created.id, { maintenance: { script: null } });
      await owner.rose();
      const cleared = await prisma.project.findUniqueOrThrow({ where: { id: created.id } });
      assert(cleared.maintenanceScript === '', 'a cleared sync script stays cleared');
      // 3. An edited one is kept.
      await updateProject(owner.userId, created.id, { maintenance: { script: 'echo mine\n' } });
      await owner.rose();
      const edited = await prisma.project.findUniqueOrThrow({ where: { id: created.id } });
      assert(edited.maintenanceScript === 'echo mine\n', 'an edited sync script is kept');
    } finally {
      await owner.cleanup();
    }
    // 4. A brand-new Rose project is created with the script.
    const fresh = await roseOwner();
    try {
      const rose = await fresh.rose();
      const row = await prisma.project.findUniqueOrThrow({ where: { id: rose.id } });
      assert(row.maintenanceScript === syncScript, 'new Rose project has the sync script');
    } finally {
      await fresh.cleanup();
    }
  });
}
