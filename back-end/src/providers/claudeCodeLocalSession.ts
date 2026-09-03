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
 */
import { type ChildProcess, spawn } from 'child_process';
import { createServer, Socket } from 'net';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { prisma } from './database';
import { createLogger } from './logger';
import { type FilePointer, downloadFromStorage, uploadToStorage } from './storage';
import { randomUUID } from './crypto';

const log = createLogger('ClaudeCodeLocal');

const LOCAL_SANDBOX_PREFIX = 'local-';

type LocalSession = {
  process: ChildProcess;
  workDir: string;
  port: number;
  sandboxId: string;
};

const localSessions = new Map<string, LocalSession>();

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

function findWsServerPath(): string {
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
  return await new Promise((resolve, reject) => {
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
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForLocalPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const sock = new Socket();
      const onDone = (ok: boolean) => {
        sock.removeAllListeners();
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(500);
      sock.once('connect', () => onDone(true));
      sock.once('timeout', () => onDone(false));
      sock.once('error', () => onDone(false));
      sock.connect(port, '127.0.0.1');
    });
    if (connected) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
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
  const workDir = join('/tmp', 'claude-code-local', taskId);
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

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...envs,
    PORT: String(port),
    CLAUDE_CODE_GOAL: goal,
    PATH: pathEnv,
    HOME: workDir,
    CLAUDE_CONFIG_DIR: join(workDir, '.claude'),
  };

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

  localSessions.set(taskId, { process: child, workDir, port, sandboxId });
  log.info(`Local Claude Code session ready: ${taskId} ws=${wsUrl}`);

  return { wsUrl, taskId, sandboxId, uploadedFiles };
}

export async function closeLocalClaudeCodeSession(
  taskId: string,
  userId?: string
): Promise<{ outputFiles: FilePointer[] }> {
  const session = localSessions.get(taskId);
  const outputFiles: FilePointer[] = [];

  if (session && userId) {
    const outputDir = join(session.workDir, 'output');
    try {
      if (existsSync(outputDir)) {
        for (const filename of readdirSync(outputDir)) {
          const fullPath = join(outputDir, filename);
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
      }
    } catch (err) {
      log.error('Failed to extract local Claude Code output files', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (session) {
    try {
      session.process.kill('SIGTERM');
    } catch {
      // already dead
    }
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
