/**
 * Project code sessions for Codex (PJ3 parity with Claude). Registered by
 * project-workspace.blackbox.ts, which owns the fixture directory, the leak
 * scan list and the project factory.
 *
 *   prepareSessionProject ─► restoreLocalProject (same provider code as Claude)
 *        └─► real e2b-templates/codex-code/ws-server.mjs (CODEX_TRANSPORT=exec,
 *            fake `codex` on PATH records its cwd, branch and prompt)
 *
 * Invariants: the CLI runs in the restored default-branch checkout on the
 * session's own branch; env files are 0600; the startup outcome (ok / failed /
 * timeout) leads the task prompt with the same wording as Claude; a resumed
 * workspace keeps its branch and reruns startup; a session without a project
 * receives exactly the prompt it always did.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { prepareSessionProject } from '../../providers/projects/session';
import { restoreLocalProject } from '../../providers/projects/workspace';
import { prisma } from '../../providers/database';
import {
  anonymousSession,
  apiKeyHeaders,
  assert,
  call,
  expectStatus,
  type Session,
} from './projects-harness';

const WS_SERVER = resolve(process.cwd(), '..', 'e2b-templates', 'codex-code', 'ws-server.mjs');
const SYSTEM_PROMPT = 'FIXTURE SYSTEM PROMPT';
const STARTUP_REPORT_PREFIX = 'ROSE_PROJECT_STARTUP_REPORT ';

/**
 * Scripted stand-ins for `rose-project-startup` (the program a code session's
 * ws-server runs and reads a final `ROSE_PROJECT_STARTUP_REPORT {...}` line
 * from), shared by the Codex and Claude cases. Each is CommonJS source.
 */
export const scriptedStartupRunners = {
  /** Exits at once; a grandchild holding its stdout writes the report 600 ms later. */
  lateReport(report: Record<string, unknown>): string {
    return `const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 600)', ${JSON.stringify(
      `\n${STARTUP_REPORT_PREFIX}${JSON.stringify(report)}\n`
    )}], { detached: true, stdio: ['ignore', 1, 2] }).unref();
process.stdout.write('runner exited before its report\\n');
`;
  },
  /** Writes some output and exits without ever writing a report. */
  crash(exitCode: number): string {
    return `process.stdout.write('compiling\\n'); process.exit(${exitCode});\n`;
  },
  /** Writes a report line with this raw payload and exits 0. */
  reportLine(payload: string): string {
    return `process.stdout.write(${JSON.stringify(`\n${STARTUP_REPORT_PREFIX}${payload}\n`)}); process.exit(0);\n`;
  },
};

/** Report payloads that are not a report: each must read as malformed, never hang. */
export const UNREADABLE_STARTUP_REPORTS: Array<[string, string]> = [
  ['truncated', '{"status":"ok"'],
  ['null', 'null'],
  ['array', '[]'],
  ['nostatus', '{"exitCode":0}'],
];

interface Capture {
  cwd: string;
  branch: string | null;
  prompt: string;
  args: string[];
}

