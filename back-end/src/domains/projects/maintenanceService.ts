/**
 * Project template sync ("maintenance"): the Rose equivalent of a boxes.dev
 * Template box. One template sandbox per PROJECT runs the project's sync
 * script on triggers; a successful run is snapshotted and new code sessions
 * start from the latest snapshot (providers/projects/maintenanceRunner.ts).
 *
 *   triggers                              claim (lease + slot)         run
 *   Run now / Snapshot now  ─┐
 *   nightly (cron, UTC slot) ├─► startMaintenance ─► claimRun ─► executeMaintenanceRun
 *   GitHub head changed      ┘      │ busy / duplicate / capped: no sandbox is created
 *                                   └─ publish only on success; failures keep the old snapshot
 *
 * 10k-agent behaviour: per-project work only. The cron tick reads bounded
 * batches (≤ 50 projects) and a process-wide cap bounds simultaneous template
 * sandboxes; sessions never run a sync, they read one column.
 */
import { createLogger } from '../../providers/logger';
import { fetchGithubBranchHeadSha, parseGithubUrl } from '../../providers/github';
import { e2bMaintenanceDeps } from '../../providers/projects/maintenanceE2b';
import {
  executeMaintenanceRun,
  maintenanceLeaseMs,
  type MaintenanceDeps,
} from '../../providers/projects/maintenanceRunner';
import {
  GITHUB_POLL_INTERVAL_MS,
  githubSlotKey,
  nextNightlyRun,
  nightlySlotKey,
} from '../../providers/projects/maintenanceSchedule';
import * as store from '../../providers/projects/maintenanceStore';
import { prepareSessionProject } from '../../providers/projects/session';
import type { ProjectWorkspace } from '../../providers/projects/types';
import { maintenanceMaxConcurrentRuns } from './config';
import { ProjectError, requireProject } from './service';

const log = createLogger('ProjectMaintenance');

const RUN_LIST_LIMIT = 10;

export interface MaintenanceServiceDeps {
  runner: () => MaintenanceDeps;
  prepareWorkspace: (userId: string, projectId: string) => Promise<ProjectWorkspace>;
  /** Head sha of the project's default branch on GitHub (null: unknown). */
  headSha: (project: { repoUrl: string; defaultBranch: string }) => Promise<string | null>;
  now: () => Date;
  maxConcurrent: () => number;
}

export const DEFAULT_MAINTENANCE_DEPS: MaintenanceServiceDeps = {
  runner: e2bMaintenanceDeps,
  prepareWorkspace: prepareSessionProject,
  headSha: async ({ repoUrl, defaultBranch }) => {
    const parsed = parseGithubUrl(repoUrl);
    return parsed ? fetchGithubBranchHeadSha(parsed.owner, parsed.repo, defaultBranch) : null;
  },
  now: () => new Date(),
  maxConcurrent: maintenanceMaxConcurrentRuns,
};

const activeRuns = new Set<string>();

export interface MaintenanceRunDto {
  id: string;
  trigger: string;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  headSha: string | null;
  snapshotId: string | null;
  fromSnapshot: boolean;
  error: string | null;
  /** Redacted tail of the run output; omitted from list responses. */
  log?: string;
}

export function toRunDto(run: store.MaintenanceRunRecord, withLog: boolean): MaintenanceRunDto {
  return {
    id: run.id,
    trigger: run.trigger,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    headSha: run.headSha,
    snapshotId: run.snapshotId,
    fromSnapshot: run.fromSnapshotId !== null,
    error: run.error,
    ...(withLog ? { log: run.logTail ?? '' } : {}),
  };
}

export interface MaintenanceStateDto {
  snapshot: { takenAt: string; sha: string | null } | null;
  running: boolean;
  nextRunAt: string | null;
  watchCheckedAt: string | null;
  runs: MaintenanceRunDto[];
}

