#!/usr/bin/env tsx
/**
 * Black-box tests for codebase sync (C9) and project code sessions (PJ3).
 *
 *   fixture checkout ── scripts/rose-sync push ──► /api/projects/:id/sync
 *        │  .env → symlink to a file OUTSIDE the repo          (encrypted client-side)
 *        │  app/.env.local (ignored), unpushed branch, uncommitted edit + untracked file
 *        ▼
 *   prepareSessionProject ─► createLocalClaudeCodeSession (real ws-server.mjs,
 *                             fake `claude` on PATH records its prompt and cwd)
 *
 * Invariants covered:
 *   - sync: external symlink content captured + link structure recorded;
 *     incremental re-sync uploads only changed files/artifacts
 *   - restore: default branch checked out from the remote; env files 0600;
 *     `.env` recreated as a symlink to a 0600 file outside the repo; unpushed
 *     commits as rose-sync/<branch>; uncommitted work as a stash + patch
 *   - startup: runs in the repo before the CLI; ok / failed / timeout are
 *     reported to the CLI prompt and by runProjectStartup(); the timeout is
 *     enforced (the session does not hang); the runner also runs under the E2B
 *     templates' HOME, whose package.json declares "type": "module"
 *   - project ref (project-workspace-project-ref.cases.ts): a spawn's
 *     github_repo_ref=<project id> restores exactly that project, one without
 *     GitHub from its synced bundle; another user's id is refused
 *   - secret-leak scan: the fixture secret never appears in API responses,
 *     CLI output, DB rows, startup log/report or the backend log
 *
 * Usage: bash scripts/run-blackbox-tests.sh project-workspace
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import {
  closeLocalClaudeCodeSession,
  createLocalClaudeCodeSession,
} from '../../providers/claudeCodeLocalSession';
import { prisma } from '../../providers/database';
import { registerClaudeStartupReportCases } from './project-workspace-claude.cases';
import { registerCodexProjectWorkspaceCases } from './project-workspace-codex.cases';
import {
  registerFilesOnlyRejectionCase,
  verifyFilesOnlyPush,
} from './project-workspace-files-only.cases';
import { registerProjectRefCase } from './project-workspace-project-ref.cases';
import { registerSeedRoseCase } from './project-workspace-seed-rose.cases';
import { prepareSessionProject } from '../../providers/projects/session';
import {
  localWorkspaceExecutor,
  registerWorkspaceExecutor,
  restoreWorkspace,
  runProjectStartup,
  unregisterWorkspaceExecutor,
} from '../../providers/projects/workspace';
import {
  anonymousSession,
  assert,
  BASE_URL,
  call,
  expectStatus,
  type Session,
} from './projects-harness';

const SECRET = `rose-sync-fixture-secret-${randomBytes(10).toString('hex')}`;
const REPO_ROOT = resolve(process.cwd(), '..');
const ROSE_SYNC = process.env.ROSE_SYNC_TEST_CLI ?? join(REPO_ROOT, 'scripts', 'rose-sync');
const WS_SERVER = join(REPO_ROOT, 'e2b-templates', 'claude-code', 'ws-server.mjs');
const fixture = mkdtempSync(join(process.env.TMPDIR ?? '/var/tmp', 'project-workspace-bb-'));
const fakeBin = join(fixture, 'bin');
const sessions: string[] = [];
const leakTexts: Array<[string, string]> = [];

const originalPath = process.env.PATH;
const originalWsOverride = process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH;

after(async () => {
  for (const taskId of sessions) {
    await closeLocalClaudeCodeSession(taskId).catch(() => undefined);
    rmSync(join('/tmp/claude-code-local', taskId), { recursive: true, force: true });
  }
  process.env.PATH = originalPath;
  if (originalWsOverride === undefined) delete process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH;
  else process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH = originalWsOverride;
  rmSync(fixture, { recursive: true, force: true });
  await prisma.$disconnect();
});

function sh(cwd: string, cmd: string): string {
  return execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
}

/** Remote with main; checkout with an unpushed `feature` commit and dirty work. */
function buildFixtureRepo(): { checkout: string; remote: string; outsideEnv: string } {
  const remote = join(fixture, 'remote.git');
  const checkout = join(fixture, 'checkout');
  const outside = join(fixture, 'outside');
  mkdirSync(outside);
  const outsideEnv = join(outside, 'secrets.env');
  writeFileSync(outsideEnv, `FIXTURE_SECRET=${SECRET}\nPUBLIC_NAME=fixture\n`);
  sh(fixture, `git init -q --bare -b main ${remote}`);
  sh(fixture, `git init -q -b main ${checkout}`);
  const git = 'git -c user.name=t -c user.email=t@example.com';
  writeFileSync(join(checkout, '.gitignore'), '.env\n.env.*\n!.env.example\n');
  writeFileSync(join(checkout, '.nvmrc'), `${process.version.replace(/^v/, '')}\n`);
  writeFileSync(join(checkout, 'README.md'), 'fixture\n');
  writeFileSync(join(checkout, '.env.example'), 'FIXTURE_SECRET=\n');
  sh(
    checkout,
    `${git} add -A && ${git} commit -qm init && git remote add origin ${remote} && git push -q origin main`
  );
  sh(
    checkout,
    `git checkout -qb feature && echo feature > feature.txt && ${git} add feature.txt && ${git} commit -qm feature`
  );
  writeFileSync(join(checkout, 'README.md'), 'fixture\nuncommitted edit\n');
  writeFileSync(join(checkout, 'untracked-note.txt'), 'untracked work\n');
  symlinkSync(outsideEnv, join(checkout, '.env'));
  mkdirSync(join(checkout, 'app'));
  writeFileSync(join(checkout, 'app', '.env.local'), 'APP_MODE=dev\n');
  return { checkout, remote, outsideEnv };
}

