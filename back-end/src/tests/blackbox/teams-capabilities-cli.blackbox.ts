#!/usr/bin/env tsx
/**
 * A teammate's code agent lists and runs the owner's team-shared CLI (cli grant):
 * the command runs in the OWNER's template sandbox under the owner's lease, its
 * output and receipt are scrubbed of every owner credential value, and the
 * owner's credential files are never leased to the teammate. A shared
 * native-template CLI runs in a fresh OWNER-side sandbox: the owner's bundle is
 * leased server-side, written only into that sandbox, refreshed files are
 * written back on release, and the sandbox is torn down. Unshare, owner
 * disconnect, an invited-only reader and an owner who left remove access at
 * once; a non-member never gets it.
 *
 * Only the sandboxes are stubs (an injected executor / owner-side sandbox):
 * routing, leases, receipts, write-back and scrubbing are the production paths.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { prisma } from '../../providers/database';
import { encryptProjectSecret } from '../../providers/projects/secrets';
import { mintAgentToolsToken } from '../../providers/agentTools/token';
import { runCliIntegration, CliIntegrationError } from '../../providers/cliIntegrations';
import {
  SHARED_CLI_CREDENTIALS_REFUSED,
  SHARED_CLI_UNPROTECTED,
  usableCliIntegration,
} from '../../providers/cliTeamShares';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_CLI_READ_SCRIPT,
  OWNER_CLI_WRITE_SCRIPT,
  OWNER_CLI_ENVIRONMENT_UNAVAILABLE,
  OWNER_CLI_TEMPLATE_UNAVAILABLE,
  SHARED_CLI_OUTPUT_WITHHELD,
  type OwnerCliSandboxFactory,
} from '../../providers/cliSharedNativeRun';
import {
  cliCredentialFileValues,
  type CliCredentialFile,
} from '../../providers/cliNativeCredentials';
import type { CliResult } from '../../providers/cliTemplate';
import { call, expectStatus } from './projects-harness';
import {
  ownerLeaves,
  randomUUID,
  share,
  teamFixture,
  unshare,
  type TeamFixture,
} from './teams-capabilities.harness';

const agentIds: string[] = [];
const sessionIds: string[] = [];
const taskIds: string[] = [];
after(async () => {
  await prisma.message.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.claudeCodeSession.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.codeSession.deleteMany({ where: { id: { in: sessionIds } } });
});

async function agentWithTask(userId: string) {
  const agentId = randomUUID();
  const taskId = randomUUID();
  agentIds.push(agentId);
  taskIds.push(taskId);
  await prisma.agent.create({
    data: { id: agentId, userId, goal: 'teams cli', busId: agentId, status: 'ACTIVE' },
  });
  await prisma.claudeCodeSession.create({
    data: { id: taskId, agentId, sandboxId: `teamcap-${taskId}`, goal: 'cli', status: 'ACTIVE' },
  });
  const token = mintAgentToolsToken(userId, agentId, { provider: 'claude', taskId }).token;
  return { caller: { userId, agentId, taskId }, token };
}

function bundle(files: Record<string, string>) {
  const entries = Object.entries(files).map(([path, text]) => ({
    path,
    data: Buffer.from(text).toString('base64'),
  }));
  return {
    kind: 'native-cli-credentials-v1',
    envelope: encryptProjectSecret(JSON.stringify(entries)),
    paths: entries.map((entry) => entry.path),
  };
}

async function ownerClis(f: TeamFixture) {
  const setup = await agentWithTask(f.owner.userId);
  const sandboxId = `teamcap-owner-sandbox-${randomUUID()}`;
  const session = await prisma.codeSession.create({
    data: {
      userId: f.owner.userId,
      rootAgentId: setup.caller.agentId,
      ownerAgentId: setup.caller.agentId,
      state: 'PAUSED',
      sandboxKind: 'e2b',
      sandboxId,
    },
  });
  sessionIds.push(session.id);
  const secret = {
    token: `OWNER-CLI-TOKEN-${randomUUID()}`,
    refresh: `OWNER-REFRESH-${randomUUID()}`,
    apiKey: `OWNER-API-KEY-${randomUUID()}`,
  };
  const files = {
    '.teamcap/credentials.json': JSON.stringify({
      auth: { token: secret.token, refresh: secret.refresh },
    }),
    '.teamcap/env': `API_KEY=${secret.apiKey}\n`,
  };
  const create = (name: string, config: Record<string, unknown>) =>
    prisma.integration.create({
      data: {
        userId: f.owner.userId,
        name: 'cli',
        accountId: randomUUID(),
        type: 'TOOL_SETUP',
        status: 'CONNECTED',
        isActive: true,
        config: {
          kind: 'cli-template-v1',
          name,
          request: name,
          agent_id: setup.caller.agentId,
          ...config,
        },
      },
    });
  const legacy = await create('TeamCap legacy', {
    code_session_id: session.id,
    command: '/home/user/bin/teamcap',
  });
  const native = await create('TeamCap native', {
    native_template: true,
    command: '/home/user/bin/teamcapn',
    credential_files: Object.keys(files),
  });
  // A legacy connection whose login was never captured: its secrets are unknown.
  const unprotected = await create('TeamCap unprotected', {
    code_session_id: session.id,
    command: '/home/user/bin/teamcapu',
  });
  for (const row of [legacy, native])
    await prisma.integration.create({
      data: {
        userId: f.owner.userId,
        name: 'cli_credentials',
        accountId: row.id,
        type: 'TOOL_SETUP',
        status: 'CONNECTED',
        config: bundle(files),
      },
    });
  return { setup, session, sandboxId, secret, legacy, native, unprotected };
}

/** The sandbox command: echoes every owner secret in several shapes. */
function leakyExecutor(seen: string[], secret: Record<string, string>) {
  return async (params: { sandboxId: string; args: string[] }): Promise<CliResult> => {
    seen.push(params.sandboxId);
    return {
      exit_code: 0,
      stdout: `whoami ok token=${secret.token} api="${secret.apiKey}"`,
      stderr: `refresh ${secret.refresh}`,
    };
  };
}

