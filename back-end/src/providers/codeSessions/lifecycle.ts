/**
 * Persistent code-session lifecycle used by session create/close.
 *
 *   create ─► resolveCodeSession ─┬─ E2B paused sandbox ──connect──► resume (fs+memory)
 *                                 ├─ sandbox not found / none ──► new sandbox
 *                                 │     └─ restoreLatestCheckpoint ──► `claude --resume`
 *                                 ├─ other connect error ──► throw (spawn retries; never orphan)
 *                                 └─ local fallback: reuse HOME, else restore checkpoint
 *   close  ─► checkpointCodeSession ─► index code_event rows ─► pause (never kill)
 *   retire ─► explicit close or TTL: kill sandbox, delete checkpoints
 */
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, sep } from 'path';
import { NotFoundError, Sandbox } from 'e2b';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { checkpointKey, deleteCheckpointObject, getCheckpointObject } from './artifactStore';
import {
  applyCheckpoint,
  CheckpointIntegrityError,
  CLI_LOG_ARTIFACT,
  createCheckpoint,
  loadVerifiedCheckpoint,
  MANIFEST_NAME,
  type CheckpointManifest,
  type CheckpointRepo,
  type VerifiedCheckpoint,
} from './checkpoint';
import { indexCodeEvents } from './codeEvents';
import { type CodeSessionFs, e2bSandboxFs, localSandboxFs } from './sandboxFs';
import {
  allocateCheckpointSeq,
  commitCheckpoint,
  findExpiredCodeSessions,
  markRetired,
  type CodeSessionRow,
} from './store';

const log = createLogger('CodeSessionLifecycle');

/** How far back a resume walks when newer checkpoints fail verification. */
const RESTORE_LOOKBACK = 5;

export type ResumedFrom = 'paused_sandbox' | 'local_home' | 'checkpoint' | 'new';

export interface RepoFacts {
  path: string;
  branch: string | null;
  head: string | null;
  localCommits: number;
  pushed: boolean;
  remoteUrl: string | null;
  dirtyFiles: number;
  /** origin/HEAD's branch when the checkpoint saw it. */
  defaultBranch?: string | null;
  /** Lines added/removed per file vs the merge target's merge base. */
  files?: Array<{ path: string; added: number; removed: number }>;
}

export interface CheckpointResult {
  seq: number;
  cliSessionId: string | null;
  repo: RepoFacts | null;
  indexedCodeEvents: number;
}

export function localCodeSessionRoot(): string {
  return resolve(
    process.env.CLAUDE_CODE_LOCAL_SESSIONS_DIR || '/tmp/claude-code-local/code-sessions'
  );
}

export function localCodeSessionHome(codeSessionId: string): string {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(codeSessionId)) {
    throw new Error(`Invalid code session id ${JSON.stringify(codeSessionId)}`);
  }
  return join(localCodeSessionRoot(), codeSessionId, 'home');
}

function isOwnedLocalHome(path: string): boolean {
  const root = localCodeSessionRoot();
  return resolve(path).startsWith(root + sep);
}

/** The repo the tool result reports: the cloned workspace, else the first repo. */
export function primaryRepoFacts(manifest: Pick<CheckpointManifest, 'repos'>): RepoFacts | null {
  const repos: CheckpointRepo[] = manifest.repos ?? [];
  const repo = repos.find((candidate) => candidate.path === 'workspace') ?? repos[0];
  if (repo === undefined) return null;
  return {
    path: repo.path,
    branch: repo.branch,
    head: repo.head,
    localCommits: repo.localCommits,
    pushed: repo.pushed,
    remoteUrl: repo.remoteUrl,
    dirtyFiles: repo.dirtyFiles.length,
    defaultBranch: repo.defaultBranch ?? null,
    files: repo.files ?? [],
  };
}

/**
 * Write a checkpoint and index its CLI log. Best-effort by design: a failure is
 * logged and returns null so close can still pause the sandbox (pause itself
 * preserves the filesystem).
 */
