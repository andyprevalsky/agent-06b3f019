#!/usr/bin/env tsx
/**
 * Black-box regressions for the backend-owned local Claude Code close boundary.
 *
 * The tests run the real local-session provider with a real child listener and
 * captured storage boundary. Only persistence is replaced so the cases remain
 * deterministic and cannot touch a developer or production database.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  closeLocalClaudeCodeSession,
  createLocalClaudeCodeSession,
} from '../../providers/claudeCodeLocalSession';
import { CODE_AGENT_HANDOFF_PATH } from '../../providers/codeAgentPrompt';
import { prisma } from '../../providers/database';

const fixtureDir = mkdtempSync(join(tmpdir(), 'claude-local-close-blackbox-'));
const fakeWsServerPath = join(fixtureDir, 'ws-server.mjs');
writeFileSync(
  fakeWsServerPath,
  `
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
writeFileSync('launch-env.json', JSON.stringify({
  goal: process.env.CLAUDE_CODE_GOAL,
  prompt: process.env.CODE_AGENT_SYSTEM_PROMPT,
}));
const port = Number(process.env.PORT);
const server = createServer();
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({
    message: 'Server listening',
    port,
    readinessToken: process.env.ROSE_LOCAL_WS_READINESS_TOKEN,
  }) + '\\n');
});
`
);

const originalCreate = prisma.claudeCodeSession.create;
const originalUpdate = prisma.claudeCodeSession.update;
const originalFetch = globalThis.fetch;
const originalWsServerPath = process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH;
const originalSupabaseUrl = process.env.SUPABASE_URL;
const originalSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

before(() => {
  process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH = fakeWsServerPath;
  process.env.SUPABASE_URL = 'https://supabase.local.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-close-blackbox-key';
  prisma.claudeCodeSession.create = (async ({ data }: { data: { id: string } }) =>
    data) as typeof prisma.claudeCodeSession.create;
  prisma.claudeCodeSession.update = (async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    status: 'CLOSED',
  })) as typeof prisma.claudeCodeSession.update;
});

after(async () => {
  prisma.claudeCodeSession.create = originalCreate;
  prisma.claudeCodeSession.update = originalUpdate;
  globalThis.fetch = originalFetch;
  if (originalWsServerPath === undefined) delete process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH;
  else process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH = originalWsServerPath;
  if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalSupabaseUrl;
  if (originalSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseKey;
  rmSync(fixtureDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

async function createSession(
  taskId: string,
  launch: { goal?: string; envs?: Record<string, string> } = {}
): Promise<string> {
  await createLocalClaudeCodeSession({
    taskId,
    agentId: `agent-${taskId}`,
    goal: launch.goal ?? 'exercise local close ownership',
    envs: launch.envs ?? {},
    claudeTokenSource: null,
    claudeTokenIntegrationId: null,
  });
  return join('/tmp', 'claude-code-local', taskId);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('condition did not become true');
}

test('overlapping closes share one task-owned operation', async () => {
  const taskId = `close-single-flight-${Date.now()}`;
  await createSession(taskId);
  let updateCalls = 0;
  let releaseUpdate: (() => void) | undefined;
  const updateGate = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  prisma.claudeCodeSession.update = (async ({ where }: { where: { id: string } }) => {
    updateCalls += 1;
    await updateGate;
    return { id: where.id, status: 'CLOSED' };
  }) as typeof prisma.claudeCodeSession.update;

  const first = closeLocalClaudeCodeSession(taskId, 'user-local-close');
  await waitFor(() => updateCalls === 1);
  const second = closeLocalClaudeCodeSession(taskId, 'user-local-close');
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseUpdate?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(updateCalls, 1, 'one task may have only one close transaction in flight');
  assert.deepEqual(secondResult, firstResult, 'overlapping callers must receive the same result');
});

test('partial extraction remains resumable and never reuploads completed files', async () => {
  const taskId = `close-partial-output-${Date.now()}`;
  const workDir = await createSession(taskId);
  writeFileSync(join(workDir, 'output', 'a.txt'), 'first');
  writeFileSync(join(workDir, 'output', 'b.txt'), 'second');

  let failSecondFile = true;
  const uploadUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes('/storage/v1/object/attachments/')) {
      throw new Error(`unexpected outbound request: ${url}`);
    }
    uploadUrls.push(url);
    if (failSecondFile && decodeURIComponent(url).endsWith('_b.txt')) {
      return new Response(JSON.stringify({ message: 'forced second-file failure' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ Key: url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await assert.rejects(
    () => closeLocalClaudeCodeSession(taskId, 'user-local-close'),
    /forced second-file failure/
  );
  const ownershipPath = join(workDir, 'session.json');
  assert.equal(existsSync(ownershipPath), true, 'failed extraction must retain ownership');
  const ownershipAfterFailure = JSON.parse(readFileSync(ownershipPath, 'utf8')) as {
    outputFiles?: unknown;
  };
  assert.equal(
    ownershipAfterFailure.outputFiles,
    undefined,
    'a partial pointer list must not be persisted as complete'
  );

  failSecondFile = false;
  const retried = await closeLocalClaudeCodeSession(taskId, 'user-local-close');
  assert.equal(retried.outputFiles.length, 2);
  const decodedUploadUrls = uploadUrls.map(decodeURIComponent);
  assert.equal(decodedUploadUrls.filter((url) => url.endsWith('_a.txt')).length, 1);
  const secondFileUrls = decodedUploadUrls.filter((url) => url.endsWith('_b.txt'));
  assert.equal(secondFileUrls.length, 2);
  assert.equal(
    secondFileUrls[0],
    secondFileUrls[1],
    'retry must reuse the same storage object key'
  );
});

test('a vanished persisted candidate is omitted without blocking process close', async () => {
  const taskId = `close-missing-output-${Date.now()}`;
  const workDir = await createSession(taskId);
  writeFileSync(join(workDir, 'output', 'a.txt'), 'first');
  writeFileSync(join(workDir, 'output', 'b.txt'), 'second');

  let failSecondFile = true;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input));
    if (failSecondFile && url.endsWith('_b.txt')) {
      return new Response(JSON.stringify({ message: 'forced second-file failure' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ Key: url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await assert.rejects(
    () => closeLocalClaudeCodeSession(taskId, 'user-local-close'),
    /forced second-file failure/
  );
  failSecondFile = false;
  rmSync(join(workDir, 'output', 'b.txt'));
  const retried = await closeLocalClaudeCodeSession(taskId, 'user-local-close');
  assert.deepEqual(
    retried.outputFiles.map((file) => file.original_filename),
    ['a.txt']
  );
  assert.equal(existsSync(join(workDir, 'session.json')), false);
});

test('an oversized candidate fails before the file is loaded or uploaded', async () => {
  const taskId = `close-oversized-output-${Date.now()}`;
  const workDir = await createSession(taskId);
  const oversizedPath = join(workDir, 'output', 'oversized.bin');
  writeFileSync(oversizedPath, '');
  truncateSync(oversizedPath, 20 * 1024 * 1024 + 1);
  let uploadCalls = 0;
  globalThis.fetch = (async () => {
    uploadCalls += 1;
    return new Response(JSON.stringify({ Key: 'unexpected' }), { status: 200 });
  }) as typeof fetch;

  await assert.rejects(
    () => closeLocalClaudeCodeSession(taskId, 'user-local-close'),
    /File size exceeds maximum of 20MB/
  );
  assert.equal(uploadCalls, 0, 'oversized output must be rejected before upload');
  rmSync(oversizedPath);
  await closeLocalClaudeCodeSession(taskId, 'user-local-close');
});

test('a symlink candidate is never followed or uploaded', async () => {
  const taskId = `close-symlink-output-${Date.now()}`;
  const workDir = await createSession(taskId);
  const outsidePath = join(fixtureDir, `outside-${taskId}.txt`);
  const symlinkPath = join(workDir, 'output', 'leak.txt');
  writeFileSync(outsidePath, 'belongs to another agent');
  symlinkSync(outsidePath, symlinkPath);
  let uploadCalls = 0;
  globalThis.fetch = (async () => {
    uploadCalls += 1;
    return new Response(JSON.stringify({ Key: 'unexpected' }), { status: 200 });
  }) as typeof fetch;

  await assert.rejects(() => closeLocalClaudeCodeSession(taskId, 'user-local-close'));
  assert.equal(uploadCalls, 0, 'a symlink target must never cross the upload boundary');
  rmSync(symlinkPath);
  await closeLocalClaudeCodeSession(taskId, 'user-local-close');
});

test('an intermediate-directory symlink cannot escape the session', async () => {
  const taskId = `close-intermediate-symlink-${Date.now()}`;
  const workDir = await createSession(taskId);
  const outsideDir = join(fixtureDir, `outside-dir-${taskId}`);
  const outsidePath = join(outsideDir, 'leak.txt');
  const linkedDir = join(workDir, 'linked');
  mkdirSync(outsideDir);
  writeFileSync(outsidePath, 'belongs to another agent');
  symlinkSync(outsideDir, linkedDir, 'dir');
  let uploadCalls = 0;
  globalThis.fetch = (async () => {
    uploadCalls += 1;
    return new Response(JSON.stringify({ Key: 'unexpected' }), { status: 200 });
  }) as typeof fetch;

  await assert.rejects(
    () => closeLocalClaudeCodeSession(taskId, 'user-local-close', ['linked/leak.txt']),
    /escaped its session directory through a symlink/
  );
  assert.equal(uploadCalls, 0, 'an intermediate symlink target must never be uploaded');
  unlinkSync(linkedDir);
  await closeLocalClaudeCodeSession(taskId, 'user-local-close');
});

test('a close without user identity leaves output extraction resumable', async () => {
  const taskId = `close-deferred-identity-${Date.now()}`;
  const workDir = await createSession(taskId);
  writeFileSync(join(workDir, 'output', 'later.txt'), 'extract me later');
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    new Response(JSON.stringify({ Key: String(input) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const anonymousClose = await closeLocalClaudeCodeSession(taskId);
  assert.deepEqual(anonymousClose.outputFiles, []);
  const retained = JSON.parse(readFileSync(join(workDir, 'session.json'), 'utf8')) as {
    outputFiles?: unknown;
  };
  assert.equal(retained.outputFiles, undefined, 'missing userId cannot mark extraction complete');

  const authorizedRetry = await closeLocalClaudeCodeSession(taskId, 'user-local-close');
  assert.deepEqual(
    authorizedRetry.outputFiles.map((file) => file.original_filename),
    ['later.txt']
  );
  assert.equal(existsSync(join(workDir, 'session.json')), false);
});

test('local fallback points the handoff path at its session HOME', async () => {
  const taskId = `handoff-launch-${Date.now()}`;
  const workDir = await createSession(taskId, {
    goal: `Do it.\n\nResult JSON Schema for ${CODE_AGENT_HANDOFF_PATH}:\n{}`,
    envs: { CODE_AGENT_SYSTEM_PROMPT: `Your parent receives only ${CODE_AGENT_HANDOFF_PATH}.` },
  });
  try {
    const localPath = join(workDir, '.rose', 'handoff.json');
    const launched = JSON.parse(readFileSync(join(workDir, 'launch-env.json'), 'utf8')) as {
      goal: string;
      prompt: string;
    };
    // /home/user does not exist on the backend host; the CLI's HOME does.
    assert.equal(launched.goal, `Do it.\n\nResult JSON Schema for ${localPath}:\n{}`);
    assert.equal(launched.prompt, `Your parent receives only ${localPath}.`);
    assert.equal(existsSync(join(workDir, '.rose')), true, 'the handoff directory exists');
  } finally {
    await closeLocalClaudeCodeSession(taskId, 'user-local-close');
  }
});

test('local close returns and consumes the handoff, and a retry returns the same one', async () => {
  const taskId = `handoff-close-${Date.now()}`;
  const workDir = await createSession(taskId);
  const content = JSON.stringify({ sentinel: 'LOCAL_OK' });
  let closed = false;
  try {
    mkdirSync(join(workDir, '.rose'), { recursive: true });
    writeFileSync(join(workDir, '.rose', 'handoff.json'), content);
    // An anonymous close cannot finish extraction, so the authorized retry must
    // still report the handoff the first close consumed.
    const anonymous = await closeLocalClaudeCodeSession(taskId);
    assert.deepEqual(anonymous.handoff, { status: 'present', content });
    assert.equal(existsSync(join(workDir, '.rose', 'handoff.json')), false, 'handoff is consumed');
    const retried = await closeLocalClaudeCodeSession(taskId, 'user-local-close');
    closed = true;
    assert.deepEqual(retried.handoff, { status: 'present', content });
  } finally {
    if (!closed) await closeLocalClaudeCodeSession(taskId, 'user-local-close');
  }
});

test('local close without a handoff file reports it missing', async () => {
  const taskId = `handoff-missing-${Date.now()}`;
  await createSession(taskId);
  const closed = await closeLocalClaudeCodeSession(taskId, 'user-local-close');
  assert.deepEqual(closed.handoff, { status: 'missing' });
});
