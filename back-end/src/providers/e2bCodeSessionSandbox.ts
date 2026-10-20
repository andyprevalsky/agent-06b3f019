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
import {
  connectPausedSandbox,
  prepareLocalCodeSessionHome,
  restoreLatestCheckpoint,
  type ResumedFrom,
} from './codeSessions/lifecycle';
import { e2bSandboxFs } from './codeSessions/sandboxFs';
import {
  linkClaudeCodeSession,
  markPaused,
  recordSandbox,
  type CodeSessionRow,
} from './codeSessions/store';

const log = createLogger('E2B');
const WS_PORT = 3000;
const SANDBOX_TIMEOUT_MS = 1800000; // keep in sync with e2b.ts

export interface CodeAgentSessionResult {
  wsUrl: string;
  taskId: string;
  sandboxId: string;
  uploadedFiles: string[];
  /** Where the persistent code session's state came from. */
  resumedFrom?: ResumedFrom;
  /** CLI conversation the session resumed (`claude --resume` / `codex resume`). */
  cliSessionId?: string | null;
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

/** Persistent code sessions pause (keeping fs + memory) on timeout. */
export function codeSessionCreateOptions(
  codeSession: CodeSessionRow | null
): { lifecycle?: { onTimeout: 'pause' } } {
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
    claudeTokenSource: string | null;
    claudeTokenIntegrationId: string | null;
  }
): Promise<CodeAgentSessionResult | null> {
  if (!isLocalClaudeCodeFallbackEligible(err)) return null;
  const localHome = codeSession !== null ? await prepareLocalCodeSessionHome(codeSession) : null;
  const resumeId = localHome?.cliSessionId ?? null;
  const local = await createLocalClaudeCodeSessionIfBillingBlocked(err, {
    ...params,
    envs: resumeId !== null ? { ...params.envs, CLAUDE_CODE_RESUME_SESSION_ID: resumeId } : params.envs,
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