export async function checkpointCodeSession(params: {
  session: CodeSessionRow;
  fs: CodeSessionFs;
  reason: string;
  agentId: string;
}): Promise<CheckpointResult | null> {
  const { session, fs, reason, agentId } = params;
  try {
    const seq = await allocateCheckpointSeq(session.id);
    const manifest = await createCheckpoint({
      fs,
      userId: session.userId,
      codeSessionId: session.id,
      seq,
      reason,
      codeProvider: session.codeProvider,
      diffBase: session.mergeTarget,
    });
    const repo = primaryRepoFacts(manifest);
    await commitCheckpoint(session.id, seq, {
      cliSessionId: manifest.cliSessionId,
      repoFacts: repo,
    });
    // Restore never looks further back than RESTORE_LOOKBACK, so periodic saves
    // keep a bounded window: drop the one checkpoint that just fell out of it.
    if (seq > RESTORE_LOOKBACK) {
      await deleteCheckpoint(session.userId, session.id, seq - RESTORE_LOOKBACK).catch(
        (error: unknown) => {
          log.warn('Pruning an old code session checkpoint failed', {
            codeSessionId: session.id,
            seq: String(seq - RESTORE_LOOKBACK),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      );
    }
    let indexedCodeEvents = 0;
    if (manifest.artifacts[CLI_LOG_ARTIFACT] !== undefined) {
      const key = checkpointKey(session.userId, session.id, seq, CLI_LOG_ARTIFACT);
      const cliLog = await getCheckpointObject(key);
      if (cliLog !== null) {
        try {
          indexedCodeEvents = await indexCodeEvents({
            userId: session.userId,
            rootAgentId: session.rootAgentId,
            agentId,
            codeSessionId: session.id,
            codeProvider: session.codeProvider,
            cliLog,
            archivePath: key,
            fallbackTime: new Date(manifest.createdAt),
          });
        } catch (indexError) {
          log.warn('Indexing code events failed; checkpoint kept', {
            codeSessionId: session.id,
            seq: String(seq),
            error: indexError instanceof Error ? indexError.message : String(indexError),
          });
        }
      }
    }
    return { seq, cliSessionId: manifest.cliSessionId, repo, indexedCodeEvents };
  } catch (error) {
    log.error('Code session checkpoint failed', {
      codeSessionId: session.id,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** github.com remotes fetch with the platform token, as the ws-server clone does. */
export function githubAuthRemoteUrl(remoteUrl: string): string {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token === '' || !remoteUrl.startsWith('https://github.com/')) {
    return remoteUrl;
  }
  return remoteUrl.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
}

/**
 * The newest checkpoint that verifies, downloaded and hash-checked. A corrupted
 * checkpoint is rejected (never returned) and the next older one is tried.
 * Read-only: touches neither the session row nor any sandbox.
 */
export async function loadNewestVerifiedCheckpoint(
  session: CodeSessionRow
): Promise<VerifiedCheckpoint | null> {
  const newest = session.latestCheckpointSeq;
  for (let seq = newest; seq >= 1 && seq > newest - RESTORE_LOOKBACK; seq -= 1) {
    try {
      return await loadVerifiedCheckpoint(session.userId, session.id, seq);
    } catch (error) {
      if (error instanceof CheckpointIntegrityError) {
        log.warn('Rejected code session checkpoint', {
          codeSessionId: session.id,
          seq: String(seq),
          error: error.message,
        });
        continue;
      }
      throw error;
    }
  }
  return null;
}

/** Restore the newest checkpoint that verifies (see loadNewestVerifiedCheckpoint). */
export async function restoreLatestCheckpoint(
  session: CodeSessionRow,
  fs: CodeSessionFs
): Promise<{ seq: number; cliSessionId: string | null } | null> {
  const verified = await loadNewestVerifiedCheckpoint(session);
  if (verified === null) return null;
  const { cliSessionId } = await applyCheckpoint(fs, verified, {
    authRemoteUrl: githubAuthRemoteUrl,
  });
  // A checkpoint written by the other provider's CLI (a usage-limit handoff,
  // C15) restores the files and history but not that CLI's conversation.
  const sameProvider = verified.manifest.codeProvider === session.codeProvider;
  return { seq: verified.manifest.seq, cliSessionId: sameProvider ? cliSessionId : null };
}

/**
 * Connect (and thereby resume) a paused E2B sandbox; null only when E2B says it
 * no longer exists. Any other failure (429, 5xx, request timeout) rethrows so the
 * spawn retries the same sandbox: replacing it from a possibly older checkpoint
 * would orphan the paused sandbox and every change made since that checkpoint.
 */
export async function connectPausedSandbox(
  sandboxId: string,
  timeoutMs: number,
  connect: (id: string, opts: { apiKey?: string; timeoutMs: number }) => Promise<Sandbox> = (
    id,
    opts
  ) => Sandbox.connect(id, opts)
): Promise<Sandbox | null> {
  try {
    return await connect(sandboxId, { apiKey: process.env.E2B_API_KEY, timeoutMs });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    log.warn('Paused sandbox no longer exists; falling back to checkpoint', {
      sandboxId,
      error: error.message,
    });
    return null;
  }
}

/** Prepare the local-fallback HOME: reuse it when present, else restore. */
export async function prepareLocalCodeSessionHome(session: CodeSessionRow): Promise<{
  home: string;
  resumedFrom: ResumedFrom;
  cliSessionId: string | null;
}> {
  const home =
    session.homeDir !== null && isOwnedLocalHome(session.homeDir)
      ? session.homeDir
      : localCodeSessionHome(session.id);
  if (session.sandboxKind === 'local' && existsSync(home)) {
    return { home, resumedFrom: 'local_home', cliSessionId: session.cliSessionId };
  }
  mkdirSync(home, { recursive: true });
  if (session.latestCheckpointSeq > 0) {
    const restored = await restoreLatestCheckpoint(session, localSandboxFs(home));
    if (restored !== null) {
      return { home, resumedFrom: 'checkpoint', cliSessionId: restored.cliSessionId };
    }
  }
  return { home, resumedFrom: 'new', cliSessionId: null };
}

async function deleteCheckpoint(userId: string, codeSessionId: string, seq: number): Promise<void> {
  const manifestKey = checkpointKey(userId, codeSessionId, seq, MANIFEST_NAME);
  const raw = await getCheckpointObject(manifestKey).catch(() => null);
  if (raw !== null) {
    try {
      const manifest = JSON.parse(raw.toString('utf8')) as CheckpointManifest;
      for (const name of Object.keys(manifest.artifacts ?? {})) {
        await deleteCheckpointObject(checkpointKey(userId, codeSessionId, seq, name));
      }
    } catch {
      // an unreadable manifest still gets deleted below
    }
  }
  await deleteCheckpointObject(manifestKey).catch(() => undefined);
}

async function deleteCheckpoints(session: CodeSessionRow): Promise<void> {
  for (let seq = 1; seq <= session.nextCheckpointSeq; seq += 1) {
    await deleteCheckpoint(session.userId, session.id, seq);
  }
}

/** Kill the sandbox, delete stored checkpoints and mark the session retired. */
export async function retireCodeSession(session: CodeSessionRow): Promise<void> {
  if (session.sandboxKind === 'e2b' && session.sandboxId !== null) {
    try {
      await Sandbox.kill(session.sandboxId, { apiKey: process.env.E2B_API_KEY });
    } catch (error) {
      log.warn('Killing retired code-session sandbox failed', {
        codeSessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (session.homeDir !== null && isOwnedLocalHome(session.homeDir)) {
    rmSync(resolve(session.homeDir, '..'), { recursive: true, force: true });
  }
  await deleteCheckpoints(session);
  await markRetired(session.id);
  log.info('Code session retired', { codeSessionId: session.id });
}

/**
 * Opportunistic, bounded TTL sweep for one user. Never rejects; spawns start it
 * without awaiting so it never blocks them.
 */
export function sweepExpiredCodeSessions(userId: string): Promise<void> {
  return findExpiredCodeSessions(userId)
    .then(async (expired) => {
      for (const session of expired) await retireCodeSession(session);
    })
    .catch((error: unknown) => {
      log.warn('Code session TTL sweep failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Periodic save of an attached session (multi-day runs), driven by the
 * attached activity's keepalive:
 *
 *   keepalive ─► due? (interval since this backend's last save, jittered on first sight)
 *                 └─► checkpoint ─► running ≥ cap − margin? ─► pause ─► resume (same sandbox)
 *
 * A sandbox that stays attached would otherwise only be checkpointed on close,
 * so any sandbox loss rolled back to the previous close. E2B also caps one
 * continuous run (24h Pro, 1h Hobby); pause + resume resets that clock and keeps
 * memory and processes, so the cycle happens before the cap with a fresh save.
 *
 * 10k sessions: one map entry per attached session on the backend instance
 * that serves its keepalives; at most MAINTENANCE_CONCURRENCY saves run at once
 * per instance (a saturated tick is retried on the next keepalive), and first
 * sight is jittered over one interval so a deploy restart does not save every
 * session at once. Keepalives served by N instances save up to N× as often.
 */
export interface CodeSessionMaintenanceDeps {
  now: () => number;
  random: () => number;
  schedule: (job: () => Promise<unknown>) => void;
  sandboxInfo: (sandboxId: string) => Promise<{ startedAt: Date }>;
  connect: (sandboxId: string) => Promise<Sandbox>;
}

const MAINTENANCE_CONCURRENCY = 4;
const RUNTIME_CYCLE_MARGIN_MS = 60 * 60 * 1000;
const lastSavedAt = new Map<string, number>();
const maintaining = new Set<string>();

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function codeSessionCheckpointIntervalMs(): number {
  return positiveEnv('CODE_SESSION_CHECKPOINT_INTERVAL_MINUTES', 30) * 60 * 1000;
}

/** E2B's maximum continuous runtime for this account (24h on Pro). */
export function e2bMaxContinuousRuntimeMs(): number {
  return positiveEnv('E2B_SANDBOX_MAX_RUNTIME_HOURS', 24) * 60 * 60 * 1000;
}

export const defaultCodeSessionMaintenanceDeps: CodeSessionMaintenanceDeps = {
  now: () => Date.now(),
  random: () => Math.random(),
  schedule: (job) => {
    void job();
  },
  sandboxInfo: (sandboxId) => Sandbox.getInfo(sandboxId, { apiKey: process.env.E2B_API_KEY }),
  connect: (sandboxId) =>
    Sandbox.connect(sandboxId, {
      apiKey: process.env.E2B_API_KEY,
      timeoutMs: 30 * 60 * 1000,
    }),
};

/** Schedule a save (and, near E2B's cap, a pause/resume cycle) when one is due. */
export function scheduleCodeSessionMaintenance(
  task: { id: string; agentId: string; sandboxId: string; codeSessionId: string | null },
  deps: CodeSessionMaintenanceDeps = defaultCodeSessionMaintenanceDeps
): void {
  const codeSessionId = task.codeSessionId;
  if (codeSessionId === null) return;
  const now = deps.now();
  const interval = codeSessionCheckpointIntervalMs();
  const last = lastSavedAt.get(codeSessionId);
  if (last === undefined) {
    lastSavedAt.set(codeSessionId, now - deps.random() * interval);
    return;
  }
  if (now - last < interval || maintaining.has(codeSessionId)) return;
  if (maintaining.size >= MAINTENANCE_CONCURRENCY) return;
  maintaining.add(codeSessionId);
  deps.schedule(() =>
    maintainCodeSession(task, codeSessionId, deps)
      .catch((error: unknown) => {
        log.warn('Periodic code session save failed', {
          codeSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        lastSavedAt.set(codeSessionId, deps.now());
        maintaining.delete(codeSessionId);
      })
  );
}

/** No close has started on the task (close writes closeReason before it checkpoints and pauses). */
async function taskStillAttached(taskId: string): Promise<boolean> {
  const task = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: { status: true, closeReason: true },
  });
  return task?.status === 'ACTIVE' && task.closeReason === null;
}

/** The task closed: drop its maintenance clock (bounded map). */
export function forgetCodeSessionMaintenance(codeSessionId: string | null): void {
  if (codeSessionId !== null) lastSavedAt.delete(codeSessionId);
}

async function maintainCodeSession(
  task: { id: string; agentId: string; sandboxId: string },
  codeSessionId: string,
  deps: CodeSessionMaintenanceDeps
): Promise<void> {
  const session = await prisma.codeSession.findUnique({ where: { id: codeSessionId } });
  if (
    session === null ||
    session.state !== 'ACTIVE' ||
    session.sandboxId !== task.sandboxId ||
    !(await taskStillAttached(task.id))
  ) {
    lastSavedAt.delete(codeSessionId);
    return;
  }
  const info = await deps.sandboxInfo(task.sandboxId);
  const cycle =
    deps.now() - info.startedAt.getTime() >= e2bMaxContinuousRuntimeMs() - RUNTIME_CYCLE_MARGIN_MS;
  const sandbox = await deps.connect(task.sandboxId);
  const checkpoint = await checkpointCodeSession({
    session,
    fs: e2bSandboxFs(sandbox),
    reason: cycle ? 'runtime_cycle' : 'periodic',
    agentId: task.agentId,
  });
  if (!cycle) return;
  // A close sets closeReason first and pauses the sandbox itself: never pause
  // under it, and never resume what it paused.
  if (!(await taskStillAttached(task.id))) return;
  await sandbox.pause();
  if (!(await taskStillAttached(task.id))) return;
  await deps.connect(task.sandboxId);
  log.info('Cycled code session sandbox before the E2B runtime cap', {
    codeSessionId,
    sandboxId: task.sandboxId,
    checkpointSeq: String(checkpoint?.seq ?? 'none'),
  });
}
