#!/usr/bin/env tsx
/**
 * REAL run: a teammate's `rose cli run` on the owner's team-shared native CLI
 * executes in a REAL owner-side E2B sandbox (startCliSandboxFromTemplate, the
 * production create + adapter), not a stub:
 *
 *   owner's credential bundle ──server-side lease──► written into the E2B sandbox
 *   `/bin/sh -c 'cat credentials; rotate it'` runs there ──► real stdout
 *   refreshed file read back from the sandbox ──► written back on release
 *   output scrubbed ([redacted]) ──► sandbox killed (E2B no longer knows it)
 *
 * The one difference from production: the sandbox boots the current base code
 * template instead of the owner's published CLI snapshot (startOwnerCliSandbox
 * picks that snapshot; publishing one builds every provider/size variant).
 * No silent skip: a missing E2B key or template fails with the exact fix.
 * Cost: one short-lived 2 vCPU sandbox per run.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { encryptProjectSecret } from '../../providers/projects/secrets';
import { mintAgentToolsToken } from '../../providers/agentTools/token';
import { runCliIntegration } from '../../providers/cliIntegrations';
import { cliCredentialFileValues } from '../../providers/cliNativeCredentials';
import {
  startCliSandboxFromTemplate,
  type OwnerCliSandbox,
  type OwnerCliSandboxFactory,
} from '../../providers/cliSharedNativeRun';
import { availableSizes, sandboxTemplateFor } from '../../providers/codeSessions/sandboxSize';
import { call, expectStatus } from './projects-harness';
import { randomUUID, share, teamFixture } from './teams-capabilities.harness';

const CREDENTIAL_PATH = '.teamcap/credentials.json';
const agentIds: string[] = [];
const taskIds: string[] = [];
after(async () => {
  await prisma.message.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.claudeCodeSession.deleteMany({ where: { id: { in: taskIds } } });
});

function liveTemplate(): { templateId: string; provider: 'claude' | 'codex' } {
  if (!process.env.E2B_API_KEY)
    throw new Error('E2B_API_KEY is not set: put the E2B key in back-end/.env to run this case.');
  for (const provider of ['codex', 'claude'] as const) {
    const [size] = availableSizes(provider);
    const templateId = size === undefined ? null : sandboxTemplateFor(provider, size);
    if (templateId !== null) return { templateId, provider };
  }
  throw new Error(
    'No E2B code template is configured: set the sandbox template env (codeSessions/sandboxSize.ts).'
  );
}

async function agentWithTask(userId: string) {
  const agentId = randomUUID();
  const taskId = randomUUID();
  agentIds.push(agentId);
  taskIds.push(taskId);
  await prisma.agent.create({
    data: { id: agentId, userId, goal: 'teams cli live', busId: agentId, status: 'ACTIVE' },
  });
  await prisma.claudeCodeSession.create({
    data: { id: taskId, agentId, sandboxId: `teamcap-${taskId}`, goal: 'cli', status: 'ACTIVE' },
  });
  return {
    caller: { userId, agentId, taskId },
    token: mintAgentToolsToken(userId, agentId, { provider: 'claude', taskId }).token,
  };
}

test('a shared native CLI runs in a real owner-side E2B sandbox: scrubbed, written back, killed', async () => {
  const { templateId, provider } = liveTemplate();
  const f = await teamFixture('cli-live');
  const secret = `OWNER-LIVE-SECRET-${randomUUID()}`;
  const rotated = `OWNER-LIVE-ROTATED-${randomUUID()}`;
  const cli = await prisma.integration.create({
    data: {
      userId: f.owner.userId,
      name: 'cli',
      accountId: randomUUID(),
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      config: {
        kind: 'cli-template-v1',
        name: 'TeamCap live',
        request: 'TeamCap live',
        agent_id: randomUUID(),
        native_template: true,
        command: '/bin/sh',
        credential_files: [CREDENTIAL_PATH],
      },
    },
  });
  const files = [
    {
      path: CREDENTIAL_PATH,
      data: Buffer.from(JSON.stringify({ token: secret })).toString('base64'),
    },
  ];
  await prisma.integration.create({
    data: {
      userId: f.owner.userId,
      name: 'cli_credentials',
      accountId: cli.id,
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      config: {
        kind: 'native-cli-credentials-v1',
        envelope: encryptProjectSecret(JSON.stringify(files)),
        paths: [CREDENTIAL_PATH],
      },
    },
  });
  await share(f, cli.id);
  const reader = await agentWithTask(f.reader.userId);

  const started: string[] = [];
  let killed = 0;
  const realOwnerSide: OwnerCliSandboxFactory = async (ownerUserId, integrationId) => {
    assert.equal(ownerUserId, f.owner.userId, "the sandbox is started for the OWNER's CLI");
    const sandbox: OwnerCliSandbox = await startCliSandboxFromTemplate(
      templateId,
      provider,
      integrationId
    );
    started.push(sandbox.sandboxId);
    return {
      ...sandbox,
      kill: async () => {
        killed += 1;
        await sandbox.kill();
      },
    };
  };
  const script = [
    `cat ${CREDENTIAL_PATH}`,
    `printf '%s' '{"token":"${rotated}"}' > ${CREDENTIAL_PATH}`,
    'echo',
    `echo next=${rotated}`,
    `ls -l ${CREDENTIAL_PATH} | cut -c1-10`,
  ].join('; ');
  const result = await runCliIntegration(reader.caller, cli.id, ['-c', script], randomUUID(), {
    startOwnerSandbox: realOwnerSide,
  });
  console.log(
    `[teams-capabilities-cli-live] template=${templateId} sandbox=${started[0]} exit=${result.exit_code} ` +
      `stdout=${JSON.stringify(result.stdout)}`
  );

  assert.equal(started.length, 1, 'one real owner-side sandbox');
  assert.equal(result.exit_code, 0, result.stderr);
  for (const value of [secret, rotated])
    assert.ok(!JSON.stringify(result).includes(value), 'no owner secret in the real output');
  assert.ok(result.stdout.includes('[redacted]'), result.stdout);
  assert.ok(result.stdout.includes('next=[redacted]'), 'the refreshed value is scrubbed too');
  assert.ok(result.stdout.includes('-rw-------'), 'the credential file was written 0600');
  const stored = await cliCredentialFileValues(f.owner.userId, cli.id);
  assert.deepEqual(stored, [JSON.stringify({ token: rotated })], 'refreshed file written back');
  const receipts = await prisma.message.findMany({ where: { agentId: reader.caller.agentId } });
  for (const value of [secret, rotated]) assert.ok(!JSON.stringify(receipts).includes(value));

  assert.equal(killed, 1, 'torn down');
  assert.equal(
    await Sandbox.kill(started[0], { apiKey: process.env.E2B_API_KEY }),
    false,
    'E2B no longer knows the owner-side sandbox'
  );
  const acquire = await call(
    `/api/agent-tools/${reader.caller.agentId}/cli/${cli.id}/native/acquire`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${reader.token}` },
      body: {},
    }
  );
  expectStatus(acquire, 403, 'the teammate never leases the files');
});
