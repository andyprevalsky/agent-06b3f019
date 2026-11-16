/**
 * Blackbox tests for importing a project from this Mac (rose-cli domain):
 * the app opens a native folder picker and runs `rose import detect|scan|apply
 * --json` with the user's own Claude Code or Codex — no copy-paste.
 *
 * Observable surface:
 *   - argv: built by main per action (never renderer-supplied); apply sends
 *     the plan on stdin (`--plan -`); the scan login code travels only in
 *     ROSE_LOGIN_CODE (argv is visible to every process via `ps`)
 *   - validation: folder is an existing absolute directory, API is http(s),
 *     login code is rlc_ + 32 chars, agent is codex|claude; unknown fields drop
 *   - stdout: one event per JSON object line, tagged with runId; malformed
 *     lines, non-objects, overlong lines and stderr are never forwarded
 *   - exit: exactly one final { runId, event: 'exit', code }, preceded by a
 *     generic error when the run failed without a CLI error event
 *   - single-run guard (also under concurrent starts), cancel (SIGTERM, then
 *     SIGKILL after the grace period), cancelAll on quit
 *   - real processes: cwd, stdin, exit codes, process-group kill reaching the
 *     agent the CLI started, and the full path through the shell launcher
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMPORT_BUSY_ERROR,
  IMPORT_CANCELED_MESSAGE,
  IMPORT_CANCEL_GRACE_MS,
  IMPORT_FAILED_MESSAGE,
  LOGIN_CODE_ENV,
} from '../../main/domains/rose-cli/config';
import { isDirectory, spawnImport } from '../../main/domains/rose-cli/repo';
import { buildLauncherScript } from '../../main/domains/rose-cli/service';
import {
  ImportRunManager,
  JsonLineParser,
  buildImportInvocation,
  folderPickResult,
  importRunEnv,
  validateImportRequest,
  type ImportRunDeps,
} from '../../main/domains/rose-cli/serviceImport';
import type {
  ImportChild,
  ImportSpawnSpec,
  RoseCliImportEvent,
  ValidImportRequest,
} from '../../main/domains/rose-cli/types';

const CODE = `rlc_${'A1b2_-'.repeat(5)}xy`;
const API = 'https://api.roselabs.ai';
const FOLDER = "/Users/me/Projects/Andy's app";
const LAUNCHER = '/Users/me/.rose/bin/rose';
const PLAN = { files: ['.env'], github: { repo: 'acme/app' } };

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rose-cli-import-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('buildImportInvocation', () => {
  it('detect: no folder, no stdin, no extra env', () => {
    expect(buildImportInvocation({ action: 'detect' })).toEqual({
      args: ['import', 'detect', '--json'],
      env: {},
      folder: null,
      stdin: null,
    });
  });

  it('scan: dir, optional agent/project, api; the login code only in ROSE_LOGIN_CODE', () => {
    const full: ValidImportRequest = {
      action: 'scan',
      folder: FOLDER,
      loginCode: CODE,
      apiUrl: API,
      project: 'My App',
      agent: 'codex',
    };
    expect(buildImportInvocation(full)).toEqual({
      args: [
        'import',
        'scan',
        '--dir',
        FOLDER,
        '--agent',
        'codex',
        '--project',
        'My App',
        '--api',
        API,
        '--json',
      ],
      env: { ROSE_LOGIN_CODE: CODE },
      folder: FOLDER,
      stdin: null,
    });
    const minimal = buildImportInvocation({
      action: 'scan',
      folder: FOLDER,
      loginCode: CODE,
      apiUrl: API,
    });
    expect(minimal.args).toEqual(['import', 'scan', '--dir', FOLDER, '--api', API, '--json']);
    expect(minimal.env).toEqual({ [LOGIN_CODE_ENV]: CODE });
    for (const invocation of [buildImportInvocation(full), minimal]) {
      expect(invocation.args.join('\0')).not.toContain(CODE);
      expect(invocation.args).not.toContain('--login-code');
    }
  });

  it('apply: plan on stdin via --plan -, --github-import only when asked', () => {
    const planJson = JSON.stringify(PLAN);
    expect(
      buildImportInvocation({
        action: 'apply',
        folder: FOLDER,
        planJson,
        githubImport: true,
        apiUrl: API,
      })
    ).toEqual({
      args: [
        'import',
        'apply',
        '--dir',
        FOLDER,
        '--plan',
        '-',
        '--github-import',
        '--api',
        API,
        '--json',
      ],
      env: {},
      folder: FOLDER,
      stdin: planJson,
    });
    expect(
      buildImportInvocation({
        action: 'apply',
        folder: FOLDER,
        planJson,
        githubImport: false,
        apiUrl: API,
      }).args
    ).toEqual(['import', 'apply', '--dir', FOLDER, '--plan', '-', '--api', API, '--json']);
  });

  it('run env: keeps the login-shell env, drops an inherited code, adds the scan code', () => {
    const base = { PATH: '/opt/homebrew/bin:/usr/bin', ROSE_LOGIN_CODE: 'rlc_stale', HOME: '/h' };
    expect(importRunEnv(base, {})).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/h' });
    expect(importRunEnv(base, { ROSE_LOGIN_CODE: CODE })).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/h',
      ROSE_LOGIN_CODE: CODE,
    });
    expect(base.ROSE_LOGIN_CODE).toBe('rlc_stale');
  });
});

describe('validateImportRequest', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = path.join(tmp, "My 'Project'");
    fs.mkdirSync(dir);
    file = path.join(tmp, 'README.md');
    fs.writeFileSync(file, 'x');
  });

  it('keeps only known fields, so a renderer cannot smuggle argv', async () => {
    const result = await validateImportRequest(
      {
        action: 'scan',
        folder: `${dir}/`,
        loginCode: CODE,
        apiUrl: 'http://localhost:3001',
        project: 'Rose',
        agent: 'claude',
        args: ['--evil'],
        command: '/bin/rm',
      },
      isDirectory
    );
    expect(result).toEqual({
      request: {
        action: 'scan',
        folder: dir,
        loginCode: CODE,
        apiUrl: 'http://localhost:3001',
        project: 'Rose',
        agent: 'claude',
      },
    });
    expect(
      await validateImportRequest({ action: 'detect', argv: ['--evil'] }, isDirectory)
    ).toEqual({ request: { action: 'detect' } });
  });

  it('apply: serializes the plan and requires a boolean githubImport', async () => {
    expect(
      await validateImportRequest(
        { action: 'apply', folder: dir, plan: PLAN, githubImport: false, apiUrl: API },
        isDirectory
      )
    ).toEqual({
      request: {
        action: 'apply',
        folder: dir,
        planJson: JSON.stringify(PLAN),
        githubImport: false,
        apiUrl: API,
      },
    });
  });

  const scan = (overrides: Record<string, unknown>) => (d: string) => ({
    action: 'scan',
    folder: d,
    loginCode: CODE,
    apiUrl: API,
    ...overrides,
  });
  const apply = (overrides: Record<string, unknown>) => (d: string) => ({
    action: 'apply',
    folder: d,
    plan: PLAN,
    githubImport: true,
    apiUrl: API,
    ...overrides,
  });
  const FOLDER_ERROR = 'Choose a project folder on this Mac.';
  const MISSING_FOLDER = 'That project folder does not exist on this Mac.';
  const API_ERROR = 'The Rose API address must be an http(s) URL.';
  const CODE_ERROR = 'The Rose sign-in code is invalid. Start the import again.';
  const PLAN_ERROR = 'The import plan is invalid. Scan the folder again.';
  const PROJECT_ERROR = 'The Rose project name is invalid.';
  const cases: Array<[string, (dir: string, file: string) => unknown, string]> = [
    ['null request', () => null, 'Unsupported import request.'],
    ['string request', () => 'detect', 'Unsupported import request.'],
    ['array request', () => ['import', 'detect'], 'Unsupported import request.'],
    ['unknown action', () => ({ action: 'push' }), 'Unsupported import action.'],
    ['relative folder', () => scan({ folder: 'Projects/app' })(''), FOLDER_ERROR],
    ['missing folder field', () => scan({ folder: undefined })(''), FOLDER_ERROR],
    ['NUL in folder', (d) => scan({ folder: `${d}\0x` })(d), FOLDER_ERROR],
    ['nonexistent folder', (d) => scan({ folder: path.join(d, 'gone') })(d), MISSING_FOLDER],
    ['file instead of folder', (_d, f) => scan({ folder: f })(f), MISSING_FOLDER],
    ['ftp api', (d) => scan({ apiUrl: 'ftp://api.roselabs.ai' })(d), API_ERROR],
    ['javascript api', (d) => scan({ apiUrl: 'javascript:alert(1)' })(d), API_ERROR],
    ['unparseable api', (d) => scan({ apiUrl: 'api.roselabs.ai' })(d), API_ERROR],
    ['non-string api', (d) => scan({ apiUrl: 42 })(d), API_ERROR],
    ['overlong api', (d) => scan({ apiUrl: `https://x.dev/${'a'.repeat(2_100)}` })(d), API_ERROR],
    ['short code', (d) => scan({ loginCode: 'rlc_short' })(d), CODE_ERROR],
    ['long code', (d) => scan({ loginCode: `rlc_${'A'.repeat(33)}` })(d), CODE_ERROR],
    ['wrong prefix', (d) => scan({ loginCode: `rlx_${'A'.repeat(32)}` })(d), CODE_ERROR],
    ['bad character', (d) => scan({ loginCode: `rlc_${'A'.repeat(31)}!` })(d), CODE_ERROR],
    ['code with newline', (d) => scan({ loginCode: `rlc_${'A'.repeat(32)}\n` })(d), CODE_ERROR],
    ['missing code', (d) => scan({ loginCode: undefined })(d), CODE_ERROR],
    ['unknown agent', (d) => scan({ agent: 'gpt' })(d), 'Choose Claude Code or Codex.'],
    ['blank project', (d) => scan({ project: '  ' })(d), PROJECT_ERROR],
    ['control char project', (d) => scan({ project: 'a\nb' })(d), PROJECT_ERROR],
    ['overlong project', (d) => scan({ project: 'p'.repeat(201) })(d), PROJECT_ERROR],
    ['numeric project', (d) => scan({ project: 7 })(d), PROJECT_ERROR],
    ['null plan', (d) => apply({ plan: null })(d), PLAN_ERROR],
    ['string plan', (d) => apply({ plan: '{"files":[]}' })(d), PLAN_ERROR],
    ['unserializable plan', (d) => apply({ plan: { size: BigInt(1) } })(d), PLAN_ERROR],
    [
      'non-boolean githubImport',
      (d) => apply({ githubImport: 'yes' })(d),
      'Unsupported import request.',
    ],
    ['apply with bad api', (d) => apply({ apiUrl: 'file:///etc/passwd' })(d), API_ERROR],
  ];

  it.each(cases)('rejects %s', async (_name, build, error) => {
    expect(await validateImportRequest(build(dir, file), isDirectory)).toEqual({ error });
  });
});

describe('JsonLineParser', () => {
  function collect(maxLineChars?: number): {
    parser: JsonLineParser;
    objects: Array<Record<string, unknown>>;
  } {
    const objects: Array<Record<string, unknown>> = [];
    return { parser: new JsonLineParser((value) => objects.push(value), maxLineChars), objects };
  }

  it('joins objects split across chunks and handles CRLF and blank lines', () => {
    const { parser, objects } = collect();
    parser.push('{"event":"prog');
    parser.push('ress","n":1}\r\n\n{"event":"plan"}\n{"ev');
    parser.push('ent":"done"}\n');
    parser.end();
    expect(objects).toEqual([{ event: 'progress', n: 1 }, { event: 'plan' }, { event: 'done' }]);
    expect(parser.malformed).toBe(0);
  });

  it('drops malformed and non-object lines without stopping', () => {
    const { parser, objects } = collect();
    parser.push('Warning: tool noise on stdout\n[1,2]\n42\n"text"\nnull\n{"broken"\n{"ok":true}\n');
    parser.end();
    expect(objects).toEqual([{ ok: true }]);
    expect(parser.malformed).toBe(6);
  });

  it('flushes a final line that has no trailing newline', () => {
    const { parser, objects } = collect();
    parser.push('{"event":"done"}');
    expect(objects).toEqual([]);
    parser.end();
    expect(objects).toEqual([{ event: 'done' }]);
  });

  it('drops an overlong line and resumes at the next one', () => {
    const { parser, objects } = collect(16);
    parser.push(`{"a":"${'x'.repeat(40)}`);
    parser.push(`${'x'.repeat(40)}"}\n{"ok":1}\n`);
    parser.push(`{"b":"${'y'.repeat(20)}"}\n{"ok":2}\n`);
    parser.end();
    expect(objects).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(parser.malformed).toBe(2);
  });
});

describe('folderPickResult', () => {
  it('maps the native dialog result', () => {
    expect(folderPickResult({ canceled: false, filePaths: ['/Users/me/app'] })).toEqual({
      canceled: false,
      path: '/Users/me/app',
    });
    expect(folderPickResult({ canceled: true, filePaths: ['/Users/me/app'] })).toEqual({
      canceled: true,
    });
    expect(folderPickResult({ canceled: false, filePaths: [] })).toEqual({ canceled: true });
  });
});

class FakeChild implements ImportChild {
  readonly signals: NodeJS.Signals[] = [];
  private readonly stdoutListeners: Array<(chunk: string) => void> = [];
  private readonly closeListeners: Array<(code: number | null) => void> = [];

  onStdout = (listener: (chunk: string) => void): void => {
    this.stdoutListeners.push(listener);
  };

  onClose = (listener: (code: number | null) => void): void => {
    this.closeListeners.push(listener);
  };

  kill = (signal: NodeJS.Signals): void => {
    this.signals.push(signal);
  };

  write(text: string): void {
    for (const listener of this.stdoutListeners) listener(text);
  }

  exit(code: number | null): void {
    for (const listener of this.closeListeners) listener(code);
  }
}

function harness(overrides: Partial<ImportRunDeps> = {}) {
  const children: FakeChild[] = [];
  const spawns: ImportSpawnSpec[] = [];
  const events: RoseCliImportEvent[] = [];
  const timers: Array<{ fn: () => void; ms: number; canceled: boolean }> = [];
  let next = 0;
  const deps: ImportRunDeps = {
    isDirectory: (p) => Promise.resolve(p === FOLDER),
    ensureLauncher: () => Promise.resolve({ success: true, path: LAUNCHER }),
    env: () => ({ PATH: '/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin' }),
    home: () => '/Users/me',
    spawn: (spec) => {
      spawns.push(spec);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    emit: (event) => events.push(event),
    newRunId: () => `run-${(next += 1)}`,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, canceled: false };
      timers.push(timer);
      return () => {
        timer.canceled = true;
      };
    },
    ...overrides,
  };
  return { manager: new ImportRunManager(deps), children, spawns, events, timers };
}

const SCAN = { action: 'scan', folder: FOLDER, loginCode: CODE, apiUrl: API, agent: 'claude' };

describe('ImportRunManager', () => {
  it('spawns the launcher with main-built argv, the code in env only, and cwd = folder', async () => {
    const { manager, spawns } = harness();

    expect(await manager.start(SCAN)).toEqual({ runId: 'run-1' });
    expect(spawns).toEqual([
      {
        command: LAUNCHER,
        args: ['import', 'scan', '--dir', FOLDER, '--agent', 'claude', '--api', API, '--json'],
        cwd: FOLDER,
        env: { PATH: '/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin', ROSE_LOGIN_CODE: CODE },
        stdin: null,
      },
    ]);
    expect(spawns[0].args.join('\0')).not.toContain(CODE);
  });

  it('runs detect in the home folder and sends the apply plan on stdin, without a code', async () => {
    const { manager, spawns, children } = harness({
      env: () => ({ PATH: '/usr/bin', ROSE_LOGIN_CODE: 'rlc_inherited_from_the_app_env' }),
    });

    await manager.start({ action: 'detect' });
    expect(spawns[0]).toMatchObject({ args: ['import', 'detect', '--json'], cwd: '/Users/me' });
    children[0].exit(0);

    await manager.start({
      action: 'apply',
      folder: FOLDER,
      plan: PLAN,
      githubImport: true,
      apiUrl: API,
    });
    expect(spawns[1]).toMatchObject({ cwd: FOLDER, stdin: JSON.stringify(PLAN) });
    expect(spawns[1].args).toContain('--github-import');
    expect(spawns.map((spawn) => spawn.env)).toEqual([{ PATH: '/usr/bin' }, { PATH: '/usr/bin' }]);
  });

  it('forwards every stdout object tagged with its runId, then one exit', async () => {
    const { manager, children, events } = harness();
    await manager.start(SCAN);

    children[0].write('{"event":"progress","step":"reading .env"}\nnot json\n{"event":"pl');
    children[0].write('an","plan":{"files":[".env"]},"runId":"spoofed"}\n');
    children[0].write('{"event":"exit","code":0}\n{"event":"done","projectId":"p1"}');
    children[0].exit(0);

    expect(events).toEqual([
      { event: 'progress', step: 'reading .env', runId: 'run-1' },
      { event: 'plan', plan: { files: ['.env'] }, runId: 'run-1' },
      { event: 'done', projectId: 'p1', runId: 'run-1' },
      { runId: 'run-1', event: 'exit', code: 0 },
    ]);
  });

  it('adds one generic error when a run fails without a CLI error event', async () => {
    const { manager, children, events } = harness();
    await manager.start(SCAN);
    children[0].exit(1);
    expect(events).toEqual([
      { runId: 'run-1', event: 'error', message: IMPORT_FAILED_MESSAGE },
      { runId: 'run-1', event: 'exit', code: 1 },
    ]);
  });

  it('does not add a generic error after the CLI reported one', async () => {
    const { manager, children, events } = harness();
    await manager.start(SCAN);
    children[0].write('{"event":"error","message":"Codex is not signed in"}\n');
    children[0].exit(2);
    expect(events).toEqual([
      { event: 'error', message: 'Codex is not signed in', runId: 'run-1' },
      { runId: 'run-1', event: 'exit', code: 2 },
    ]);
  });

  it('allows one active run, including two starts racing each other', async () => {
    const { manager, children, spawns } = harness();

    const [first, second] = await Promise.all([manager.start(SCAN), manager.start(SCAN)]);
    expect(first).toEqual({ runId: 'run-1' });
    expect(second).toEqual({ error: IMPORT_BUSY_ERROR });
    expect(await manager.start({ action: 'detect' })).toEqual({ error: IMPORT_BUSY_ERROR });
    expect(spawns).toHaveLength(1);

    children[0].exit(0);
    expect(await manager.start({ action: 'detect' })).toEqual({ runId: 'run-2' });
  });

  it('never spawns on a rejected request or launcher failure, and frees the guard', async () => {
    const failing = harness({
      ensureLauncher: () => Promise.resolve({ success: false, error: 'missing its rose CLI' }),
    });
    expect(await failing.manager.start(SCAN)).toEqual({ error: 'missing its rose CLI' });
    expect(failing.spawns).toEqual([]);

    const throwing = harness({
      spawn: () => {
        throw new Error('spawn EACCES');
      },
    });
    expect(await throwing.manager.start(SCAN)).toEqual({
      error: 'Could not start the import: spawn EACCES',
    });

    const { manager, spawns } = harness();
    expect(await manager.start({ ...SCAN, folder: '/Users/me/not-a-folder' })).toEqual({
      error: 'That project folder does not exist on this Mac.',
    });
    expect(await manager.start({ ...SCAN, loginCode: 'paste-me' })).toEqual({
      error: 'The Rose sign-in code is invalid. Start the import again.',
    });
    expect(spawns).toEqual([]);
    expect(await manager.start(SCAN)).toEqual({ runId: 'run-1' });
  });

  it('cancel: SIGTERM, SIGKILL only after the grace period, reported as canceled', async () => {
    const { manager, children, events, timers } = harness();
    await manager.start(SCAN);

    manager.cancel('run-other');
    expect(children[0].signals).toEqual([]);

    manager.cancel('run-1');
    manager.cancel('run-1');
    expect(children[0].signals).toEqual(['SIGTERM']);
    expect(timers.map((timer) => timer.ms)).toEqual([IMPORT_CANCEL_GRACE_MS]);

    timers[0].fn();
    expect(children[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
    children[0].exit(null);
    expect(events).toEqual([
      { runId: 'run-1', event: 'error', message: IMPORT_CANCELED_MESSAGE, canceled: true },
      { runId: 'run-1', event: 'exit', code: null },
    ]);
  });

  it('a run that stops within the grace period never gets SIGKILL', async () => {
    const { manager, children, timers } = harness();
    await manager.start(SCAN);
    manager.cancel('run-1');
    children[0].exit(null);
    expect(timers[0].canceled).toBe(true);
    expect(children[0].signals).toEqual(['SIGTERM']);
    manager.cancel('run-1');
    expect(children[0].signals).toEqual(['SIGTERM']);
  });

  it('cancelAll stops the active run (app quit) and is a no-op when idle', async () => {
    const { manager, children } = harness();
    manager.cancelAll();
    await manager.start(SCAN);
    manager.cancelAll();
    expect(children[0].signals).toEqual(['SIGTERM']);
  });
});

function writeScript(name: string, source: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, source);
  return file;
}

function closed(child: ImportChild): Promise<number | null> {
  return new Promise((resolve) => child.onClose(resolve));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fake `rose`: reports what it was started with, writes noise and a malformed line. */
