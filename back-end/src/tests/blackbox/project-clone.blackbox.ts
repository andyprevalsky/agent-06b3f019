import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { once } from 'node:events';
import { waitFor } from '../helpers/waitFor';
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
    const fixture = JSON.parse(
      execFileSync('python3', [helper, root], {
        encoding: 'utf8',
        env: { ...process.env, ROSE_MEASURE_PARENT_PID: String(process.pid) },
      })
    ) as {
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
        env: { ...env, ...envs, ROSE_MEASURE_PARENT_PID: String(process.pid) },
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
    const historical = execFileSync('git', ['show', 'HEAD~10:data'], {
      cwd: checkout,
      env,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(historical.subarray(-32).toString(), String(fixture.count - 11).padStart(32, '0'));
    const data = readFileSync(join(checkout, 'data'));
    const blobHash = (bytes: Buffer) =>
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(blobHash(data), git('rev-parse', 'HEAD:data'));
    assert.equal(blobHash(historical), git('rev-parse', 'HEAD~10:data'));
    assert.equal(data.length, fixture.size);
    assert.equal(data.subarray(-32).toString(), String(fixture.count - 1).padStart(32, '0'));
    assert.equal(readFileSync(join(checkout, '.env'), 'utf8'), 'FIXTURE_ONLY=value\n');
    assert.equal(statSync(join(checkout, '.env')).mode & 0o777, 0o600);
  } finally {
    unregisterWorkspaceExecutor(sessionId);
    rmSync(root, { recursive: true, force: true });
  }
});

test('measurement helper releases its owned command when its parent is killed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-clone-cancel-'));
  const marker = join(root, 'command.pid');
  const command = `exec python3 -c ${shq(`import os,pathlib,select; pathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid())); select.select([],[],[])`)}`;
  const launcher = spawn(
    'python3',
    [
      '-c',
      'import os,subprocess,sys; p=subprocess.Popen([sys.executable,sys.argv[1],"measure",sys.argv[2],sys.argv[3],"600000"],env={**os.environ,"ROSE_MEASURE_PARENT_PID":str(os.getpid())}); p.wait()',
      helper,
      command,
      root,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const exited = once(launcher, 'exit');
  let commandPid: number | undefined;
  let commandReaped = false;
  try {
    const pid = await waitFor(
      'owned measurement command starts',
      () => (existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : undefined),
      { timeoutMs: 60_000 }
    );
    assert.ok(pid > 1);
    commandPid = pid;
    launcher.kill('SIGKILL');
    await exited;
    await waitFor(
      'parent-death cleanup reaps the owned command',
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
          throw error;
        }
      },
      { timeoutMs: 60_000 }
    );
    commandReaped = true;
  } finally {
    if (commandPid !== undefined && !commandReaped) {
      try {
        process.kill(-commandPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          console.error('Owned measurement cleanup failed', error);
      }
    }
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill('SIGTERM');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('measurement helper refuses work when its expected parent already exited', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-clone-startup-'));
  const marker = join(root, 'unexpected-command.pid');
  const formerParent = spawn('python3', ['-c', 'pass'], { stdio: 'ignore' });
  await once(formerParent, 'exit');
  assert.ok(formerParent.pid !== undefined && formerParent.pid > 1);
  const command = `exec python3 -c ${shq(`import os,pathlib,select; pathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid())); select.select([],[],[])`)}`;
  const worker = spawn('python3', [helper, 'measure', command, root, '600000'], {
    env: { ...process.env, ROSE_MEASURE_PARENT_PID: String(formerParent.pid) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(worker, 'close');
  try {
    const result = await waitFor(
      'helper observes cancellation before starting work',
      () => {
        if (existsSync(marker)) return 'started-work';
        if (worker.exitCode !== null || worker.signalCode !== null) return 'exited';
        return undefined;
      },
      { timeoutMs: 60_000 }
    );
    assert.equal(result, 'exited');
    await closed;
    assert.equal(worker.exitCode, 143);
    assert.equal(existsSync(marker), false);
  } finally {
    if (existsSync(marker)) {
      const pid = Number(readFileSync(marker, 'utf8'));
      if (pid > 1) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          console.error('Owned startup fixture cleanup', error);
        }
      }
    }
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
