/**
 * Repo layer for indexed-db-reader.
 *
 * Owns every system boundary the domain touches:
 *   - Electron's `app.getPath('home')` to establish a stable per-user cwd for
 *     the Python child process.
 *   - `child_process.spawn` for the Python helper itself. The orchestrator
 *     provides a driver callback that receives stdout/stderr data chunks and
 *     the final exit code / spawn error, and resolves with the raw bytes.
 *
 * The service layer never imports `child_process` or `electron` directly;
 * every subprocess invocation goes through `runPythonScript` so the blackbox
 * suite can drive the spawned process deterministically via the
 * `child_process` mock.
 */

import { spawn } from 'child_process';
import { app } from 'electron';

/** Outcome of a Python subprocess run. `error` fires when spawn itself fails. */
export interface PythonRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
}

/** Return the user's home directory — used as the child-process cwd. */
export function resolveHomeDir(): string {
  return app.getPath('home');
}

/**
 * Spawn a Python subprocess and collect its stdout/stderr until it closes.
 *
 * Never rejects: spawn errors surface via `spawnError`, non-zero exits via
 * `exitCode`. This matches the pre-refactor contract, where the service layer
 * translated every failure mode into an empty result rather than throwing.
 */
export function runPythonScript(
  pythonBin: string,
  args: readonly string[],
  cwd: string
): Promise<PythonRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(pythonBin, args, { cwd });

    let stdout = '';
    let stderr = '';
    let spawnError: Error | null = null;
    let settled = false;

    const settle = (result: PythonRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    proc.stdout.on('data', (data: Buffer | string) => {
      stdout += typeof data === 'string' ? data : data.toString();
    });

    proc.stderr.on('data', (data: Buffer | string) => {
      stderr += typeof data === 'string' ? data : data.toString();
    });

    proc.on('error', (error: Error) => {
      spawnError = error;
      settle({ exitCode: null, stdout, stderr, spawnError });
    });

    proc.on('close', (code: number | null) => {
      settle({ exitCode: code, stdout, stderr, spawnError });
    });
  });
}
