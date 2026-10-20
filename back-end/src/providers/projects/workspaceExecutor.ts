/**
 * Where a project workspace is materialized: a session-scoped executor that
 * can run shell commands and write files with explicit modes. The local
 * Claude Code fallback (`claudeCodeLocalSession.ts`) and E2B sandboxes each
 * provide one; W5's persistent sessions register theirs the same way.
 */
import { spawn } from 'child_process';
import { chmod, lstat, mkdir, realpath, writeFile } from 'fs/promises';
import { dirname, resolve, sep } from 'path';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface WorkspaceExecutor {
  kind: 'local' | 'e2b';
  /** Session HOME; the repo lives in `<homeDir>/workspace`. */
  homeDir: string;
  run(
    command: string,
    opts: { cwd?: string; timeoutMs: number; env?: Record<string, string> }
  ): Promise<ExecResult>;
  /**
   * Write `content` at `root/rel` with `mode`, creating parents. Refuses any
   * destination whose resolved parent escapes `root` (symlinked directories).
   */
  writeFileInside(root: string, rel: string, content: Buffer, mode: number): Promise<string>;
}

/** POSIX single-quote escaping for one shell word. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const executors = new Map<string, WorkspaceExecutor>();

export function registerWorkspaceExecutor(sessionId: string, executor: WorkspaceExecutor): void {
  executors.set(sessionId, executor);
}

export function unregisterWorkspaceExecutor(sessionId: string): void {
  executors.delete(sessionId);
}

export function workspaceExecutorFor(sessionId: string): WorkspaceExecutor | null {
  return executors.get(sessionId) ?? null;
}

const MAX_CAPTURE = 256 * 1024;

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

async function nearestExistingRealpath(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** Executor over a local directory (same host as the backend). */
export function localWorkspaceExecutor(
  homeDir: string,
  baseEnv: NodeJS.ProcessEnv = {}
): WorkspaceExecutor {
  return {
    kind: 'local',
    homeDir,
    run(command, opts) {
      return new Promise((resolveRun) => {
        const child = spawn('bash', ['-c', command], {
          cwd: opts.cwd ?? homeDir,
          env: { ...baseEnv, HOME: homeDir, ...opts.env },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.on('data', (b: Buffer) => {
          if (stdout.length < MAX_CAPTURE) stdout += b.toString('utf8');
        });
        child.stderr.on('data', (b: Buffer) => {
          if (stderr.length < MAX_CAPTURE) stderr += b.toString('utf8');
        });
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, opts.timeoutMs);
        child.on('error', (err) => {
          clearTimeout(timer);
          resolveRun({ exitCode: 127, stdout, stderr: stderr + err.message, timedOut });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolveRun({ exitCode: code ?? 1, stdout, stderr, timedOut });
        });
      });
    },
    async writeFileInside(root, rel, content, mode) {
      const rootReal = await nearestExistingRealpath(resolve(root));
      const target = resolve(rootReal, rel);
      if (!isInside(rootReal, target)) throw new Error(`refusing to write outside ${root}`);
      await mkdir(dirname(target), { recursive: true });
      const parentReal = await realpath(dirname(target));
      if (!isInside(rootReal, parentReal)) {
        throw new Error(`refusing to write through a symlinked directory: ${rel}`);
      }
      const existing = await lstat(target).catch(() => null);
      if (existing?.isSymbolicLink() === true || existing?.isDirectory() === true) {
        throw new Error(`refusing to overwrite a non-file destination: ${rel}`);
      }
      await writeFile(target, content, { mode });
      await chmod(target, mode);
      return target;
    },
  };
}

/** Minimal E2B sandbox surface the executor needs. */
export interface E2bSandboxLike {
  files: { write(path: string, data: ArrayBuffer): Promise<unknown> };
  commands: {
    run(
      cmd: string,
      opts?: { cwd?: string; timeoutMs?: number; envs?: Record<string, string> }
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Executor over an E2B sandbox (commands throw on non-zero exit there). */
export function e2bWorkspaceExecutor(sandbox: E2bSandboxLike, homeDir: string): WorkspaceExecutor {
  const executor: WorkspaceExecutor = {
    kind: 'e2b',
    homeDir,
    async run(command, opts) {
      try {
        const out = await sandbox.commands.run(command, {
          cwd: opts.cwd ?? homeDir,
          timeoutMs: opts.timeoutMs,
          envs: opts.env,
        });
        return { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr, timedOut: false };
      } catch (err) {
        const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
        const timedOut = /timeout|deadline/i.test(e.message ?? '');
        return {
          exitCode: typeof e.exitCode === 'number' ? e.exitCode : 1,
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? e.message ?? String(err),
          timedOut,
        };
      }
    },
    async writeFileInside(root, rel, content, mode) {
      const target = `${root.replace(/\/+$/, '')}/${rel}`;
      const parent = target.slice(0, target.lastIndexOf('/'));
      const check = await executor.run(
        `mkdir -p ${shq(parent)} && r=$(realpath -e ${shq(root)}) && p=$(realpath -e ${shq(parent)}) ` +
          `&& case "$p/" in "$r"/*) ;; *) exit 3;; esac && [ ! -L ${shq(target)} ] && [ ! -d ${shq(target)} ]`,
        { timeoutMs: 15_000 }
      );
      if (check.exitCode !== 0) throw new Error(`refusing unsafe destination: ${rel}`);
      await sandbox.files.write(target, toArrayBuffer(content));
      const chmodResult = await executor.run(`chmod ${mode.toString(8)} ${shq(target)}`, {
        timeoutMs: 10_000,
      });
      if (chmodResult.exitCode !== 0) throw new Error(`chmod failed for ${rel}`);
      return target;
    },
  };
  return executor;
}
