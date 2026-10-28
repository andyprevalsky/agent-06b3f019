/**
 * Persistence for a project's template sync ("maintenance") runs.
 *
 *   claimRun ─► ProjectMaintenanceRun(RUNNING) + Project lease        one tx
 *   publishSnapshot ─► Project.templateSnapshot* (iff the lease is still ours)
 *   finishRun ─► run row terminal + lease released (iff still ours)
 *
 * Exclusion: at most one live run per project. The lease lives on the Project
 * row (`maintenanceRunId` + `maintenanceLeaseUntil`), claimed by one
 * conditional UPDATE, so replicas and retries cannot start two sandboxes for
 * one project. A crashed owner's lease expires and reconcileStaleRuns() turns
 * its run into FAILED. Scheduled and GitHub triggers carry a slot key; the
 * unique (projectId, slotKey) makes a duplicate trigger a no-op.
 *
 * 10k-agent behaviour: every operation touches one project's rows, or a
 * bounded (take ≤ 50) indexed batch from the cron tick; nothing is per agent.
 */
import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../database';
import { nightlySlotKey } from './maintenanceSchedule';

export const MAINTENANCE_LOG_LIMIT = 16 * 1024;
export const MAINTENANCE_RUN_HISTORY = 30;
export const MAINTENANCE_BATCH = 50;

export type MaintenanceTrigger = 'manual' | 'snapshot' | 'nightly' | 'github';
export type MaintenanceMode = 'sync' | 'snapshot';
export type MaintenanceStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';

export interface MaintenanceRunRecord {
  id: string;
  projectId: string;
  trigger: string;
  mode: string;
  status: string;
  slotKey: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  exitCode: number | null;
  headSha: string | null;
  sandboxId: string | null;
  snapshotId: string | null;
  fromSnapshotId: string | null;
  error: string | null;
  logTail: string | null;
}

export type ClaimResult =
  { kind: 'claimed'; run: MaintenanceRunRecord } | { kind: 'busy' } | { kind: 'duplicate' };

export interface ClaimInput {
  projectId: string;
  trigger: MaintenanceTrigger;
  mode: MaintenanceMode;
  slotKey?: string;
  fromSnapshotId: string | null;
  leaseMs: number;
  now: Date;
  /** GitHub trigger: the head sha being built; recorded as the watched sha in the same tx. */
  watchedSha?: string;
}

class Busy extends Error {}