const RECORDING_CLI = `
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  process.stderr.write('tool noise: sk-secret-token\\n');
  const report = {
    event: 'progress',
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin: Buffer.concat(chunks).toString('utf8'),
    runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    loginCode: process.env.ROSE_LOGIN_CODE ?? null,
  };
  process.stdout.write(JSON.stringify(report) + '\\nnot json\\n' + JSON.stringify({ event: 'done' }));
  process.exitCode = Number(process.env.FAKE_EXIT ?? '0');
});
`;

describe('spawnImport (real processes)', () => {
  it('runs argv-style in cwd, pipes stdin, drops stderr and reports the exit code', async () => {
    const cli = writeScript('cli.mjs', RECORDING_CLI);
    const folder = path.join(tmp, 'Andy\'s "app" $(touch pwned)');
    fs.mkdirSync(folder);
    let stdout = '';

    const child = spawnImport({
      command: process.execPath,
      args: [cli, 'two words', "it's"],
      cwd: folder,
      env: { PATH: '/usr/bin:/bin', FAKE_EXIT: '3' },
      stdin: '{"plan":1}',
    });
    child.onStdout((chunk) => {
      stdout += chunk;
    });

    expect(await closed(child)).toBe(3);
    const [first] = stdout.split('\n');
    expect(JSON.parse(first)).toEqual({
      event: 'progress',
      argv: ['two words', "it's"],
      cwd: folder,
      stdin: '{"plan":1}',
      runAsNode: null,
      loginCode: null,
    });
    expect(stdout).not.toContain('sk-secret-token');
    expect(fs.existsSync(path.join(tmp, 'pwned'))).toBe(false);
  });

  it('kill signals the whole process group, reaching the agent the CLI started', async () => {
    const cli = writeScript(
      'agent.mjs',
      "import { spawn } from 'node:child_process';\n" +
        "const agent = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });\n" +
        "process.stdout.write(JSON.stringify({ agentPid: agent.pid }) + '\\n');\n" +
        'setInterval(() => undefined, 1_000);\n'
    );
    let stdout = '';
    const child = spawnImport({
      command: process.execPath,
      args: [cli],
      cwd: tmp,
      env: { PATH: '/usr/bin:/bin' },
      stdin: null,
    });
    child.onStdout((chunk) => {
      stdout += chunk;
    });
    const exit = closed(child);
    await vi.waitFor(() => expect(stdout).toContain('\n'), { timeout: 15_000 });
    const { agentPid } = JSON.parse(stdout.split('\n')[0]) as { agentPid: number };
    expect(isAlive(agentPid)).toBe(true);

    child.kill('SIGTERM');

    expect(await exit).toBeNull();
    await vi.waitFor(() => expect(isAlive(agentPid)).toBe(false), { timeout: 15_000 });
    child.kill('SIGKILL');
  });

  it('reports a command that cannot start as a null close', async () => {
    const child = spawnImport({
      command: path.join(tmp, 'missing-rose'),
      args: [],
      cwd: tmp,
      env: { PATH: '/usr/bin:/bin' },
      stdin: null,
    });
    expect(await closed(child)).toBeNull();
  });
});

