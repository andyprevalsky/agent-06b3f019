/**
 * Minimal filesystem/exec surface shared by E2B sandboxes and the local
 * Claude Code fallback, so checkpoint/restore logic is written (and tested)
 * once against either backend.
 *
 *   checkpoint.ts ──► CodeSessionFs ──┬─► e2bSandboxFs(sandbox)  (/home/user)
 *                                     └─► localSandboxFs(homeDir) (backend host)
 */
import { execFile } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { Sandbox } from 'e2b';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodeSessionFs {
  kind: 'e2b' | 'local';
  /** Session HOME: the CLI's working tree, Rose skills, CLIs and logs live here. */
  home: string;
  /** Run a bash script; never throws on a non-zero exit. */
  exec(script: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
}

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_BUFFER = 16 * 1024 * 1024;

export function localSandboxFs(home: string): CodeSessionFs {
  return {
    kind: 'local',
    home,
    exec: (script, opts) =>
      new Promise((resolve) => {
        execFile(
          'bash',
          ['-c', script],
          {
            cwd: home,
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              HOME: home,
              LANG: 'C.UTF-8',
              GIT_TERMINAL_PROMPT: '0',
            },
            timeout: opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
            maxBuffer: MAX_EXEC_BUFFER,
          },
          (error, stdout, stderr) => {
            const code =
              error === null
                ? 0
                : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
                  ? Number((error as unknown as { code: number }).code)
                  : 1;
            resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
          }
        );
      }),
    readFile: (path) => readFile(path),
    writeFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
  };
}

function isCommandResult(value: unknown): value is ExecResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { exitCode?: unknown }).exitCode === 'number'
  );
}

export function e2bSandboxFs(sandbox: Sandbox, home = '/home/user'): CodeSessionFs {
  return {
    kind: 'e2b',
    home,
    exec: async (script, opts) => {
      try {
        const result = await sandbox.commands.run(`bash -c ${shellQuote(script)}`, {
          timeoutMs: opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
          cwd: home,
        });
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        // e2b throws CommandExitError for a non-zero exit; it carries the result.
        if (isCommandResult(error)) {
          return {
            exitCode: error.exitCode,
            stdout: String(error.stdout ?? ''),
            stderr: String(error.stderr ?? ''),
          };
        }
        throw error;
      }
    },
    readFile: async (path) => Buffer.from(await sandbox.files.read(path, { format: 'bytes' })),
    writeFile: async (path, data) => {
      const bytes = new Uint8Array(data.byteLength);
      bytes.set(data);
      await sandbox.files.write(path, bytes.buffer);
    },
  };
}

/** POSIX single-quote a value for interpolation into a bash script. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