// Keep native CLI work from blocking pooled HTTP socket close/expiry events.
function runChild(file: string, args: string[], env = process.env) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(file, args, { encoding: 'utf8', env }, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function runSync(s: Session, args: string[]) {
  const out = await runChild(process.execPath, [ROSE_SYNC, ...args, '--json'], {
    ...process.env,
    ROSE_TOKEN: s.token,
    ROSE_API_URL: BASE_URL,
    ROSE_API_KEY: '',
    ROSE_USER_ID: '',
  });
  leakTexts.push(['rose-sync output', out.stdout + out.stderr]);
  assert(out.status === 0, `rose-sync ${args.join(' ')} failed: ${out.stderr}${out.stdout}`);
  return JSON.parse(out.stdout) as {
    revision: number;
    written: string[];
    unchanged: string[];
    deleted: string[];
    gitBundle: string;
    uncommittedPatch: string;
  };
}

function installFakeClaude(): void {
  mkdirSync(fakeBin, { recursive: true });
  const path = join(fakeBin, 'claude');
  writeFileSync(
    path,
    `#!${process.execPath}
// ws-server keeps stdin open until the turn's result (direct chat / agent
// messages), so answer the first stream-json prompt line instead of waiting
// for end-of-input. Control requests (initialize) come first and are answered
// like the real CLI does.
const { writeFileSync } = require('node:fs');
let stdin = '';
let pending = '';
let answered = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  stdin += c;
  pending += c;
  let newline;
  let line;
  while (!answered && (newline = pending.indexOf('\\n')) !== -1) {
    const candidate = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {}
    if (parsed?.type === 'control_request') {
      process.stdout.write(JSON.stringify({ type: 'control_response', response: {
        request_id: parsed.request_id, subtype: 'success', response: { models: [] }
      } }) + '\\n');
      continue;
    }
    line = candidate;
    break;
  }
  if (answered || line === undefined) return;
  answered = true;
  // The prompt arrives as a stream-json user message; record its text.
  let text = line;
  try {
    const msg = JSON.parse(line);
    text = (msg.message?.content ?? []).map((part) => part.text ?? '').join('');
  } catch {}
  writeFileSync(
    process.env.FAKE_CLAUDE_CAPTURE_PATH,
    JSON.stringify({ cwd: process.cwd(), stdin: text, raw: stdin })
  );
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`
  );
  chmodSync(path, 0o755);
  process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
  process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH = WS_SERVER;
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

async function startSession(userId: string, projectId: string, label: string) {
  const taskId = randomUUID();
  sessions.push(taskId);
  const capture = join(fixture, `claude-${label}.json`);
  const workspace = await prepareSessionProject(userId, projectId);
  const started = Date.now();
  const session = await createLocalClaudeCodeSession({
    taskId,
    agentId: randomUUID(),
    goal: `project workspace blackbox ${label}`,
    envs: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token', FAKE_CLAUDE_CAPTURE_PATH: capture },
    projectWorkspace: workspace,
    claudeTokenSource: 'test',
    claudeTokenIntegrationId: null,
  });
  return { taskId, session, capture, started, home: join('/tmp/claude-code-local', taskId) };
}

async function createProject(s: Session, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await call('/api/projects', { method: 'POST', auth: s.token, body });
  expectStatus(res, 201, 'create project');
  leakTexts.push(['create project response', res.text]);
  return res.data as { id: string };
}

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

test('sync → restore → startup ok, with incremental re-sync and no secret leaks', async () => {
  installFakeClaude();
  const s = await anonymousSession();
  const { checkout, outsideEnv } = buildFixtureRepo();
  const project = await createProject(s, {
    name: 'PJ-Restore',
    startupScript: [
      'set -e',
      '. ./.env',
      'echo "startup token is $FIXTURE_SECRET"',
      'git rev-parse --abbrev-ref HEAD > startup-branch.txt',
      'echo ran > startup-ran.txt',
    ].join('\n'),
    startupTimeoutS: 60,
  });

  const first = await runSync(s, ['push', '--dir', checkout, '--project', project.id]);
  assert(first.revision === 1, `first revision ${first.revision}`);
  assert(
    JSON.stringify([...first.written].sort()) === JSON.stringify(['.env', 'app/.env.local']),
    `first push writes both env files: ${first.written}`
  );
  assert(
    first.gitBundle === 'written' && first.uncommittedPatch === 'written',
    'artifacts written'
  );
  const second = await runSync(s, ['push', '--dir', checkout, '--project', project.id]);
  assert(
    second.written.length === 0 && second.unchanged.length === 2,
    'no-op re-sync uploads nothing'
  );
  assert(
    second.gitBundle === 'unchanged' && second.uncommittedPatch === 'unchanged',
    'artifacts unchanged'
  );
  writeFileSync(join(checkout, 'app', '.env.local'), 'APP_MODE=staging\n');
  const third = await runSync(s, ['push', '--dir', checkout, '--project', project.id]);
  assert(
    JSON.stringify(third.written) === JSON.stringify(['app/.env.local']),
    `only changed file: ${third.written}`
  );

  await verifyFilesOnlyPush({ s, checkout, projectId: project.id, runSync, sh });

  const envRow = await prisma.projectEnvFile.findUniqueOrThrow({
    where: { projectId_path: { projectId: project.id, path: '.env' } },
  });
  assert(envRow.linkTarget === outsideEnv && envRow.source === 'sync', 'link structure recorded');
  assert(
    JSON.stringify(envRow.variables) ===
      JSON.stringify([{ name: 'FIXTURE_SECRET' }, { name: 'PUBLIC_NAME' }]),
    `variable names only: ${JSON.stringify(envRow.variables)}`
  );
  const files = await call(`/api/projects/${project.id}/env-files`, { auth: s.token });
  leakTexts.push(['env-files response', files.text]);

  const { taskId, capture, home } = await startSession(s.userId, project.id, 'ok');
  const prompt = JSON.parse(await waitForFile(capture, 60_000)) as { cwd: string; stdin: string };
  const repo = join(home, 'workspace');
  assert(prompt.cwd === repo, `CLI runs in the restored repo, got ${prompt.cwd}`);
  assert(
    prompt.stdin.startsWith('/goal Project startup for project PJ-Restore finished OK'),
    `startup outcome reaches the CLI: ${prompt.stdin.slice(0, 200)}`
  );
  assert(
    readFileSync(join(repo, 'startup-ran.txt'), 'utf8').trim() === 'ran',
    'startup script ran'
  );
  assert(
    readFileSync(join(repo, 'startup-branch.txt'), 'utf8').trim() === 'main',
    'default branch checked out'
  );

  const link = join(repo, '.env');
  assert(lstatSync(link).isSymbolicLink(), '.env restored as a symlink');
  const target = readlinkSync(link);
  assert(!target.startsWith(repo), `symlink target outside the repo: ${target}`);
  assert(
    readFileSync(link, 'utf8').includes(`FIXTURE_SECRET=${SECRET}`),
    'symlinked content restored'
  );
  assert(mode(target) === '600', `linked file mode ${mode(target)}`);
  assert(mode(join(repo, 'app', '.env.local')) === '600', 'env file mode 0600');
  assert(
    readFileSync(join(repo, 'app', '.env.local'), 'utf8') === 'APP_MODE=staging\n',
    'latest sync wins'
  );

  const branches = sh(repo, 'git branch --format="%(refname:short)"').split('\n').filter(Boolean);
  assert(branches.includes('rose-sync/feature'), `unpushed branch restored: ${branches}`);
  assert(
    sh(repo, 'git log -1 --format=%s rose-sync/feature').trim() === 'feature',
    'unpushed commit present'
  );
  const stash = sh(repo, 'git stash list');
  assert(
    /rose-sync uncommitted \(r\d+, feature\)/.test(stash),
    `uncommitted work stashed: ${stash}`
  );
  const stashed = sh(repo, 'git show stash@{0}:README.md');
  assert(stashed.includes('uncommitted edit'), 'tracked edit in the stash');
  // `git apply --index` stages new files, so untracked work lands in the stash tree itself.
  const untracked = sh(repo, 'git show "stash@{0}:untracked-note.txt"');
  assert(untracked.includes('untracked work'), 'untracked file in the stash');
  assert(
    readdirSync(join(home, '.rose/project')).some((f) => /^uncommitted-r\d+\.patch$/.test(f)),
    'patch file kept'
  );

  // Resume (W5 hook): restoring into an existing workspace keeps the session's
  // branch and local work, and refreshes env files.
  sh(repo, 'git checkout -q -b agent-work && echo wip > agent-wip.txt');
  writeFileSync(join(repo, 'app', '.env.local'), 'LOCALLY_EDITED=1\n');
  const stashesBefore = sh(repo, 'git stash list').split('\n').filter(Boolean).length;
  const resumed = await restoreWorkspace(taskId, await prepareSessionProject(s.userId, project.id));
  assert(
    resumed.checkout.source === 'existing',
    `resume keeps the checkout: ${resumed.checkout.source}`
  );
  assert(
    resumed.checkout.branch === 'agent-work',
    `resume keeps the branch: ${resumed.checkout.branch}`
  );
  assert(existsSync(join(repo, 'agent-wip.txt')), 'resume keeps uncommitted session work');
  const stashesAfter = sh(repo, 'git stash list').split('\n').filter(Boolean).length;
  assert(stashesAfter === stashesBefore, 'resume does not re-stash synced work');
  assert(
    readFileSync(join(repo, 'app', '.env.local'), 'utf8') === 'APP_MODE=staging\n',
    'resume rewrites env files from the project'
  );
  leakTexts.push(['resume report', JSON.stringify(resumed)]);

  const rerun = await runProjectStartup(taskId);
  assert(rerun.status === 'ok' && rerun.exitCode === 0, `rerun ok: ${JSON.stringify(rerun)}`);
  assert(rerun.outputTail.includes('[REDACTED]'), 'secret redacted in report');
  const logText = readFileSync(rerun.logPath, 'utf8');
  assert(mode(rerun.logPath) === '600', 'startup log is 0600');
  leakTexts.push(
    ['startup report', JSON.stringify(rerun)],
    ['startup log', logText],
    ['CLI prompt', prompt.stdin]
  );
  leakTexts.push([
    'startup-report.json',
    readFileSync(join(home, '.rose/project/startup-report.json'), 'utf8'),
  ]);

  const dbRows = await Promise.all([
    prisma.project.findMany({ where: { userId: s.userId } }),
    prisma.projectEnvFile.findMany({ where: { projectId: project.id } }),
    prisma.projectSyncSnapshot.findMany({ where: { projectId: project.id } }),
    prisma.claudeCodeSession.findMany({ where: { id: taskId } }),
  ]);
  const sessionRow = dbRows[3][0];
  assert(sessionRow?.projectId === project.id, 'session row records its project');
  leakTexts.push(['DB rows', JSON.stringify(dbRows)]);
});

registerSeedRoseCase({
  fixture,
  repoRoot: REPO_ROOT,
  secret: SECRET,
  roseSync: ROSE_SYNC,
  baseUrl: BASE_URL,
  leakTexts,
  sh,
  runChild,
});

test('startup failure and timeout are reported, and the timeout is enforced', async () => {
  installFakeClaude();
  const s = await anonymousSession();
  const remote = join(fixture, 'remote.git');
  const failing = await createProject(s, {
    name: 'PJ-Fail',
    repoUrl: remote,
    startupScript: 'echo failing now\nexit 3',
  });
  const slow = await createProject(s, {
    name: 'PJ-Timeout',
    repoUrl: remote,
    startupScript: 'echo begin\nsleep 30\necho never',
    startupTimeoutS: 2,
  });

  const fail = await startSession(s.userId, failing.id, 'fail');
  const failPrompt = JSON.parse(await waitForFile(fail.capture, 60_000)) as { stdin: string };
  assert(
    failPrompt.stdin.startsWith('/goal Project startup for project PJ-Fail FAILED (exit 3)'),
    `failure reaches the CLI: ${failPrompt.stdin.slice(0, 200)}`
  );
  assert(failPrompt.stdin.includes('failing now'), 'failure output tail included');
  const failReport = await runProjectStartup(fail.taskId);
  assert(
    failReport.status === 'failed' && failReport.exitCode === 3,
    `failed report ${JSON.stringify(failReport)}`
  );

  const slowSession = await startSession(s.userId, slow.id, 'timeout');
  const slowPrompt = JSON.parse(await waitForFile(slowSession.capture, 30_000)) as {
    stdin: string;
  };
  const elapsed = Date.now() - slowSession.started;
  assert(
    slowPrompt.stdin.startsWith('/goal Project startup for project PJ-Timeout TIMED OUT after 2s'),
    `timeout reaches the CLI: ${slowPrompt.stdin.slice(0, 200)}`
  );
  assert(elapsed < 20_000, `the session did not wait for the 30s script (${elapsed}ms)`);
  const t0 = Date.now();
  const report = await runProjectStartup(slowSession.taskId);
  assert(
    report.status === 'timeout' && report.timeoutS === 2,
    `timeout report ${JSON.stringify(report)}`
  );
  assert(Date.now() - t0 < 15_000, 'runProjectStartup enforced the timeout');
  assert(!report.outputTail.includes('never'), 'the script was stopped before finishing');
});

for (const template of ['claude-code', 'codex-code']) {
  test(`startup runner runs under the ${template} E2B HOME ("type": "module" package.json)`, async () => {
    // The E2B templates copy their package.json ("type": "module") into
    // /home/user; Node then loaded an extensionless CommonJS runner as an ES
    // module and every E2B project startup failed with "no report".
    const home = mkdtempSync(join(fixture, `${template}-home-`));
    copyFileSync(
      join(REPO_ROOT, 'e2b-templates', template, 'package.json'),
      join(home, 'package.json')
    );
    const sessionId = `e2b-home-${randomUUID()}`;
    registerWorkspaceExecutor(sessionId, localWorkspaceExecutor(home, process.env));
    try {
      await restoreWorkspace(sessionId, {
        project: {
          id: `${template}-home`,
          name: 'PJ-E2B-Home',
          repoUrl: null,
          defaultBranch: 'main',
          startupScript: 'echo started under the module-type home',
          startupTimeoutS: 30,
        },
        revision: 0,
        manifest: null,
        files: [],
        gitBundle: null,
        uncommittedPatch: null,
        redactions: [],
      });
      const report = await runProjectStartup(sessionId);
      assert(
        report.status === 'ok' && report.exitCode === 0,
        `startup ok under ${template} HOME: ${JSON.stringify(report)}`
      );
      assert(report.outputTail.includes('started under the module-type home'), 'script output');
    } finally {
      unregisterWorkspaceExecutor(sessionId);
    }
  });
}

test('resume re-points origin at the current clone URL (a rotated GitHub token reaches a paused session)', async () => {
  // The clone URL carries the backend GITHUB_TOKEN (session.ts withGithubToken).
  // A resumed workspace keeps its checkout, so its origin must be refreshed from
  // the URL resolved now; otherwise a rotated token leaves push/fetch failing.
  const remote = join(fixture, `rotation-${randomUUID()}.git`);
  sh(fixture, `git init -q --bare -b main ${remote}`);
  const seed = mkdtempSync(join(fixture, 'rotation-seed-'));
  sh(
    seed,
    `git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && git push -q ${remote} main`
  );
  const home = mkdtempSync(join(fixture, 'rotation-home-'));
  const sessionId = `rotation-${randomUUID()}`;
  const workspace = (cloneUrl: string) => ({
    project: {
      id: 'rotation',
      name: 'PJ-Token-Rotation',
      repoUrl: remote,
      defaultBranch: 'main',
      startupScript: null,
      startupTimeoutS: 30,
    },
    revision: 0,
    manifest: null,
    files: [],
    gitBundle: null,
    uncommittedPatch: null,
    redactions: [],
    cloneUrl,
  });
  registerWorkspaceExecutor(sessionId, localWorkspaceExecutor(home, process.env));
  try {
    const first = await restoreWorkspace(sessionId, workspace(remote));
    assert(first.checkout.cloned, `first restore clones: ${JSON.stringify(first.checkout)}`);
    const repo = join(home, 'workspace');
    const rotated = `file://${remote}`;
    const resumed = await restoreWorkspace(sessionId, workspace(rotated));
    assert(resumed.checkout.source === 'existing', 'resume keeps the checkout');
    const origin = sh(repo, 'git remote get-url origin').trim();
    assert(origin === rotated, `origin carries the current credentials: ${origin}`);
    assert(
      !JSON.stringify(resumed).includes(rotated),
      'the credentialed URL never appears in the report'
    );
  } finally {
    unregisterWorkspaceExecutor(sessionId);
  }
});

test('project CLI child yields the event loop, drains output and preserves failure status', async () => {
  let advanced = false;
  const heartbeat = setImmediate(() => {
    advanced = true;
  });
  try {
    const out = await runChild(process.execPath, [
      '-e',
      'setTimeout(() => { process.stdout.write("fixture stdout"); process.stderr.write("fixture stderr"); }, 25)',
    ]);
    assert(advanced, 'the parent event loop must run while the CLI child is pending');
    assert(
      out.status === 0 && out.stdout === 'fixture stdout' && out.stderr === 'fixture stderr',
      'the joined CLI child must preserve both output streams'
    );
    const failed = await runChild(process.execPath, [
      '-e',
      'process.stdout.write("partial output"); process.stderr.write("fixture failure"); process.exitCode = 7',
    ]);
    assert(
      failed.status === 7 &&
        failed.stdout === 'partial output' &&
        failed.stderr === 'fixture failure',
      'nonzero CLI exit remains a failure with its captured output'
    );
  } finally {
    clearImmediate(heartbeat);
  }
});

registerFilesOnlyRejectionCase({ fixture, roseSync: ROSE_SYNC, sh, runChild });

registerClaudeStartupReportCases({
  fixture,
  wsServer: WS_SERVER,
  installFakeClaude,
  waitForFile,
});

registerCodexProjectWorkspaceCases({
  fixture,
  secret: SECRET,
  remote: () => join(fixture, 'remote.git'),
  leakTexts,
  createProject,
});

registerProjectRefCase({ fixture, secret: SECRET, leakTexts, runSync, createProject });

test('secret-leak scan: fixture secret absent from every surface', async () => {
  const artifactDir = process.env.BLACKBOX_TEST_ARTIFACT_DIR;
  const backendLog =
    process.env.BLACKBOX_TEST_BACKEND_LOG ?? (artifactDir ? join(artifactDir, 'backend.log') : '');
  if (backendLog && existsSync(backendLog))
    leakTexts.push(['backend log', readFileSync(backendLog, 'utf8')]);
  assert(leakTexts.length >= 12, `expected every surface to be captured, got ${leakTexts.length}`);
  for (const [label, text] of leakTexts) {
    assert(!text.includes(SECRET), `fixture secret leaked into ${label}`);
  }
});