export async function getMaintenance(
  userId: string,
  projectId: string,
  now: Date = new Date()
): Promise<MaintenanceStateDto> {
  const project = await requireProject(userId, projectId);
  const runs = await store.listRuns(project.id, RUN_LIST_LIMIT);
  return {
    snapshot:
      project.templateSnapshotId !== null && project.templateSnapshotAt !== null
        ? { takenAt: project.templateSnapshotAt.toISOString(), sha: project.templateSnapshotSha }
        : null,
    running: isLeased(project, now),
    nextRunAt: project.maintenanceNightly ? nextNightlyRun(now).toISOString() : null,
    watchCheckedAt: project.maintenanceOnGithubChange
      ? (project.maintenanceWatchCheckedAt?.toISOString() ?? null)
      : null,
    runs: runs.map((run) => toRunDto(run, false)),
  };
}

export function isLeased(
  project: { maintenanceRunId: string | null; maintenanceLeaseUntil: Date | null },
  now: Date
): boolean {
  return (
    project.maintenanceRunId !== null &&
    project.maintenanceLeaseUntil !== null &&
    project.maintenanceLeaseUntil.getTime() > now.getTime()
  );
}

export async function getRun(
  userId: string,
  projectId: string,
  runId: string
): Promise<MaintenanceRunDto> {
  const project = await requireProject(userId, projectId);
  const run = await store.findRun(project.id, runId);
  if (!run) throw new ProjectError(404, 'Run not found');
  return toRunDto(run, true);
}

export type StartResult =
  | { kind: 'started'; run: store.MaintenanceRunRecord; done: Promise<void> }
  | { kind: 'busy' | 'duplicate' | 'capped' | 'ineligible'; reason?: string };

interface StartOptions {
  trigger: store.MaintenanceTrigger;
  mode: store.MaintenanceMode;
  slotKey?: string;
  watchedSha?: string;
}

/**
 * Claim the project's lease and run the sync in the background. Returns
 * without waiting (`done` settles when the run is terminal; tests await it).
 * No sandbox is created unless the claim succeeded.
 */
export async function startMaintenance(
  projectId: string,
  options: StartOptions,
  deps: MaintenanceServiceDeps = DEFAULT_MAINTENANCE_DEPS
): Promise<StartResult> {
  const project = await store.findMaintenanceProject(projectId);
  if (project === null) return { kind: 'ineligible', reason: 'Project not found' };
  if (project.repoUrl === null)
    return { kind: 'ineligible', reason: 'The project has no repository' };
  if (options.mode === 'sync' && !(project.maintenanceScript ?? '').trim()) {
    return { kind: 'ineligible', reason: 'The project has no sync script' };
  }
  if (activeRuns.size >= deps.maxConcurrent()) return { kind: 'capped' };

  // A failed last run makes this one start clean (base template + fresh clone),
  // so a bad snapshot can never keep a project failing.
  const lastStatus = await store.lastFinishedStatus(project.id);
  const fromSnapshotId =
    project.templateSnapshotId !== null && (lastStatus === null || lastStatus === 'SUCCEEDED')
      ? project.templateSnapshotId
      : null;
  const now = deps.now();
  const claim = await store.claimRun({
    projectId: project.id,
    trigger: options.trigger,
    mode: options.mode,
    ...(options.slotKey !== undefined ? { slotKey: options.slotKey } : {}),
    ...(options.watchedSha !== undefined ? { watchedSha: options.watchedSha } : {}),
    fromSnapshotId,
    leaseMs: maintenanceLeaseMs(project),
    now,
  });
  if (claim.kind !== 'claimed') return { kind: claim.kind };

  activeRuns.add(claim.run.id);
  const done = runClaimed(project, claim.run, options.mode, deps).finally(() => {
    activeRuns.delete(claim.run.id);
  });
  return { kind: 'started', run: claim.run, done };
}