function noSecret(value: unknown, secret: Record<string, string>, label: string) {
  const text = JSON.stringify(value);
  for (const item of Object.values(secret)) assert.ok(!text.includes(item), `${label} leaked`);
}

async function runHttp(agentId: string, token: string, id: string) {
  return call(`/api/agent-tools/${agentId}/cli/${id}/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: { args: ['whoami'], request_id: randomUUID() },
  });
}

async function listed(agentId: string, token: string) {
  const res = await call(`/api/agent-tools/${agentId}/cli`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expectStatus(res, 200, 'cli list');
  return res.data.integrations as Array<Record<string, unknown>>;
}

test('a teammate runs the shared CLI in the owner sandbox; output is scrubbed; no lease', async () => {
  const f = await teamFixture('cli');
  const owner = await ownerClis(f);
  const reader = await agentWithTask(f.reader.userId);
  expectStatus(await runHttp(reader.caller.agentId, reader.token, owner.legacy.id), 404, 'private');
  assert.equal((await listed(reader.caller.agentId, reader.token)).length, 0);

  await share(f, owner.legacy.id);
  await share(f, owner.native.id);
  await share(f, owner.unprotected.id);
  const list = await listed(reader.caller.agentId, reader.token);
  noSecret(list, owner.secret, 'list');
  const legacy = list.find((row) => row.id === owner.legacy.id);
  assert.equal(legacy?.status, 'connected');
  assert.deepEqual(legacy?.shared, {
    team_id: f.teamId,
    team_name: 'cli team',
    owner_user_id: f.owner.userId,
    owner_name: 'cli owner',
  });
  const native = list.find((row) => row.id === owner.native.id);
  assert.equal(native?.status, 'connected', 'a shared native CLI is runnable');

  // Native without a published owner template: a clear error before any lease.
  const nativeRun = await runHttp(reader.caller.agentId, reader.token, owner.native.id);
  expectStatus(nativeRun, 409, 'shared native run without owner template');
  assert.equal(nativeRun.data.error, OWNER_CLI_TEMPLATE_UNAVAILABLE);
  for (const id of [owner.native.id, owner.legacy.id]) {
    const acquire = await call(
      `/api/agent-tools/${reader.caller.agentId}/cli/${id}/native/acquire`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${reader.token}` },
        body: {},
      }
    );
    expectStatus(acquire, 403, 'teammate credential lease');
    assert.equal(acquire.data.error, SHARED_CLI_CREDENTIALS_REFUSED);
    noSecret(acquire.data, owner.secret, 'acquire');
  }
  const bundles = await prisma.integration.findMany({
    where: { userId: f.owner.userId, name: 'cli_credentials' },
  });
  assert.ok(
    bundles.every((row) => !('lease' in (row.config as object))),
    'no lease was taken'
  );

  // Unknown owner secrets fail closed: listed as failed, never executed.
  const unprotectedEntry = list.find((row) => row.id === owner.unprotected.id);
  assert.equal(unprotectedEntry?.status, 'failed');
  assert.equal(unprotectedEntry?.error, SHARED_CLI_UNPROTECTED);
  const unprotectedRun = await runHttp(reader.caller.agentId, reader.token, owner.unprotected.id);
  expectStatus(unprotectedRun, 409, 'unprotected shared run');
  assert.equal(unprotectedRun.data.error, SHARED_CLI_UNPROTECTED);
  const never: string[] = [];
  await assert.rejects(
    runCliIntegration(reader.caller, owner.unprotected.id, ['whoami'], randomUUID(), {
      execute: leakyExecutor(never, owner.secret),
    }),
    (error: unknown) => error instanceof CliIntegrationError && error.status === 409
  );
  assert.deepEqual(never, [], 'never executed without known secrets');

  // Legacy: runs in the OWNER's template sandbox, scrubbed, receipt scrubbed too.
  const seen: string[] = [];
  const requestId = randomUUID();
  const run = () =>
    runCliIntegration(reader.caller, owner.legacy.id, ['whoami'], requestId, {
      execute: leakyExecutor(seen, owner.secret),
    });
  const result = await run();
  assert.deepEqual(seen, [owner.sandboxId], 'executed in the owner sandbox');
  noSecret(result, owner.secret, 'run output');
  assert.equal(result.stdout, 'whoami ok token=[redacted] api="[redacted]"');
  assert.equal(result.stderr, 'refresh [redacted]');
  const receipts = await prisma.message.findMany({ where: { agentId: reader.caller.agentId } });
  assert.equal(receipts.length, 1);
  noSecret(receipts, owner.secret, 'receipt');
  assert.deepEqual(await run(), result, 'a retried request replays the scrubbed receipt');
  assert.equal(seen.length, 1, 'never executed twice');
  const session = await prisma.codeSession.findUniqueOrThrow({ where: { id: owner.session.id } });
  assert.equal(session.leaseOwner, null, 'owner sandbox lease released');

  // The owner's own run is unchanged (its own output, unscrubbed).
  const ownSeen: string[] = [];
  const own = await runCliIntegration(
    owner.setup.caller,
    owner.legacy.id,
    ['whoami'],
    randomUUID(),
    { execute: leakyExecutor(ownSeen, owner.secret) }
  );
  assert.ok(own.stdout.includes(owner.secret.token));
});