/** Claim the project's lease and create the RUNNING row, atomically. */
export async function claimRun(input: ClaimInput): Promise<ClaimResult> {
  try {
    const run = await runTransactionWithRetry(async (tx) => {
      const created = await tx.projectMaintenanceRun.create({
        data: {
          projectId: input.projectId,
          trigger: input.trigger,
          mode: input.mode,
          status: 'RUNNING',
          slotKey: input.slotKey ?? null,
          startedAt: input.now,
          fromSnapshotId: input.fromSnapshotId,
          headSha: input.watchedSha ?? null,
        },
      });
      const leased = await tx.project.updateMany({
        where: {
          id: input.projectId,
          OR: [{ maintenanceRunId: null }, { maintenanceLeaseUntil: { lt: input.now } }],
        },
        data: {
          maintenanceRunId: created.id,
          maintenanceLeaseUntil: new Date(input.now.getTime() + input.leaseMs),
          ...(input.watchedSha !== undefined ? { maintenanceWatchedSha: input.watchedSha } : {}),
        },
      });
      if (leased.count !== 1) throw new Busy();
      return created;
    });
    return { kind: 'claimed', run };
  } catch (error) {
    if (error instanceof Busy) return { kind: 'busy' };
    if (isUniqueViolation(error)) return { kind: 'duplicate' };
    throw error;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** Extend the lease while the run is alive (still ours), so a long run is not reclaimed. */
export async function extendLease(
  projectId: string,
  runId: string,
  leaseMs: number,
  now: Date
): Promise<boolean> {
  const out = await prisma.project.updateMany({
    where: { id: projectId, maintenanceRunId: runId },
    data: { maintenanceLeaseUntil: new Date(now.getTime() + leaseMs) },
  });
  return out.count === 1;
}

export async function recordSandbox(runId: string, sandboxId: string): Promise<void> {
  await prisma.projectMaintenanceRun.updateMany({ where: { id: runId }, data: { sandboxId } });
}

export interface PublishInput {
  projectId: string;
  runId: string;
  snapshotId: string;
  sha: string | null;
  size: { cpu: number; memoryGb: number } | null;
  now: Date;
}

/**
 * Atomically make `snapshotId` the project's template snapshot — only while the
 * run still holds the lease. Returns the snapshot to delete (the old
 * "previous"), or null when publication was refused.
 */
export async function publishSnapshot(
  input: PublishInput
): Promise<{ published: boolean; dropSnapshotId: string | null }> {
  return runTransactionWithRetry(async (tx) => {
    const project = await tx.project.findFirst({
      where: { id: input.projectId, maintenanceRunId: input.runId },
      select: { templateSnapshotId: true, templatePrevSnapshotId: true },
    });
    if (project === null) return { published: false, dropSnapshotId: null };
    const out = await tx.project.updateMany({
      where: { id: input.projectId, maintenanceRunId: input.runId },
      data: {
        templatePrevSnapshotId: project.templateSnapshotId,
        templateSnapshotId: input.snapshotId,
        templateSnapshotAt: input.now,
        templateSnapshotSha: input.sha,
        templateSnapshotRunId: input.runId,
        templateSnapshotSize: input.size ?? Prisma.DbNull,
      },
    });
    return {
      published: out.count === 1,
      dropSnapshotId: out.count === 1 ? project.templatePrevSnapshotId : null,
    };
  });
}

export interface FinishInput {
  runId: string;
  projectId: string;
  status: Exclude<MaintenanceStatus, 'RUNNING'>;
  now: Date;
  startedAt: Date;
  exitCode?: number | null;
  headSha?: string | null;
  snapshotId?: string | null;
  error?: string | null;
  logTail?: string | null;
}

/** Terminal row + lease release (the release only when the lease is still this run's). */
export async function finishRun(input: FinishInput): Promise<void> {
  await runTransactionWithRetry(async (tx) => {
    await tx.projectMaintenanceRun.updateMany({
      where: { id: input.runId, status: 'RUNNING' },
      data: {
        status: input.status,
        finishedAt: input.now,
        durationMs: Math.max(0, input.now.getTime() - input.startedAt.getTime()),
        exitCode: input.exitCode ?? null,
        headSha: input.headSha ?? undefined,
        snapshotId: input.snapshotId ?? null,
        error: input.error ?? null,
        logTail: (input.logTail ?? '').slice(-MAINTENANCE_LOG_LIMIT) || null,
      },
    });
    await tx.project.updateMany({
      where: { id: input.projectId, maintenanceRunId: input.runId },
      data: { maintenanceRunId: null, maintenanceLeaseUntil: null },
    });
  });
  await pruneRuns(input.projectId);
}

/** Keep the newest MAINTENANCE_RUN_HISTORY runs of the project. */
export async function pruneRuns(projectId: string): Promise<void> {
  const old = await prisma.projectMaintenanceRun.findMany({
    where: { projectId },
    orderBy: { startedAt: 'desc' },
    skip: MAINTENANCE_RUN_HISTORY,
    select: { id: true },
  });
  if (old.length > 0) {
    await prisma.projectMaintenanceRun.deleteMany({
      where: { id: { in: old.map((row) => row.id) }, status: { not: 'RUNNING' } },
    });
  }
}

/**
 * Runs whose lease expired (owner crashed or was redeployed) become FAILED and
 * release the project. Bounded batch; safe to call from every replica.
 */
export async function reconcileStaleRuns(now: Date): Promise<number> {
  const stale = await prisma.project.findMany({
    where: { maintenanceRunId: { not: null }, maintenanceLeaseUntil: { lt: now } },
    select: { id: true, maintenanceRunId: true },
    take: MAINTENANCE_BATCH,
  });
  for (const project of stale) {
    const runId = project.maintenanceRunId;
    if (runId === null) continue;
    const run = await prisma.projectMaintenanceRun.findUnique({ where: { id: runId } });
    await finishRun({
      runId,
      projectId: project.id,
      status: 'FAILED',
      now,
      startedAt: run?.startedAt ?? now,
      error: 'abandoned: the backend running this sync stopped before it finished',
      logTail: run?.logTail ?? null,
    });
  }
  return stale.length;
}

export async function listRuns(projectId: string, limit: number): Promise<MaintenanceRunRecord[]> {
  return prisma.projectMaintenanceRun.findMany({
    where: { projectId },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

export async function findRun(
  projectId: string,
  runId: string
): Promise<MaintenanceRunRecord | null> {
  return prisma.projectMaintenanceRun.findFirst({ where: { id: runId, projectId } });
}

/** The most recent finished run's status: a failed run makes the next one start clean. */
export async function lastFinishedStatus(projectId: string): Promise<string | null> {
  const row = await prisma.projectMaintenanceRun.findFirst({
    where: { projectId, status: { not: 'RUNNING' } },
    orderBy: { startedAt: 'desc' },
    select: { status: true },
  });
  return row?.status ?? null;
}

/** Projects with the nightly schedule on that have no run for today's slot yet. */
export async function findNightlyDue(now: Date): Promise<string[]> {
  const slot = nightlySlotKey(now);
  const rows = await prisma.project.findMany({
    where: {
      maintenanceNightly: true,
      repoUrl: { not: null },
      maintenanceScript: { not: '' },
      maintenanceRuns: { none: { slotKey: slot } },
    },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: MAINTENANCE_BATCH,
  });
  return rows.map((row) => row.id);
}

export interface WatchedProject {
  id: string;
  userId: string;
  repoUrl: string;
  defaultBranch: string;
  maintenanceWatchedSha: string | null;
}

/** GitHub-watching projects whose head was not polled within `minIntervalMs`. */
export async function findGithubPollDue(
  now: Date,
  minIntervalMs: number
): Promise<WatchedProject[]> {
  const rows = await prisma.project.findMany({
    where: {
      maintenanceOnGithubChange: true,
      repoUrl: { not: null },
      maintenanceScript: { not: '' },
      OR: [
        { maintenanceWatchCheckedAt: null },
        { maintenanceWatchCheckedAt: { lt: new Date(now.getTime() - minIntervalMs) } },
      ],
    },
    select: {
      id: true,
      userId: true,
      repoUrl: true,
      defaultBranch: true,
      maintenanceWatchedSha: true,
    },
    orderBy: { maintenanceWatchCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: MAINTENANCE_BATCH,
  });
  return rows.flatMap((row) => (row.repoUrl === null ? [] : [{ ...row, repoUrl: row.repoUrl }]));
}

export async function markWatchChecked(projectId: string, now: Date): Promise<void> {
  await prisma.project.updateMany({
    where: { id: projectId },
    data: { maintenanceWatchCheckedAt: now },
  });
}

/** First observation of a watched project: remember the head without building it. */
export async function seedWatchedSha(projectId: string, sha: string): Promise<void> {
  await prisma.project.updateMany({
    where: { id: projectId, maintenanceWatchedSha: null },
    data: { maintenanceWatchedSha: sha },
  });
}

export interface MaintenanceProject {
  id: string;
  userId: string;
  repoUrl: string | null;
  defaultBranch: string;
  maintenanceScript: string | null;
  maintenanceTimeoutS: number;
  templateSnapshotId: string | null;
  templateSnapshotSize: unknown;
  sandboxSize: unknown;
}

export async function findMaintenanceProject(
  projectId: string
): Promise<MaintenanceProject | null> {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      userId: true,
      repoUrl: true,
      defaultBranch: true,
      maintenanceScript: true,
      maintenanceTimeoutS: true,
      templateSnapshotId: true,
      templateSnapshotSize: true,
      sandboxSize: true,
    },
  });
}
