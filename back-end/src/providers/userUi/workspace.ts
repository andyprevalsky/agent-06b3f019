/**
 * Materialize a user's `rose_user_ui/` folder (+ the `rose-ui` CLI) into a
 * code-agent session home.
 *
 *   createClaudeCodeSession(userId)
 *     └─ prepareUserUiWorkspace(userId)
 *          active version files (storage) ─┐
 *          or seed (README + manifest +    ├─► files under ~/rose_user_ui/
 *          theme + examples)               ┘   README.md always regenerated
 *          rose-ui CLI + preview host ───────► ~/.rose/bin/rose-ui, ~/.rose/lib/rose-ui/
 *          fresh publish token (agt + tsk) ──► ROSE_UI_PUBLISH_URL / _TOKEN env
 *          active version usercontent URL ──► ROSE_UI_PUBLISHED_BASE_URL / _VERSION_ID env
 *     └─ (sandbox) background `rose-ui screenshot --current`
 *          → ~/rose_user_ui/screenshots/current/*.png of the published UI
 *          (the CLI also captures lazily on its first browser command)
 *
 * The folder lives in the session HOME (not the repo workDir) so a GitHub clone
 * into the workDir never collides with it.
 */
import { chmod, mkdir, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { createLogger } from '../logger';
import type { UserUiBundleFile } from './manifest';
import { mintUserUiPublishToken } from './publishToken';
import {
  USER_UI_CLI_BIN_DIR,
  USER_UI_CLI_NAME,
  USER_UI_DIR_NAME,
  userUiReadme,
  userUiSeedFiles,
  userUiToolFiles,
} from './seed';
import { findActiveUserUiVersion, readUserUiVersionFiles } from './store';

const log = createLogger('UserUiWorkspace');

export { USER_UI_CLI_BIN_DIR };

export interface UserUiWorkspace {
  /** Files relative to the session HOME (rose_user_ui/..., .rose/bin/rose-ui, .rose/lib/...). */
  files: UserUiBundleFile[];
  /** Env injected into the session for `rose-ui publish` and published-UI screenshots. */
  envs: Record<string, string>;
  /** Overrides for a same-host (local fallback) session, e.g. loopback URLs. */
  localEnvs?: Record<string, string>;
  source: { kind: 'active'; versionId: string } | { kind: 'seed' };
}

/**
 * Where a published version's files are served. Mirrors the user-ui domain:
 * USERCONTENT_BASE_URL (separate origin) in production, else this backend.
 */
export function userUiPublishedBaseUrl(versionId: string, backendBaseUrl: string): string {
  const configured = process.env.USERCONTENT_BASE_URL?.trim();
  const origin = configured ? configured.replace(/\/+$/, '') : backendBaseUrl;
  return `${origin}/usercontent/${versionId}/`;
}

/** Public base URL a sandbox uses to reach this backend. */
export function userUiPublishBaseUrl(): string {
  const configured =
    process.env.ROSE_UI_PUBLISH_BASE_URL ??
    process.env.BACKEND_URL ??
    process.env.RENDER_EXTERNAL_URL;
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT || 3001}`;
}

export async function prepareUserUiWorkspace(
  userId: string,
  agentId?: string,
  taskId?: string
): Promise<UserUiWorkspace> {
  const active = await findActiveUserUiVersion(userId);
  const bundle = active ? await readUserUiVersionFiles(userId, active.id) : userUiSeedFiles();
  const withReadme = [
    ...bundle.filter((file) => file.path !== 'README.md'),
    { path: 'README.md', content: Buffer.from(userUiReadme(), 'utf8') },
  ];
  const { token } = mintUserUiPublishToken(userId, { agentId, taskId });
  const envs: Record<string, string> = {
    ROSE_UI_PUBLISH_URL: `${userUiPublishBaseUrl()}/api/user-ui/versions`,
    ROSE_UI_PUBLISH_TOKEN: token,
  };
  if (active) {
    envs.ROSE_UI_PUBLISHED_VERSION_ID = active.id;
    envs.ROSE_UI_PUBLISHED_BASE_URL = userUiPublishedBaseUrl(active.id, userUiPublishBaseUrl());
  }
  return {
    files: [
      ...withReadme.map((file) => ({
        path: `${USER_UI_DIR_NAME}/${file.path}`,
        content: file.content,
      })),
      ...userUiToolFiles(),
    ],
    envs,
    source: active ? { kind: 'active', versionId: active.id } : { kind: 'seed' },
  };
}

/** Best-effort wrapper: a UI-folder failure must never block a code session. */
export async function prepareUserUiWorkspaceSafe(
  userId: string | undefined,
  agentId?: string,
  taskId?: string
): Promise<UserUiWorkspace | null> {
  if (!userId) return null;
  try {
    const workspace = await prepareUserUiWorkspace(userId, agentId, taskId);
    log.info('Prepared rose_user_ui workspace', {
      userId,
      source: workspace.source.kind,
      versionId: workspace.source.kind === 'active' ? workspace.source.versionId : null,
      fileCount: workspace.files.length,
    });
    return workspace;
  } catch (err) {
    log.error('Failed to prepare rose_user_ui workspace', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Write the workspace under a local HOME directory (local Claude Code fallback). */
export async function writeUserUiWorkspaceToDir(homeDir: string, workspace: UserUiWorkspace) {
  const root = resolve(homeDir);
  for (const file of workspace.files) {
    const full = resolve(root, file.path);
    if (!full.startsWith(root + sep)) throw new Error(`refusing to write outside ${root}`);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.content);
  }
  for (const bin of cliBinPaths(workspace)) await chmod(join(root, bin), 0o755);
}

/** Every file installed under ~/.rose/bin (rose-ui, rose-agents, ...). */
function cliBinPaths(workspace: UserUiWorkspace): string[] {
  return workspace.files
    .map((file) => file.path)
    .filter((path) => path.startsWith(`${USER_UI_CLI_BIN_DIR}/`));
}

interface SandboxFiles {
  files: {
    write(entries: { path: string; data: ArrayBuffer }[]): Promise<unknown>;
  };
  commands: { run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ exitCode: number }> };
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Write the workspace into an E2B sandbox whose HOME is `homeDir`. */
export async function writeUserUiWorkspaceToSandbox(
  sandbox: SandboxFiles,
  homeDir: string,
  workspace: UserUiWorkspace
) {
  const home = homeDir.replace(/\/+$/, '');
  await sandbox.files.write(
    workspace.files.map((file) => ({
      path: `${home}/${file.path}`,
      data: toArrayBuffer(file.content),
    }))
  );
  const bins = cliBinPaths(workspace).map((bin) => `${home}/${bin}`);
  if (bins.length === 0) return;
  await sandbox.commands.run(`chmod 755 ${bins.join(' ')}`, { timeoutMs: 10_000 });
  if (workspace.source.kind === 'active') {
    await sandbox.commands.run(currentScreenshotsCommand(home), { timeoutMs: 10_000 });
  }
}

/**
 * Detached session-start capture of the published UI. It needs Playwright +
 * Chromium in the template; when they are missing it fails into its log and
 * `rose-ui` retries lazily on the agent's first browser command.
 */
export function currentScreenshotsCommand(home: string): string {
  const cli = `${home}/${USER_UI_CLI_BIN_DIR}/${USER_UI_CLI_NAME}`;
  return `nohup ${cli} screenshot --current --quiet > ${home}/.rose/current-screenshots.log 2>&1 &`;
}

const SANDBOX_HOME = '/home/user';
const SANDBOX_DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Inject the rose-ui publish env and put `~/.rose/bin` on the E2B sandbox PATH. */
export function applyUserUiSandboxEnvs(
  envs: Record<string, string>,
  workspace: UserUiWorkspace | null
): void {
  if (!workspace) return;
  Object.assign(envs, workspace.envs);
  envs.PATH = `${SANDBOX_HOME}/${USER_UI_CLI_BIN_DIR}:${SANDBOX_HOME}/.local/bin:${SANDBOX_DEFAULT_PATH}`;
}

/** Best-effort E2B write: the rose_user_ui folder never blocks a code session. */
export async function writeUserUiWorkspaceToSandboxSafe(
  sandbox: SandboxFiles,
  workspace: UserUiWorkspace | null,
  agentId: string
): Promise<void> {
  if (!workspace) return;
  try {
    await writeUserUiWorkspaceToSandbox(sandbox, SANDBOX_HOME, workspace);
    log.info('Materialized rose_user_ui in sandbox', { agentId, source: workspace.source.kind });
  } catch (err) {
    log.error('Failed to materialize rose_user_ui in sandbox', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Best-effort local-fallback write under the session HOME. Returns the CLI bin
 * dir for PATH and env overrides: a same-host session publishes to this
 * backend's loopback port rather than the public URL a remote sandbox needs.
 */
export async function materializeUserUiInLocalHome(
  homeDir: string,
  workspace: UserUiWorkspace | null | undefined,
  agentId: string
): Promise<{ binDir: string; envs: Record<string, string> } | null> {
  if (!workspace) return null;
  try {
    await writeUserUiWorkspaceToDir(homeDir, workspace);
    const loopback = `http://127.0.0.1:${process.env.PORT || 3001}`;
    const envs: Record<string, string> = {
      ROSE_UI_PUBLISH_URL: `${loopback}/api/user-ui/versions`,
      ...workspace.localEnvs,
    };
    if (workspace.source.kind === 'active') {
      envs.ROSE_UI_PUBLISHED_BASE_URL = userUiPublishedBaseUrl(
        workspace.source.versionId,
        loopback
      );
    }
    return { binDir: join(homeDir, USER_UI_CLI_BIN_DIR), envs };
  } catch (err) {
    log.error('Failed to materialize local rose_user_ui', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
