#!/usr/bin/env tsx
/**
 * Black-box contract for read-only code inspection (explore `inspect_code`,
 * L-EXPLORE-CODE): a short-lived code agent answers a question about a code
 * session's latest checkpoint without touching the live session.
 *
 *   live session (real git repo, leased, paused sandbox id) ──checkpoint──► local object store
 *   inspectCodeSession ──► throwaway "sandbox" (fresh local HOME) ──restore + guards──►
 *     scripted claude / codex CLI on PATH: reads files, tries commit / push / merge / gh,
 *     writes a scratch file, answers with citations
 *   asserts: answer + verified citations, live row / HEAD / storage unchanged, every
 *            attempt blocked, nothing checkpointed back, sandbox killed exactly once
 *            (success, CLI failure, restore failure), foreign sessions 404, C15 fall-over
 *   running backend ──HTTP──► route wiring: 400 / 404 / 409 before any sandbox exists
 *
 * Hermetic: local checkpoint storage, fake keys, no E2B, GitHub or provider calls.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Sandbox } from 'e2b';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import {
  __resetAnthropicApiKeyCooldown,
  isAnthropicApiKeyOnCooldown,
} from '../../providers/computeCredentials';
import { checkpointCodeSession } from '../../providers/codeSessions/lifecycle';
import { localSandboxFs, type CodeSessionFs } from '../../providers/codeSessions/sandboxFs';
import {
  CodeInspectError,
  inspectCodeSession,
  setCodeInspectSandboxFactoryForTests,
} from '../../providers/codeSessions/inspect';
import { fakeInspectCli } from './code-session-inspect.fake-cli';
import { beginIsolatedFundedKeyCooldowns } from './funded-key-cooldown.support';

config();

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3001';
const apiKey = process.env.BACKEND_API_KEY || '';
const fixtureDir = mkdtempSync(join(tmpdir(), 'code-inspect-blackbox-'));
const fakeBin = join(fixtureDir, 'bin');
const cliLog = join(fixtureDir, 'cli-runs.jsonl');
const modeFile = join(fixtureDir, 'cli-mode');
const storageDir = join(fixtureDir, 'storage');
const userA = `code-inspect-a-${randomUUID()}`;
const userB = `code-inspect-b-${randomUUID()}`;
const agentA = randomUUID();
const agentB = randomUUID();
const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const ENV_KEYS = [
  'CODE_SESSION_STORAGE_BACKEND',
  'CODE_SESSION_STORAGE_LOCAL_DIR',
  'ANTHROPIC_API_KEY',
  'GPT_API_KEY',
  'AZURE_FOUNDRY_ENDPOINT_3',
  'AZURE_FOUNDRY_API_KEY_3',
  'AZURE_FOUNDRY_DEPLOYMENTS_3',
  'CODEX_AZURE_FOUNDRY_HOST',
  'CODEX_AZURE_DEPLOYMENT',
  'CODE_INSPECT_CODEX_MODEL',
  'CODEX_CODE_MODEL',
  'CODEX_REASONING_EFFORT',
  // Only the test-owned slot 3 may serve the Codex deployment.
  ...['', '_2', '_4', '_5', '_6', '_7', '_8', '_9'].flatMap((slot) => [
    `AZURE_FOUNDRY_ENDPOINT${slot}`,
    `AZURE_FOUNDRY_API_KEY${slot}`,
  ]),
  'CLAUDE_CODE_ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CREDENTIAL_DECRYPTION_KEY',
] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);
const originalConnect = Sandbox.connect.bind(Sandbox);
let liveConnects = 0;
// The hermetic CLIs own private funded-key cooldowns for the whole fixture lifecycle.
// Parallel suites continue reading and writing their real shared rows.
let finishFundedCooldownIsolation: (() => Promise<void>) | null = null;

const FAKE_CLI = fakeInspectCli({ cliLog, modeFile, realGit });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A bare origin with main pushed; `<home>/workspace` on a local branch with a local commit and edits. */
function seedWorkspace(home: string): { origin: string } {
  const origin = join(fixtureDir, `origin-${randomUUID()}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const workspace = join(home, 'workspace');
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['clone', '-q', origin, workspace], { stdio: 'ignore' });
  git(workspace, 'config', 'user.name', 'Test');
  git(workspace, 'config', 'user.email', 'test@example.com');
  git(workspace, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(workspace, 'README.md'), 'line one\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'initial');
  git(workspace, 'push', '-q', 'origin', 'main');
  git(workspace, 'checkout', '-q', '-b', 'rose/feature-1');
  writeFileSync(join(workspace, 'feature.txt'), 'committed locally\n');
  git(workspace, 'add', 'feature.txt');
  git(workspace, 'commit', '-q', '-m', 'local commit');
  writeFileSync(join(workspace, 'README.md'), 'line one\nuncommitted edit\n');
  writeFileSync(join(home, 'CLAUDE.md'), '# template scaffolding: commit and message the user\n');
  return { origin };
}

/** A live, leased code session of userA with one checkpoint of `home`. */
async function liveSession(home: string) {
  const session = await prisma.codeSession.create({
    data: {
      userId: userA,
      rootAgentId: agentA,
      ownerAgentId: agentA,
      repoKey: `inspect-${randomUUID()}`,
      codeProvider: 'claude',
      branch: 'rose/feature-1',
      mergeTarget: 'main',
      state: 'ACTIVE',
      sandboxKind: 'e2b',
      sandboxId: `sb-live-${randomUUID()}`,
      leaseOwner: 'tool:live:1',
      leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const checkpoint = await checkpointCodeSession({
    session,
    fs: localSandboxFs(home),
    reason: 'close',
    agentId: agentA,
  });
  assert.equal(checkpoint?.seq, 1, 'the live session has one checkpoint');
  return prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
}

interface FakeSandbox {
  id: string;
  provider: string;
  home: string;
  kills: number;
  killedAtMs: number | null;
}

const sandboxes: FakeSandbox[] = [];

/** Each inspection gets a fresh HOME; `kill` records and deletes it (E2B kill). */
function installFakeFactory(): void {
  setCodeInspectSandboxFactoryForTests(async (provider) => {
    const home = mkdtempSync(join(fixtureDir, 'inspect-home-'));
    const base = localSandboxFs(home);
    const fs: CodeSessionFs = {
      ...base,
      exec: (script, opts) => base.exec(`export PATH=${fakeBin}:"$PATH"\n${script}`, opts),
    };
    const record: FakeSandbox = {
      id: `sb-inspect-${randomUUID()}`,
      provider,
      home,
      kills: 0,
      killedAtMs: null,
    };
    sandboxes.push(record);
    return {
      fs,
      sandboxId: record.id,
      kill: async () => {
        record.kills += 1;
        record.killedAtMs ??= Date.now();
        rmSync(home, { recursive: true, force: true });
      },
    };
  });
}

/** What one scripted CLI run saw (written by FAKE_CLI). */
interface CliRun {
  cli: string;
  argv: string[];
  cwd: string;
  prompt: string;
  mode: string;
  path0: string;
  anthropic_key: string;
  openai_key: boolean;
  azure_key: string;
  github_token: boolean;
  env_file_left: boolean;
  home_claude_md: boolean;
  attempts?: Record<string, { cmd: string; rc: number; out: string; err: string }>;
  head_before?: string;
  head_after?: string;
  remote?: string;
  slow_done_ms?: number;
}

function cliRuns(): CliRun[] {
  if (!existsSync(cliLog)) return [];
  return readFileSync(cliLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliRun);
}

function setMode(mode: string): void {
  writeFileSync(modeFile, mode);
}

function storedSeqs(userId: string, codeSessionId: string): string[] {
  const dir = join(storageDir, 'user', userId, 'code-sessions', codeSessionId);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

async function http(method: string, path: string, userId: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'X-User-Id': userId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: response.status, data: data as Record<string, unknown> };
}

before(async () => {
  finishFundedCooldownIsolation = await beginIsolatedFundedKeyCooldowns();
  process.env.CODE_SESSION_STORAGE_BACKEND = 'local';
  process.env.CODE_SESSION_STORAGE_LOCAL_DIR = storageDir;
  // Fake funded keys; no decryption key, so no stored credential is ever decrypted.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-inspect-test-key-0000000000000000';
  process.env.GPT_API_KEY = 'sk-inspect-test-openai';
  // The funded Codex provider is the region deploying gpt-6.1-sol, never GPT_API_KEY.
  process.env.AZURE_FOUNDRY_ENDPOINT_3 = 'https://rose-foundry-southcentralus.openai.azure.com';
  process.env.AZURE_FOUNDRY_API_KEY_3 = 'azure-inspect-test-key';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS_3 = 'gpt-6.1-sol';
  for (const key of ENV_KEYS) {
    if (
      !/^(AZURE_FOUNDRY_(ENDPOINT|API_KEY)(_[24-9])?|CODEX_\w+|CODE_INSPECT_CODEX_MODEL)$/.test(key)
    )
      continue;
    delete process.env[key];
  }
  for (const key of [
    'CLAUDE_CODE_ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CREDENTIAL_DECRYPTION_KEY',
  ]) {
    delete process.env[key];
  }
  mkdirSync(fakeBin, { recursive: true });
  for (const cli of ['claude', 'codex']) {
    writeFileSync(join(fakeBin, cli), FAKE_CLI);
    chmodSync(join(fakeBin, cli), 0o755);
  }
  // The inspection must never attach to (and so resume) the live paused sandbox.
  (Sandbox as unknown as { connect: (id: string) => Promise<Sandbox> }).connect = async () => {
    liveConnects += 1;
    throw new Error('the live sandbox must not be connected');
  };
  installFakeFactory();
  await prisma.user.create({ data: { userId: userA, name: 'Inspect A' } });
  await prisma.user.create({ data: { userId: userB, name: 'Inspect B' } });
  await prisma.agent.create({ data: { id: agentA, userId: userA, goal: 'Build the feature' } });
  await prisma.agent.create({ data: { id: agentB, userId: userB, goal: 'Someone else' } });
});

after(async () => {
  try {
    setCodeInspectSandboxFactoryForTests(null);
    (Sandbox as unknown as { connect: typeof originalConnect }).connect = originalConnect;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.codeSession.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.agent.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.user.deleteMany({ where: { userId: { in: [userA, userB] } } });
    rmSync(fixtureDir, { recursive: true, force: true });
  } finally {
    try {
      await finishFundedCooldownIsolation?.();
    } finally {
      await prisma.$disconnect();
    }
  }
});

test('an inspection restores the latest checkpoint into its own sandbox and answers with verified citations; the live session is untouched', async () => {
  setMode('answer');
  const liveHome = join(fixtureDir, 'live-home');
  seedWorkspace(liveHome);
  const live = await liveSession(liveHome);
  const liveHead = git(join(liveHome, 'workspace'), 'rev-parse', 'HEAD');
  const seqsBefore = storedSeqs(userA, live.id);
  const runsBefore = cliRuns().length;
  const sandboxesBefore = sandboxes.length;

  const result = await inspectCodeSession({
    userId: userA,
    agentId: agentA,
    codeSessionId: live.id,
    question: 'What does feature.txt say?',
  });
  console.log(
    `[code-inspect] startup_ms=${result.timings.startup_ms} (sandbox ${result.timings.sandbox_ms}, ` +
      `restore ${result.timings.restore_ms}, guards ${result.timings.guard_ms}) cli_ms=${result.timings.cli_ms} ` +
      `total_ms=${result.timings.total_ms}`
  );

  assert.equal(result.status, 'answered', JSON.stringify(result));
  assert.equal(result.provider, 'claude');
  assert.equal(result.checkpoint_seq, 1);
  assert.equal(result.branch, 'rose/feature-1');
  assert.equal(result.head, liveHead, 'the inspected HEAD is the checkpoint HEAD');
  assert.match(result.answer ?? '', /feature\.txt holds: committed locally/);
  assert.deepEqual(result.citations, [
    { path: 'feature.txt', line: 1, end_line: null },
    { path: 'README.md', line: 1, end_line: 2 },
  ]);
  assert.deepEqual(result.unverified_citations, ['missing/nowhere.ts:9', '../escape.txt:1']);
  assert.ok(result.timings.startup_ms > 0, 'startup time is recorded');
  assert.equal(
    result.timings.startup_ms >= result.timings.sandbox_ms + result.timings.restore_ms,
    true
  );

  const run = cliRuns()[runsBefore];
  assert.ok(run, 'the inspector CLI ran');
  assert.equal(run.cwd.endsWith('/workspace'), true, 'the CLI runs in the restored repo');
  assert.match(run.prompt, /What does feature\.txt say\?/);
  assert.equal(run.anthropic_key, 'sk-ant-inspect-test-key-0000000000000000');
  assert.equal(run.env_file_left, false, 'the credential env file is gone before the CLI starts');
  assert.equal(run.github_token, false, 'no GitHub token reaches the inspector');
  assert.equal(run.home_claude_md, false, 'the code-agent template instructions are removed');
  assert.ok(
    String(run.path0).endsWith('/.rose-inspect/bin'),
    'the guard wrappers come first on PATH'
  );
  const argv = run.argv;
  assert.equal(
    argv[argv.indexOf('--effort') + 1],
    'xhigh',
    'Claude inspector inherits Ultra effort'
  );
  assert.ok(argv.includes('--strict-mcp-config'), 'no MCP servers (Rose user-facing tools)');
  for (const denied of [
    'Write',
    'Edit',
    'Skill',
    'Bash(git commit:*)',
    'Bash(git push:*)',
    'Bash(gh:*)',
  ]) {
    assert.ok(argv.includes(denied), `claude denies ${denied}`);
  }
  assert.ok(!argv.includes('--resume'), 'a fresh conversation, never the live CLI session');
  assert.ok(argv.includes('--append-system-prompt'));

  // The live session: lease, branch, state, sandbox, checkpoint counters and HEAD unchanged.
  const after = await prisma.codeSession.findUniqueOrThrow({ where: { id: live.id } });
  for (const field of [
    'state',
    'leaseOwner',
    'branch',
    'mergeTarget',
    'sandboxKind',
    'sandboxId',
    'cliSessionId',
    'latestCheckpointSeq',
    'nextCheckpointSeq',
    'codeProvider',
  ] as const) {
    assert.deepEqual(after[field], live[field], `live session ${field} unchanged`);
  }
  assert.equal(
    after.leaseExpiresAt?.getTime(),
    live.leaseExpiresAt?.getTime(),
    'lease not extended'
  );
  assert.equal(after.lastActiveAt.getTime(), live.lastActiveAt.getTime(), 'TTL clock not touched');
  assert.deepEqual(after.lastRepoFacts, live.lastRepoFacts);
  assert.equal(git(join(liveHome, 'workspace'), 'rev-parse', 'HEAD'), liveHead);
  assert.equal(existsSync(join(liveHome, 'workspace', 'inspector-scratch.txt')), false);
  assert.deepEqual(storedSeqs(userA, live.id), seqsBefore, 'nothing is checkpointed back');
  assert.equal(liveConnects, 0, 'the live (paused) sandbox is never attached');

  // Teardown: exactly one sandbox, killed exactly once, its files gone.
  const created = sandboxes.slice(sandboxesBefore);
  assert.equal(created.length, 1);
  assert.equal(created[0].kills, 1, 'the inspection sandbox is killed');
  assert.equal(existsSync(created[0].home), false);
  assert.equal(result.sandbox_id, created[0].id);
});

test('commit, push, merge and gh are blocked inside the inspection; reads still work', async () => {
  setMode('answer');
  const liveHome = join(fixtureDir, 'live-home-guards');
  seedWorkspace(liveHome);
  const live = await liveSession(liveHome);
  const runsBefore = cliRuns().length;
  const result = await inspectCodeSession({
    userId: userA,
    agentId: agentA,
    codeSessionId: live.id,
    question: 'Try to change things.',
  });
  assert.equal(result.status, 'answered', JSON.stringify(result));
  const run = cliRuns()[runsBefore];
  const attempts = run.attempts;
  assert.ok(attempts, 'the scripted CLI recorded its attempts');
  assert.equal(attempts.read.rc, 0, 'read-only git still works');
  assert.equal(attempts.read.out, 'local commit');
  for (const name of ['commit', 'push', 'merge', 'direct_commit', 'gh']) {
    assert.notEqual(attempts[name].rc, 0, `${name} must fail: ${JSON.stringify(attempts[name])}`);
    assert.match(attempts[name].err, /read-only code inspection/, `${name} is refused by a guard`);
  }
  assert.equal(run.head_after, run.head_before, 'no commit landed, even with the real git binary');
  assert.ok(!String(run.remote).includes('@'), 'the remote carries no credential');
  assert.deepEqual(storedSeqs(userA, live.id), ['1'], 'still only the live checkpoint');
});

test('another user’s session (or agent) is refused before any sandbox exists', async () => {
  const liveHome = join(fixtureDir, 'live-home-owner');
  seedWorkspace(liveHome);
  const live = await liveSession(liveHome);
  const sandboxesBefore = sandboxes.length;
  for (const params of [
    { userId: userB, agentId: agentB }, // B asks about A's session
    { userId: userA, agentId: agentB }, // A's id with B's agent
    { userId: userB, agentId: agentA }, // B's id with A's agent
  ]) {
    await assert.rejects(
      inspectCodeSession({ ...params, codeSessionId: live.id, question: 'What is here?' }),
      (error: unknown) =>
        error instanceof CodeInspectError &&
        error.status === 404 &&
        error.code === 'CODE_SESSION_NOT_FOUND'
    );
  }
  const foreign = await http(
    'POST',
    `/api/claude-code-session/code-sessions/${live.id}/inspect`,
    userB,
    {
      agent_id: agentB,
      question: 'What is here?',
    }
  );
  assert.equal(foreign.status, 404, JSON.stringify(foreign.data));
  assert.equal(foreign.data.code, 'CODE_SESSION_NOT_FOUND');
  assert.equal(sandboxes.length, sandboxesBefore, 'no sandbox was created for a refused call');
});

test('route wiring: invalid body 400, session without a checkpoint 409', async () => {
  const fresh = await prisma.codeSession.create({
    data: {
      userId: userA,
      rootAgentId: agentA,
      ownerAgentId: agentA,
      repoKey: `inspect-${randomUUID()}`,
    },
  });
  const path = `/api/claude-code-session/code-sessions/${fresh.id}/inspect`;
  const missing = await http('POST', path, userA, { agent_id: agentA });
  assert.equal(missing.status, 400, JSON.stringify(missing.data));
  const noCheckpoint = await http('POST', path, userA, { agent_id: agentA, question: 'Anything?' });
  assert.equal(noCheckpoint.status, 409, JSON.stringify(noCheckpoint.data));
  assert.equal(noCheckpoint.data.code, 'CODE_SESSION_NO_CHECKPOINT');
});

test('teardown: the sandbox is killed when the CLI fails and when the restore fails', async () => {
  const liveHome = join(fixtureDir, 'live-home-teardown');
  const { origin } = seedWorkspace(liveHome);
  const live = await liveSession(liveHome);

  setMode('crash');
  const before = sandboxes.length;
  const failed = await inspectCodeSession({
    userId: userA,
    agentId: agentA,
    codeSessionId: live.id,
    question: 'Crash please.',
  });
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  assert.equal(failed.answer, null);
  assert.match(failed.error ?? '', /exited 2/);
  assert.deepEqual(
    sandboxes.slice(before).map((sandbox) => sandbox.kills),
    [1],
    'a failed CLI run still kills its sandbox'
  );

  // The restore re-fetches the repo's remote; without it the restore throws.
  rmSync(origin, { recursive: true, force: true });
  setMode('answer');
  const beforeRestore = sandboxes.length;
  await assert.rejects(
    inspectCodeSession({ userId: userA, agentId: agentA, codeSessionId: live.id, question: 'Hi?' }),
    /restore failed/
  );
  assert.deepEqual(
    sandboxes.slice(beforeRestore).map((sandbox) => sandbox.kills),
    [1],
    'a failed restore still kills its sandbox'
  );
});

test('a caller that gives up (abort) gets its sandbox killed at once, not after the CLI', async () => {
  const liveHome = join(fixtureDir, 'live-home-abort');
  seedWorkspace(liveHome);
  const live = await liveSession(liveHome);
  setMode('slow');
  const before = sandboxes.length;
  const runsBefore = cliRuns().length;
  const abort = new AbortController();
  const pending = inspectCodeSession({
    userId: userA,
    agentId: agentA,
    codeSessionId: live.id,
    question: 'Take your time.',
    signal: abort.signal,
  });
  // Abort once the CLI has started (it writes its first record on start).
  await retryWithBackoff(async () => cliRuns().length > runsBefore, {
    maxRetries: 100,
    fixedDelays: Array<number>(99).fill(50),
    shouldRetryResult: (started) => !started,
    component: 'CodeInspectAbortFixture',
  });
  assert.ok(cliRuns().length > runsBefore, 'the CLI started before the caller aborted');
  abort.abort();
  const result = await pending;
  assert.equal(result.status, 'failed', JSON.stringify(result));
  const [sandbox] = sandboxes.slice(before);
  assert.equal(sandbox.kills, 1, 'killed once, though the run also reached its finally');
  const doneMs = cliRuns()
    .slice(runsBefore)
    .find((run) => run.slow_done_ms !== undefined)?.slow_done_ms;
  assert.ok(doneMs !== undefined && sandbox.killedAtMs !== null);
  assert.ok(sandbox.killedAtMs < doneMs, 'the kill happened while the CLI was still running');
});

test('C15: a Claude usage limit backs that credential off and the inspection answers on Codex', async () => {
  const liveHome = join(fixtureDir, 'live-home-c15');
  seedWorkspace(liveHome);
  const live = await liveSession(liveHome);
  await __resetAnthropicApiKeyCooldown();
  setMode('rate_limit');
  const before = sandboxes.length;
  const runsBefore = cliRuns().length;
  try {
    const result = await inspectCodeSession({
      userId: userA,
      agentId: agentA,
      codeSessionId: live.id,
      question: 'What does feature.txt say?',
    });
    assert.equal(result.status, 'answered', JSON.stringify(result));
    assert.equal(result.provider, 'codex');
    assert.match(result.answer ?? '', /committed locally/);
    assert.equal(
      await isAnthropicApiKeyOnCooldown(),
      true,
      'the exhausted Claude key is backed off'
    );
    const runs = cliRuns().slice(runsBefore);
    assert.deepEqual(
      runs.map((run) => run.cli),
      ['claude', 'codex']
    );
    assert.ok(runs[1].argv.includes('--ignore-user-config'), 'codex loads no MCP config');
    assert.deepEqual(
      [runs[1].openai_key, runs[1].azure_key, runs[1].argv.includes('model_provider="azure"')],
      [false, 'azure-inspect-test-key', true],
      'codex runs on the Azure funding, never the unfunded OpenAI key'
    );
    // agentA is a Rose Ultra agent with the Fast Mode button on (Agent defaults):
    // gpt-6.1-sol at xhigh, Azure priority, the shipped catalog loaded.
    for (const flag of [
      'gpt-6.1-sol',
      'service_tier="priority"',
      'model_reasoning_effort="xhigh"',
    ]) {
      assert.ok(runs[1].argv.includes(flag), `codex argv has ${flag}: ${runs[1].argv.join(' ')}`);
    }
    assert.ok(
      runs[1].argv.some((arg: string) =>
        /^model_catalog_json=".*azure-model-catalog\.json"$/.test(arg)
      ),
      'the Azure catalog describes gpt-6.1-sol'
    );
    assert.deepEqual(
      sandboxes.slice(before).map((sandbox) => [sandbox.provider, sandbox.kills]),
      [
        ['claude', 1],
        ['codex', 1],
      ],
      'each attempt had its own sandbox and both were killed'
    );
  } finally {
    await __resetAnthropicApiKeyCooldown();
  }
});

test('C15 keeps its Codex fallback while a sibling holds the funded cooldown', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './src/tests/blackbox/code-session-inspect-cooldown.fixture.ts',
      '--test',
      '--test-name-pattern=C15:',
      'src/tests/blackbox/code-session-inspect.blackbox.ts',
    ],
    { env: process.env, encoding: 'utf8', timeout: 900_000 }
  );
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  assert.ifError(child.error);
  assert.equal(child.signal, null, 'the original C15 child completed');
  assert.equal(child.status, 0, 'the unchanged C15 assertions pass with a competing cooldown');
  assert.match(child.stdout, /ok \d+ - C15: a Claude usage limit/);
});
