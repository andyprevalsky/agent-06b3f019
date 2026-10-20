/**
 * local-code-runner — service layer (pure logic, no Electron or I/O)
 *
 *   folder grants ──► resolveSessionFolder ──► buildWsServerSpawn ──► ws-server.mjs (cwd = grant)
 *                                     └──────► buildTerminalAttachCommand ──► Terminal.app
 *
 * Grant enforcement resolves symlinks first, so a path that merely *looks*
 * inside a grant (`~/code/link -> /etc`) is refused.
 */
import path from 'path';
import {
  FORBIDDEN_GRANT_ROOTS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SESSION_ENV_ALLOWLIST,
  SESSION_ENV_FROM_BACKEND,
} from './config';
import type {
  ControlToDevice,
  ExecSpec,
  FolderGrant,
  LocalCodeProvider,
  SessionFailureCode,
  SpawnSpec,
  TunnelToDevice,
} from './types';

export class LocalFolderError extends Error {
  constructor(
    public readonly code: SessionFailureCode | 'invalid_folder',
    message: string
  ) {
    super(message);
    this.name = 'LocalFolderError';
  }
}

export interface FolderFs {
  /** Symlink-resolved absolute path; throws when it does not exist. */
  realpath: (p: string) => string;
  isDirectory: (p: string) => boolean;
}

/** True when `target` is `root` or strictly inside it (both already resolved). */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** "/Users/andy/Developer/rose" → "~/Developer/rose". */
export function displayFolder(folder: string, home: string): string {
  if (home !== '' && isInside(home, folder)) {
    const rest = path.relative(home, folder);
    return rest === '' ? '~' : `~/${rest}`;
  }
  return folder;
}

/** Add a grant (idempotent per resolved path). The first grant is the default. */
export function addGrant(
  grants: FolderGrant[],
  requested: string,
  fs: FolderFs,
  meta: { id: string; now: string; home: string }
): FolderGrant[] {
  if (!path.isAbsolute(requested)) {
    throw new LocalFolderError('invalid_folder', 'Choose an absolute folder path');
  }
  let resolved: string;
  try {
    resolved = fs.realpath(requested);
  } catch {
    throw new LocalFolderError('invalid_folder', 'That folder does not exist');
  }
  if (!fs.isDirectory(resolved)) {
    throw new LocalFolderError('invalid_folder', 'Choose a folder, not a file');
  }
  if (FORBIDDEN_GRANT_ROOTS.includes(resolved) || resolved === meta.home) {
    throw new LocalFolderError(
      'invalid_folder',
      'Choose a project folder, not a whole disk or home'
    );
  }
  if (grants.some((grant) => grant.path === resolved)) return grants;
  return [
    ...grants,
    {
      id: meta.id,
      path: resolved,
      label: displayFolder(resolved, meta.home),
      createdAt: meta.now,
      isDefault: grants.length === 0,
    },
  ];
}

export function removeGrant(grants: FolderGrant[], id: string): FolderGrant[] {
  const kept = grants.filter((grant) => grant.id !== id);
  if (kept.length > 0 && !kept.some((grant) => grant.isDefault)) {
    return kept.map((grant, index) => ({ ...grant, isDefault: index === 0 }));
  }
  return kept;
}

export function setDefaultGrant(grants: FolderGrant[], id: string): FolderGrant[] {
  if (!grants.some((grant) => grant.id === id)) return grants;
  return grants.map((grant) => ({ ...grant, isDefault: grant.id === id }));
}

/**
 * The folder a session may run in: the requested path when it resolves inside
 * a grant, otherwise the default grant. Never a path outside every grant.
 */
export function resolveSessionFolder(
  requested: string | null,
  grants: FolderGrant[],
  fs: FolderFs
): { folder: string; grant: FolderGrant } {
  if (grants.length === 0) {
    throw new LocalFolderError('no_folder_granted', 'No folder is shared with Rose on this Mac');
  }
  if (requested === null || requested === '') {
    const grant = grants.find((g) => g.isDefault) ?? grants[0];
    return { folder: fs.realpath(grant.path), grant };
  }
  let resolved: string;
  try {
    resolved = fs.realpath(requested);
  } catch {
    throw new LocalFolderError('folder_not_granted', 'The requested folder does not exist');
  }
  for (const grant of grants) {
    let root: string;
    try {
      root = fs.realpath(grant.path);
    } catch {
      continue;
    }
    if (isInside(root, resolved) && fs.isDirectory(resolved)) return { folder: resolved, grant };
  }
  throw new LocalFolderError('folder_not_granted', 'The requested folder is not shared with Rose');
}