async function runClaimed(
  project: store.MaintenanceProject,
  run: store.MaintenanceRunRecord,
  mode: store.MaintenanceMode,
  deps: MaintenanceServiceDeps
): Promise<void> {
  try {
    const workspace = await deps.prepareWorkspace(project.userId, project.id);
    await executeMaintenanceRun({ project, workspace, run, mode }, deps.runner());
  } catch (error) {
    // Preparation (decrypt, clone grant) or sandbox bindings failed before the
    // runner could settle the row: settle it here so the lease is released.
    log.error('Project template sync could not start', {
      projectId: project.id,
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await store
      .finishRun({
        runId: run.id,
        projectId: project.id,
        status: 'FAILED',
        now: deps.now(),
        startedAt: run.startedAt,
        error: error instanceof Error ? error.message.slice(0, 500) : 'could not start',
      })
      .catch(() => undefined);
  }
}

/** POST /api/projects/:id/maintenance/runs — Run now / Snapshot now. */
export async function triggerRun(
  userId: string,
  projectId: string,
  mode: store.MaintenanceMode,
  deps: MaintenanceServiceDeps = DEFAULT_MAINTENANCE_DEPS
): Promise<{ run: MaintenanceRunDto; done: Promise<void> }> {
  const project = await requireProject(userId, projectId);
  const result = await startMaintenance(
    project.id,
    { trigger: mode === 'snapshot' ? 'snapshot' : 'manual', mode },
    deps
  );
  switch (result.kind) {
    case 'started':
      return { run: toRunDto(result.run, false), done: result.done };
    case 'busy':
    case 'duplicate':
      throw new ProjectError(
        409,
        'A sync is already running for this project',
        'maintenance_running'
      );
    case 'capped':
      throw new ProjectError(
        429,
        'Too many syncs are running; try again shortly',
        'maintenance_capped'
      );
    default:
      throw new ProjectError(400, result.reason ?? 'The project cannot be synced');
  }
}

export interface TickSummary {
  reconciled: number;
  nightly: number;
  github: number;
  watching: number;
}

/**
 * One cron tick (every few minutes, any replica): settle abandoned runs, start
 * today's nightly runs, and start a run for every watched project whose
 * default-branch head moved. Replicas racing here are harmless: the lease and
 * the slot key admit exactly one run.
 */
export async function runMaintenanceTick(
  deps: MaintenanceServiceDeps = DEFAULT_MAINTENANCE_DEPS
): Promise<TickSummary & { done: Promise<void>[] }> {
  const now = deps.now();
  const summary: TickSummary = {
    reconciled: await store.reconcileStaleRuns(now),
    nightly: 0,
    github: 0,
    watching: 0,
  };
  const done: Promise<void>[] = [];
  for (const projectId of await store.findNightlyDue(now)) {
    const started = await startMaintenance(
      projectId,
      { trigger: 'nightly', mode: 'sync', slotKey: nightlySlotKey(now) },
      deps
    );
    if (started.kind === 'started') {
      summary.nightly += 1;
      done.push(started.done);
    } else if (started.kind === 'capped') {
      break;
    }
  }
  for (const watched of await store.findGithubPollDue(now, GITHUB_POLL_INTERVAL_MS)) {
    summary.watching += 1;
    const sha = await deps.headSha(watched);
    await store.markWatchChecked(watched.id, now);
    if (sha === null) continue;
    if (watched.maintenanceWatchedSha === null) {
      await store.seedWatchedSha(watched.id, sha);
      continue;
    }
    if (sha === watched.maintenanceWatchedSha) continue;
    const started = await startMaintenance(
      watched.id,
      { trigger: 'github', mode: 'sync', slotKey: githubSlotKey(sha), watchedSha: sha },
      deps
    );
    if (started.kind === 'started') {
      summary.github += 1;
      done.push(started.done);
    } else if (started.kind === 'capped') {
      break;
    }
  }
  if (summary.nightly + summary.github + summary.reconciled > 0) {
    log.info('Project template sync tick', { ...summary });
  }
  return { ...summary, done };
}