describe('import through the real launcher', () => {
  function realLauncherRun(): {
    manager: ImportRunManager;
    events: RoseCliImportEvent[];
    folder: string;
    exited: () => Promise<void>;
  } {
    const cli = writeScript('rose.mjs', RECORDING_CLI);
    const launcher = path.join(tmp, 'bin', 'rose');
    fs.mkdirSync(path.dirname(launcher));
    fs.writeFileSync(launcher, buildLauncherScript({ execPath: process.execPath, cliEntry: cli }), {
      mode: 0o755,
    });
    const folder = path.join(tmp, "Andy's app");
    fs.mkdirSync(folder);
    const events: RoseCliImportEvent[] = [];
    const manager = new ImportRunManager({
      isDirectory,
      ensureLauncher: () => Promise.resolve({ success: true, path: launcher }),
      env: () => ({ PATH: '/usr/bin:/bin' }),
      home: () => tmp,
      spawn: spawnImport,
      emit: (event) => events.push(event),
      newRunId: () => 'run-e2e',
      setTimer: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });
    const exited = (): Promise<void> =>
      vi.waitFor(() => expect(events.map((event) => event.event)).toContain('exit'), {
        timeout: 15_000,
      });
    return { manager, events, folder, exited };
  }

  it('delivers the exact argv, cwd and plan to the CLI and forwards only its JSON objects', async () => {
    const { manager, events, folder, exited } = realLauncherRun();

    const started = await manager.start({
      action: 'apply',
      folder,
      plan: PLAN,
      githubImport: true,
      apiUrl: 'http://localhost:3001',
    });

    expect(started).toEqual({ runId: 'run-e2e' });
    await exited();
    expect(events).toEqual([
      {
        event: 'progress',
        argv: [
          'import',
          'apply',
          '--dir',
          folder,
          '--plan',
          '-',
          '--github-import',
          '--api',
          'http://localhost:3001',
          '--json',
        ],
        cwd: folder,
        stdin: JSON.stringify(PLAN),
        runAsNode: '1',
        loginCode: null,
        runId: 'run-e2e',
      },
      { event: 'done', runId: 'run-e2e' },
      { runId: 'run-e2e', event: 'exit', code: 0 },
    ]);
  });

  it('scan: the CLI receives the login code in ROSE_LOGIN_CODE and never in argv', async () => {
    const { manager, events, folder, exited } = realLauncherRun();

    expect(
      await manager.start({ action: 'scan', folder, loginCode: CODE, apiUrl: API, agent: 'codex' })
    ).toEqual({ runId: 'run-e2e' });
    await exited();

    expect(events[0]).toEqual({
      event: 'progress',
      argv: ['import', 'scan', '--dir', folder, '--agent', 'codex', '--api', API, '--json'],
      cwd: folder,
      stdin: '',
      runAsNode: '1',
      loginCode: CODE,
      runId: 'run-e2e',
    });
    expect(JSON.stringify(events[0].argv)).not.toContain(CODE);
  });
});
