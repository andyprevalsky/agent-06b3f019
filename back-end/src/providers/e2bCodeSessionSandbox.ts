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
} from './claudeCodeLocalSession';
import type { UserUiWorkspace } from './userUi/workspace';
import type { ProjectRestoreReport, ProjectWorkspace } from './projects/types';
import {
  connectPausedSandbox,
  prepareLocalCodeSessionHome,
  restoreLatestCheckpoint,
  type ResumedFrom,
} from './codeSessions/lifecycle';
import { e2bSandboxFs } from './codeSessions/sandboxFs';
import { createSandboxWithRetry } from './e2bSandboxCreate';
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
}

/**
 * Persistent code sessions resume their paused sandbox (filesystem + memory).
 * When it is gone, a new sandbox is created and the latest verified
 * checkpoint restored into it before the ws-server starts.
 */
export async function acquireCodeSessionSandbox(
  codeSession: CodeSessionRow | null,
  create: () => Promise<Sandbox>
): Promise<{ sandbox: Sandbox; resumedFrom: ResumedFrom; cliSessionId: string | null }> {
  if (codeSession?.sandboxKind === 'e2b' && codeSession.sandboxId !== null) {
    const resumed = await connectPausedSandbox(codeSession.sandboxId, SANDBOX_TIMEOUT_MS);
    if (resumed !== null) {
      await stopStaleWsServer(resumed);
      return {
        sandbox: resumed,
        resumedFrom: 'paused_sandbox',
        cliSessionId: codeSession.cliSessionId,
      };
    }
  }
  const sandbox = await create();
  if (codeSession !== null && codeSession.latestCheckpointSeq > 0) {
    const restored = await restoreLatestCheckpoint(codeSession, e2bSandboxFs(sandbox));
    if (restored !== null) {
      return { sandbox, resumedFrom: 'checkpoint', cliSessionId: restored.cliSessionId };
    }
  }
  return { sandbox, resumedFrom: 'new', cliSessionId: null };
}

/**
 * Acquire the sandbox for a spawn: resume the session's paused sandbox, else
 * create one from `templateId` (restoring the latest checkpoint). The
 * timeout is the idle window every keepalive extends, not a runtime cap.
 */
export async function acquireCodeSandbox(
  codeSession: CodeSessionRow | null,
  templateId: string,
  envs: Record<string, string>,
  label: string
): Promise<{ sandbox: Sandbox; resumedFrom: ResumedFrom; cliSessionId: string | null }> {
  return acquireCodeSessionSandbox(codeSession, () =>
    createSandboxWithRetry(
      templateId,
      {
        apiKey: process.env.E2B_API_KEY,
        timeoutMs: SANDBOX_TIMEOUT_MS,
        envs,
        ...codeSessionCreateOptions(codeSession),
      },
      label
    )
  );
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

/** Remember which E2B sandbox now holds the session (resume connects to it). */
export async function recordE2bCodeSessionSandbox(
  codeSession: CodeSessionRow | null,
  sandboxId: string
): Promise<void> {
  if (codeSession !== null) await recordSandbox(codeSession.id, { sandboxKind: 'e2b', sandboxId });
}

/** A persistent session's sandbox is paused (never killed) on a failed start. */
export async function releaseSandboxAfterFailedStart(
  sandbox: Sandbox,
  codeSession: CodeSessionRow | null
): Promise<void> {
  if (codeSession === null) {
    await sandbox.kill();
    return;
  }
  try {
    await sandbox.pause();
    await recordSandbox(codeSession.id, { sandboxKind: 'e2b', sandboxId: sandbox.sandboxId });
  } catch (error) {
    log.warn('Pausing the sandbox after a failed start failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await markPaused(codeSession.id);
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
  codeSession: CodeSessionRow | null,
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
  const resumeId = localHome?.cliSessionId ?? null;
  const local = await createLocalClaudeCodeSessionIfBillingBlocked(err, {
    ...params,
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
