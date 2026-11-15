#!/usr/bin/env tsx
/**
 * A teammate's code agent lists and runs the owner's team-shared CLI (cli grant):
 * the command runs in the OWNER's template sandbox under the owner's lease, its
 * output and receipt are scrubbed of every owner credential value, and the
 * owner's credential files are never leased to the teammate. A shared
 * native-template CLI returns a clear error instead of leasing credentials.
 * Unshare, owner disconnect, an invited-only reader and an owner who left remove
 * access at once; a non-member never gets it.
 *
 * The sandbox command itself is the only stub (an injected executor): routing,
 * leases, receipts and scrubbing are the production code paths.
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
  SHARED_NATIVE_CLI_UNAVAILABLE,
  usableCliIntegration,
} from '../../providers/cliTeamShares';
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
  assert.equal(native?.status, 'failed');
  assert.equal(native?.error, SHARED_NATIVE_CLI_UNAVAILABLE);

  // Native: a clear error, never a credential lease.
  const nativeRun = await runHttp(reader.caller.agentId, reader.token, owner.native.id);
  expectStatus(nativeRun, 409, 'shared native run');
  assert.equal(nativeRun.data.error, SHARED_NATIVE_CLI_UNAVAILABLE);
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
    runCliIntegration(
      reader.caller,
      owner.unprotected.id,
      ['whoami'],
      randomUUID(),
      leakyExecutor(never, owner.secret)
    ),
    (error: unknown) => error instanceof CliIntegrationError && error.status === 409
  );
  assert.deepEqual(never, [], 'never executed without known secrets');

  // Legacy: runs in the OWNER's template sandbox, scrubbed, receipt scrubbed too.
  const seen: string[] = [];
  const requestId = randomUUID();
  const run = () =>
    runCliIntegration(
      reader.caller,
      owner.legacy.id,
      ['whoami'],
      requestId,
      leakyExecutor(seen, owner.secret)
    );
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
    leakyExecutor(ownSeen, owner.secret)
  );
  assert.ok(own.stdout.includes(owner.secret.token));
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
    const inList = (await listed(reader.caller.agentId, reader.token)).length > 0;
    assert.equal(inList, direct, 'list and run agree');
    if (!direct)
      expectStatus(await runHttp(reader.caller.agentId, reader.token, owner.legacy.id), 404, 'run');
    return direct;
  };
  await share(f, owner.legacy.id);
  assert.equal(await usable(f.reader.userId), true);
  assert.equal(await usable(f.invited.userId), false, 'invited only');
  assert.equal(await usable(f.outsider.userId), false, 'non-member');

  await unshare(f, owner.legacy.id);
  assert.equal(await visible(), false, 'unshared');
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
