/**
 * Materialize a user's `rose_user_ui/` folder (+ the `rose-ui` CLI) into a
 * code-agent session home.
 *
 *   createClaudeCodeSession(userId)
 *     └─ prepareUserUiWorkspace(userId)
 *          active version files (storage) ─┐
 *          or seed (README + manifest +    ├─► files under ~/rose_user_ui/
 *          theme + examples)               ┘   README.md always regenerated
 *          rose-ui CLI ──────────────────────► ~/.rose/bin/rose-ui
 *          fresh publish token ──────────────► ROSE_UI_PUBLISH_URL / _TOKEN env
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
  USER_UI_CLI_NAME,
  USER_UI_CLI_SCRIPT,
  USER_UI_DIR_NAME,
  USER_UI_README,
  userUiSeedFiles,
} from './seed';
import { findActiveUserUiVersion, readUserUiVersionFiles } from './store';

const log = createLogger('UserUiWorkspace');

export const USER_UI_CLI_BIN_DIR = '.rose/bin';

export interface UserUiWorkspace {
  /** Files relative to the session HOME (rose_user_ui/... and .rose/bin/rose-ui). */
  files: UserUiBundleFile[];
  /** Env injected into the session so `rose-ui publish` can reach the backend. */
  envs: Record<string, string>;
  source: { kind: 'active'; versionId: string } | { kind: 'seed' };
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

export async function prepareUserUiWorkspace(userId: string): Promise<UserUiWorkspace> {
  const active = await findActiveUserUiVersion(userId);
  const bundle = active ? await readUserUiVersionFiles(userId, active.id) : userUiSeedFiles();
  const withReadme = [
    ...bundle.filter((file) => file.path !== 'README.md'),
    { path: 'README.md', content: Buffer.from(USER_UI_README, 'utf8') },
  ];
  const { token } = mintUserUiPublishToken(userId);
  return {
    files: [
      ...withReadme.map((file) => ({
        path: `${USER_UI_DIR_NAME}/${file.path}`,
        content: file.content,
      })),
      {
        path: `${USER_UI_CLI_BIN_DIR}/${USER_UI_CLI_NAME}`,
        content: Buffer.from(USER_UI_CLI_SCRIPT, 'utf8'),
      },
    ],
    envs: {
      ROSE_UI_PUBLISH_URL: `${userUiPublishBaseUrl()}/api/user-ui/versions`,
      ROSE_UI_PUBLISH_TOKEN: token,
    },
    source: active ? { kind: 'active', versionId: active.id } : { kind: 'seed' },
  };
}

/** Best-effort wrapper: a UI-folder failure must never block a code session. */
export async function prepareUserUiWorkspaceSafe(
  userId: string | undefined
): Promise<UserUiWorkspace | null> {
  if (!userId) return null;
  try {
    const workspace = await prepareUserUiWorkspace(userId);
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
  for (const file of binFiles(workspace)) await chmod(join(root, file), 0o755);
}

/** Every CLI under ~/.rose/bin (rose-ui plus any added by other features, e.g. rose-display). */
function binFiles(workspace: UserUiWorkspace): string[] {
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
  const bins = binFiles(workspace).map((path) => `${home}/${path}`);
  if (bins.length === 0) return;
  await sandbox.commands.run(`chmod 755 ${bins.join(' ')}`, { timeoutMs: 10_000 });
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

/** Same-host session: keep the display path, swap the public origin for loopback. */
function localDisplayUrl(publicUrl: string): string {
  const { pathname } = new URL(publicUrl);
  return `http://127.0.0.1:${process.env.PORT || 3001}${pathname}`;
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
    return {
      binDir: join(homeDir, USER_UI_CLI_BIN_DIR),
      envs: {
        ROSE_UI_PUBLISH_URL: `http://127.0.0.1:${process.env.PORT || 3001}/api/user-ui/versions`,
        ...(workspace.envs.ROSE_DISPLAY_URL
          ? { ROSE_DISPLAY_URL: localDisplayUrl(workspace.envs.ROSE_DISPLAY_URL) }
          : {}),
      },
    };
  } catch (err) {
    log.error('Failed to materialize local rose_user_ui', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
