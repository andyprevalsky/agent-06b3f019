import { prisma } from './database';
/**
 * Persistent code-session sandbox acquisition for E2B Claude Code / Codex
 * sessions (see providers/codeSessions/lifecycle.ts for the full flow).
 */
import type { Sandbox } from 'e2b';
import type { FilePointer } from './storage';
import { createLogger } from './logger';
import {
  createLocalClaudeCodeSessionIfBillingBlocked,
  isLocalClaudeCodeFallbackEligible,
  resolveLocalSessionWorkDir,
} from './claudeCodeLocalSession';
import { agentToolsForLocalHome } from './agentTools/workspace';
import type { UserUiWorkspace } from './userUi/workspace';
import type {
  ProjectRestoreReport,
  ProjectTemplateSnapshot,
  ProjectWorkspace,
} from './projects/types';
import {
  checkpointCodeSession,
  connectPausedSandbox,
  prepareLocalCodeSessionHome,
  restoreLatestCheckpoint,
  type ResumedFrom,
} from './codeSessions/lifecycle';
import {
  heldSandboxSize,
  resolveSpawnSandbox,
  sameSize,
  defaultSandboxSize,
  type SandboxProvider,
  type SandboxSize,
} from './codeSessions/sandboxSize';
import { e2bSandboxFs, localSandboxFs } from './codeSessions/sandboxFs';
import { writeHandoffTrajectory, type SpawnCodeSession } from './codeSessions/usageLimit';
import { createSandboxWithRetry } from './e2bSandboxCreate';
import { withClaudeCodeCreateSlot } from './e2bCreateSlot';
import { NATIVE_CLI_PATH, resolveNativeCliTemplate } from './nativeCliTemplateBuilder';
import {
  linkClaudeCodeSession,
  markPaused,
  recordSandbox,
  type CodeSessionRow,
} from './codeSessions/store';

const log = createLogger('E2B');
const WS_PORT = 3000;
/**
 * How long a sandbox nobody is attached to stays up. The attached activity
 * keeps extending it (POST /:taskId/keepalive), so this is an idle window,
 * not a runtime limit: on expiry a persistent session's sandbox pauses
 * (lifecycle onTimeout=pause) and resumes on the next spawn.
 */
export const CODE_SANDBOX_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SANDBOX_TIMEOUT_MS = CODE_SANDBOX_IDLE_TIMEOUT_MS;

export interface CodeAgentSessionResult {
  wsUrl: string;
  taskId: string;
  sandboxId: string;
  uploadedFiles: string[];
  /** Where the persistent code session's state came from. */
  resumedFrom?: ResumedFrom;
  /** CLI conversation the session resumed (`claude --resume` / `codex resume`). */
  cliSessionId?: string | null;
  /** Restore summary when the session materialized a Project (PJ3). */
  projectRestore?: ProjectRestoreReport | null;
  /** Public URL of the session's live dev-server preview (Rose dev accounts, A1). */
  previewUrl?: string | null;
  /** vCPUs / memory of the E2B sandbox (C16); absent for local sessions. */
  sandboxSize?: SandboxSize | null;
}

/** Persistent workspace and conversation controls for a Claude code spawn. */
export interface ClaudeCodeSessionOptions {
  /** Project restored into `~/workspace` before the CLI starts (PJ3 / C9). */
  projectWorkspace?: ProjectWorkspace | null;
  /** Persistent code session to resume or start (C1, C13). */
  codeSession?: CodeSessionRow | null;
  /** Keep the session's sandbox and files but start a new CLI conversation. */
  freshConversation?: boolean;
}

/** Sizing of a spawn (C16): the size it wants and the agent to attribute checkpoints to. */
export interface SpawnSizing {
  provider?: SandboxProvider;
  size?: SandboxSize;
  agentId?: string;
}

/**
 * Persistent code sessions resume their paused sandbox (filesystem + memory).
 * When it is gone, a new sandbox is created and the latest verified
 * checkpoint restored into it before the ws-server starts.
 *
 * C16: when the spawn wants another size than the held sandbox has, the held
 * sandbox is checkpointed, a new one of the wanted size restores it, and only
 * then is the held one killed. A failed save or restore keeps the held
 * sandbox (paused) and throws, so nothing is lost.
 */
