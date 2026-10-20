#!/usr/bin/env tsx
/**
 * Black-box contract for persistent code sessions (docs/plans/active/
 * code-agent-persistent-sessions.md; rose-builds-rose rows C1-C5, C11, C13).
 *
 *   real git repos + local sandbox fs ──checkpoint──► local object store ──restore──► fresh HOME
 *   fake E2B sandbox (same fs) ──closeClaudeCodeSession──► pause (never kill)
 *   real DB rows ──resolveSpawnCodeSession──► owner-scoped session + branch plan
 *   running backend ──HTTP──► ownership 404s, keepalive, grep over code_event rows
 *   (merge facts and the commit/merge prompt: code-session-merge-facts.blackbox.ts)
 *
 * Storage is hermetic (CODE_SESSION_STORAGE_BACKEND=local); nothing reaches E2B,
 * GitHub or Supabase Storage.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { Sandbox } from 'e2b';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { checkpointKey } from '../../providers/codeSessions/artifactStore';
import { shareCodeSession } from '../../providers/codeSessions/branch';
import {
  CheckpointIntegrityError,
  loadVerifiedCheckpoint,
} from '../../providers/codeSessions/checkpoint';
import {
  checkpointCodeSession,
  restoreLatestCheckpoint,
} from '../../providers/codeSessions/lifecycle';
import { localSandboxFs } from '../../providers/codeSessions/sandboxFs';
import {
  CodeSessionBusyError,
  CodeSessionNotFoundError,
  keepAliveCodeTask,
  markAwaitingParent,
  resolveSpawnCodeSession,
  retireOwnedCodeSession,
} from '../../providers/codeSessions/spawn';
import { markPaused } from '../../providers/codeSessions/store';
import { closeClaudeCodeSession } from '../../providers/e2bCloseSession';
import { acquireCodeSessionSandbox } from '../../providers/e2bCodeSessionSandbox';

config();

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3001';
const apiKey = process.env.BACKEND_API_KEY || '';
const fixtureDir = mkdtempSync(join(tmpdir(), 'code-sessions-blackbox-'));
const userA = `code-session-a-${randomUUID()}`;
const userB = `code-session-b-${randomUUID()}`;
const rootAgentId = randomUUID();
const grepToken = `w5grep${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const cliSessionId = randomUUID();
const savedEnv = {
  backend: process.env.CODE_SESSION_STORAGE_BACKEND,
  dir: process.env.CODE_SESSION_STORAGE_LOCAL_DIR,
};
const originalConnect = Sandbox.connect.bind(Sandbox);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A bare origin with main pushed, plus a clone in `<home>/workspace` on a local branch. */
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
  writeFileSync(join(workspace, 'untracked.txt'), 'untracked file\n');
  const logDir = join(home, '.claude', 'projects', '-home-user-workspace');
  mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString();
  writeFileSync(
    join(logDir, `${cliSessionId}.jsonl`),
    [
      {
        type: 'assistant',
        timestamp: ts,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_g1',
              name: 'Bash',
              input: { command: `echo ${grepToken}` },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: ts,
        toolUseResult: { stdout: `${grepToken}\n`, stderr: '' },
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_g1', content: grepToken }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n'
  );
  return { origin };
}

async function newSessionRow(
  overrides: Partial<{ ownerAgentId: string; branch: string | null }> = {}
) {
  return prisma.codeSession.create({
    data: {
      userId: userA,
      rootAgentId,
      ownerAgentId: overrides.ownerAgentId ?? rootAgentId,
      repoKey: `local-${randomUUID()}`,
      branch: overrides.branch === undefined ? 'rose/feature-1' : overrides.branch,
      mergeTarget: 'main',
      sandboxKind: 'local',
      sandboxId: `local-${randomUUID()}`,
    },
  });
}

/** E2B sandbox stand-in over a local HOME: commands and files map /home/user → home. */
function fakeSandbox(home: string, sandboxId: string) {
  const map = (value: string) => value.split('/home/user').join(home);
  const calls = { paused: 0, killed: 0 };
  const sandbox = {
    sandboxId,
    commands: {
      run: async (cmd: string, opts?: { cwd?: string }) => {
        const result = spawnSync('bash', ['-c', map(cmd)], {
          cwd: map(opts?.cwd ?? '/home/user'),
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_TERMINAL_PROMPT: '0' },
        });
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
    },
    files: {
      read: async (path: string, opts?: { format?: string }) => {
        const data = readFileSync(map(path));
        return opts?.format === 'text' ? data.toString('utf8') : new Uint8Array(data);
      },
      write: async (path: string, data: ArrayBuffer | Blob | string) => {
        mkdirSync(dirname(map(path)), { recursive: true });
        const bytes =
          typeof data === 'string'
            ? Buffer.from(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(data))
              : Buffer.from(await data.arrayBuffer());
        writeFileSync(map(path), bytes);
      },
    },
    pause: async () => {
      calls.paused += 1;
      return true;
    },
    kill: async () => {
      calls.killed += 1;
    },
  };
  return { sandbox: sandbox as unknown as Sandbox, calls };
}

function patchConnect(impl: (id: string) => Promise<Sandbox>): void {
  (Sandbox as unknown as { connect: (id: string) => Promise<Sandbox> }).connect = impl;
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
  process.env.CODE_SESSION_STORAGE_LOCAL_DIR = join(fixtureDir, 'storage');
  await prisma.user.create({ data: { userId: userA, name: 'Code Session A' } });
  await prisma.user.create({ data: { userId: userB, name: 'Code Session B' } });
  await prisma.agent.create({
    data: { id: rootAgentId, userId: userA, goal: 'Build the feature' },
  });
});

