/**
 * E2B wiring for the live preview (A1), called by providers/e2b.ts:
 *
 *   applyPreviewUrlEnv   after the sandbox exists: ROSE_PREVIEW_URL = its public
 *                        host for the preview port (only when rose-preview is installed)
 *   autostartRosePreview after ws-server starts, for a Rose-repo session: detached
 *                        `rose-preview start --dir front-end --wait-startup`
 *
 * Both are no-ops for non-dev sessions (no ROSE_PREVIEW_PORT in their env) and
 * best-effort: a preview problem never blocks or fails a code session.
 */
import { readFileSync, realpathSync, rmSync } from 'fs';
import { join, sep } from 'path';
import { createLogger } from '../logger';
import {
  CODE_PREVIEW_STATE_PATH,
  codePreviewAutostartCommand,
  e2bPreviewUrl,
  isRoseRepoUrl,
} from './preview';

const log = createLogger('CodePreviewSandbox');
const SANDBOX_HOME = '/home/user';

function previewPort(envs: Record<string, string>): number | null {
  const port = Number(envs.ROSE_PREVIEW_PORT);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** Set ROSE_PREVIEW_URL for a dev session; returns the URL (null when not a dev session). */
export function applyPreviewUrlEnv(
  envs: Record<string, string>,
  wsUrl: string,
  sandboxId: string
): string | null {
  const port = previewPort(envs);
  if (port === null) return null;
  const url = e2bPreviewUrl(wsUrl, sandboxId, port);
  envs.ROSE_PREVIEW_URL = url;
  return url;
}

interface SandboxCommands {
  sandboxId: string;
  commands: {
    run(
      cmd: string,
      opts?: { timeoutMs?: number; envs?: Record<string, string> }
    ): Promise<unknown>;
  };
}

/**
 * Same-host (local fallback) close: stop the preview the session started, so a
 * closed session never leaves a dev server running on the backend host. The
 * CLI runs vite as its own process group; signal exactly that group.
 */
export function stopLocalCodePreview(home: string): boolean {
  const statePath = join(home, CODE_PREVIEW_STATE_PATH);
  let pid: number;
  try {
    pid = Number((JSON.parse(readFileSync(statePath, 'utf8')) as { pid?: unknown }).pid);
  } catch {
    return false;
  }
  rmSync(statePath, { force: true });
  if (!Number.isInteger(pid) || pid <= 1) return false;
  // The state file is session-written: only signal a process that runs inside this HOME.
  try {
    const root = realpathSync(home);
    const cwd = realpathSync(`/proc/${pid}/cwd`);
    if (cwd !== root && !cwd.startsWith(`${root}${sep}`)) return false;
  } catch {
    return false;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    log.info('Stopped local code-session preview', { home, pid });
    return true;
  } catch {
    return false;
  }
}

/** Start the Rose front-end preview in the background for a dev Rose-repo session. */
export async function autostartRosePreview(
  sandbox: SandboxCommands,
  params: { envs: Record<string, string>; repoUrl: string | null | undefined; sinceMs: number }
): Promise<boolean> {
  if (previewPort(params.envs) === null || !isRoseRepoUrl(params.repoUrl)) return false;
  try {
    await sandbox.commands.run(codePreviewAutostartCommand(SANDBOX_HOME, params.sinceMs), {
      timeoutMs: 10_000,
      envs: params.envs,
    });
    log.info('Started Rose-in-Rose preview', { sandboxId: sandbox.sandboxId });
    return true;
  } catch (err) {
    log.warn('Rose-in-Rose preview autostart failed', {
      sandboxId: sandbox.sandboxId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
