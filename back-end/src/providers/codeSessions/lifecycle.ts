/**
 * Persistent code-session lifecycle used by session create/close.
 *
 *   create ─► resolveCodeSession ─┬─ E2B paused sandbox ──connect──► resume (fs+memory)
 *                                 ├─ connect failed / none ──► new sandbox
 *                                 │     └─ restoreLatestCheckpoint ──► `claude --resume`
 *                                 └─ local fallback: reuse HOME, else restore checkpoint
 *   close  ─► checkpointCodeSession ─► index code_event rows ─► pause (never kill)
 *   retire ─► explicit close or TTL: kill sandbox, delete checkpoints
 */
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, sep } from 'path';
import { Sandbox } from 'e2b';
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
} from './checkpoint';
import { indexCodeEvents } from './codeEvents';
import { type CodeSessionFs, localSandboxFs } from './sandboxFs';
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
    });
    const repo = primaryRepoFacts(manifest);
    await commitCheckpoint(session.id, seq, {
      cliSessionId: manifest.cliSessionId,
      repoFacts: repo,
    });
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
 * Restore the newest checkpoint that verifies. A corrupted checkpoint is
 * rejected (never applied) and the next older one is tried.
 */
export async function restoreLatestCheckpoint(
  session: CodeSessionRow,
  fs: CodeSessionFs
): Promise<{ seq: number; cliSessionId: string | null } | null> {
  const newest = session.latestCheckpointSeq;
  for (let seq = newest; seq >= 1 && seq > newest - RESTORE_LOOKBACK; seq -= 1) {
    let verified;
    try {
      verified = await loadVerifiedCheckpoint(session.userId, session.id, seq);
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
    const { cliSessionId } = await applyCheckpoint(fs, verified, {
      authRemoteUrl: githubAuthRemoteUrl,
    });
    return { seq, cliSessionId };
  }
  return null;
}

/** Connect (and thereby resume) a paused E2B sandbox; null when it is gone. */
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
    log.warn('Paused sandbox could not be resumed; falling back to checkpoint', {
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
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

async function deleteCheckpoints(session: CodeSessionRow): Promise<void> {
  for (let seq = 1; seq <= session.nextCheckpointSeq; seq += 1) {
    const manifestKey = checkpointKey(session.userId, session.id, seq, MANIFEST_NAME);
    const raw = await getCheckpointObject(manifestKey).catch(() => null);
    if (raw !== null) {
      try {
        const manifest = JSON.parse(raw.toString('utf8')) as CheckpointManifest;
        for (const name of Object.keys(manifest.artifacts ?? {})) {
          await deleteCheckpointObject(checkpointKey(session.userId, session.id, seq, name));
        }
      } catch {
        // an unreadable manifest still gets deleted below
      }
    }
    await deleteCheckpointObject(manifestKey).catch(() => undefined);
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

/** Opportunistic, bounded TTL sweep for one user (never blocks the caller). */
export function sweepExpiredCodeSessions(userId: string): void {
  void findExpiredCodeSessions(userId)
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
