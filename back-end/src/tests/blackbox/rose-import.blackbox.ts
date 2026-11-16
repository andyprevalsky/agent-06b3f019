#!/usr/bin/env tsx
/**
 * `rose import detect|scan|apply`: the Mac app's no-copy-paste import, run by
 * the real CLI against the isolated test backend. Fake `codex`, `claude`,
 * `security` and `gh` executables first on PATH record their argv and emit
 * canned output; HOME, git config and the Rose config dir are per case.
 *
 *   detect ─► {agents:[codex, claude], preferred}  (Codex before Claude)
 *   scan   ─► sign in with the one-time code ─► capture ─► local agent, READ-ONLY
 *              ─► plan validated against the checkout (no ../, no values) ─► plan event
 *   apply  ─► push (project, branch, includes, setup) ─► github import only when asked
 *              and needed ─► verify ─► done
 *
 * Invariants: one JSON object per stdout line; no secret value on any stream or
 * in any agent's argv; an unparsable plan is retried once, then an error; a
 * hung agent times out.
 *
 * Usage: bash scripts/run-blackbox-tests.sh rose-import
 */
// First import: refuses a non-local DATABASE_URL before any module can query.
import { BASE_URL, anonymousSession, assert, call } from './projects-harness';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import {
  DB_SECRET,
  GH_TOKEN,
  GOOD_PLAN,
  SECRET,
  SLUG,
  checkout,
  loginCode,
  noSecrets,
  rose,
  scan,
  signedInWorld,
  world,
} from './rose-import-harness';
import './rose-import-live.cases';

// ── detect ──────────────────────────────────────────────────────────────────
test('import detect: which local agents are signed in and runnable, Codex first', async () => {
  const none = world('detect-none', {});
  const empty = await rose(none.env, ['import', 'detect', '--json']);
  assert(empty.code === 0, empty.stderr);
  assert(
    JSON.stringify(empty.events) ===
      JSON.stringify([
        {
          agents: [
            { id: 'codex', label: 'Codex', signedIn: false, binary: null },
            { id: 'claude', label: 'Claude Code', signedIn: false, binary: null },
          ],
          preferred: null,
        },
      ]),
    `nothing installed: ${empty.stdout}`
  );

  const both = world('detect-both');
  mkdirSync(join(both.home, '.codex'));
  writeFileSync(
    join(both.home, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { refresh_token: 'r' } })
  );
  mkdirSync(join(both.home, '.claude'));
  writeFileSync(join(both.home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}');
  const preferred = (await rose(both.env, ['import', 'detect', '--json'])).events[0];
  assert(preferred.preferred === 'codex', `Codex before Claude: ${JSON.stringify(preferred)}`);
  assert(
    preferred.agents?.every((a) => a.signedIn && a.binary === join(both.dir, 'bin', a.id)),
    `both usable: ${JSON.stringify(preferred)}`
  );

  // Codex present but signed out (no tokens, no key); Claude via the Keychain item.
  const keychain = world('detect-keychain');
  mkdirSync(join(keychain.home, '.codex'));
  writeFileSync(join(keychain.home, '.codex', 'auth.json'), '{"tokens":null}');
  const viaKeychain = (
    await rose({ ...keychain.env, FAKE_KEYCHAIN: 'present' }, ['import', 'detect', '--json'])
  ).events[0];
  assert(viaKeychain.preferred === 'claude', JSON.stringify(viaKeychain));
  assert(viaKeychain.agents?.[0].signedIn === false, 'tokens:null is signed out');
  const securityCall = keychain.calls().find((c) => c.bin === 'security');
  assert(
    securityCall !== undefined &&
      securityCall.args.includes('Claude Code-credentials') &&
      !securityCall.args.includes('-w'),
    `Keychain checked by exit code only: ${JSON.stringify(securityCall)}`
  );

  // CODEX_HOME, CLAUDE_CONFIG_DIR and ANTHROPIC_API_KEY; a binary whose --version fails.
  const custom = world('detect-custom');
  const codexHome = join(custom.dir, 'codex-home');
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
  const claudeDir = join(custom.dir, 'claude-config');
  mkdirSync(claudeDir);
  writeFileSync(join(claudeDir, '.credentials.json'), '{}');
  const configured = (
    await rose(
      {
        ...custom.env,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeDir,
        FAKE_VERSION_FAIL: 'codex',
      },
      ['import', 'detect', '--json']
    )
  ).events[0];
  assert(configured.agents?.[0].signedIn === true, 'CODEX_HOME auth.json with a key');
  assert(configured.agents?.[0].binary === null, 'a codex whose --version fails is not runnable');
  assert(configured.agents?.[1].signedIn === true, 'CLAUDE_CONFIG_DIR credentials');
  assert(configured.preferred === 'claude', JSON.stringify(configured));
  const apiKey = world('detect-api-key', { claude: true });
  const keyed = (
    await rose({ ...apiKey.env, ANTHROPIC_API_KEY: 'sk-ant-x' }, ['import', 'detect', '--json'])
  ).events[0];
  assert(
    keyed.agents?.[1].signedIn === true && keyed.preferred === 'claude',
    JSON.stringify(keyed)
  );
  noSecrets('detect', empty.stdout, JSON.stringify(keyed));
});

