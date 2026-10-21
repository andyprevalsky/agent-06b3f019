/**
 * Local Claude Code session fallback when E2B team billing blocks sandbox create.
 *
 * E2B returns `403: team is blocked: missing payment method` for mutating
 * sandbox APIs while reads still work. Soft-fail alone cannot pass the
 * cuda-kernel code-agent quality judge (needs a real coding-agent fetch).
 * Spin the same ws-server.mjs used in the E2B template on localhost so the
 * Temporal worker can connect via ws://127.0.0.1:<port>.
 *
 * Scope: same-host workers only (local / cloud-agent benches). Production
 * Fly workers still need a funded E2B team — this path is gated on the E2B
 * billing error and disabled when FLY_APP_NAME is set.
 *
 * Ownership (workDir + pid + port) is persisted to
 * `/tmp/claude-code-local/<taskId>/session.json` so close can still extract
 * outputs and terminate a surviving server after a backend restart.
 */
import { type ChildProcess, spawn } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join, relative, resolve, sep } from 'path';
import { prisma } from './database';
import { createLogger } from './logger';
import { MAX_FILE_SIZE, type FilePointer, downloadFromStorage, uploadToStorage } from './storage';
import { randomUUID } from './crypto';
import { isMissingLocalFileError, readRegularFileNoFollow } from './claudeCodeLocalFileRead';
import { isFilePointer } from './claudeCodeLocalOwnership';
import { allocatePort, waitForChildReadiness } from './claudeCodeLocalProcess';
import { isSandboxCreateTimeoutOrAbortError } from './e2bSandboxCreate';
import { materializeUserUiInLocalHome, type UserUiWorkspace } from './userUi/workspace';
import { localCodeSessionRoot } from './codeSessions/lifecycle';
import { stopLocalCodePreview } from './codePreview/sandbox';
import type { ProjectRestoreReport, ProjectWorkspace } from './projects/types';
import { restoreLocalProject, unregisterWorkspaceExecutor } from './projects/workspace';

const log = createLogger('ClaudeCodeLocal');

const LOCAL_SANDBOX_PREFIX = 'local-';
const LOCAL_ROOT = '/tmp/claude-code-local';
const OWNERSHIP_FILE = 'session.json';

/** Runtime / proxy keys safe to inherit; never copy DATABASE_URL etc. */
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

type LocalSessionOwnership = {
  taskId: string;
  sandboxId: string;
  workDir: string;
  port: number;
  pid: number | null;
  /**
   * Session HOME when it outlives the task (persistent code session); outputs
   * are read from here. Absent for legacy sessions, whose HOME is workDir.
   */
  homeDir?: string;
  /** Durable per-file upload progress; objectId makes retries storage-idempotent. */
  outputCandidates?: LocalOutputCandidate[];
  /** Persisted before the DB close so retries never upload the same files twice. */
  outputFiles?: FilePointer[];
};

type LocalOutputCandidate = {
  relativePath: string;
  filename: string;
  objectId: string;
  pointer?: FilePointer;
  missing?: true;
};

type LocalSession = LocalSessionOwnership & {
  process: ChildProcess | null;
};

const localSessions = new Map<string, LocalSession>();
const closeOperations = new Map<string, Promise<{ outputFiles: FilePointer[] }>>();

export function resolveLocalSessionWorkDir(taskId: string): string {
  if (
    taskId.length === 0 ||
    taskId === '.' ||
    taskId === '..' ||
    taskId.includes('/') ||
    taskId.includes('\\')
  ) {
    throw new Error(`Invalid local Claude Code task id: ${JSON.stringify(taskId)}`);
  }
  return join(LOCAL_ROOT, taskId);
}

function ownershipPath(workDir: string): string {
  return join(workDir, OWNERSHIP_FILE);
}

function writeOwnership(ownership: LocalSessionOwnership): void {
  mkdirSync(ownership.workDir, { recursive: true });
  const path = ownershipPath(ownership.workDir);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const durable: LocalSessionOwnership = {
      taskId: ownership.taskId,
      sandboxId: ownership.sandboxId,
      workDir: ownership.workDir,
      port: ownership.port,
      pid: ownership.pid,
      homeDir: ownership.homeDir,
      outputCandidates: ownership.outputCandidates,
      outputFiles: ownership.outputFiles,
    };
    writeFileSync(temporaryPath, JSON.stringify(durable), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // best-effort cleanup; preserve the ownership persistence error
    }
    throw error;
  }
}

