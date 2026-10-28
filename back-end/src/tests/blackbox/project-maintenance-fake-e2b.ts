/**
 * A fake E2B for the template-sync black-box suite: real `bash` and real `git`
 * run inside a temp directory standing in for the sandbox HOME, snapshots are
 * directory copies, and every create / kill / delete is recorded. Only the
 * external SDK surface is replaced; the production runner, store and service
 * run unchanged on top of it.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  MaintenanceDeps,
  MaintenanceSandbox,
} from '../../providers/projects/maintenanceRunner';

export class FakeE2b {
  readonly home: string;
  private readonly store: string;
  private sandboxCount = 0;
  private snapshotCount = 0;
  /** Template or snapshot ids requested from createSandbox, in order. */
  readonly created: string[] = [];
  readonly killed: string[] = [];
  readonly deleted: string[] = [];
  readonly snapshots: string[] = [];
  /** Creating from one of these fails, as a deleted snapshot would. */
  readonly missing = new Set<string>();
  /** Delay (ms) before createSandbox resolves, to overlap concurrent triggers. */
  createDelayMs = 0;

  constructor(root: string) {
    this.home = join(root, 'sandbox-home');
    this.store = join(root, 'snapshots');
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.store, { recursive: true });
  }

  deps(): MaintenanceDeps {
    return {
      homeDir: this.home,
      now: () => new Date(),
      baseTemplate: () => ({ templateId: 'base-template', size: { cpu: 2, memoryGb: 4 } }),
      createSandbox: (id) => this.createSandbox(id),
      deleteSnapshot: async (id) => {
        this.deleted.push(id);
        return true;
      },
    };
  }

  async createSandbox(id: string): Promise<MaintenanceSandbox> {
    this.created.push(id);
    if (this.createDelayMs > 0) await new Promise((r) => setTimeout(r, this.createDelayMs));
    if (this.missing.has(id)) throw new Error(`template ${id} not found`);
    rmSync(this.home, { recursive: true, force: true });
    mkdirSync(this.home, { recursive: true });
    if (id.startsWith('snap-')) cpSync(join(this.store, id), this.home, { recursive: true });
    return this.sandbox(`sbx-${(this.sandboxCount += 1)}`);
  }

  /** The sandbox object for the current HOME (also used to start a "session" from a snapshot). */
  sandbox(sandboxId: string): MaintenanceSandbox {
    return {
      sandboxId,
      files: {
        write: async (path: string, data: ArrayBuffer) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, Buffer.from(data));
        },
      },
      commands: {
        run: (cmd, opts) => this.run(cmd, opts),
      },
      kill: async () => {
        this.killed.push(sandboxId);
      },
      createSnapshot: async () => {
        const snapshotId = `snap-${(this.snapshotCount += 1)}`;
        cpSync(this.home, join(this.store, snapshotId), { recursive: true });
        this.snapshots.push(snapshotId);
        return { snapshotId };
      },
    };
  }

  private run(
    cmd: string,
    opts?: { cwd?: string; timeoutMs?: number; envs?: Record<string, string> }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', cmd], {
        cwd: opts?.cwd ?? this.home,
        env: { PATH: process.env.PATH ?? '', HOME: this.home, ...(opts?.envs ?? {}) },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => {
        try {
          process.kill(-(child.pid ?? 0), 'SIGKILL');
        } catch {
          // already gone
        }
        reject(Object.assign(new Error('command timeout exceeded'), { stdout, stderr }));
      }, opts?.timeoutMs ?? 60_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ exitCode: 0, stdout, stderr });
        else
          reject(
            Object.assign(new Error(`exit status ${code}`), { exitCode: code, stdout, stderr })
          );
      });
    });
  }

  dispose(): void {
    rmSync(dirname(this.home), { recursive: true, force: true });
  }
}

export function tempRoot(prefix: string): string {
  return mkdtempSync(join(process.env.TMPDIR ?? '/var/tmp', prefix));
}