// ── scan ────────────────────────────────────────────────────────────────────
test('import scan (codex): signs in, captures, runs Codex read-only and emits a validated plan', async () => {
  const s = await anonymousSession();
  const w = signedInWorld('scan-codex');
  const repo = checkout(w.dir, 'app');
  await prisma.githubRepoAccess.create({
    data: { userId: s.userId, repoUrl: `https://github.com/${SLUG}/app` },
  });
  // The Mac app's contract: the one-time code in ROSE_LOGIN_CODE (argv shows in `ps`), run with
  // Electron's Node (ELECTRON_RUN_AS_NODE); neither may reach git or the agent.
  const code = await loginCode(s);
  const result = await scan(w, repo, ['--agent', 'codex'], {
    FAKE_PLAN: JSON.stringify(GOOD_PLAN),
    ROSE_LOGIN_CODE: code,
    ELECTRON_RUN_AS_NODE: '1',
  });
  assert(result.code === 0, `scan failed: ${result.stdout}${result.stderr}`);
  const agentCalls = w.calls().filter((c) => c.bin === 'codex');
  assert(
    agentCalls.length > 0 && agentCalls.every((c) => (c.leaked ?? []).length === 0),
    `nothing leaks to the agent: ${JSON.stringify(agentCalls.map((c) => c.leaked))}`
  );
  assert(!JSON.stringify(w.calls()).includes(code), 'the one-time code never reaches a child');
  const stages = result.events.filter((e) => e.event === 'progress').map((e) => e.stage);
  assert(
    JSON.stringify([...new Set(stages)]) === JSON.stringify(['signin', 'capture', 'scan']),
    `progress stages ${stages}`
  );
  const planEvent = result.events.at(-1)!;
  assert(planEvent.event === 'plan' && planEvent.agent === 'codex', result.stdout);
  const plan = planEvent.plan!;
  assert(plan.projectName === 'Import Fixture' && plan.branch === 'develop', JSON.stringify(plan));
  assert(
    JSON.stringify(plan.repo) ===
      JSON.stringify({
        remoteUrl: `https://github.com/${SLUG}/app.git`,
        githubRepo: `${SLUG}/app`,
      }),
    JSON.stringify(plan.repo)
  );
  assert(
    JSON.stringify(plan.envFiles) ===
      JSON.stringify([{ path: '.env', variables: ['APP_SECRET', 'DATABASE_URL'] }]),
    `env files with names only: ${JSON.stringify(plan.envFiles)}`
  );
  assert(plan.extraFiles[0]?.path === 'config/local.json', JSON.stringify(plan.extraFiles));
  assert(
    JSON.stringify(plan.setupCommands) === JSON.stringify(['npm ci', 'npm run build']),
    JSON.stringify(plan.setupCommands)
  );
  assert(
    JSON.stringify(plan.github) ===
      JSON.stringify({ status: 'reachable_rose', login: null, canImport: false }),
    JSON.stringify(plan.github)
  );
  const exec = w.calls().find((c) => c.bin === 'codex' && c.args[0] === 'exec');
  assert(exec !== undefined, 'codex exec ran');
  const args = exec.args;
  for (const [flag, value] of [
    ['--sandbox', 'read-only'],
    ['-C', repo],
  ]) {
    assert(args[args.indexOf(flag) + 1] === value, `${flag} ${value}: ${args.join(' ')}`);
  }
  assert(
    args.includes('--skip-git-repo-check') &&
      args.includes('--output-schema') &&
      args.includes('-o'),
    args.join(' ')
  );
  const prompt = args.at(-1)!;
  assert(prompt.includes('APP_SECRET') && prompt.includes('DATABASE_URL'), 'the prompt has names');
  assert(/Never open, read, print or quote/.test(prompt), 'the prompt forbids reading secrets');
  noSecrets('scan codex', result.stdout, result.stderr, JSON.stringify(w.calls()));
});

