import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  closeLocalClaudeCodeSession,
  createLocalClaudeCodeSession,
  createLocalClaudeCodeSessionIfBillingBlocked,
  isE2bTeamBillingBlockError,
  isLocalClaudeCodeSandboxId,
  resolveLocalAttachmentPath,
  resolveLocalSessionWorkDir,
  shouldAllowLocalClaudeCodeFallback,
} from '../../providers/claudeCodeLocalSession';
import { prisma } from '../../providers/database';

test('detects E2B team payment-method blocks', () => {
  assert.equal(
    isE2bTeamBillingBlockError(new Error('403: team is blocked: missing payment method')),
    true
  );
  assert.equal(
    isE2bTeamBillingBlockError(new Error('{"message":"team is blocked: missing payment method"}')),
    true
  );
  assert.equal(isE2bTeamBillingBlockError(new Error('redis pool timeout')), false);
});

test('recognizes local sandbox ids', () => {
  assert.equal(isLocalClaudeCodeSandboxId('local-abc'), true);
  assert.equal(isLocalClaudeCodeSandboxId('i-123'), false);
  assert.equal(isLocalClaudeCodeSandboxId(null), false);
  assert.equal(isLocalClaudeCodeSandboxId(undefined), false);
});

test('disables local fallback on Fly by default', () => {
  const prevFly = process.env.FLY_APP_NAME;
  const prevFlag = process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
  try {
    delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    process.env.FLY_APP_NAME = 'rose-backend';
    assert.equal(shouldAllowLocalClaudeCodeFallback(), false);
    process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = '1';
    assert.equal(shouldAllowLocalClaudeCodeFallback(), true);
    process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = '0';
    delete process.env.FLY_APP_NAME;
    assert.equal(shouldAllowLocalClaudeCodeFallback(), false);
  } finally {
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
    if (prevFlag === undefined) delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    else process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = prevFlag;
  }
});

test('createLocalClaudeCodeSessionIfBillingBlocked returns null when not a billing block', async () => {
  const result = await createLocalClaudeCodeSessionIfBillingBlocked(new Error('rate limited'), {
    taskId: 't-no-op',
    agentId: 'a-no-op',
    goal: 'noop',
    envs: {},
    claudeTokenSource: null,
    claudeTokenIntegrationId: null,
  });
  assert.equal(result, null);
});

test('createLocalClaudeCodeSessionIfBillingBlocked returns null when Fly disables fallback', async () => {
  const prevFly = process.env.FLY_APP_NAME;
  const prevFlag = process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
  try {
    delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    process.env.FLY_APP_NAME = 'rose-backend';
    const result = await createLocalClaudeCodeSessionIfBillingBlocked(
      new Error('403: team is blocked: missing payment method'),
      {
        taskId: 't-fly',
        agentId: 'a-fly',
        goal: 'noop',
        envs: {},
        claudeTokenSource: null,
        claudeTokenIntegrationId: null,
      }
    );
    assert.equal(result, null);
  } finally {
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
    if (prevFlag === undefined) delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    else process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = prevFlag;
  }
});