after(async () => {
  patchConnect(originalConnect);
  for (const [key, value] of [
    ['CODE_SESSION_STORAGE_BACKEND', savedEnv.backend],
    ['CODE_SESSION_STORAGE_LOCAL_DIR', savedEnv.dir],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await prisma.agentTrajectorySearch.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.claudeCodeSession.deleteMany({ where: { agentId: rootAgentId } });
  await prisma.codeSessionShare.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.codeSession.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.agent.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.user.deleteMany({ where: { userId: { in: [userA, userB] } } });
  rmSync(fixtureDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

test('checkpoint round trip restores uncommitted, untracked, local commit, branch and CLI log; corrupt artifacts are rejected', async () => {
  const home = join(fixtureDir, 'home-roundtrip');
  seedWorkspace(home);
  const session = await newSessionRow();
  const first = await checkpointCodeSession({
    session,
    fs: localSandboxFs(home),
    reason: 'close',
    agentId: rootAgentId,
  });
  assert.ok(first, 'checkpoint must succeed');
  assert.equal(first.seq, 1);
  assert.equal(first.cliSessionId, cliSessionId);
  assert.equal(first.repo?.branch, 'rose/feature-1');
  assert.equal(first.repo?.localCommits, 1);
  assert.equal(first.repo?.pushed, false);
  assert.ok((first.repo?.dirtyFiles ?? 0) >= 2, JSON.stringify(first.repo));
  assert.ok(first.indexedCodeEvents >= 1, 'the Bash command must be indexed as a code_event');
  const files = new Map((first.repo?.files ?? []).map((file) => [file.path, file]));
  assert.deepEqual(files.get('feature.txt'), { path: 'feature.txt', added: 1, removed: 0 });
  assert.equal(files.get('README.md')?.added, 1, JSON.stringify([...files.values()]));
  assert.ok(files.has('untracked.txt'), 'untracked files count toward the diff summary');

  const manifest = (await loadVerifiedCheckpoint(userA, session.id, 1)).manifest;
  const repo = manifest.repos.find((candidate) => candidate.path === 'workspace');
  assert.ok(
    repo?.refs?.['refs/heads/rose/feature-1'] && repo.refs['refs/heads/main'],
    'every local ref is recorded'
  );
  assert.ok(repo?.bundle, 'the local-only commit travels in an incremental bundle');
  const bundleSize = manifest.artifacts[repo.bundle].size;
  assert.ok(bundleSize < 4096, `bundle must hold only local-only history, got ${bundleSize} bytes`);

  const restoredHome = join(fixtureDir, 'home-restored');
  mkdirSync(restoredHome, { recursive: true });
  const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
  const restored = await restoreLatestCheckpoint(row, localSandboxFs(restoredHome));
  assert.deepEqual(restored, { seq: 1, cliSessionId });
  const workspace = join(restoredHome, 'workspace');
  assert.equal(readFileSync(join(workspace, 'untracked.txt'), 'utf8'), 'untracked file\n');
  assert.equal(readFileSync(join(workspace, 'README.md'), 'utf8'), 'line one\nuncommitted edit\n');
  assert.equal(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD'), 'rose/feature-1');
  assert.equal(git(workspace, 'log', '-1', '--format=%s'), 'local commit');
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: workspace,
    encoding: 'utf8',
  });
  assert.match(status, /^ M README\.md$/m);
  assert.match(status, /^\?\? untracked\.txt$/m);
  assert.ok(
    existsSync(
      join(restoredHome, '.claude', 'projects', '-home-user-workspace', `${cliSessionId}.jsonl`)
    ),
    'the CLI conversation is restored for --resume'
  );

  // A newer checkpoint whose artifact no longer matches its sha256 is never applied.
  writeFileSync(join(home, 'workspace', 'later.txt'), 'later\n');
  const second = await checkpointCodeSession({
    session,
    fs: localSandboxFs(home),
    reason: 'close',
    agentId: rootAgentId,
  });
  assert.equal(second?.seq, 2);
  const storage = process.env.CODE_SESSION_STORAGE_LOCAL_DIR ?? '';
  appendFileSync(join(storage, checkpointKey(userA, session.id, 2, 'worktree.tar.gz')), 'x');
  await assert.rejects(loadVerifiedCheckpoint(userA, session.id, 2), CheckpointIntegrityError);
  const fallbackHome = join(fixtureDir, 'home-fallback');
  mkdirSync(fallbackHome, { recursive: true });
  const latest = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.equal((await restoreLatestCheckpoint(latest, localSandboxFs(fallbackHome)))?.seq, 1);
  assert.equal(existsSync(join(fallbackHome, 'workspace', 'later.txt')), false);
  appendFileSync(join(storage, checkpointKey(userA, session.id, 1, 'worktree.tar.gz')), 'x');
  const noneHome = join(fixtureDir, 'home-none');
  mkdirSync(noneHome, { recursive: true });
  assert.equal(await restoreLatestCheckpoint(latest, localSandboxFs(noneHome)), null);
  assert.equal(
    existsSync(join(noneHome, 'workspace')),
    false,
    'a rejected checkpoint touches nothing'
  );
});

test('code_event rows are greppable from the root after the session pauses', async () => {
  for (const agentId of [rootAgentId, undefined]) {
    const result = await http('POST', '/api/data/grep', userA, {
      source: 'agent_trajectories',
      pattern: grepToken,
      ...(agentId !== undefined ? { agent_id: agentId } : {}),
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const matches = (result.data.matches ?? []) as Array<{ content?: string }>;
    assert.ok(
      matches.some((match) => String(match.content).includes(`command: echo ${grepToken}`)),
      `grep from ${agentId ?? 'the user'} must find the code agent's command: ${JSON.stringify(result.data)}`
    );
  }
  const foreign = await http('POST', '/api/data/grep', userB, {
    source: 'agent_trajectories',
    pattern: grepToken,
  });
  assert.equal(
    ((foreign.data.matches ?? []) as unknown[]).length,
    0,
    'other users never see the rows'
  );
});

test('close checkpoints and pauses the sandbox, never kills it; a dead sandbox falls back to the checkpoint', async () => {
  const home = join(fixtureDir, 'home-e2b');
  seedWorkspace(home);
  const sandboxId = `sb-${randomUUID()}`;
  const codeSession = await prisma.codeSession.create({
    data: {
      userId: userA,
      rootAgentId,
      ownerAgentId: rootAgentId,
      repoKey: `e2b-${randomUUID()}`,
      branch: 'rose/feature-1',
      sandboxKind: 'e2b',
      sandboxId,
      leaseOwner: 'tool:root:1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  const task = await prisma.claudeCodeSession.create({
    data: { agentId: rootAgentId, sandboxId, goal: 'g', codeSessionId: codeSession.id },
  });
  const fake = fakeSandbox(home, sandboxId);
  patchConnect(async () => fake.sandbox);
  try {
    const closed = await closeClaudeCodeSession(task.id, userA, rootAgentId, [], {
      reason: 'close',
    });
    assert.equal(fake.calls.paused, 1, 'close must pause the sandbox');
    assert.equal(fake.calls.killed, 0, 'close must never kill a persistent session');
    assert.equal(closed.codeSession?.state, 'PAUSED');
    assert.equal(closed.codeSession?.checkpoint_seq, 1);
    assert.equal(closed.codeSession?.branch, 'rose/feature-1');
    assert.equal(closed.codeSession?.merge.merged, false);
    const row = await prisma.codeSession.findUniqueOrThrow({ where: { id: codeSession.id } });
    assert.equal(row.state, 'PAUSED');
    assert.equal(row.leaseOwner, null, 'a paused session releases its lease for the next spawn');

    // Resume path: the paused sandbox is gone, so a new one gets the checkpoint.
    patchConnect(async () => {
      throw new Error('sandbox not found');
    });
    const freshHome = join(fixtureDir, 'home-e2b-fresh');
    mkdirSync(freshHome, { recursive: true });
    const fresh = fakeSandbox(freshHome, `sb-${randomUUID()}`);
    const acquired = await acquireCodeSessionSandbox(row, async () => fresh.sandbox);
    assert.equal(acquired.resumedFrom, 'checkpoint');
    assert.equal(acquired.cliSessionId, cliSessionId);
    assert.equal(
      readFileSync(join(freshHome, 'workspace', 'untracked.txt'), 'utf8'),
      'untracked file\n'
    );
  } finally {
    patchConnect(originalConnect);
  }
});

test('sessions are owner-scoped: user B cannot read, retire or resume user A’s session', async () => {
  const session = await newSessionRow();
  const own = await http('GET', `/api/claude-code-session/code-sessions/${session.id}`, userA);
  assert.equal(own.status, 200, JSON.stringify(own.data));
  assert.equal(own.data.branch, 'rose/feature-1');
  assert.equal(own.data.merge_target, 'main');
  for (const method of ['GET', 'DELETE']) {
    const foreign = await http(
      method,
      `/api/claude-code-session/code-sessions/${session.id}`,
      userB
    );
    assert.equal(
      foreign.status,
      404,
      `${method} by another user must 404: ${JSON.stringify(foreign.data)}`
    );
  }
  assert.equal(
    (await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } })).state,
    'ACTIVE'
  );
  await assert.rejects(
    resolveSpawnCodeSession({
      agentId: rootAgentId,
      userId: userB,
      repoUrl: null,
      codeProvider: 'claude',
      codeSessionId: session.id,
      leaseOwner: 'tool:b:1',
    }),
    CodeSessionNotFoundError
  );
});

test('branch model: root from default, sub-agents from the parent branch, parallel spawns branch, shares reuse', async () => {
  const repoUrl = `https://github.com/rose-test/branch-${randomUUID().slice(0, 8)}`;
  const root = randomUUID();
  const child = randomUUID();
  const grandchild = randomUUID();
  const sharer = randomUUID();
  await prisma.agent.create({ data: { id: root, userId: userA, goal: 'Polish the Rose UI' } });
  await prisma.agent.create({
    data: { id: child, userId: userA, goal: 'Speed up', parentAgentId: root, busId: root },
  });
  await prisma.agent.create({
    data: {
      id: grandchild,
      userId: userA,
      goal: 'Cache images',
      parentAgentId: child,
      busId: root,
    },
  });
  await prisma.agent.create({ data: { id: sharer, userId: userA, goal: 'Same branch helper' } });
  const spawn = (agentId: string, leaseOwner: string) =>
    resolveSpawnCodeSession({
      agentId,
      userId: userA,
      repoUrl,
      codeProvider: 'claude',
      leaseOwner,
    });

  const rootSession = await spawn(root, 'tool:root:1');
  assert.ok(rootSession);
  assert.equal(rootSession.branch, `rose/polish-the-rose-ui-${root.replace(/-/g, '').slice(0, 8)}`);
  assert.equal(rootSession.baseBranch, null, 'a new agent branches from the default branch');
  assert.equal(rootSession.mergeTarget, null, 'and merges into the default branch');
  await markPaused(rootSession.id);

  const childSession = await spawn(child, 'tool:child:1');
  assert.ok(
    childSession?.branch?.startsWith(`${rootSession.branch}--speed-up-`),
    childSession?.branch ?? ''
  );
  assert.equal(childSession.baseBranch, rootSession.branch);
  assert.equal(
    childSession.mergeTarget,
    rootSession.branch,
    'a sub-agent merges into its parent branch'
  );
  assert.equal(childSession.parentCodeSessionId, rootSession.id);
  await markPaused(childSession.id);
  const grandchildSession = await spawn(grandchild, 'tool:grand:1');
  assert.equal(grandchildSession?.mergeTarget, childSession.branch);
  assert.ok(
    !grandchildSession?.branch?.includes('/speed'),
    'never a/b next to a/b/c (git D/F conflict)'
  );

  assert.equal(
    (await spawn(root, 'tool:root:2'))?.id,
    rootSession.id,
    'the next spawn resumes the latest session'
  );
  assert.equal(
    (await spawn(root, 'tool:root:2'))?.id,
    rootSession.id,
    'a Temporal retry keeps its lease'
  );
  const parallel = await spawn(root, 'tool:root:3');
  assert.notEqual(parallel?.id, rootSession.id, 'two CLIs never share one worktree');
  assert.equal(parallel?.baseBranch, rootSession.branch);
  assert.equal(parallel?.mergeTarget, rootSession.branch);

  await shareCodeSession({ userId: userA, agentId: sharer, sharedWithAgentId: root });
  await assert.rejects(spawn(sharer, 'tool:sharer:1'), CodeSessionBusyError);
  await markPaused(rootSession.id);
  const shared = await spawn(sharer, 'tool:sharer:1');
  assert.equal(
    shared?.id,
    rootSession.id,
    '"New agent in this branch" works in the parent’s session'
  );

  const missing = await http('POST', '/api/agents', userA, {
    goal: 'share with a stranger',
    share_code_session_with: randomUUID(),
  });
  assert.equal(missing.status, 404, JSON.stringify(missing.data));
  assert.equal(missing.data.code, 'CODE_SESSION_SHARE_TARGET_NOT_FOUND');
});

test('keepalive extends an attached sandbox and its lease; retire deletes checkpoints', async () => {
  const session = await newSessionRow();
  await prisma.codeSession.update({
    where: { id: session.id },
    data: {
      sandboxKind: 'e2b',
      sandboxId: 'sb-keepalive',
      leaseOwner: 'tool:k:1',
      leaseExpiresAt: new Date(),
    },
  });
  const task = await prisma.claudeCodeSession.create({
    data: { agentId: rootAgentId, sandboxId: 'sb-keepalive', goal: 'g', codeSessionId: session.id },
  });
  const extended: Array<[string, number]> = [];
  const alive = await keepAliveCodeTask(task.id, async (sandboxId, timeoutMs) => {
    extended.push([sandboxId, timeoutMs]);
  });
  assert.deepEqual(alive, { alive: true, code_session_id: session.id, awaiting_parent: null });
  // A question to the (blocked) spawning agent rides on the next keepalive.
  await markAwaitingParent(task.id, { message_id: 'q-1', question: 'Which database?' });
  const asked = await keepAliveCodeTask(task.id, async () => undefined);
  assert.equal(asked.awaiting_parent?.question, 'Which database?');
  assert.equal(asked.awaiting_parent?.message_id, 'q-1');
  assert.deepEqual(extended, [['sb-keepalive', 30 * 60 * 1000]]);
  const leased = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.ok(
    (leased.leaseExpiresAt?.getTime() ?? 0) > Date.now() + 30 * 60 * 1000,
    'lease pushed out'
  );

  const local = await newSessionRow();
  const home = join(fixtureDir, 'home-retire');
  seedWorkspace(home);
  const ckpt = await checkpointCodeSession({
    session: local,
    fs: localSandboxFs(home),
    reason: 'close',
    agentId: rootAgentId,
  });
  const storage = process.env.CODE_SESSION_STORAGE_LOCAL_DIR ?? '';
  const manifestPath = join(
    storage,
    checkpointKey(userA, local.id, ckpt?.seq ?? 1, 'manifest.json')
  );
  assert.ok(existsSync(manifestPath));
  const retired = await retireOwnedCodeSession(userA, local.id);
  assert.equal(retired.state, 'RETIRED');
  assert.equal(existsSync(manifestPath), false, 'retirement deletes stored checkpoints');
});