test('import scan (claude): plan mode, .env reads denied, JSON parsed from the final result', async () => {
  const s = await anonymousSession();
  const w = signedInWorld('scan-claude');
  const repo = checkout(w.dir, 'app');
  const result = await scan(w, repo, ['--agent', 'claude', '--login-code', await loginCode(s)], {
    FAKE_PLAN: JSON.stringify(GOOD_PLAN),
    FAKE_GH_TOKEN: GH_TOKEN,
  });
  assert(result.code === 0, `scan failed: ${result.stdout}${result.stderr}`);
  const plan = result.events.at(-1)!.plan!;
  assert(result.events.at(-1)?.agent === 'claude' && plan.branch === 'develop', result.stdout);
  assert(plan.github.canImport === true, 'a local gh credential can be imported');
  assert(
    plan.github.status === 'unreachable' || plan.github.status === 'reachable_rose',
    plan.github.status
  );
  const run = w.calls().find((c) => c.bin === 'claude' && c.args[0] === '-p');
  assert(run !== undefined, 'claude -p ran');
  const args = run.args;
  assert(args[args.indexOf('--output-format') + 1] === 'json', args.join(' '));
  assert(args[args.indexOf('--permission-mode') + 1] === 'plan', args.join(' '));
  const denied = args[args.indexOf('--disallowedTools') + 1] ?? '';
  assert(denied.includes('.env') && denied.includes('Bash'), `denied tools: ${denied}`);
  noSecrets('scan claude', result.stdout, result.stderr, JSON.stringify(w.calls()));
});

test('import scan: a malicious plan is clamped to the checkout and never carries values', async () => {
  const s = await anonymousSession();
  const w = signedInWorld('scan-malicious');
  const repo = checkout(w.dir, 'app');
  const malicious = {
    projectName: `x\n${'y'.repeat(500)}`,
    branch: '--upload-pack=evil',
    envFiles: [
      '../outside.env',
      '/etc/passwd',
      '.env',
      'config/../../outside.env',
      `.env=${SECRET}`,
    ],
    extraFiles: [
      { path: '../outside.env', reason: 'escape' },
      { path: 'config/local.json', reason: `needs ${SECRET}` },
      { path: 'missing.json', reason: 'does not exist' },
    ],
    setupCommands: [`export APP_SECRET=${SECRET}`, 'npm ci', 'line one\nline two'],
    notes: [`the database is ${DB_SECRET}`, 'ok note'],
  };
  const result = await scan(w, repo, ['--agent', 'codex', '--login-code', await loginCode(s)], {
    FAKE_PLAN: JSON.stringify(malicious),
  });
  assert(result.code === 0, `scan failed: ${result.stdout}${result.stderr}`);
  const plan = result.events.at(-1)!.plan!;
  assert(plan.projectName === 'app', `bad name falls back to the folder: ${plan.projectName}`);
  assert(plan.branch === 'develop', `bad branch falls back to the remote default: ${plan.branch}`);
  assert(
    JSON.stringify(plan.envFiles.map((f) => f.path)) === JSON.stringify(['.env']),
    JSON.stringify(plan.envFiles)
  );
  assert(
    plan.extraFiles.length === 0,
    `escaping, valued or missing extras dropped: ${JSON.stringify(plan.extraFiles)}`
  );
  assert(
    JSON.stringify(plan.setupCommands) === JSON.stringify(['npm ci']),
    JSON.stringify(plan.setupCommands)
  );
  assert(JSON.stringify(plan.notes) === JSON.stringify(['ok note']), JSON.stringify(plan.notes));
  noSecrets('malicious plan', result.stdout, result.stderr);
});

