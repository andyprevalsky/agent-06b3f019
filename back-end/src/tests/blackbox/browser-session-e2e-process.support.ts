/** Exact-child ownership for local browser E2E fixtures only. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type TestChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};
export type TestChildStopOptions = { gracefulMs?: number; killMs?: number };

export async function withTestDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class OwnedTestChild {
  private terminal?: TestChildExit;
  private readonly completion: Promise<TestChildExit>;
  private stopping?: Promise<TestChildExit>;

  constructor(readonly child: ChildProcess) {
    this.completion = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.terminal = { code, signal };
        resolve(this.terminal);
      });
      child.once('error', (error) => {
        // A failed spawn has no process to reap. Other errors do not prove exit.
        if (child.pid === undefined) {
          this.terminal = { code: null, signal: null, error };
          resolve(this.terminal);
        }
      });
    });
  }

  get exited(): boolean {
    return this.terminal !== undefined;
  }

  async wait(ms: number): Promise<TestChildExit | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.completion,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  stop(options: TestChildStopOptions = {}): Promise<TestChildExit> {
    this.stopping ??= this.stopOnce(options);
    return this.stopping;
  }

  private async stopOnce({ gracefulMs = 1000, killMs = 1000 }: TestChildStopOptions) {
    if (this.terminal) return this.terminal;
    const pid = this.child.pid;
    if (pid === undefined) {
      const failedSpawn = await this.wait(killMs);
      if (failedSpawn) return failedSpawn;
      throw new Error('Owned test child never reported spawn failure or exit');
    }
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Refusing unsafe child PID ${pid}`);
    // child.kill targets this spawn handle, never a shell group or name pattern.
    this.child.kill('SIGTERM');
    const graceful = await this.wait(gracefulMs);
    if (graceful) return graceful;
    this.child.kill('SIGKILL');
    const killed = await this.wait(killMs);
    if (killed) return killed;
    throw new Error(`Owned test child ${pid} did not report exit after SIGKILL`);
  }
}

export class TestChildProcesses {
  private readonly children = new Set<OwnedTestChild>();

  spawn(command: string, args: string[], options: SpawnOptions = {}): OwnedTestChild {
    const owned = new OwnedTestChild(spawn(command, args, options));
    this.children.add(owned); // Register before any readiness/connect await.
    return owned;
  }

  async acquire<T>(
    command: string,
    args: string[],
    options: SpawnOptions,
    initialize: (owned: OwnedTestChild) => Promise<T>
  ): Promise<T> {
    const owned = this.spawn(command, args, options);
    try {
      return await initialize(owned);
    } catch (error) {
      try {
        await owned.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Test child initialization and cleanup failed'
        );
      }
      throw error;
    }
  }

  async stopAll(options?: TestChildStopOptions): Promise<void> {
    const results = await Promise.allSettled(
      [...this.children].map((child) => child.stop(options))
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length) throw new AggregateError(failures, 'Owned test children failed to exit');
  }
}

export async function runOwnedTestChild(
  command: string,
  args: string[],
  options: SpawnOptions & { timeoutMs: number; stopOptions?: TestChildStopOptions }
): Promise<string> {
  const { timeoutMs, stopOptions, ...spawnOptions } = options;
  const owner = new TestChildProcesses();
  const owned = owner.spawn(command, args, spawnOptions);
  let stdout = '',
    stderr = '';
  owned.child.stdout?.on('data', (data) => {
    stdout += data.toString();
  });
  owned.child.stderr?.on('data', (data) => {
    stderr = (stderr + data.toString()).slice(-24_000);
  });
  try {
    const result = await owned.wait(timeoutMs);
    if (!result) throw new Error(`Test child timed out after ${timeoutMs}ms`);
    if (result.error) throw result.error;
    if (result.code !== 0)
      throw new Error(`Test child exited ${result.code ?? result.signal}\n${stdout}\n${stderr}`);
    return stdout;
  } finally {
    await owner.stopAll(stopOptions);
  }
}
