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
import { execFileSync } from 'node:child_process';
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
/** The shared Anthropic-key cooldown row (shared test DB): cleared for this suite, then restored. */
const COOLDOWN_KEY = {
  userId: '00000000-0000-0000-0000-000000000000',
  name: 'anthropic_api_key_cooldown',
  accountId: '',
};
let priorCooldown: Awaited<ReturnType<typeof prisma.integration.findUnique>> = null;

async function restoreCooldownRow(): Promise<void> {
  await __resetAnthropicApiKeyCooldown();
  if (priorCooldown === null) return;
  await prisma.integration.create({
    data: {
      ...COOLDOWN_KEY,
      type: priorCooldown.type,
      status: priorCooldown.status,
      rateLimitedUntil: priorCooldown.rateLimitedUntil,
      failureReason: priorCooldown.failureReason,
    },
  });
}

/**
 * Scripted CLIs. claude reads the question on stdin; codex gets it as the last
 * argument and writes its answer to --output-last-message. Each run records
 * what it saw (argv, cwd, env, guard results) to cli-runs.jsonl.
 */
const FAKE_CLI = String.raw`#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
CLI = os.path.basename(sys.argv[0])
LOG = pathlib.Path(${JSON.stringify(cliLog)})
MODE = pathlib.Path(${JSON.stringify(modeFile)})
REAL_GIT = ${JSON.stringify(realGit)}
mode = MODE.read_text().strip() if MODE.exists() else "answer"
argv = sys.argv[1:]
if CLI == "codex" and argv[:1] == ["login"]:
    sys.stdin.read()
    sys.exit(0)
prompt = sys.stdin.read() if CLI == "claude" else argv[-1]

def run(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return {"cmd": cmd, "rc": p.returncode, "out": p.stdout.strip()[-300:], "err": p.stderr.strip()[-300:]}

record = {"cli": CLI, "argv": argv, "cwd": os.getcwd(), "prompt": prompt, "mode": mode,
          "path0": os.environ.get("PATH", "").split(":")[0],
          "anthropic_key": os.environ.get("ANTHROPIC_API_KEY", ""), "openai_key": bool(os.environ.get("OPENAI_API_KEY")),
          "github_token": bool(os.environ.get("GITHUB_TOKEN")),
          "env_file_left": (pathlib.Path(os.environ["HOME"]) / ".rose-inspect" / "env").exists(),
          "home_claude_md": (pathlib.Path(os.environ["HOME"]) / "CLAUDE.md").exists()}
if CLI == "claude" and mode == "rate_limit":
    print(json.dumps({"type": "system", "subtype": "init"}))
    print(json.dumps({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": 1790988600}}))
    print(json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True, "result": "limit"}))
    LOG.open("a").write(json.dumps(record) + "\n")
    sys.exit(1)
if mode == "crash":
    LOG.open("a").write(json.dumps(record) + "\n")
    sys.stderr.write("boom\n")
    sys.exit(2)
head_before = run("git rev-parse HEAD")["out"]
record["attempts"] = {
    "read": run("git log -1 --format=%s"),
    "commit": run("git commit -am 'inspector commit'"),
    "push": run("git push origin HEAD"),
    "merge": run("git -C . merge main"),
    "direct_commit": run(REAL_GIT + " commit --allow-empty -m 'direct commit'"),
    "gh": run("gh pr create --fill"),
}
record["head_before"] = head_before
record["head_after"] = run("git rev-parse HEAD")["out"]
record["remote"] = run("git remote get-url origin")["out"]
pathlib.Path("inspector-scratch.txt").write_text("scratch\n")
feature = pathlib.Path("feature.txt").read_text().strip()
LOG.open("a").write(json.dumps(record) + "\n")
answer = ("feature.txt holds: " + feature + "\n\nCitations:\n- feature.txt:1\n- README.md:1-2\n"
          "- missing/nowhere.ts:9\n- ../escape.txt:1\n")
if CLI == "codex":
    out = argv[argv.index("--output-last-message") + 1]
    pathlib.Path(out).write_text(answer)
    print(json.dumps({"type": "thread.started", "thread_id": "t-1"}))
    print(json.dumps({"type": "turn.completed", "usage": {}}))
else:
    print(json.dumps({"type": "system", "subtype": "init"}))
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": answer}))
`;

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
    const record: FakeSandbox = { id: `sb-inspect-${randomUUID()}`, provider, home, kills: 0 };
    sandboxes.push(record);
    return {
      fs,
      sandboxId: record.id,
      kill: async () => {
        record.kills += 1;
        rmSync(home, { recursive: true, force: true });
      },
    };
  });
}

function cliRuns(): Array<Record<string, any>> {
  if (!existsSync(cliLog)) return [];
  return readFileSync(cliLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
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
  process.env.CODE_SESSION_STORAGE_BACKEND = 'local';
  process.env.CODE_SESSION_STORAGE_LOCAL_DIR = storageDir;
  // Fake funded keys; no decryption key, so no stored credential is ever decrypted.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-inspect-test-key-0000000000000000';
  process.env.GPT_API_KEY = 'sk-inspect-test-openai';
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
  priorCooldown = await prisma.integration.findUnique({
    where: { userId_name_accountId: COOLDOWN_KEY },
  });
  await __resetAnthropicApiKeyCooldown();
  await prisma.user.create({ data: { userId: userA, name: 'Inspect A' } });
  await prisma.user.create({ data: { userId: userB, name: 'Inspect B' } });
  await prisma.agent.create({ data: { id: agentA, userId: userA, goal: 'Build the feature' } });
  await prisma.agent.create({ data: { id: agentB, userId: userB, goal: 'Someone else' } });
});

after(async () => {
  setCodeInspectSandboxFactoryForTests(null);
  await restoreCooldownRow();
  (Sandbox as unknown as { connect: typeof originalConnect }).connect = originalConnect;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await prisma.codeSession.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.agent.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.user.deleteMany({ where: { userId: { in: [userA, userB] } } });
  rmSync(fixtureDir, { recursive: true, force: true });
  await prisma.$disconnect();
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
  const argv = run.argv as string[];
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
  const attempts = run.attempts as Record<string, { rc: number; out: string; err: string }>;
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
    assert.ok(
      (runs[1].argv as string[]).includes('--ignore-user-config'),
      'codex loads no MCP config'
    );
    assert.equal(runs[1].openai_key, true);
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