const fixtureDir = mkdtempSync(join(tmpdir(), 'claude-local-ws-'));
const fakeWsServerPath = join(fixtureDir, 'ws-server.mjs');
// Minimal stand-in for the E2B-template ws-server: bind PORT and stay up until killed.
writeFileSync(
  fakeWsServerPath,
  `
import { createServer } from 'node:net';
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
const createdIds: string[] = [];

before(() => {
  process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH = fakeWsServerPath;
  prisma.claudeCodeSession.create = (async ({ data }: { data: { id: string } }) => {
    createdIds.push(data.id);
    return data;
  }) as typeof prisma.claudeCodeSession.create;
  prisma.claudeCodeSession.update = (async ({ where }: { where: { id: string } }) => {
    return { id: where.id, status: 'CLOSED' };
  }) as typeof prisma.claudeCodeSession.update;
});

/** Session dirs this run created under /tmp/claude-code-local (removed in after()). */
const createdTaskIds = new Set<string>();
function trackTask(taskId: string): string {
  createdTaskIds.add(taskId);
  return taskId;
}

after(() => {
  for (const taskId of createdTaskIds) {
    rmSync(resolveLocalSessionWorkDir(taskId), { recursive: true, force: true });
  }
  delete process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH;
  prisma.claudeCodeSession.create = originalCreate;
  prisma.claudeCodeSession.update = originalUpdate;
  rmSync(fixtureDir, { recursive: true, force: true });
});

test('createLocalClaudeCodeSession boots a local ws listener and close tears it down', async () => {
  const prevFlag = process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
  const prevFly = process.env.FLY_APP_NAME;
  try {
    process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = '1';
    delete process.env.FLY_APP_NAME;

    const taskId = trackTask(`local-session-test-${Date.now()}`);
    const session = await createLocalClaudeCodeSession({
      taskId,
      agentId: 'agent-local-test',
      goal: 'cover local fallback',
      envs: { CLAUDE_CODE_TEST: '1' },
      claudeTokenSource: 'test',
      claudeTokenIntegrationId: null,
    });

    assert.equal(session.taskId, taskId);
    assert.equal(session.sandboxId, `local-${taskId}`);
    assert.match(session.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(session.uploadedFiles.length, 0);
    assert.ok(createdIds.includes(taskId));

    // Port must actually be accepting connections.
    const port = Number(new URL(session.wsUrl).port);
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () => {
        // EADDRINUSE means our child still holds the port — expected.
        resolve();
      });
      probe.listen(port, '127.0.0.1', () => {
        probe.close();
        reject(new Error(`expected local ws-server to hold port ${port}`));
      });
    });

    const closed = await closeLocalClaudeCodeSession(taskId, 'unit-cleanup');
    assert.deepEqual(closed.outputFiles, []);
  } finally {
    if (prevFlag === undefined) delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    else process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = prevFlag;
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
  }
});

test('createLocalClaudeCodeSessionIfBillingBlocked creates when billing-blocked', async () => {
  const prevFlag = process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
  const prevFly = process.env.FLY_APP_NAME;
  try {
    process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = '1';
    delete process.env.FLY_APP_NAME;
    const taskId = trackTask(`local-session-billing-${Date.now()}`);
    const session = await createLocalClaudeCodeSessionIfBillingBlocked(
      new Error('403: team is blocked: missing payment method'),
      {
        taskId,
        agentId: 'agent-billing',
        goal: 'billing fallback',
        envs: {},
        claudeTokenSource: null,
        claudeTokenIntegrationId: null,
      }
    );
    assert.ok(session);
    assert.equal(session!.sandboxId, `local-${taskId}`);
    await closeLocalClaudeCodeSession(taskId, 'unit-cleanup');
  } finally {
    if (prevFlag === undefined) delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    else process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = prevFlag;
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
  }
});

test('close preserves ownership metadata until the database records CLOSED', async () => {
  const taskId = trackTask(`local-session-close-retry-${Date.now()}`);
  await createLocalClaudeCodeSession({
    taskId,
    agentId: 'agent-close-retry',
    goal: 'close ordering',
    envs: {},
    claudeTokenSource: null,
    claudeTokenIntegrationId: null,
  });
  const workingUpdate = prisma.claudeCodeSession.update;
  try {
    prisma.claudeCodeSession.update = (async () => {
      throw new Error('database close unavailable');
    }) as typeof prisma.claudeCodeSession.update;
    await assert.rejects(
      () => closeLocalClaudeCodeSession(taskId, 'unit-close-retry'),
      /database close unavailable/
    );
    assert.equal(
      existsSync(join('/tmp', 'claude-code-local', taskId, 'session.json')),
      true,
      'ownership must survive a failed CLOSED update so cleanup can retry'
    );
    const ownership = JSON.parse(
      readFileSync(join('/tmp', 'claude-code-local', taskId, 'session.json'), 'utf8')
    ) as { outputFiles?: unknown };
    assert.deepEqual(
      ownership.outputFiles,
      [],
      'uploaded output pointers must be persisted before the fallible DB close'
    );
  } finally {
    prisma.claudeCodeSession.update = workingUpdate;
  }
  await closeLocalClaudeCodeSession(taskId, 'unit-close-retry');
  assert.equal(existsSync(join('/tmp', 'claude-code-local', taskId, 'session.json')), false);
});

test('createLocalClaudeCodeSession soft-fails undownloadable attachments', async () => {
  const prevFlag = process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
  const prevFly = process.env.FLY_APP_NAME;
  try {
    process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = '1';
    delete process.env.FLY_APP_NAME;
    const taskId = trackTask(`local-session-attach-${Date.now()}`);
    const session = await createLocalClaudeCodeSession({
      taskId,
      agentId: 'agent-attach',
      goal: 'attachment staging',
      envs: {},
      claudeTokenSource: null,
      claudeTokenIntegrationId: null,
      attachments: [
        {
          id: 'fp-missing',
          storage_path: 'missing/does-not-exist.bin',
          original_filename: 'missing.bin',
          mime_type: 'application/octet-stream',
          size_bytes: 1,
          created_at: new Date().toISOString(),
        },
      ],
    });
    // Staging failed, so nothing was uploaded into the workdir attachments list.
    assert.equal(session.uploadedFiles.length, 0);
    await closeLocalClaudeCodeSession(taskId, 'unit-cleanup');
  } finally {
    if (prevFlag === undefined) delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    else process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = prevFlag;
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
  }
});

test('local attachment paths cannot escape the session attachment directory', () => {
  const workDir = join('/tmp', 'claude-code-local', 'path-boundary');
  assert.equal(
    resolveLocalAttachmentPath(workDir, 'evidence.txt'),
    join(workDir, 'attachments', 'evidence.txt')
  );
  assert.throws(() => resolveLocalAttachmentPath(workDir, '../session.json'), /escapes/);
  assert.throws(() => resolveLocalAttachmentPath(workDir, '/tmp/outside.txt'), /escapes/);
});

test('local session task ids cannot escape or alias another ownership directory', () => {
  assert.equal(
    resolveLocalSessionWorkDir('task-owned-by-this-session'),
    join('/tmp', 'claude-code-local', 'task-owned-by-this-session')
  );
  for (const taskId of ['', '.', '..', '../other-agent', 'nested/other-agent', 'nested\\other']) {
    assert.throws(() => resolveLocalSessionWorkDir(taskId), /Invalid local Claude Code task id/);
  }
});

test('closeLocalClaudeCodeSession extracts output files when userId is provided', async () => {
  const prevFlag = process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
  const prevFly = process.env.FLY_APP_NAME;
  const prevSupabaseUrl = process.env.SUPABASE_URL;
  const prevSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevFetch = globalThis.fetch;
  try {
    process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = '1';
    delete process.env.FLY_APP_NAME;
    process.env.SUPABASE_URL = 'https://supabase.local.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-session-unit-key';
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ Key: 'stored' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const taskId = trackTask(`local-session-output-${Date.now()}`);
    await createLocalClaudeCodeSession({
      taskId,
      agentId: 'agent-output',
      goal: 'output extract',
      envs: {},
      claudeTokenSource: null,
      claudeTokenIntegrationId: null,
    });
    const outputPath = join('/tmp', 'claude-code-local', taskId, 'output', 'result.txt');
    writeFileSync(outputPath, 'hello-from-local-claude');
    const closed = await closeLocalClaudeCodeSession(taskId, 'user-output-extract');
    assert.equal(closed.outputFiles.length, 1);
    assert.equal(closed.outputFiles[0].original_filename, 'result.txt');
  } finally {
    globalThis.fetch = prevFetch;
    if (prevFlag === undefined) delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    else process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = prevFlag;
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
    if (prevSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevSupabaseUrl;
    if (prevSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevSupabaseKey;
  }
});

test('createLocalClaudeCodeSession throws when the ws-server never listens', async () => {
  const prevFlag = process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
  const prevFly = process.env.FLY_APP_NAME;
  const prevOverride = process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH;
  const deadServerPath = join(fixtureDir, 'dead-ws-server.mjs');
  writeFileSync(
    deadServerPath,
    `process.stdout.write('dying without listen\\n'); process.exit(0);\n`
  );
  try {
    process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = '1';
    delete process.env.FLY_APP_NAME;
    process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH = deadServerPath;
    await assert.rejects(
      () =>
        createLocalClaudeCodeSession({
          taskId: trackTask(`local-session-dead-${Date.now()}`),
          agentId: 'agent-dead',
          goal: 'never listens',
          envs: {},
          claudeTokenSource: null,
          claudeTokenIntegrationId: null,
        }),
      /did not prove readiness on port/i
    );
  } finally {
    if (prevFlag === undefined) delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    else process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = prevFlag;
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
    if (prevOverride === undefined) delete process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH;
    else process.env.CLAUDE_CODE_LOCAL_WS_SERVER_PATH = prevOverride;
  }
});