test('import scan: unparsable output is retried once, then a clear error; a hung agent times out', async () => {
  const s = await anonymousSession();
  const w = signedInWorld('scan-retry');
  const repo = checkout(w.dir, 'app');
  const recovered = await scan(w, repo, ['--agent', 'codex', '--login-code', await loginCode(s)], {
    FAKE_PLAN: JSON.stringify(GOOD_PLAN),
    FAKE_AGENT_MODE: 'garbage-once',
  });
  assert(recovered.events.at(-1)?.event === 'plan', `retried: ${recovered.stdout}`);
  assert(
    w.calls().filter((c) => c.bin === 'codex' && c.args[0] === 'exec').length === 2,
    'one retry'
  );

  const failing = signedInWorld('scan-garbage');
  const repo2 = checkout(failing.dir, 'app');
  const failed = await scan(
    failing,
    repo2,
    ['--agent', 'claude', '--login-code', await loginCode(s)],
    {
      FAKE_AGENT_MODE: 'garbage',
    }
  );
  assert(failed.code !== 0, 'a failed scan exits non-zero');
  const error = failed.events.at(-1)!;
  assert(
    error.event === 'error' && /could not produce a valid import plan/.test(error.message ?? ''),
    failed.stdout
  );
  assert(
    failing.calls().filter((c) => c.bin === 'claude' && c.args[0] === '-p').length === 2,
    'two attempts'
  );

  const hung = signedInWorld('scan-hang');
  const repo3 = checkout(hung.dir, 'app');
  const started = Date.now();
  const timedOut = await scan(
    hung,
    repo3,
    ['--agent', 'codex', '--login-code', await loginCode(s)],
    {
      FAKE_AGENT_MODE: 'hang',
      ROSE_IMPORT_AGENT_TIMEOUT_MS: '1500',
    }
  );
  assert(Date.now() - started < 30_000, 'never hangs');
  const timeout = timedOut.events.at(-1)!;
  assert(timeout.event === 'error' && /timed out/.test(timeout.message ?? ''), timedOut.stdout);
  noSecrets('retry/timeout', recovered.stdout, failed.stdout, timedOut.stdout, failed.stderr);
});