export async function acquireCodeSessionSandbox(
  codeSession: CodeSessionRow | null,
  create: () => Promise<Sandbox>,
  sizing: SpawnSizing = {}
): Promise<{ sandbox: Sandbox; resumedFrom: ResumedFrom; cliSessionId: string | null }> {
  let session = codeSession;
  let replaced: Sandbox | null = null;
  if (session?.sandboxKind === 'e2b' && session.sandboxId !== null) {
    const sandboxId = session.sandboxId;
    const resume = () => connectPausedSandbox(sandboxId, SANDBOX_TIMEOUT_MS);
    const resumed = await (sizing.provider === 'claude'
      ? withClaudeCodeCreateSlot(resume)
      : resume());
    if (resumed !== null) {
      await stopStaleWsServer(resumed);
      if (sizing.size === undefined || sameSize(sizing.size, heldSandboxSize(session))) {
        return {
          sandbox: resumed,
          resumedFrom: 'paused_sandbox',
          cliSessionId: session.cliSessionId,
        };
      }
      session = await saveBeforeResize(session, resumed, sizing);
      replaced = resumed;
    }
  }
  const sandbox = await create();
  if (session !== null && session.latestCheckpointSeq > 0) {
    const restored = await restoreLatestCheckpoint(session, e2bSandboxFs(sandbox));
    if (restored !== null) {
      if (replaced !== null) await retireReplacedSandbox(session, sandbox, replaced, sizing);
      else await recordNewSandbox(session, sandbox, sizing);
      return { sandbox, resumedFrom: 'checkpoint', cliSessionId: restored.cliSessionId };
    }
  }
  if (replaced !== null) {
    await sandbox.kill().catch(() => undefined);
    await replaced.pause().catch(() => undefined);
    throw new Error('The saved session could not be restored into the new sandbox size');
  }
  if (session !== null) await recordNewSandbox(session, sandbox, sizing);
  return { sandbox, resumedFrom: 'new', cliSessionId: null };
}

/** The row names the sandbox the session holds, with its size, as soon as it exists (C16). */
async function recordNewSandbox(
  session: CodeSessionRow,
  sandbox: Sandbox,
  sizing: SpawnSizing
): Promise<void> {
  if (sizing.size === undefined) return;
  await recordSandbox(session.id, {
    sandboxKind: 'e2b',
    sandboxId: sandbox.sandboxId,
    size: sizing.size,
  });
}

/** Checkpoint the held sandbox before moving to another size; the row now names that checkpoint. */
async function saveBeforeResize(
  session: CodeSessionRow,
  held: Sandbox,
  sizing: SpawnSizing
): Promise<CodeSessionRow> {
  const checkpoint = await checkpointCodeSession({
    session,
    fs: e2bSandboxFs(held),
    reason: 'resize',
    agentId: sizing.agentId ?? session.ownerAgentId,
  });
  if (checkpoint === null) {
    await held.pause().catch(() => undefined);
    throw new Error('The session could not be saved before moving it to another sandbox size');
  }
  return {
    ...session,
    latestCheckpointSeq: Math.max(session.latestCheckpointSeq, checkpoint.seq),
    cliSessionId: checkpoint.cliSessionId ?? session.cliSessionId,
  };
}