function isOutputCandidate(value: unknown, workDir: string): value is LocalOutputCandidate {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LocalOutputCandidate>;
  if (
    typeof candidate.relativePath !== 'string' ||
    candidate.relativePath === '' ||
    typeof candidate.filename !== 'string' ||
    candidate.filename === '' ||
    typeof candidate.objectId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(candidate.objectId)
  ) {
    return false;
  }
  if (!isPathInsideWorkDir(workDir, resolve(workDir, candidate.relativePath))) return false;
  if (candidate.missing !== undefined && candidate.missing !== true) return false;
  return candidate.pointer === undefined || isFilePointer(candidate.pointer);
}

function readOwnership(taskId: string): LocalSessionOwnership | null {
  const workDir = resolveLocalSessionWorkDir(taskId);
  const path = ownershipPath(workDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LocalSessionOwnership>;
    if (
      typeof parsed.taskId !== 'string' ||
      typeof parsed.workDir !== 'string' ||
      typeof parsed.sandboxId !== 'string' ||
      typeof parsed.port !== 'number' ||
      parsed.taskId !== taskId ||
      parsed.sandboxId !== `${LOCAL_SANDBOX_PREFIX}${taskId}` ||
      resolve(parsed.workDir) !== resolve(workDir)
    ) {
      return null;
    }
    const homeDir =
      typeof parsed.homeDir === 'string' && isPersistentLocalHome(parsed.homeDir)
        ? parsed.homeDir
        : undefined;
    if (parsed.homeDir !== undefined && homeDir === undefined) return null;
    const home = homeDir ?? workDir;
    return {
      taskId: parsed.taskId,
      sandboxId: parsed.sandboxId,
      workDir: parsed.workDir,
      port: parsed.port,
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      homeDir,
      outputCandidates:
        Array.isArray(parsed.outputCandidates) &&
        parsed.outputCandidates.every((candidate) => isOutputCandidate(candidate, home))
          ? parsed.outputCandidates
          : undefined,
      outputFiles:
        Array.isArray(parsed.outputFiles) && parsed.outputFiles.every(isFilePointer)
          ? parsed.outputFiles
          : undefined,
    };
  } catch {
    return null;
  }
}

function clearOwnership(workDir: string): void {
  try {
    rmSync(ownershipPath(workDir), { force: true });
  } catch {
    // best-effort
  }
}

function buildLocalChildEnv(
  envs: Record<string, string>,
  extras: Record<string, string>
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  // Explicit opt-in only — never inherit the full backend env by default.
  if (process.env.CLAUDE_CODE_LOCAL_INHERIT_ENV === '1') {
    Object.assign(childEnv, process.env);
  } else {
    for (const key of CHILD_ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined && value !== '') childEnv[key] = value;
    }
  }
  Object.assign(childEnv, envs, extras);
  return childEnv;
}

/** Persistent code-session HOMEs live under one owned root. */
function isPersistentLocalHome(path: string): boolean {
  const root = localCodeSessionRoot();
  return resolve(path).startsWith(`${root}${sep}`);
}

function isPathInsideWorkDir(workDir: string, candidate: string): boolean {
  const root = resolve(workDir);
  const target = resolve(candidate);
  return target === root || target.startsWith(`${root}/`);
}

async function killOwnedProcess(session: {
  process: ChildProcess | null;
  pid: number | null;
}): Promise<void> {
  if (session.process) {
    try {
      session.process.kill('SIGTERM');
    } catch {
      // already dead
    }
    return;
  }
  if (session.pid !== null && session.pid > 0) {
    try {
      process.kill(session.pid, 'SIGTERM');
    } catch {
      // already dead
    }
  }
}

export function isLocalClaudeCodeSandboxId(sandboxId: string | null | undefined): boolean {
  return typeof sandboxId === 'string' && sandboxId.startsWith(LOCAL_SANDBOX_PREFIX);
}

export function isE2bTeamBillingBlockError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const upper = text.toUpperCase();
  return (
    upper.includes('TEAM IS BLOCKED') ||
    upper.includes('MISSING PAYMENT METHOD') ||
    (upper.includes('403') && upper.includes('PAYMENT METHOD'))
  );
}

export function shouldAllowLocalClaudeCodeFallback(): boolean {
  if (process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK === '0') return false;
  if (process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK === '1') return true;
  // Same-host benches (local / Cursor cloud). Fly multi-machine workers cannot
  // reach a backend-local ws://127.0.0.1 listener.
  return !process.env.FLY_APP_NAME;
}

/** Local fallback applies only to E2B billing blocks and create timeouts. */
export function isLocalClaudeCodeFallbackEligible(err: unknown): boolean {
  if (!shouldAllowLocalClaudeCodeFallback()) return false;
  return isE2bTeamBillingBlockError(err) || isSandboxCreateTimeoutOrAbortError(err);
}

