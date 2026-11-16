import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  e2bWorkspaceExecutor,
  registerWorkspaceExecutor,
  restoreWorkspace,
  unregisterWorkspaceExecutor,
} from '../../providers/projects/workspace';
import { shq } from '../../providers/projects/workspaceExecutor';

const helper = fileURLToPath(new URL('./fixtures/project-delta-pack.py', import.meta.url));
const execute = promisify(execFile);

test('E2B project preparation avoids delta-cache thrashing and retains complete history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-clone-'));
  const sessionId = randomUUID();
  try {
    const fixture = JSON.parse(execFileSync('python3', [helper, root], { encoding: 'utf8' })) as {
      remote: string;
      count: number;
      size: number;
    };
    const home = join(root, 'session');
    mkdirSync(home);
    const globalConfig = join(root, 'gitconfig');
    // Same cache/base-size ratio as the captured ~100 MiB objects and 96 MiB
    // default, scaled down to keep the deterministic offline fixture small.
    writeFileSync(globalConfig, '[core]\n  deltaBaseCacheLimit = 1m\n');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
    const run = async (command: string, cwd = home, timeoutMs = 600_000, envs = {}) => {
      const out = await execute('python3', [helper, 'measure', command, cwd, String(timeoutMs)], {
        env: { ...env, ...envs },
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(out.stdout) as {
        exitCode: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
        cpu: number;
      };
    };
    const source = `file://${fixture.remote}`;
    const reference = await run(
      `git -c core.deltaBaseCacheLimit=512m clone --quiet ${shq(source)} ${shq(join(root, 'reference'))}`
    );
    assert.equal(reference.exitCode, 0, reference.stderr);
    let cloneCpu: number | undefined;
    const sandbox = {
      commands: {
        async run(
          command: string,
          opts?: { cwd?: string; timeoutMs?: number; envs?: Record<string, string> }
        ) {
          const result = await run(command, opts?.cwd, opts?.timeoutMs, opts?.envs);
          if (command.includes('clone --quiet')) cloneCpu = result.cpu;
          return result;
        },
      },
      files: {
        async write(path: string, data: ArrayBuffer) {
          writeFileSync(path, Buffer.from(data));
        },
      },
    };
    registerWorkspaceExecutor(sessionId, e2bWorkspaceExecutor(sandbox, home));
    const report = await restoreWorkspace(sessionId, {
      project: {
        id: 'fixture',
        name: 'Fixture',
        repoUrl: source,
        defaultBranch: 'main',
        startupScript: null,
        startupTimeoutS: 60,
      },
      revision: 0,
      manifest: null,
      files: [
        {
          path: '.env',
          kind: 'env',
          content: Buffer.from('FIXTURE_ONLY=value\n'),
          linkTarget: null,
        },
      ],
      gitBundle: null,
      uncommittedPatch: null,
      redactions: [],
    });
    assert.equal(report.checkout.source, 'remote');
    assert.deepEqual(report.warnings, []);
    assert.ok(cloneCpu !== undefined, 'measured the real clone, not surrounding session work');
    console.log(JSON.stringify({ cloneCpu, referenceCpu: reference.cpu }));
    // CPU accounting excludes scheduler waits under the deploy stability load.
    // Compare identical packs, transport and host, with room for process noise.
    assert.ok(
      cloneCpu < reference.cpu * 1.6,
      'session preparation must avoid repeated delta-base reconstruction'
    );
    const checkout = join(home, 'workspace');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: checkout, env, encoding: 'utf8' }).trim();
    assert.equal(git('rev-list', '--count', 'HEAD'), String(fixture.count));
    assert.equal(git('rev-parse', '--is-shallow-repository'), 'false');
    git('show-ref', '--verify', 'refs/remotes/origin/other');
    assert.equal(Number(git('cat-file', '-s', 'HEAD~10:data')), fixture.size);
    const data = readFileSync(join(checkout, 'data'));
    assert.equal(data.length, fixture.size);
    assert.equal(data.subarray(-32).toString(), String(fixture.count - 1).padStart(32, '0'));
    assert.equal(readFileSync(join(checkout, '.env'), 'utf8'), 'FIXTURE_ONLY=value\n');
    assert.equal(statSync(join(checkout, '.env')).mode & 0o777, 0o600);
  } finally {
    unregisterWorkspaceExecutor(sessionId);
    rmSync(root, { recursive: true, force: true });
  }
});
