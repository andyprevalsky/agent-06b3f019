/**
 * rose-cli — repo layer (filesystem I/O only, no business logic).
 */
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { LAUNCHER_DIR_MODE, LAUNCHER_MODE } from './config';
import type { ImportChild, ImportSpawnSpec, LauncherIo } from './types';

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readLauncher(p: string): Promise<{ content: string; mode: number } | null> {
  try {
    const [content, stat] = await Promise.all([
      fs.promises.readFile(p, 'utf8'),
      fs.promises.stat(p),
    ]);
    return { content, mode: stat.mode & 0o777 };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Write a sibling temp file (exclusive create, so nothing pre-planted is
 * followed), set 0755 explicitly (the umask may have cleared bits), then
 * rename it over the launcher: a shell never sees a half-written `rose`.
 */
export async function writeLauncherAtomic(p: string, content: string): Promise<void> {
  const dir = path.dirname(p);
  await fs.promises.mkdir(dir, { recursive: true, mode: LAUNCHER_DIR_MODE });
  const temp = path.join(
    dir,
    `.${path.basename(p)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await fs.promises.writeFile(temp, content, { mode: LAUNCHER_MODE, flag: 'wx' });
    await fs.promises.chmod(temp, LAUNCHER_MODE);
    await fs.promises.rename(temp, p);
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
}

export const launcherIo: LauncherIo = {
  exists: pathExists,
  readLauncher,
  writeLauncher: writeLauncherAtomic,
};

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Start `rose import …` argv-style in its own process group (detached), so a
 * cancel reaches the CLI and the coding agent it runs. stderr is drained and
 * dropped (tool noise, possibly secrets); stdout arrives as UTF-8 text.
 */
export function spawnImport(spec: ImportSpawnSpec): ImportChild {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: [spec.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const closeListeners: Array<(code: number | null) => void> = [];
  let closed = false;
  const finish = (code: number | null): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(code);
  };
  child.once('error', () => finish(null));
  child.once('close', (code) => finish(code));
  child.stdout?.setEncoding('utf8');
  child.stderr?.resume();
  if (spec.stdin !== null && child.stdin !== null) {
    child.stdin.on('error', () => undefined);
    child.stdin.end(spec.stdin);
  }
  return {
    onStdout: (listener) => {
      child.stdout?.on('data', (chunk: string) => listener(chunk));
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    kill: (signal) => {
      if (closed) return;
      const pid = child.pid;
      try {
        if (pid !== undefined && pid > 1) process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    },
  };
}
