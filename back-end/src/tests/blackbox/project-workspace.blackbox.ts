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
 *     enforced (the session does not hang)
 *   - secret-leak scan: the fixture secret never appears in API responses,
 *     CLI output, DB rows, startup log/report or the backend log
 *
 * Usage: bash scripts/run-blackbox-tests.sh project-workspace
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
import { prepareSessionProject } from '../../providers/projects/session';
import { runProjectStartup } from '../../providers/projects/workspace';
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
const ROSE_SYNC = join(REPO_ROOT, 'scripts', 'rose-sync');
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

function runSync(s: Session, args: string[]) {
  const out = spawnSync(process.execPath, [ROSE_SYNC, ...args, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROSE_TOKEN: s.token,
      ROSE_API_URL: BASE_URL,
      ROSE_API_KEY: '',
      ROSE_USER_ID: '',
    },
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
const { writeFileSync } = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  writeFileSync(process.env.FAKE_CLAUDE_CAPTURE_PATH, JSON.stringify({ cwd: process.cwd(), stdin }));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
});
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

  const first = runSync(s, ['push', '--dir', checkout, '--project', project.id]);
  assert(first.revision === 1, `first revision ${first.revision}`);
  assert(
    JSON.stringify([...first.written].sort()) === JSON.stringify(['.env', 'app/.env.local']),
    `first push writes both env files: ${first.written}`
  );
  assert(
    first.gitBundle === 'written' && first.uncommittedPatch === 'written',
    'artifacts written'
  );
  const second = runSync(s, ['push', '--dir', checkout, '--project', project.id]);
  assert(
    second.written.length === 0 && second.unchanged.length === 2,
    'no-op re-sync uploads nothing'
  );
  assert(
    second.gitBundle === 'unchanged' && second.uncommittedPatch === 'unchanged',
    'artifacts unchanged'
  );
  writeFileSync(join(checkout, 'app', '.env.local'), 'APP_MODE=staging\n');
  const third = runSync(s, ['push', '--dir', checkout, '--project', project.id]);
  assert(
    JSON.stringify(third.written) === JSON.stringify(['app/.env.local']),
    `only changed file: ${third.written}`
  );

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
    prompt.stdin.startsWith('Project startup for project PJ-Restore finished OK'),
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
  assert(/rose-sync uncommitted \(r3, feature\)/.test(stash), `uncommitted work stashed: ${stash}`);
  const stashed = sh(repo, 'git show stash@{0}:README.md');
  assert(stashed.includes('uncommitted edit'), 'tracked edit in the stash');
  // `git apply --index` stages new files, so untracked work lands in the stash tree itself.
  const untracked = sh(repo, 'git show "stash@{0}:untracked-note.txt"');
  assert(untracked.includes('untracked work'), 'untracked file in the stash');
  assert(existsSync(join(home, '.rose/project/uncommitted-r3.patch')), 'patch file kept');

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

test('seed-rose: Rose project gets its startup script and six env files (PJ4)', async () => {
  const s = await anonymousSession();
  const repo = join(fixture, 'rose-checkout');
  const fixtureScript = readFileSync(
    join(REPO_ROOT, 'agents/benchmarks/fixtures/projects/rose-startup.sh'),
    'utf8'
  );
  const outside = join(fixture, 'rose-outside');
  mkdirSync(outside, { recursive: true });
  sh(fixture, `git init -q -b main ${repo}`);
  mkdirSync(join(repo, 'agents/benchmarks/fixtures/projects'), { recursive: true });
  writeFileSync(join(repo, 'agents/benchmarks/fixtures/projects/rose-startup.sh'), fixtureScript);
  writeFileSync(join(repo, '.gitignore'), '.env\n.env.*\n');
  sh(repo, 'git -c user.name=t -c user.email=t@example.com add -A');
  sh(repo, 'git -c user.name=t -c user.email=t@example.com commit -qm init');
  // Andy's layout: env files are symlinks into a separate authoritative checkout.
  for (const rel of ['agents/.env', 'back-end/.env', 'agents/.env.benchmark-temporal']) {
    const real = join(outside, rel.replace(/\//g, '__'));
    writeFileSync(real, `SEEDED_${rel.replace(/[^A-Za-z]/g, '_').toUpperCase()}=${SECRET}\n`);
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    symlinkSync(real, join(repo, rel));
  }
  const out = spawnSync(process.execPath, [ROSE_SYNC, 'seed-rose', '--dir', repo, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ROSE_TOKEN: s.token, ROSE_API_URL: BASE_URL, ROSE_API_KEY: '' },
  });
  leakTexts.push(['seed-rose output', out.stdout + out.stderr]);
  assert(out.status === 0, `seed-rose failed: ${out.stderr}${out.stdout}`);
  const projects = await call('/api/projects', { auth: s.token });
  const rose = (projects.data.projects as Array<Record<string, unknown>>).find(
    (p) => p.name === 'Rose'
  );
  assert(rose, 'Rose project created');
  assert(rose.startupScript === fixtureScript, 'startup script is the checked-in fixture');
  assert(rose.defaultBranch === 'main' && rose.startupTimeoutS === 120, 'Rose defaults');
  const files = await call(`/api/projects/${String(rose.id)}/env-files`, { auth: s.token });
  leakTexts.push(['Rose env-files response', files.text]);
  const byPath = new Map(
    (files.data.envFiles as Array<{ path: string; source: string; hasContent: boolean }>).map(
      (f) => [f.path, f]
    )
  );
  const expected = [
    'agents/.env',
    'back-end/.env',
    'agents/.env.benchmark-temporal',
    'front-end/.env',
    'mac-app/.env',
    'research/.env',
  ];
  assert(byPath.size === expected.length, `six env files, got ${[...byPath.keys()]}`);
  for (const path of expected.slice(0, 3)) {
    assert(byPath.get(path)?.source === 'sync' && byPath.get(path)?.hasContent, `${path} synced`);
  }
  for (const path of expected.slice(3)) {
    assert(byPath.get(path)?.source === 'declared', `${path} declared, awaiting sync`);
  }
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
    failPrompt.stdin.startsWith('Project startup for project PJ-Fail FAILED (exit 3)'),
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
    slowPrompt.stdin.startsWith('Project startup for project PJ-Timeout TIMED OUT after 2s'),
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

test('secret-leak scan: fixture secret absent from every surface', async () => {
  const artifactDir = process.env.BLACKBOX_TEST_ARTIFACT_DIR;
  const backendLog =
    process.env.BLACKBOX_TEST_BACKEND_LOG ?? (artifactDir ? join(artifactDir, 'backend.log') : '');
  if (backendLog && existsSync(backendLog))
    leakTexts.push(['backend log', readFileSync(backendLog, 'utf8')]);
  assert(leakTexts.length >= 8, `expected every surface to be captured, got ${leakTexts.length}`);
  for (const [label, text] of leakTexts) {
    assert(!text.includes(SECRET), `fixture secret leaked into ${label}`);
  }
});