export async function createLocalClaudeCodeSessionIfBillingBlocked(
  err: unknown,
  params: Parameters<typeof createLocalClaudeCodeSession>[0]
): Promise<Awaited<ReturnType<typeof createLocalClaudeCodeSession>> | null> {
  if (!isLocalClaudeCodeFallbackEligible(err)) return null;
  const billing = isE2bTeamBillingBlockError(err);
  log.warn(
    billing
      ? `E2B team billing blocked sandbox create; falling back to local Claude Code for agent ${params.agentId}`
      : `E2B sandbox create timed out/aborted; falling back to local Claude Code for agent ${params.agentId}`,
    { error: err instanceof Error ? err.message : String(err) }
  );
  return createLocalClaudeCodeSession(params);
}

function findWsServerPath(): string {
  // Test seam: unit tests point this at a tiny TCP listener instead of the full
  // E2B-template ws-server.mjs (which pulls Claude Code deps we do not want in
  // the coverage process).
  const override = process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH?.trim();
  if (override && existsSync(override)) return override;

  const candidates = [
    join(process.cwd(), '..', 'e2b-templates', 'claude-code', 'ws-server.mjs'),
    join(process.cwd(), 'e2b-templates', 'claude-code', 'ws-server.mjs'),
    join('/workspace', 'e2b-templates', 'claude-code', 'ws-server.mjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`Claude Code ws-server.mjs not found (tried ${candidates.join(', ')})`);
}

export function resolveLocalAttachmentPath(workDir: string, filename: string): string {
  const attachmentDir = resolve(workDir, 'attachments');
  const target = resolve(attachmentDir, filename);
  if (target === attachmentDir || !target.startsWith(`${attachmentDir}${sep}`)) {
    throw new Error(`Attachment filename escapes the session directory: ${filename}`);
  }
  return target;
}

async function extractLocalFiles(
  ownership: LocalSessionOwnership,
  userId: string | undefined,
  additionalPaths?: string[]
): Promise<FilePointer[]> {
  if (!userId) return [];

  // Persistent sessions keep outputs in their long-lived HOME.
  const workDir = ownership.homeDir ?? ownership.workDir;
  const byFilename = new Map(
    (ownership.outputCandidates ?? []).map((candidate) => [candidate.filename, candidate])
  );
  const discovered: Array<{ fullPath: string; filename: string }> = [];

  const outputDir = join(workDir, 'output');
  if (existsSync(outputDir)) {
    for (const filename of readdirSync(outputDir)) {
      discovered.push({ fullPath: join(outputDir, filename), filename });
    }
  }

  if (additionalPaths && additionalPaths.length > 0) {
    for (const filePath of additionalPaths) {
      const resolved = resolve(workDir, filePath);
      if (!isPathInsideWorkDir(workDir, resolved)) {
        log.warn('Skipping additionalPath outside local session workDir', { filePath });
        continue;
      }
      const filename = resolved.split('/').pop() || '';
      if (!filename) continue;
      discovered.push({ fullPath: resolved, filename });
    }
  }

  for (const { fullPath, filename } of discovered) {
    if (byFilename.has(filename) || !existsSync(fullPath)) continue;
    byFilename.set(filename, {
      relativePath: relative(workDir, fullPath),
      filename,
      objectId: randomUUID(),
    });
  }
  ownership.outputCandidates = [...byFilename.values()];
  // Persist every storage object key before its first upload. A crash after the
  // provider commits can then retry the exact same key instead of duplicating it.
  writeOwnership(ownership);

  for (const candidate of ownership.outputCandidates) {
    if (candidate.pointer || candidate.missing) continue;
    const fullPath = resolve(workDir, candidate.relativePath);
    if (!isPathInsideWorkDir(workDir, fullPath)) {
      throw new Error(
        `Local output candidate escaped its session directory: ${candidate.filename}`
      );
    }
    try {
      // Open with O_NOFOLLOW, then validate and read the same descriptor. Path
      // checks followed by stat/read can otherwise be swapped to a symlink.
      const content = readRegularFileNoFollow(fullPath, workDir, MAX_FILE_SIZE);
      const { storage_path } = await uploadToStorage(
        userId,
        content,
        candidate.filename,
        'application/octet-stream',
        { objectId: candidate.objectId }
      );
      candidate.pointer = {
        id: candidate.objectId,
        storage_path,
        original_filename: candidate.filename,
        mime_type: 'application/octet-stream',
        size_bytes: content.length,
        created_at: new Date().toISOString(),
      };
      // Checkpoint each successful file independently. A later failure must
      // leave earlier pointers reusable while outputFiles remains incomplete.
      writeOwnership(ownership);
    } catch (fileErr) {
      if (isMissingLocalFileError(fileErr)) {
        log.warn('Local output candidate disappeared before upload', {
          filename: candidate.filename,
        });
        candidate.missing = true;
        writeOwnership(ownership);
        continue;
      }
      log.error(`Failed to extract local output file ${candidate.filename}`, {
        error: fileErr instanceof Error ? fileErr.message : String(fileErr),
      });
      throw fileErr;
    }
  }

  return ownership.outputCandidates.flatMap((candidate) => {
    if (candidate.pointer) return [candidate.pointer];
    if (candidate.missing) return [];
    throw new Error(`Local output file was not uploaded: ${candidate.filename}`);
  });
}

export async function createLocalClaudeCodeSession(params: {
  taskId: string;
  /**
   * Persistent code-session HOME (survives close; resume reuses it). Defaults
   * to the per-task directory, which is the legacy ephemeral behavior.
   */
  homeDir?: string;
  agentId: string;
  goal: string;
  envs: Record<string, string>;
  attachments?: FilePointer[];
  /** Session HOME files (CLIs, tools config, Rose skills) to materialize under the session HOME. */
  userUiWorkspace?: UserUiWorkspace | null;
  /** Project checkout + env files restored into `<HOME>/workspace` before the CLI starts. */
  projectWorkspace?: ProjectWorkspace | null;
  claudeTokenSource: string | null;
  claudeTokenIntegrationId: string | null;
}): Promise<{
  wsUrl: string;
  taskId: string;
  sandboxId: string;
  uploadedFiles: string[];
  projectRestore?: ProjectRestoreReport | null;
}> {
  const { taskId, agentId, goal, envs } = params;
  const sandboxId = `${LOCAL_SANDBOX_PREFIX}${taskId}`;
  const taskDir = resolveLocalSessionWorkDir(taskId);
  if (params.homeDir !== undefined && !isPersistentLocalHome(params.homeDir)) {
    throw new Error(`Local code-session HOME outside its root: ${params.homeDir}`);
  }
  const persistentHome = params.homeDir !== undefined;
  const workDir = params.homeDir ?? taskDir;
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(join(workDir, 'attachments'), { recursive: true });
  mkdirSync(join(workDir, 'output'), { recursive: true });
  mkdirSync(join(workDir, '.claude'), { recursive: true });

  const uploadedFiles: string[] = [];
  if (params.attachments && params.attachments.length > 0) {
    for (const fp of params.attachments) {
      try {
        const content = await downloadFromStorage(fp.storage_path);
        const remotePath = resolveLocalAttachmentPath(workDir, fp.original_filename);
        writeFileSync(remotePath, content);
        uploadedFiles.push(remotePath);
      } catch (err) {
        log.error(`Failed to stage attachment ${fp.original_filename}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const userUi = await materializeUserUiInLocalHome(workDir, params.userUiWorkspace, agentId);
  const project = await restoreLocalProject(
    taskId,
    workDir,
    buildLocalChildEnv(envs, {}),
    params.projectWorkspace
  );

  const port = await allocatePort();
  const readinessToken = randomUUID();
  const wsServerPath = findWsServerPath();
  const pathEnv = [userUi?.binDir, '/home/ubuntu/.local/bin', process.env.PATH || '']
    .filter(Boolean)
    .join(':');

  const childEnv = buildLocalChildEnv(envs, {
    PORT: String(port),
    CLAUDE_CODE_GOAL: goal,
    PATH: pathEnv,
    HOME: workDir,
    CLAUDE_CONFIG_DIR: join(workDir, '.claude'),
    ROSE_LOCAL_WS_READINESS_TOKEN: readinessToken,
    ...userUi?.envs,
    ...project.envs,
  });

  log.info(
    `Starting local Claude Code ws-server for agent ${agentId} on port ${port} (E2B billing fallback)`
  );

  const child = spawn(process.execPath, [wsServerPath], {
    cwd: workDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  child.stdout?.on('data', (buf: Buffer) => {
    log.info(`[local-ws ${sandboxId}] ${buf.toString('utf8').trim()}`);
  });
  child.stderr?.on('data', (buf: Buffer) => {
    log.warn(`[local-ws ${sandboxId}] ${buf.toString('utf8').trim()}`);
  });
  child.on('exit', (code, signal) => {
    log.info('Local Claude Code ws-server exited', { sandboxId, code, signal });
  });

  const ready = await waitForChildReadiness(child, port, readinessToken, 20_000);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`Local Claude Code ws-server did not prove readiness on port ${port}`);
  }

  const wsUrl = `ws://127.0.0.1:${port}`;
  const ownership: LocalSessionOwnership = {
    taskId,
    sandboxId,
    workDir: taskDir,
    port,
    pid: child.pid ?? null,
    ...(persistentHome ? { homeDir: workDir } : {}),
  };

  try {
    await prisma.claudeCodeSession.create({
      data: {
        id: taskId,
        agentId,
        sandboxId,
        streamUrl: wsUrl,
        goal,
        status: 'ACTIVE',
        claudeTokenSource: params.claudeTokenSource ?? 'local_fallback',
        claudeTokenIntegrationId: params.claudeTokenIntegrationId,
        projectId: params.projectWorkspace?.project.id ?? null,
        // The local fallback runs the Claude Code ws-server only.
        codeProvider: 'claude',
      },
    });
  } catch (persistErr) {
    // Child is already listening; kill it so a failed DB write cannot leak a
    // process that no close path can reach.
    try {
      child.kill('SIGKILL');
    } catch {
      // already dead
    }
    try {
      // A persistent HOME holds earlier sessions' work; only the task dir goes.
      rmSync(taskDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw persistErr;
  }

  try {
    writeOwnership(ownership);
  } catch (ownershipError) {
    await killOwnedProcess({ process: child, pid: ownership.pid });
    try {
      await prisma.claudeCodeSession.update({
        where: { id: taskId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
    } catch (closeError) {
      try {
        await prisma.claudeCodeSession.delete({ where: { id: taskId } });
      } catch (deleteError) {
        throw new AggregateError(
          [ownershipError, closeError, deleteError],
          `Failed to persist or roll back local Claude Code session ${taskId}`
        );
      }
    }
    clearOwnership(taskDir);
    try {
      rmSync(taskDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Rollback cleanup is best-effort. Never mask the ownership persistence
      // failure that made this session unusable in the first place.
      log.warn('Failed to clean local Claude Code workDir during ownership rollback', {
        taskId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw ownershipError;
  }
  localSessions.set(taskId, { ...ownership, process: child });
  log.info(`Local Claude Code session ready: ${taskId} ws=${wsUrl}`);

  return { wsUrl, taskId, sandboxId, uploadedFiles, projectRestore: project.report };
}

async function runLocalClaudeCodeClose(
  taskId: string,
  userId?: string,
  additionalPaths?: string[]
): Promise<{ outputFiles: FilePointer[] }> {
  const live = localSessions.get(taskId);
  const ownership = live ?? readOwnership(taskId);
  let outputFiles = ownership?.outputFiles ?? [];

  if (ownership && ownership.outputFiles === undefined && userId) {
    outputFiles = await extractLocalFiles(ownership, userId, additionalPaths);
    ownership.outputFiles = outputFiles;
    // Upload results are part of close ownership state. Persist them before
    // stopping the process or updating the DB so every retry is side-effect free.
    writeOwnership(ownership);
  }

  if (ownership) {
    await killOwnedProcess({
      process: live?.process ?? null,
      pid: ownership.pid,
    });
    // A dev session's `rose-preview` dev server (A1) dies with the session.
    stopLocalCodePreview(ownership.homeDir ?? ownership.workDir);
  }

  await prisma.claudeCodeSession.update({
    where: { id: taskId },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
    },
  });

  unregisterWorkspaceExecutor(taskId);
  if (ownership?.outputFiles !== undefined) {
    clearOwnership(ownership.workDir);
    localSessions.delete(taskId);
  } else if (ownership) {
    // A close without identity still stops the owned process and closes the DB
    // session, but retains candidate metadata and files for a later authorized
    // extraction retry.
    localSessions.set(taskId, { ...ownership, process: null });
  }

  return { outputFiles };
}

export function closeLocalClaudeCodeSession(
  taskId: string,
  userId?: string,
  additionalPaths?: string[]
): Promise<{ outputFiles: FilePointer[] }> {
  const inFlight = closeOperations.get(taskId);
  if (inFlight) return inFlight;

  const operation = runLocalClaudeCodeClose(taskId, userId, additionalPaths);
  closeOperations.set(taskId, operation);
  void operation.then(
    () => {
      if (closeOperations.get(taskId) === operation) closeOperations.delete(taskId);
    },
    () => {
      if (closeOperations.get(taskId) === operation) closeOperations.delete(taskId);
    }
  );
  return operation;
}
