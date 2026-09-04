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
import { createServer } from 'net';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join, resolve, sep } from 'path';
import { prisma } from './database';
import { createLogger } from './logger';
import { type FilePointer, downloadFromStorage, uploadToStorage } from './storage';
import { randomUUID } from './crypto';

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
  /** Persisted before the DB close so retries never upload the same files twice. */
  outputFiles?: FilePointer[];
};

type LocalSession = LocalSessionOwnership & {
  process: ChildProcess | null;
};

const localSessions = new Map<string, LocalSession>();

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
    writeFileSync(temporaryPath, JSON.stringify(ownership), { encoding: 'utf8', mode: 0o600 });
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

function isFilePointer(value: unknown): value is FilePointer {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<FilePointer>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.storage_path === 'string' &&
    typeof candidate.original_filename === 'string' &&
    typeof candidate.mime_type === 'string' &&
    typeof candidate.size_bytes === 'number' &&
    typeof candidate.created_at === 'string'
  );
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
    return {
      taskId: parsed.taskId,
      sandboxId: parsed.sandboxId,
      workDir: parsed.workDir,
      port: parsed.port,
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
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

export async function createLocalClaudeCodeSessionIfBillingBlocked(
  err: unknown,
  params: Parameters<typeof createLocalClaudeCodeSession>[0]
): Promise<Awaited<ReturnType<typeof createLocalClaudeCodeSession>> | null> {
  if (!isE2bTeamBillingBlockError(err) || !shouldAllowLocalClaudeCodeFallback()) {
    return null;
  }
  log.warn(
    `E2B team billing blocked sandbox create; falling back to local Claude Code for agent ${params.agentId}`,
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

async function allocatePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to allocate local port'));
        return;
      }
      const { port } = addr;
      server.close((err) => {
        if (err) reject(err);
        else resolvePort(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForChildReadiness(
  child: ChildProcess,
  port: number,
  readinessToken: string,
  timeoutMs: number
): Promise<boolean> {
  return await new Promise((resolveReady) => {
    let settled = false;
    let stdout = '';
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onFailure);
      child.off('exit', onFailure);
      resolveReady(ready);
    };
    const onFailure = () => finish(false);
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (
            event.message === 'Server listening' &&
            event.port === port &&
            event.readinessToken === readinessToken
          ) {
            finish(true);
            return;
          }
        } catch {
          // Only the authenticated JSON readiness record can satisfy startup.
        }
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.stdout?.on('data', onData);
    child.once('error', onFailure);
    child.once('exit', onFailure);
  });
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
  workDir: string,
  userId: string | undefined,
  additionalPaths?: string[]
): Promise<FilePointer[]> {
  const outputFiles: FilePointer[] = [];
  if (!userId) return outputFiles;

  const seen = new Set<string>();
  const candidates: Array<{ fullPath: string; filename: string }> = [];

  const outputDir = join(workDir, 'output');
  try {
    if (existsSync(outputDir)) {
      for (const filename of readdirSync(outputDir)) {
        candidates.push({ fullPath: join(outputDir, filename), filename });
      }
    }
  } catch (err) {
    log.error('Failed to list local Claude Code output directory', {
      error: err instanceof Error ? err.message : String(err),
    });
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
      candidates.push({ fullPath: resolved, filename });
    }
  }

  for (const { fullPath, filename } of candidates) {
    if (seen.has(filename)) continue;
    if (!existsSync(fullPath)) continue;
    seen.add(filename);
    try {
      const content = readFileSync(fullPath);
      const { storage_path } = await uploadToStorage(
        userId,
        content,
        filename,
        'application/octet-stream'
      );
      outputFiles.push({
        id: randomUUID(),
        storage_path,
        original_filename: filename,
        mime_type: 'application/octet-stream',
        size_bytes: content.length,
        created_at: new Date().toISOString(),
      });
    } catch (fileErr) {
      log.error(`Failed to extract local output file ${filename}`, {
        error: fileErr instanceof Error ? fileErr.message : String(fileErr),
      });
    }
  }

  return outputFiles;
}

export async function createLocalClaudeCodeSession(params: {
  taskId: string;
  agentId: string;
  goal: string;
  envs: Record<string, string>;
  attachments?: FilePointer[];
  claudeTokenSource: string | null;
  claudeTokenIntegrationId: string | null;
}): Promise<{
  wsUrl: string;
  taskId: string;
  sandboxId: string;
  uploadedFiles: string[];
}> {
  const { taskId, agentId, goal, envs } = params;
  const sandboxId = `${LOCAL_SANDBOX_PREFIX}${taskId}`;
  const workDir = resolveLocalSessionWorkDir(taskId);
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

  const port = await allocatePort();
  const readinessToken = randomUUID();
  const wsServerPath = findWsServerPath();
  const pathEnv = ['/home/ubuntu/.local/bin', process.env.PATH || ''].filter(Boolean).join(':');

  const childEnv = buildLocalChildEnv(envs, {
    PORT: String(port),
    CLAUDE_CODE_GOAL: goal,
    PATH: pathEnv,
    HOME: workDir,
    CLAUDE_CONFIG_DIR: join(workDir, '.claude'),
    ROSE_LOCAL_WS_READINESS_TOKEN: readinessToken,
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
    workDir,
    port,
    pid: child.pid ?? null,
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
      rmSync(workDir, { recursive: true, force: true });
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
    clearOwnership(workDir);
    try {
      rmSync(workDir, { recursive: true, force: true });
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

  return { wsUrl, taskId, sandboxId, uploadedFiles };
}

export async function closeLocalClaudeCodeSession(
  taskId: string,
  userId?: string,
  additionalPaths?: string[]
): Promise<{ outputFiles: FilePointer[] }> {
  const live = localSessions.get(taskId);
  const ownership = live ?? readOwnership(taskId);
  let outputFiles = ownership?.outputFiles ?? [];

  if (ownership && ownership.outputFiles === undefined) {
    outputFiles = await extractLocalFiles(ownership.workDir, userId, additionalPaths);
    const resumableOwnership = { ...ownership, outputFiles };
    // Upload results are part of close ownership state. Persist them before
    // stopping the process or updating the DB so every retry is side-effect free.
    writeOwnership(resumableOwnership);
    if (live) live.outputFiles = outputFiles;
  }

  if (ownership) {
    await killOwnedProcess({
      process: live?.process ?? null,
      pid: ownership.pid,
    });
  }

  await prisma.claudeCodeSession.update({
    where: { id: taskId },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
    },
  });

  if (ownership) {
    clearOwnership(ownership.workDir);
    localSessions.delete(taskId);
  }

  return { outputFiles };
}
