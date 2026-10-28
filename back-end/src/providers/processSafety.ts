import {
  execFile,
  spawn,
  type ExecFileOptions,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { promisify } from 'node:util';

/** Keep process ownership, signals and coverage on the actual interpreter. */
export function typeScriptProcess(args: string[]): [string, string[]] {
  return [process.execPath, ['--import', require.resolve('tsx'), ...args]];
}

export async function execTypeScript(args: string[], options: ExecFileOptions = {}) {
  const [command, argv] = typeScriptProcess(args);
  try {
    return await promisify(execFile)(command, argv, { ...options, encoding: 'utf8' });
  } catch (error) {
    if (error instanceof Error) {
      const child = error as Error & {
        code?: string | number;
        signal?: string;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      error.message +=
        `\nChild process: code=${child.code ?? 'none'} signal=${child.signal ?? 'none'} killed=${child.killed ?? false}` +
        `\nstdout: ${child.stdout ?? ''}\nstderr: ${child.stderr ?? ''}`;
    }
    throw error;
  }
}

export function spawnTypeScript(args: string[], options: SpawnOptionsWithoutStdio = {}) {
  const [command, argv] = typeScriptProcess(args);
  return spawn(command, argv, options);
}
