import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sandbox } from 'e2b';
import { assert } from './projects-harness';
import { acquireCodeSandbox } from '../../providers/e2bCodeSessionSandbox';
import {
  registerWorkspaceExecutor,
  unregisterWorkspaceExecutor,
} from '../../providers/projects/workspaceExecutor';
import { e2bWorkspaceExecutor, restoreWorkspace } from '../../providers/projects/workspace';

type Fixtures = Pick<
  typeof import('./project-maintenance.blackbox'),
  'fixture' | 'runOnce' | 'lastRun' | 'git'
> & { SECRET: string };

export function registerMaintenanceProviderCases({
  fixture,
  runOnce,
  lastRun,
  git,
  SECRET,
}: Fixtures): void {
  test('Codex starts on its provider image while Claude keeps the project snapshot', async () => {
    const f = await fixture('provider-snapshot');
    await runOnce(f);
    const snapshotId = (await lastRun(f.projectId)).snapshotId!;
    const originalCreate = Sandbox.create;
    const testEnv = {
      E2B_SANDBOX_TEMPLATES: JSON.stringify({ codex: { '2x4': 'codex-base' } }),
      CODE_SANDBOX_GRID: JSON.stringify({ cpu: [2, 8], memoryGb: [4, 8] }),
      CODE_SANDBOX_DEFAULT_CPU: '2',
      CODE_SANDBOX_DEFAULT_MEMORY_GB: '4',
    };
    const originalEnv = Object.fromEntries(
      Object.keys(testEnv).map((key) => [key, process.env[key]])
    );
    Object.assign(process.env, testEnv);
    const created: string[] = [];
    Sandbox.create = (async (template: string) => {
      created.push(template);
      const sandbox = await f.fake.createSandbox(template);
      // Replay the captured image boundary: project snapshots have Claude only;
      // the Codex provider image supplies the Codex executable.
      const bin = join(f.fake.home, 'bin');
      mkdirSync(bin, { recursive: true });
      const executable = join(bin, template === snapshotId ? 'claude' : 'codex');
      writeFileSync(executable, '#!/bin/sh\nprintf "fixture-cli\\n"\n');
      chmodSync(executable, 0o755);
      return sandbox as unknown as Sandbox;
    }) as unknown as typeof Sandbox.create;
    try {
      for (const provider of ['claude', 'codex'] as const) {
        const result = await acquireCodeSandbox(null, 'base-tpl', {}, 'Test', {
          provider,
          project: {
            ...f.workspace().project,
            sandboxSize: { cpu: 2, memoryGb: 4 },
            templateSnapshot: { id: snapshotId, size: { cpu: 2, memoryGb: 4 } },
          },
        });
        const sessionId = `provider-snapshot-${provider}`;
        registerWorkspaceExecutor(sessionId, e2bWorkspaceExecutor(result.sandbox, f.fake.home));
        try {
          const report = await restoreWorkspace(sessionId, {
            ...f.workspace(),
            startedFromSnapshot: result.fromSnapshot,
          });
          const launch = await new Promise<{ error: string | null; code: number | null }>(
            (resolve) => {
              let error: string | null = null;
              const child = spawn(provider, ['--version'], {
                cwd: join(f.fake.home, 'workspace'),
                env: { PATH: join(f.fake.home, 'bin') },
                stdio: 'ignore',
              });
              child.on('error', (err) => {
                error = err.message;
              });
              child.on('close', (code) => resolve({ error, code }));
            }
          );
          assert(
            launch.error === null && launch.code === 0,
            `${provider} startup failed: ${launch.error}, exit ${launch.code}`
          );
          assert(
            result.fromSnapshot === (provider === 'claude'),
            'only Claude uses the project snapshot'
          );
          assert(
            created.at(-1) === (provider === 'claude' ? snapshotId : 'codex-base'),
            'provider owns the selected image'
          );
          assert(
            report.checkout.source === (provider === 'claude' ? 'snapshot' : 'remote'),
            'both providers restore their workspace'
          );
          assert(
            git(report.repoDir, 'remote', 'get-url', 'origin') === f.remote,
            'repository restored'
          );
          assert(
            readFileSync(join(report.repoDir, '.env'), 'utf8').includes(SECRET),
            'project env restored'
          );
        } finally {
          unregisterWorkspaceExecutor(sessionId);
        }
      }
    } finally {
      Sandbox.create = originalCreate;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}
