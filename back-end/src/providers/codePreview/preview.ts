/**
 * Live dev-server preview of a code session (Rose-in-Rose, A1).
 *
 *   code session (E2B sandbox | backend-host local HOME | Mac)
 *     ~/.rose/bin/rose-preview start ─► vite --port 5173 (E2B) | free port (local)
 *                                       ~/.rose/preview/state.json {pid, port, url}
 *   backend
 *     create response / code_agent.preview_url ─► e2bPreviewUrl(streamUrl)   (no I/O)
 *     GET /:taskId/preview ─► resolveTaskPreview (status.ts) ─► { preview_url, status }
 *        E2B:   https://5173-<sandbox>.<domain>/ ; status by one bounded GET
 *               (never for a PAUSED session: probing must not wake it)
 *        local: http://127.0.0.1:<state.port>/ from the session HOME's state file
 *        Mac:   the backend cannot see the Mac's loopback → status "unknown"
 *
 * Dev accounts only: the CLI and its env are installed for isRoseDevUser()
 * sessions, and every route refuses other accounts with 403.
 *
 * 10k-agent behaviour: the URL is derived from columns already loaded (no
 * query); a status read is one task lookup + at most one HTTP probe, issued
 * only when a client asks for it. Nothing is polled or broadcast.
 */
import { parseGithubUrl } from '../github';
import type { UserUiBundleFile } from '../userUi/manifest';
import { codePreviewCliScript } from './assets';

/** Dev-server port inside a cloud sandbox (each sandbox has its own network). */
export const CODE_PREVIEW_PORT = 5173;
export const CODE_PREVIEW_CLI_NAME = 'rose-preview';
export const CODE_PREVIEW_CLI_PATH = `.rose/bin/${CODE_PREVIEW_CLI_NAME}`;
export const CODE_PREVIEW_STATE_PATH = '.rose/preview/state.json';
/** The Rose repo whose sessions start the front-end preview automatically. */
export const ROSE_GITHUB_REPO = { owner: 'Rose-Ai-Labs', repo: 'rose' } as const;
/** Front-end directory of the Rose repo, relative to the checkout. */
export const ROSE_FRONT_END_DIR = 'front-end';

export type CodePreviewStatus = 'running' | 'not_running' | 'paused' | 'unknown';

export interface CodePreviewView {
  task_id: string;
  code_session_id: string | null;
  /** cloud = E2B sandbox; local = this backend host's fallback HOME or the user's Mac. */
  target: 'cloud' | 'local';
  /** What the user opens; null when no preview can exist (Mac, or not started locally). */
  preview_url: string | null;
  port: number | null;
  status: CodePreviewStatus;
  checked_at: string;
}

/**
 * owner/repo of a GitHub remote in any form a synced checkout reports:
 * https URL, `git@github.com:o/r.git` or `ssh://git@github.com/o/r.git`.
 */
export function githubRepoOf(
  url: string | null | undefined
): { owner: string; repo: string } | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  const trimmed = url.trim();
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  const parsed = ssh !== null ? { owner: ssh[1], repo: ssh[2] } : parseGithubUrl(trimmed);
  return parsed === null ? null : { owner: parsed.owner, repo: parsed.repo.replace(/\.git$/i, '') };
}

export function isRoseRepoUrl(url: string | null | undefined): boolean {
  const parsed = githubRepoOf(url);
  return (
    parsed !== null &&
    parsed.owner.toLowerCase() === ROSE_GITHUB_REPO.owner.toLowerCase() &&
    parsed.repo.toLowerCase() === ROSE_GITHUB_REPO.repo
  );
}

/**
 * Public URL of `port` in an E2B sandbox, from its ws-server stream URL
 * (`wss://3000-<sandbox>.<domain>` → `https://<port>-<sandbox>.<domain>/`), so
 * the sandbox domain is never guessed. Falls back to E2B's default domain.
 */
export function e2bPreviewUrl(
  streamUrl: string | null | undefined,
  sandboxId: string,
  port: number = CODE_PREVIEW_PORT
): string {
  if (typeof streamUrl === 'string' && streamUrl !== '') {
    try {
      const match = /^\d+-([^.]+)\.(.+)$/.exec(new URL(streamUrl).hostname);
      if (match !== null && match[1] === sandboxId) {
        return `https://${port}-${sandboxId}.${match[2]}/`;
      }
    } catch {
      // fall through to the default domain
    }
  }
  const domain = (process.env.E2B_DOMAIN || 'e2b.app').trim();
  return `https://${port}-${sandboxId}.${domain}/`;
}

/** `rose-preview` CLI, as a file relative to the session HOME. */
export function codePreviewToolFiles(): UserUiBundleFile[] {
  return [{ path: CODE_PREVIEW_CLI_PATH, content: codePreviewCliScript() }];
}

/** Env for a cloud sandbox; ROSE_PREVIEW_URL is added once the sandbox exists. */
export function codePreviewSandboxEnvs(backendBaseUrl: string): Record<string, string> {
  return {
    ROSE_PREVIEW_PORT: String(CODE_PREVIEW_PORT),
    ROSE_PREVIEW_BACKEND_URL: backendBaseUrl,
  };
}

/**
 * Overrides for a same-host session (local fallback): no fixed port (sessions
 * share the host, so the CLI picks a free one) and the loopback backend.
 */
export function codePreviewLocalEnvs(): Record<string, string> {
  return {
    ROSE_PREVIEW_PORT: '',
    ROSE_PREVIEW_URL: '',
    ROSE_PREVIEW_BACKEND_URL: `http://127.0.0.1:${process.env.PORT || 3001}`,
  };
}

/**
 * Detached `rose-preview start` for a Rose-repo session: waits for this boot's
 * project startup, then serves the front-end. "This boot" = a startup report
 * written after the ws-server launched, `sinceLaunchMs` ago; the cutoff is
 * computed on the sandbox clock so backend/sandbox clock skew cannot matter.
 */
export function codePreviewAutostartCommand(home: string, sinceLaunchMs: number): string {
  const cli = `${home}/${CODE_PREVIEW_CLI_PATH}`;
  const log = `${home}/.rose/preview/autostart.log`;
  const elapsed = Math.max(0, Math.floor(sinceLaunchMs));
  // Only the nohup'd preview goes to the background, with every stdio stream
  // redirected: backgrounding the whole `mkdir && nohup` list kept a subshell
  // on the caller's output pipe for the preview's life, so every E2B autostart
  // waited out its 10 s command timeout (code-agent-rose-repo, 2026-11-08).
  return (
    `mkdir -p ${home}/.rose/preview && { nohup ${cli} start --dir ${ROSE_FRONT_END_DIR} ` +
    `--wait-startup --since "$(( $(date +%s%3N) - ${elapsed} ))" > ${log} 2>&1 < /dev/null & }`
  );
}