/** The new-size sandbox holds the session now: record it, then kill the old one. */
async function retireReplacedSandbox(
  session: CodeSessionRow,
  sandbox: Sandbox,
  replaced: Sandbox,
  sizing: SpawnSizing
): Promise<void> {
  await recordSandbox(session.id, {
    sandboxKind: 'e2b',
    sandboxId: sandbox.sandboxId,
    ...(sizing.size !== undefined ? { size: sizing.size } : {}),
  });
  try {
    await replaced.kill();
    log.info('Replaced the code-session sandbox with a resized one', {
      codeSessionId: session.id,
      previous: replaced.sandboxId,
      sandboxId: sandbox.sandboxId,
    });
  } catch (error) {
    log.warn('Killing the replaced code-session sandbox failed', {
      codeSessionId: session.id,
      sandboxId: replaced.sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Caller identity may supply a new spawn owner but never replace session authority. */
export function codeSandboxUserId(
  codeSession: CodeSessionRow | null,
  userId?: string
): string | undefined {
  if (codeSession !== null && userId !== undefined && codeSession.userId !== userId) {
    throw new Error('Code session does not belong to the spawning user');
  }
  return codeSession?.userId ?? userId;
}

/**
 * Acquire the sandbox for a spawn: resume the session's paused sandbox, else
 * create one (restoring the latest checkpoint). With a `provider`, the
 * session's size (C16: an active resize, the held size, or a new session's
 * project default) picks the template; `templateId` is the unsized fallback.
 * The timeout is the idle window every keepalive extends, not a runtime cap.
 */
export async function acquireCodeSandbox(
  codeSession: SpawnCodeSession | null,
  templateId: string,
  envs: Record<string, string>,
  label: string,
  sizing: {
    provider?: SandboxProvider;
    projectSize?: unknown;
    agentId?: string;
    userId?: string;
    /**
     * The session's project: its default size, and its published template
     * snapshot, which a BRAND-NEW session sandbox starts from.
     */
    project?: ProjectWorkspace['project'] | null;
    snapshot?: ProjectTemplateSnapshot | null;
  } = {}
): Promise<{
  sandbox: Sandbox;
  resumedFrom: ResumedFrom;
  cliSessionId: string | null;
  size?: SandboxSize;
  /** The sandbox was created from the project's template snapshot. */
  fromSnapshot: boolean;
}> {
  const userId = codeSandboxUserId(codeSession, sizing.userId);
  const sized =
    sizing.provider !== undefined
      ? await resolveSpawnSandbox(
          codeSession,
          sizing.provider,
          sizing.project?.sandboxSize ?? sizing.projectSize ?? null
        )
      : null;
  const spawnSizing: SpawnSizing = {
    ...(sized !== null ? { size: sized.size } : {}),
    agentId: sizing.agentId,
    provider: sizing.provider,
  };
  const createOptions = {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    envs: { ...envs, PATH: NATIVE_CLI_PATH },
    ...codeSessionCreateOptions(codeSession),
  };
  // Resolve on the exact base image, including project snapshots, before reserving
  // the runtime sandbox. Template builds have their own bounded creation slot.
  const createWithNativeCli = async (baseTemplateId: string, size: SandboxSize) => {
    const selectedTemplateId =
      userId && sizing.provider
        ? await resolveNativeCliTemplate(userId, sizing.provider, size, baseTemplateId)
        : baseTemplateId;
    const create = () => createSandboxWithRetry(selectedTemplateId, createOptions, label);
    return sizing.provider === 'claude' ? withClaudeCodeCreateSlot(create) : create();
  };
  let fromSnapshot = false;
  const acquired = await acquireCodeSessionSandbox(
    codeSession,
    async () => {
      const snapshot = sizing.snapshot ?? sizing.project?.templateSnapshot ?? null;
      // Only a session with no sandbox of its own (a new one) starts from the
      // snapshot; a lost sandbox being replaced or resized keeps the base path.
      if (snapshot !== null && (codeSession === null || codeSession.sandboxId === null)) {
        try {
          const sandbox = await createWithNativeCli(
            snapshot.id,
            snapshot.size ?? sized?.size ?? defaultSandboxSize()
          );
          fromSnapshot = true;
          // The held size is the snapshot's: a later resume must not read it as a resize.
          if (snapshot.size !== null && spawnSizing.size !== undefined) {
            spawnSizing.size = snapshot.size;
          }
          return sandbox;
        } catch (error) {
          log.warn('Project template snapshot could not start; using the base template', {
            snapshotId: snapshot.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (sized !== null && sized.templateId === null) {
        // The unsized fallback is a fixed-size image: never hand it to another size.
        throw new Error(
          `No ${label} sandbox template is built for ${sized.size.cpu} vCPU / ${sized.size.memoryGb} GB; configure E2B_SANDBOX_TEMPLATES for that size`
        );
      }
      return createWithNativeCli(
        sized?.templateId ?? templateId,
        sized?.size ?? defaultSandboxSize()
      );
    },
    spawnSizing
  );
  const trajectory = codeSession?.handoffTrajectory ?? null;
  if (trajectory !== null) {
    // C15 provider switch: after the checkpoint restore, so the previous CLI's
    // session log is in the HOME the new CLI starts in, where the handoff points.
    // The sandbox is new (a switch drops the old one); on a failed write it is
    // killed and the spawn fails, so no CLI starts on a prompt naming a missing file.
    try {
      await writeHandoffTrajectory(e2bSandboxFs(acquired.sandbox), trajectory);
    } catch (error) {
      await acquired.sandbox.kill().catch(() => undefined);
      throw error;
    }
  }
  return {
    ...acquired,
    ...(spawnSizing.size !== undefined ? { size: spawnSizing.size } : {}),
    fromSnapshot,
  };
}

/** A resumed sandbox still runs the previous (lingering) ws-server on WS_PORT. */
async function stopStaleWsServer(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.commands.run(
      `pkill -f 'node /home/user/ws-server.mjs' || true; for i in $(seq 1 50); do netstat -tln | grep -q ':${WS_PORT} ' || exit 0; sleep 0.1; done; exit 0`,
      { timeoutMs: 10_000 }
    );
  } catch (error) {
    log.warn('Stopping the resumed sandbox ws-server failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Task-row fields tying a spawn to its persistent session and CLI provider. */
export function codeSessionTaskFields(
  codeSession: CodeSessionRow | null,
  codeProvider: 'claude' | 'codex'
): { codeSessionId: string | null; codeProvider: string } {
  return { codeSessionId: codeSession?.id ?? null, codeProvider };
}

/** Remember which E2B sandbox now holds the session (resume connects to it). */
export async function recordE2bCodeSessionSandbox(
  codeSession: CodeSessionRow | null,
  sandboxId: string
): Promise<void> {
  if (codeSession !== null) await recordSandbox(codeSession.id, { sandboxKind: 'e2b', sandboxId });
}

/** Cleanup did not confirm a pause; retain the session lease for reconciliation. */
export class CodeSessionPauseUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super(
      `Code session pause unconfirmed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = 'CodeSessionPauseUnconfirmedError';
  }
}

/** A persistent session's sandbox is paused (never killed) on a failed start. */
export async function releaseSandboxAfterFailedStart(
  sandbox: Sandbox,
  codeSession: SpawnCodeSession | null
): Promise<void> {
  if (codeSession === null) {
    await sandbox.kill();
    return;
  }
  try {
    await recordSandbox(codeSession.id, { sandboxKind: 'e2b', sandboxId: sandbox.sandboxId });
    await sandbox.pause();
  } catch (error) {
    log.warn('Pausing the sandbox after a failed start failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new CodeSessionPauseUnconfirmedError(error);
  }
  if (codeSession.retainFailedStartLease === true) {
    // Keep this attempt's unique switch custody until the outer rollback finishes.
    await prisma.codeSession.updateMany({
      where: {
        id: codeSession.id,
        leaseOwner: codeSession.leaseOwner,
        codeProvider: codeSession.codeProvider,
        sandboxId: sandbox.sandboxId,
        state: { not: 'RETIRED' },
      },
      data: { state: 'PAUSED', lastActiveAt: new Date() },
    });
  } else {
    await markPaused(codeSession.id);
  }
}

/**
 * Branch the sandbox ws-server checks out before the CLI starts (plan §1b).
 * CODE_AGENT_BASE_BRANCH empty = cut from the repository's default branch.
 */
export function codeSessionBranchEnvs(codeSession: CodeSessionRow | null): Record<string, string> {
  if (codeSession?.branch === null || codeSession?.branch === undefined) return {};
  return {
    CODE_AGENT_BRANCH: codeSession.branch,
    CODE_AGENT_BASE_BRANCH: codeSession.baseBranch ?? '',
    CODE_AGENT_MERGE_TARGET: codeSession.mergeTarget ?? '',
  };
}

/** Persistent code sessions pause (keeping fs + memory) on timeout. */
export function codeSessionCreateOptions(codeSession: CodeSessionRow | null): {
  lifecycle?: { onTimeout: 'pause' };
} {
  return codeSession !== null ? { lifecycle: { onTimeout: 'pause' } } : {};
}

/**
 * Local ws-server fallback (E2B billing block / create timeout) for a
 * persistent session: reuse its HOME, else restore the latest checkpoint.
 */
export async function createLocalCodeSessionFallback(
  err: unknown,
  codeSession: SpawnCodeSession | null,
  params: {
    taskId: string;
    agentId: string;
    goal: string;
    envs: Record<string, string>;
    attachments?: FilePointer[];
    userUiWorkspace?: UserUiWorkspace | null;
    projectWorkspace?: ProjectWorkspace | null;
    claudeTokenSource: string | null;
    claudeTokenIntegrationId: string | null;
  }
): Promise<CodeAgentSessionResult | null> {
  if (!isLocalClaudeCodeFallbackEligible(err)) return null;
  const localHome = codeSession !== null ? await prepareLocalCodeSessionHome(codeSession) : null;
  const trajectory = codeSession?.handoffTrajectory ?? null;
  if (localHome !== null && trajectory !== null) {
    // C15 provider switch on this host: the log lands under the session HOME
    // and the handoff prompt names that path instead of the sandbox one.
    const written = await writeHandoffTrajectory(localSandboxFs(localHome.home), trajectory);
    params = { ...params, goal: params.goal.split(trajectory.path).join(written) };
  }
  const resumeId = localHome?.cliSessionId ?? null;
  // Same-host session: loopback tools URL, MCP path under the session HOME
  // (the persistent code-session HOME when there is one, else the task dir).
  const toolsHome = localHome?.home ?? resolveLocalSessionWorkDir(params.taskId);
  const local = await createLocalClaudeCodeSessionIfBillingBlocked(err, {
    ...params,
    userUiWorkspace: agentToolsForLocalHome(params.userUiWorkspace, toolsHome),
    envs:
      resumeId !== null ? { ...params.envs, CLAUDE_CODE_RESUME_SESSION_ID: resumeId } : params.envs,
    ...(localHome !== null ? { homeDir: localHome.home } : {}),
  });
  if (local === null) return null;
  if (codeSession !== null && localHome !== null) {
    await recordSandbox(codeSession.id, {
      sandboxKind: 'local',
      sandboxId: local.sandboxId,
      homeDir: localHome.home,
    });
    await linkClaudeCodeSession(local.taskId, codeSession.id);
  }
  return { ...local, resumedFrom: localHome?.resumedFrom ?? 'new', cliSessionId: resumeId };
}