/** Session env: allowlisted Mac env + the backend's goal/credential keys only. */
export function buildSessionEnv(
  hostEnv: Record<string, string | undefined>,
  backendEnvs: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SESSION_ENV_ALLOWLIST) {
    const value = hostEnv[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  for (const [key, value] of Object.entries(backendEnvs)) {
    if (SESSION_ENV_FROM_BACKEND.has(key)) env[key] = value;
  }
  return env;
}

/**
 * Spawn the template ws-server with the Mac app's own Node (Electron as Node),
 * working in the granted folder, with a private per-session HOME so the user's
 * own ~/.claude / ~/.codex are never touched.
 */
export function buildWsServerSpawn(params: {
  execPath: string;
  wsServerPath: string;
  provider: LocalCodeProvider;
  folder: string;
  sessionHome: string;
  port: number;
  readinessToken: string;
  shellPath: string;
  hostEnv: Record<string, string | undefined>;
  backendEnvs: Record<string, string>;
}): SpawnSpec {
  return {
    command: params.execPath,
    args: [params.wsServerPath],
    cwd: params.folder,
    env: {
      ...buildSessionEnv(params.hostEnv, params.backendEnvs),
      ELECTRON_RUN_AS_NODE: '1',
      PATH: params.shellPath,
      PORT: String(params.port),
      HOME: params.sessionHome,
      ...(params.provider === 'claude'
        ? { CLAUDE_CONFIG_DIR: path.join(params.sessionHome, '.claude') }
        : { CODEX_HOME: path.join(params.sessionHome, '.codex') }),
      // Same contract the templates use for a restored project: work in this
      // existing folder, never clone into it or overwrite its CLAUDE.md/AGENTS.md.
      ROSE_PROJECT_WORKDIR: params.folder,
      ROSE_LOCAL_WS_READINESS_TOKEN: params.readinessToken,
    },
  };
}

/** POSIX single-quote for a shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** AppleScript string literal. */
export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Open a real Terminal.app window attached to the session: it follows the
 * session's terminal log (the CLI's own stdout/stderr as the ws-server streams it).
 */
export function buildTerminalAttachCommand(params: { logPath: string; title: string }): ExecSpec {
  const shell = [
    `printf '\\033]0;%s\\007' ${shellQuote(params.title)}`,
    'clear',
    `exec tail -n +1 -F ${shellQuote(params.logPath)}`,
  ].join('; ');
  return {
    file: 'osascript',
    args: [
      '-e',
      `tell application "Terminal" to do script ${appleScriptString(shell)}`,
      '-e',
      'tell application "Terminal" to activate',
    ],
  };
}

/** Terminal text a ws-server frame contributes (stdout/stderr/buffer), else null. */
export function terminalTextFromFrame(raw: string): string | null {
  try {
    const message = JSON.parse(raw) as { type?: unknown; data?: unknown; code?: unknown };
    if (
      (message.type === 'stdout' || message.type === 'stderr' || message.type === 'buffer') &&
      typeof message.data === 'string'
    ) {
      return message.data;
    }
    if (message.type === 'exit') {
      return `\n[Rose] Session finished (exit ${String(message.code)})\n`;
    }
  } catch {
    // ws-server frames are JSON; anything else is not terminal output
  }
  return null;
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseControlMessage(raw: string): ControlToDevice | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.task_id !== 'string') return null;
  if (value.type === 'stop_session') return { type: 'stop_session', task_id: value.task_id };
  if (
    value.type === 'start_session' &&
    typeof value.agent_id === 'string' &&
    (value.provider === 'claude' || value.provider === 'codex') &&
    (value.folder === null || typeof value.folder === 'string') &&
    isRecord(value.envs) &&
    typeof value.relay_path === 'string' &&
    value.relay_path.startsWith('/api/local-code-relay/')
  ) {
    const envs: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.envs)) {
      if (typeof item === 'string') envs[key] = item;
    }
    return {
      type: 'start_session',
      task_id: value.task_id,
      agent_id: value.agent_id,
      provider: value.provider,
      folder: value.folder,
      envs,
      relay_path: value.relay_path,
    };
  }
  return null;
}

export function parseTunnelMessage(raw: string): TunnelToDevice | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.ch !== 'number' || !Number.isInteger(value.ch)) return null;
  if (value.op === 'open') return { op: 'open', ch: value.ch };
  if (value.op === 'close') return { op: 'close', ch: value.ch };
  if (value.op === 'data' && typeof value.data === 'string') {
    return { op: 'data', ch: value.ch, data: value.data };
  }
  return null;
}

/** ws(s) URL for a backend path. */
export function backendWsUrl(apiUrl: string, pathname: string): string {
  return `${apiUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')}${pathname}`;
}