/** A stub owner-side sandbox: records what reaches it and what the bundle lease looked like. */
function fakeOwnerSide(
  ownerUserId: string,
  integrationId: string,
  options: {
    rotated?: Record<string, string>;
    output?: string;
    failWrite?: boolean;
    failRead?: boolean;
  }
) {
  const record = {
    starts: [] as string[],
    written: [] as CliCredentialFile[][],
    runs: [] as Array<{ command: string; args: string[]; conversation: string; lease: unknown }>,
    killed: 0,
  };
  const factory: OwnerCliSandboxFactory = async (owner) => {
    record.starts.push(owner);
    return {
      sandboxId: `fake-owner-side-${randomUUID()}`,
      async writeFiles(files) {
        if (options.failWrite === true) throw new Error('fixture disk failure');
        record.written.push(files);
      },
      async run(command, args, conversation) {
        const bundle = await prisma.integration.findFirstOrThrow({
          where: { userId: ownerUserId, name: 'cli_credentials', accountId: integrationId },
        });
        record.runs.push({
          command,
          args,
          conversation,
          lease: (bundle.config as { lease?: unknown }).lease,
        });
        return { exit_code: 0, stdout: options.output ?? 'ok', stderr: '' };
      },
      async readFiles(paths) {
        if (options.failRead === true) throw new Error('fixture capture failure');
        const latest = record.written[record.written.length - 1] ?? [];
        return paths.map((path) => {
          const rotated = options.rotated?.[path];
          if (rotated !== undefined) return { path, data: Buffer.from(rotated).toString('base64') };
          return { path, data: latest.find((file) => file.path === path)?.data ?? null };
        });
      },
      async kill() {
        record.killed += 1;
      },
    };
  };
  return { record, factory };
}