// ── apply ───────────────────────────────────────────────────────────────────
test('import apply: uploads the plan, imports GitHub access only when asked, verifies, done', async () => {
  const s = await anonymousSession();
  const w = signedInWorld('apply');
  const repo = checkout(w.dir, 'app');
  await prisma.githubRepoAccess.create({
    data: { userId: s.userId, repoUrl: `https://github.com/${SLUG}/app` },
  });
  const scanned = await scan(w, repo, ['--agent', 'codex', '--login-code', await loginCode(s)], {
    FAKE_PLAN: JSON.stringify(GOOD_PLAN),
  });
  const planLine = scanned.stdout.trim().split('\n').at(-1)!;
  const planFile = join(w.dir, 'plan.json');
  writeFileSync(planFile, planLine);
  const ghCalls = () => w.calls().filter((c) => c.bin === 'gh').length;
  const ghBefore = ghCalls();
  const applied = await rose({ ...w.env, FAKE_GH_TOKEN: GH_TOKEN }, [
    'import',
    'apply',
    '--dir',
    repo,
    '--plan',
    planFile,
    '--api',
    BASE_URL,
    '--json',
  ]);
  assert(applied.code === 0, `apply failed: ${applied.stdout}${applied.stderr}`);
  const stages = applied.events.filter((e) => e.event === 'progress').map((e) => e.stage);
  assert(
    JSON.stringify([...new Set(stages)]) === JSON.stringify(['upload', 'verify']),
    `no github step unless asked: ${stages}`
  );
  const done = applied.events.at(-1)!;
  assert(done.event === 'done' && done.project?.name === 'Import Fixture', applied.stdout);
  const projectId = done.project!.id;
  const project = await call(`/api/projects/${projectId}`, { auth: s.token });
  assert(project.data.defaultBranch === 'develop', `starting branch: ${project.text}`);
  const files = await call(`/api/projects/${projectId}/env-files`, { auth: s.token });
  const paths = (files.data.envFiles as Array<{ path: string; hasContent: boolean }>)
    .filter((f) => f.hasContent)
    .map((f) => f.path)
    .sort();
  assert(
    JSON.stringify(paths) === JSON.stringify(['.env', 'config/local.json']),
    `uploaded ${paths}`
  );
  const sync = await call(`/api/projects/${projectId}/sync`, { auth: s.token });
  const commands = (sync.data.manifest as { setup: { commands: string[] } }).setup.commands;
  assert(
    JSON.stringify(commands) === JSON.stringify(['npm ci', 'npm run build']),
    JSON.stringify(commands)
  );
  assert(ghCalls() === ghBefore, 'apply without --github-import never asks gh');

  const applyArgs = (dir: string, ...extra: string[]) => [
    'import',
    'apply',
    '--dir',
    dir,
    '--plan',
    '-',
    ...extra,
    '--api',
    BASE_URL,
    '--json',
  ];
  // The user's gh token by default: --github-import imports the local credential even
  // when Rose can already reach the repo (here a granted one).
  const reachable = await rose(
    { ...w.env, FAKE_GH_TOKEN: GH_TOKEN },
    applyArgs(repo, '--github-import'),
    planLine
  );
  const githubSteps = reachable.events.filter((e) => e.stage === 'github');
  assert(
    githubSteps.some((e) => /Uploading this computer's GitHub credential/.test(e.message ?? '')),
    `imported although reachable: ${reachable.stdout}`
  );
  assert(ghCalls() > ghBefore, 'the local gh credential was read');
  // The test backend verifies the token with GitHub, which rejects this fake one: an
  // error after the upload.
  const last = reachable.events.at(-1)!;
  assert(
    last.event === 'done' || (last.event === 'error' && /GitHub/.test(last.message ?? '')),
    reachable.stdout
  );

  // Another checkout: without the flag gh is never asked; with it but no local
  // credential, the step is skipped with a note and the import still finishes.
  const other = signedInWorld('apply-github');
  const unreachable = checkout(other.dir, 'unreachable');
  const plan = JSON.stringify({ ...JSON.parse(planLine).plan, projectName: `Unreachable ${SLUG}` });
  const signin = await rose(other.env, [
    'agent-init',
    '--login-code',
    await loginCode(s),
    '--dir',
    unreachable,
    '--api',
    BASE_URL,
  ]);
  assert(signin.code === 0, signin.stderr);
  const withoutFlag = await rose(
    { ...other.env, FAKE_GH_TOKEN: GH_TOKEN },
    applyArgs(unreachable),
    plan
  );
  assert(withoutFlag.events.at(-1)?.event === 'done', withoutFlag.stdout);
  assert(!other.calls().some((c) => c.bin === 'gh'), 'gh is never asked without --github-import');
  const noCredential = await rose(other.env, applyArgs(unreachable, '--github-import'), plan);
  assert(
    noCredential.events.some(
      (e) => e.stage === 'github' && /No GitHub credential on this computer/.test(e.message ?? '')
    ),
    noCredential.stdout
  );
  assert(noCredential.events.at(-1)?.event === 'done', noCredential.stdout);
  noSecrets(
    'apply',
    applied.stdout,
    applied.stderr,
    reachable.stdout,
    reachable.stderr,
    withoutFlag.stdout,
    noCredential.stdout
  );
});
