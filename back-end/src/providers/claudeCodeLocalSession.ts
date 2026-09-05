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
import { createServer, Socket } from 'net';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { prisma } from './database';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';
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
};

type LocalSession = LocalSessionOwnership & {
  process: ChildProcess | null;
};

const localSessions = new Map<string, LocalSession>();

function ownershipPath(workDir: string): string {
  return join(workDir, OWNERSHIP_FILE);
}

function writeOwnership(ownership: LocalSessionOwnership): void {
  mkdirSync(ownership.workDir, { recursive: true });
  writeFileSync(ownershipPath(ownership.workDir), JSON.stringify(ownership), 'utf8');
}

function readOwnership(taskId: string): LocalSessionOwnership | null {
  const workDir = join(LOCAL_ROOT, taskId);
  const path = ownershipPath(workDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LocalSessionOwnership>;
    if (
      typeof parsed.taskId !== 'string' ||
      typeof parsed.workDir !== 'string' ||
      typeof parsed.sandboxId !== 'string' ||
      typeof parsed.port !== 'number'
    ) {
      return null;
    }
    return {
      taskId: parsed.taskId,
      sandboxId: parsed.sandboxId,
      workDir: parsed.workDir,
      port: parsed.port,
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
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

/**
 * True when E2B sandbox create failed on control-plane abort/timeout after retries.
 * Same-host benches can fall back to a local Claude Code ws-server (cuda-kernel
 * k=3 r29: wedged keep-alive sockets hung until AbortSignal.timeout).
 */
export function isE2bSandboxCreateTimeoutError(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor !== null && cursor !== undefined; depth += 1) {
    if (cursor instanceof Error) {
      if (
        cursor.name === 'TimeoutError' ||
        cursor.name === 'AbortError' ||
        cursor.constructor?.name === 'DOMException'
      ) {
        return true;
      }
      const upper = cursor.message.toUpperCase();
      if (
        upper.includes('ABORTED DUE TO TIMEOUT') ||
        upper.includes('OPERATION WAS ABORTED') ||
        upper.includes('TIMEOUTERROR') ||
        upper.includes('REQUEST HANDSHAKE TIMED OUT')
      ) {
        return true;
      }
      cursor = (cursor as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
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
  if (!shouldAllowLocalClaudeCodeFallback()) {
    return null;
  }
  if (isE2bTeamBillingBlockError(err)) {
    log.warn(
      `E2B team billing blocked sandbox create; falling back to local Claude Code for agent ${params.agentId}`,
      { error: err instanceof Error ? err.message : String(err) }
    );
    return createLocalClaudeCodeSession(params);
  }
  if (isE2bSandboxCreateTimeoutError(err)) {
    log.warn(
      `E2B sandbox create timed out/aborted; falling back to local Claude Code for agent ${params.agentId}`,
      { error: err instanceof Error ? err.message : String(err) }
    );
    return createLocalClaudeCodeSession(params);
  }
  return null;
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

async function waitForLocalPort(port: number, timeoutMs: number): Promise<boolean> {
  const pollMs = 200;
  const maxRetries = Math.max(1, Math.ceil(timeoutMs / pollMs));
  const connected = await retryWithBackoff(
    () =>
      new Promise<boolean>((resolveReady) => {
        const sock = new Socket();
        const onDone = (ok: boolean) => {
          sock.removeAllListeners();
          sock.destroy();
          resolveReady(ok);
        };
        sock.setTimeout(500);
        sock.once('connect', () => onDone(true));
        sock.once('timeout', () => onDone(false));
        sock.once('error', () => onDone(false));
        sock.connect(port, '127.0.0.1');
      }),
    {
      maxRetries,
      fixedDelays: Array.from({ length: maxRetries }, () => pollMs),
      shouldRetryResult: (ready) => !ready,
      component: 'ClaudeCodeLocalPort',
    }
  );
  return connected;
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
  const workDir = join(LOCAL_ROOT, taskId);
  mkdirSync(join(workDir, 'attachments'), { recursive: true });
  mkdirSync(join(workDir, 'output'), { recursive: true });
  mkdirSync(join(workDir, '.claude'), { recursive: true });

  const uploadedFiles: string[] = [];
  if (params.attachments && params.attachments.length > 0) {
    for (const fp of params.attachments) {
      try {
        const content = await downloadFromStorage(fp.storage_path);
        const remotePath = join(workDir, 'attachments', fp.original_filename);
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
  const wsServerPath = findWsServerPath();
  const pathEnv = ['/home/ubuntu/.local/bin', process.env.PATH || ''].filter(Boolean).join(':');

  const childEnv = buildLocalChildEnv(envs, {
    PORT: String(port),
    CLAUDE_CODE_GOAL: goal,
    PATH: pathEnv,
    HOME: workDir,
    CLAUDE_CONFIG_DIR: join(workDir, '.claude'),
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
    localSessions.delete(taskId);
  });

  const ready = await waitForLocalPort(port, 20_000);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`Local Claude Code ws-server failed to listen on port ${port}`);
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

  writeOwnership(ownership);
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
  const outputFiles = ownership
    ? await extractLocalFiles(ownership.workDir, userId, additionalPaths)
    : [];

  if (ownership) {
    await killOwnedProcess({
      process: live?.process ?? null,
      pid: ownership.pid,
    });
    clearOwnership(ownership.workDir);
    localSessions.delete(taskId);
  }

  await prisma.claudeCodeSession.update({
    where: { id: taskId },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
    },
  });

  return { outputFiles };
}