const decoded = (files: CliCredentialFile[]) =>
  Object.fromEntries(
    files.map((file) => [
      file.path,
      file.data === null ? null : Buffer.from(file.data, 'base64').toString(),
    ])
  );

async function bundleLease(ownerUserId: string, integrationId: string) {
  const row = await prisma.integration.findFirstOrThrow({
    where: { userId: ownerUserId, name: 'cli_credentials', accountId: integrationId },
  });
  return (row.config as { lease?: { agentId: string; taskId: string } }).lease;
}

test('a shared native CLI runs in an owner-side sandbox under the owner lease, written back and scrubbed', async () => {
  const f = await teamFixture('cli-native');
  const owner = await ownerClis(f);
  const reader = await agentWithTask(f.reader.userId);
  await share(f, owner.native.id);
  const original = await cliCredentialFileValues(f.owner.userId, owner.native.id);
  const rotatedToken = `OWNER-ROTATED-TOKEN-${randomUUID()}`;
  const rotatedFile = JSON.stringify({
    auth: { token: rotatedToken, refresh: owner.secret.refresh },
  });
  const ownerSide = fakeOwnerSide(f.owner.userId, owner.native.id, {
    rotated: { '.teamcap/credentials.json': rotatedFile },
    output: `whoami ok token=${owner.secret.token} next=${rotatedToken} api=${owner.secret.apiKey}`,
  });
  const requestId = randomUUID();
  const run = () =>
    runCliIntegration(reader.caller, owner.native.id, ['whoami', '--json'], requestId, {
      startOwnerSandbox: ownerSide.factory,
    });
  const result = await run();

  assert.deepEqual(ownerSide.record.starts, [f.owner.userId], "started from the OWNER's template");
  assert.equal(ownerSide.record.written.length, 1, 'files written into the owner-side sandbox');
  assert.deepEqual(
    Object.values(decoded(ownerSide.record.written[0])).sort(),
    [...(original ?? [])].sort(),
    "exactly the owner's stored files"
  );
  assert.equal(ownerSide.record.runs.length, 1);
  const [ran] = ownerSide.record.runs;
  assert.equal(ran.command, '/home/user/bin/teamcapn');
  assert.deepEqual(ran.args, ['whoami', '--json']);
  assert.equal(ran.conversation, reader.caller.taskId);
  assert.deepEqual(
    {
      agentId: (ran.lease as { agentId: string }).agentId,
      taskId: (ran.lease as { taskId: string }).taskId,
    },
    { agentId: reader.caller.agentId, taskId: reader.caller.taskId },
    "the owner's lease was held for the run"
  );
  assert.equal(ownerSide.record.killed, 1, 'owner-side sandbox torn down');
  assert.equal(await bundleLease(f.owner.userId, owner.native.id), undefined, 'lease released');
  const after = await cliCredentialFileValues(f.owner.userId, owner.native.id);
  assert.ok(after?.includes(rotatedFile), 'refreshed login written back');

  const secrets = { ...owner.secret, rotatedToken };
  noSecret(result, secrets, 'native run output');
  assert.equal(result.stdout, 'whoami ok token=[redacted] next=[redacted] api=[redacted]');
  const receipts = await prisma.message.findMany({ where: { agentId: reader.caller.agentId } });
  assert.equal(receipts.length, 1);
  noSecret(receipts, secrets, 'native receipt');
  assert.deepEqual(await run(), result, 'a retry replays the scrubbed receipt');
  assert.equal(ownerSide.record.starts.length, 1, 'never executed twice');

  // The teammate never holds the files: native leasing stays owner-only.
  const acquire = await call(
    `/api/agent-tools/${reader.caller.agentId}/cli/${owner.native.id}/native/acquire`,
    { method: 'POST', headers: { Authorization: `Bearer ${reader.token}` }, body: {} }
  );
  expectStatus(acquire, 403, 'teammate native acquire');
  noSecret(acquire.data, secrets, 'acquire');

  // A failure before the command runs releases the untouched files and is retryable.
  const broken = fakeOwnerSide(f.owner.userId, owner.native.id, { failWrite: true });
  await assert.rejects(
    runCliIntegration(reader.caller, owner.native.id, ['whoami'], randomUUID(), {
      startOwnerSandbox: broken.factory,
    }),
    (error: unknown) =>
      error instanceof CliIntegrationError && error.message === OWNER_CLI_ENVIRONMENT_UNAVAILABLE
  );
  assert.equal(broken.record.killed, 1);
  assert.equal(await bundleLease(f.owner.userId, owner.native.id), undefined);
  assert.deepEqual(await cliCredentialFileValues(f.owner.userId, owner.native.id), after);
  assert.equal(await prisma.message.count({ where: { agentId: reader.caller.agentId } }), 1);

  // A refreshed login that cannot be captured withholds the output and is never re-run.
  const lost = fakeOwnerSide(f.owner.userId, owner.native.id, {
    failRead: true,
    output: `leak ${rotatedToken}`,
  });
  const lostRequest = randomUUID();
  const lostRun = () =>
    runCliIntegration(reader.caller, owner.native.id, ['whoami'], lostRequest, {
      startOwnerSandbox: lost.factory,
    });
  await assert.rejects(lostRun(), (error: unknown) => {
    assert.ok(error instanceof CliIntegrationError && error.message === SHARED_CLI_OUTPUT_WITHHELD);
    assert.ok(!error.message.includes(rotatedToken));
    return true;
  });
  assert.equal(lost.record.killed, 1);
  await assert.rejects(
    lostRun(),
    (error: unknown) => error instanceof CliIntegrationError && error.status === 409
  );
  assert.equal(lost.record.starts.length, 1, 'an unknown outcome never runs again');
  noSecret(
    await prisma.message.findMany({ where: { agentId: reader.caller.agentId } }),
    secrets,
    'receipts'
  );
});

