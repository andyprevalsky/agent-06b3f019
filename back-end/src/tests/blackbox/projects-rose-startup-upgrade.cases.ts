/**
 * Rose out of the box (PJ4), default startup script upgrades: a Rose project
 * still holding exactly an earlier checked-in default script
 * (agents/benchmarks/fixtures/projects/rose-startup-previous/) gets the current
 * default and, when unchanged, the Rose startup timeout; an edited script or
 * timeout is never overwritten. Registered by projects.blackbox.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  applyRoseProjectSetup,
  planRoseProjectSetup,
  ROSE_PREVIOUS_STARTUP_SCRIPTS_DIR,
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
}
