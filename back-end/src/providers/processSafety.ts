import {
  execFile,
  spawn,
  type ExecFileOptions,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

/** Keep process ownership, signals and coverage on the actual interpreter. */
export function typeScriptProcess(args: string[]): [string, string[]] {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const flag =
    major > 20 || (major === 20 && minor >= 6) || (major === 18 && minor >= 19)
      ? '--import'
      : '--loader';
  const preload = flag === '--loader' ? ['--require', require.resolve('tsx/cjs')] : [];
  return [
    process.execPath,
    [flag, pathToFileURL(require.resolve('tsx')).href, ...preload, ...args],
  ];
}

/** Execute a fixture as UTF-8 text; binary/other encodings are not supported. */
export async function execTypeScript(
  args: string[],
  options: Omit<ExecFileOptions, 'encoding'> & { encoding?: 'utf8' | 'utf-8' } = {}
) {
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