test('unshare, invited-only, non-member, disconnect and owner leaving end shared CLI access', async () => {
  const f = await teamFixture('cli-revoke');
  const owner = await ownerClis(f);
  const reader = await agentWithTask(f.reader.userId);
  const usable = async (userId: string) => {
    try {
      return (await usableCliIntegration(userId, owner.legacy.id)).shared !== null;
    } catch (error) {
      assert.ok(error instanceof CliIntegrationError && error.status === 404, String(error));
      return false;
    }
  };
  // Only ever called once access should be gone: a live run would reach the real sandbox.
  const visible = async () => {
    const direct = await usable(f.reader.userId);
    const inList = (await listed(reader.caller.agentId, reader.token)).some(
      (row) => row.id === owner.legacy.id
    );
    assert.equal(inList, direct, 'list and run agree');
    if (!direct)
      expectStatus(await runHttp(reader.caller.agentId, reader.token, owner.legacy.id), 404, 'run');
    return direct;
  };
  // A revoked native CLI never starts an owner-side sandbox.
  const ownerSide = fakeOwnerSide(f.owner.userId, owner.native.id, {});
  const nativeBlocked = async (userId: string, label: string) => {
    await assert.rejects(
      runCliIntegration({ ...reader.caller, userId }, owner.native.id, ['whoami'], randomUUID(), {
        startOwnerSandbox: ownerSide.factory,
      }),
      (error: unknown) => error instanceof CliIntegrationError && error.status === 404,
      label
    );
    assert.deepEqual(ownerSide.record.starts, [], `${label}: no owner sandbox`);
  };
  await share(f, owner.legacy.id);
  await share(f, owner.native.id);
  assert.equal(await usable(f.reader.userId), true);
  await nativeBlocked(f.invited.userId, 'invited only');
  await nativeBlocked(f.outsider.userId, 'non-member');
  assert.equal(await usable(f.invited.userId), false, 'invited only');
  assert.equal(await usable(f.outsider.userId), false, 'non-member');

  await unshare(f, owner.legacy.id);
  await unshare(f, owner.native.id);
  assert.equal(await visible(), false, 'unshared');
  await nativeBlocked(f.reader.userId, 'native unshared');
  await share(f, owner.native.id);
  await prisma.integration.update({
    where: { id: owner.native.id },
    data: { status: 'EXPIRED', isActive: false },
  });
  await nativeBlocked(f.reader.userId, 'native owner disconnected');
  await share(f, owner.legacy.id);
  assert.equal(await usable(f.reader.userId), true);
  await prisma.integration.update({
    where: { id: owner.legacy.id },
    data: { status: 'EXPIRED', isActive: false },
  });
  assert.equal(await visible(), false, 'owner disconnected');
  await prisma.integration.update({
    where: { id: owner.legacy.id },
    data: { status: 'CONNECTED', isActive: true },
  });
  assert.equal(await usable(f.reader.userId), true);
  await ownerLeaves(f);
  assert.equal(await visible(), false, 'owner left the team');
});