export function registerCodexProjectWorkspaceCases(ctx: {
  fixture: string;
  secret: string;
  remote: () => string;
  leakTexts: Array<[string, string]>;
  createProject: (s: Session, body: Record<string, unknown>) => Promise<{ id: string }>;
}): void {
  const children: ChildProcess[] = [];
  const fakeBin = join(ctx.fixture, 'codex-bin');
  after(() => {
    for (const child of children) child.kill('SIGKILL');
  });

  function installFakeCodex(): void {
    mkdirSync(fakeBin, { recursive: true });
    const path = join(fakeBin, 'codex');
    writeFileSync(
      path,
      `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
let branch = null;
try {
  branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {}
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_CODEX_CAPTURE_PATH, JSON.stringify({
  cwd: process.cwd(), branch, prompt: args[args.length - 1], args,
}));
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
`
    );
    chmodSync(path, 0o755);
  }

  function waitForFile(path: string, timeoutMs: number): Promise<string> {
    const startedAt = Date.now();
    return new Promise((resolveFile, rejectFile) => {
      const timer = setInterval(() => {
        if (existsSync(path)) {
          clearInterval(timer);
          resolveFile(readFileSync(path, 'utf8'));
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          rejectFile(new Error(`timed out waiting for ${path}`));
        }
      }, 100);
    });
  }

  /** Restore `projectId` into `home` (when given) and run the Codex ws-server there. */
  async function runCodexSession(options: {
    userId: string;
    projectId: string | null;
    home: string;
    label: string;
    taskId?: string;
  }) {
    installFakeCodex();
    const { home, label } = options;
    mkdirSync(home, { recursive: true });
    let projectEnvs: Record<string, string> = {};
    if (options.projectId !== null) {
      const workspace = await prepareSessionProject(options.userId, options.projectId);
      const restored = await restoreLocalProject(
        options.taskId ?? randomUUID(),
        home,
        { ...process.env },
        workspace
      );
      projectEnvs = restored.envs;
    }
    return runWsServer({
      home,
      label,
      env: {
        CODE_AGENT_BRANCH: options.projectId === null ? '' : 'rose/codex-project-branch',
        ...projectEnvs,
      },
    });
  }

  /** Run the real Codex ws-server in `home` until the fake `codex` captures its prompt. */
  async function runWsServer(options: {
    home: string;
    label: string;
    env: Record<string, string>;
  }) {
    const { home, label } = options;
    const capturePath = join(ctx.fixture, `codex-${label}.json`);
    const started = Date.now();
    const child = spawn(process.execPath, [WS_SERVER], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PORT: '0',
        CODEX_TRANSPORT: 'exec',
        CODEX_GOAL: `codex project workspace ${label}`,
        CODEX_AUTH_JSON: '{}',
        CODE_AGENT_SYSTEM_PROMPT: SYSTEM_PROMPT,
        FAKE_CODEX_CAPTURE_PATH: capturePath,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let log = '';
    child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
    try {
      const capture = JSON.parse(await waitForFile(capturePath, 60_000)) as Capture;
      return { capture, elapsed: Date.now() - started, log };
    } finally {
      child.kill('SIGKILL');
    }
  }

  /**
   * Project-mode ws-server whose startup runner is a script the test controls
   * (what it writes and when), instead of the generated rose-project-startup.
   * No backend or database is involved.
   */
  function runWithScriptedStartupRunner(label: string, runnerSource: string) {
    installFakeCodex();
    const home = mkdtempSync(join(ctx.fixture, `codex-home-runner-${label}-`));
    const workdir = join(home, 'workspace');
    mkdirSync(workdir, { recursive: true });
    const runner = join(home, 'scripted-startup-runner.cjs');
    writeFileSync(runner, runnerSource);
    return runWsServer({
      home,
      label: `runner-${label}`,
      env: {
        ROSE_PROJECT_WORKDIR: workdir,
        ROSE_PROJECT_STARTUP: runner,
        ROSE_PROJECT_NAME: `PJ-Codex-Runner-${label}`,
      },
    });
  }

  const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

  test('codex: a project session restores the default branch, 0600 env files, runs startup and reports it', async () => {
    const s = await anonymousSession();
    const project = await ctx.createProject(s, {
      name: 'PJ-Codex-Restore',
      repoUrl: ctx.remote(),
      startupScript: [
        'set -e',
        'echo "startup sees $(git rev-parse --abbrev-ref HEAD)"',
        'echo ran > startup-ran.txt',
      ].join('\n'),
      startupTimeoutS: 60,
    });
    const envFile = await call(`/api/projects/${project.id}/env-files`, {
      method: 'POST',
      auth: s.token,
      body: { path: '.env', variables: [{ name: 'CODEX_FIXTURE_SECRET', value: ctx.secret }] },
    });
    expectStatus(envFile, 201, 'add env file');
    ctx.leakTexts.push(['codex env-file response', envFile.text]);
    const home = mkdtempSync(join(ctx.fixture, 'codex-home-ok-'));
    const { capture, log } = await runCodexSession({
      userId: s.userId,
      projectId: project.id,
      home,
      label: 'ok',
    });
    const repo = join(home, 'workspace');
    assert(capture.cwd === repo, `Codex runs in the restored repo, got ${capture.cwd}`);
    assert(
      capture.args.includes('--cd') && capture.args[capture.args.indexOf('--cd') + 1] === repo,
      'exec --cd names the restored repo'
    );
    assert(
      capture.prompt.includes('Project startup for project PJ-Codex-Restore finished OK') &&
        capture.prompt.indexOf('Project startup') < capture.prompt.indexOf('Task:\n'),
      `startup outcome leads the task: ${capture.prompt.slice(0, 300)}`
    );
    assert(capture.prompt.startsWith(`System instructions:\n${SYSTEM_PROMPT}\n\n`), 'system first');
    assert(
      readFileSync(join(repo, 'startup-ran.txt'), 'utf8').trim() === 'ran',
      'startup script ran in the repo'
    );
    assert(
      capture.branch === 'rose/codex-project-branch',
      `own session branch checked out, got ${capture.branch}`
    );
    assert(
      readFileSync(join(home, '.rose/project/startup-report.json'), 'utf8').includes('"ok"'),
      'startup report persisted'
    );
    assert(
      !existsSync(join(repo, 'AGENTS.md')) ||
        !readFileSync(join(repo, 'AGENTS.md'), 'utf8').includes(SYSTEM_PROMPT),
      "the project's own AGENTS.md is never overwritten"
    );
    assert(mode(join(repo, '.env')) === '600', `env file mode ${mode(join(repo, '.env'))}`);
    ctx.leakTexts.push(
      ['codex CLI prompt', capture.prompt],
      ['codex ws-server log', log],
      ['codex startup log', readFileSync(join(home, '.rose/project/startup.log'), 'utf8')]
    );
  });

  test('codex: startup failure and timeout are reported to the CLI and the timeout is enforced', async () => {
    const s = await anonymousSession();
    const failing = await ctx.createProject(s, {
      name: 'PJ-Codex-Fail',
      repoUrl: ctx.remote(),
      startupScript: 'echo failing now\nexit 3',
    });
    const slow = await ctx.createProject(s, {
      name: 'PJ-Codex-Timeout',
      repoUrl: ctx.remote(),
      startupScript: 'echo begin\nsleep 30\necho never',
      startupTimeoutS: 2,
    });
    const fail = await runCodexSession({
      userId: s.userId,
      projectId: failing.id,
      home: mkdtempSync(join(ctx.fixture, 'codex-home-fail-')),
      label: 'fail',
    });
    assert(
      fail.capture.prompt.includes('Project startup for project PJ-Codex-Fail FAILED (exit 3)'),
      `failure reaches the CLI: ${fail.capture.prompt.slice(0, 300)}`
    );
    assert(fail.capture.prompt.includes('failing now'), 'failure output tail included');
    const timeout = await runCodexSession({
      userId: s.userId,
      projectId: slow.id,
      home: mkdtempSync(join(ctx.fixture, 'codex-home-timeout-')),
      label: 'timeout',
    });
    assert(
      timeout.capture.prompt.includes(
        'Project startup for project PJ-Codex-Timeout TIMED OUT after 2s'
      ),
      `timeout reaches the CLI: ${timeout.capture.prompt.slice(0, 300)}`
    );
    assert(timeout.elapsed < 25_000, `the session did not wait for the 30s script`);
    assert(!timeout.capture.prompt.includes('never'), 'the script was stopped before finishing');
  });

  test('codex: a startup report that reaches stdout only after the runner exits is not lost', async () => {
    const { capture } = await runWithScriptedStartupRunner(
      'late',
      scriptedStartupRunners.lateReport({
        status: 'ok',
        exitCode: 0,
        durationMs: 1500,
        timeoutS: 60,
        outputTail: 'late',
        logPath: null,
      })
    );
    assert(
      capture.prompt.includes(
        'Project startup for project PJ-Codex-Runner-late finished OK in 1.5s'
      ),
      `the late report is used: ${capture.prompt.slice(0, 300)}`
    );
  });

  test('codex: a missing or unreadable startup report is reported as such and never stalls the session', async () => {
    const crash = await runWithScriptedStartupRunner('crash', scriptedStartupRunners.crash(7));
    assert(
      crash.capture.prompt.includes('FAILED (exit ?)') &&
        crash.capture.prompt.includes('startup runner produced no report (exit code 7)'),
      `a crash without a report says so: ${crash.capture.prompt.slice(0, 300)}`
    );
    assert(!crash.capture.prompt.includes('malformed'), 'a missing report is not "malformed"');
    for (const [name, payload] of UNREADABLE_STARTUP_REPORTS) {
      const run = await runWithScriptedStartupRunner(
        name,
        scriptedStartupRunners.reportLine(payload)
      );
      assert(
        run.capture.prompt.includes('FAILED (exit ?)') &&
          run.capture.prompt.includes('startup runner wrote a malformed report (exit code 0)') &&
          !run.capture.prompt.includes('finished OK'),
        `${name}: an unreadable report is malformed, not success: ${run.capture.prompt.slice(0, 300)}`
      );
    }
  });

  test('codex: a resumed workspace keeps its branch and local work, and startup reruns', async () => {
    const s = await anonymousSession();
    const project = await ctx.createProject(s, {
      name: 'PJ-Codex-Resume',
      repoUrl: ctx.remote(),
      startupScript: 'echo resumed startup',
    });
    const home = mkdtempSync(join(ctx.fixture, 'codex-home-resume-'));
    const first = await runCodexSession({
      userId: s.userId,
      projectId: project.id,
      home,
      label: 'resume-1',
    });
    assert(first.capture.branch === 'rose/codex-project-branch', 'first run on the session branch');
    writeFileSync(join(home, 'workspace', 'agent-wip.txt'), 'wip\n');
    const second = await runCodexSession({
      userId: s.userId,
      projectId: project.id,
      home,
      label: 'resume-2',
    });
    assert(
      second.capture.branch === 'rose/codex-project-branch',
      `resume stays on the session branch, got ${second.capture.branch}`
    );
    assert(existsSync(join(home, 'workspace', 'agent-wip.txt')), 'resume keeps uncommitted work');
    assert(
      second.capture.prompt.includes('Project startup for project PJ-Codex-Resume finished OK'),
      'startup reruns on resume'
    );
  });

  test('codex: a session without a project receives exactly the prompt it always did', async () => {
    const home = mkdtempSync(join(ctx.fixture, 'codex-home-none-'));
    const { capture } = await runCodexSession({
      userId: randomUUID(),
      projectId: null,
      home,
      label: 'none',
    });
    assert(capture.cwd === home, `no project: Codex works in HOME, got ${capture.cwd}`);
    assert(
      capture.prompt ===
        `System instructions:\n${SYSTEM_PROMPT}\n\nTask:\ncodex project workspace none`,
      `prompt unchanged: ${JSON.stringify(capture.prompt)}`
    );
  });

  test('codex: create resolves the agent (or its root) project and refuses a foreign one', async () => {
    const owner = await anonymousSession();
    const stranger = await anonymousSession();
    const project = await ctx.createProject(owner, {
      name: 'PJ-Codex-Owner',
      repoUrl: ctx.remote(),
    });
    const root = randomUUID();
    const child = randomUUID();
    await prisma.agent.create({
      data: {
        id: root,
        userId: stranger.userId,
        busId: root,
        goal: 'codex root',
        projectId: project.id,
      },
    });
    await prisma.agent.create({
      data: { id: child, userId: stranger.userId, busId: root, goal: 'codex child' },
    });
    // The project belongs to `owner`: neither the agent's own nor its root's
    // project may be restored for another user, and the refusal is a 404 (as
    // for Claude), not a sandbox failure.
    for (const agentId of [root, child]) {
      const res = await call('/api/codex-code-session/create', {
        method: 'POST',
        headers: apiKeyHeaders(stranger.userId),
        body: { agent_id: agentId, goal: 'codex project goal', user_id: stranger.userId },
      });
      assert(
        res.status === 404 && res.data.code === 'PROJECT_NOT_FOUND',
        `foreign project refused for ${agentId}: ${res.status} ${res.text.slice(0, 200)}`
      );
    }
  });
}