test('owner-side sandbox scripts write and capture credentials without following links', () => {
  const home = mkdtempSync(join(tmpdir(), 'teamcap-cli-home-'));
  const outside = mkdtempSync(join(tmpdir(), 'teamcap-cli-outside-'));
  try {
    scriptChecks(home, outside);
  } finally {
    // Our own mkdtemp directories; rmSync removes links without following them.
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function scriptChecks(home: string, outside: string) {
  const write = (files: CliCredentialFile[]) => {
    const spec = join(home, '..', `teamcap-spec-${randomUUID()}.json`);
    writeFileSync(spec, JSON.stringify(files));
    execFileSync('python3', ['-c', OWNER_CLI_WRITE_SCRIPT, spec, home], { stdio: 'pipe' });
    assert.throws(() => lstatSync(spec), 'the spec file is deleted after reading');
  };
  const read = (paths: string[]) =>
    JSON.parse(
      execFileSync('python3', ['-c', OWNER_CLI_READ_SCRIPT, JSON.stringify(paths), home], {
        stdio: 'pipe',
      }).toString()
    ) as CliCredentialFile[];
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  write([
    { path: '.teamcap/nested/credentials.json', data: b64('{"token":"A"}') },
    { path: '.teamcap/env', data: b64('API_KEY=B') },
  ]);
  assert.equal(
    readFileSync(join(home, '.teamcap/nested/credentials.json'), 'utf8'),
    '{"token":"A"}'
  );
  assert.equal(lstatSync(join(home, '.teamcap/env')).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(home, '.teamcap/nested')).mode & 0o777, 0o700);
  assert.deepEqual(read(['.teamcap/env', '.teamcap/missing']), [
    { path: '.teamcap/env', data: b64('API_KEY=B') },
    { path: '.teamcap/missing', data: null },
  ]);
  write([{ path: '.teamcap/env', data: null }]);
  assert.deepEqual(read(['.teamcap/env']), [{ path: '.teamcap/env', data: null }], 'removed');
  // A planted link never redirects a write or a capture outside HOME.
  mkdirSync(join(outside, 'target'));
  symlinkSync(join(outside, 'target'), join(home, '.linked'));
  assert.throws(() => write([{ path: '.linked/credentials.json', data: b64('X') }]));
  assert.throws(() => lstatSync(join(outside, 'target', 'credentials.json')));
  writeFileSync(join(outside, 'secret'), 'OUTSIDE');
  symlinkSync(join(outside, 'secret'), join(home, '.teamcap/link'));
  assert.throws(() => read(['.teamcap/link']));
}
