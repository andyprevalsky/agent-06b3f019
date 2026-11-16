#!/usr/bin/env tsx
/**
 * Black-box contract for C15: a code agent that hits a provider usage limit
 * resumes on the next credential (or the other provider) from its saved session.
 *
 *   POST /:taskId/usage-limit ──► the task's pool token gets rateLimitedUntil = reset
 *   GET /credential-availability ──► leasable Claude / Codex credential right now
 *   createWithCodeSession(provider switch) ──► same session, checkpoint restore,
 *                                              handoff summary, no foreign --resume id
 *   Mac session (C14) ──► only the user's own login is marked; own_only
 *                         availability ignores pool tokens; keepalive skips E2B
 *
 * C15 rotation branches (the agents half is code_sessions.blackbox.py rotation_*):
 *   (a) the usage-limit answer lists shared pools and funded keys; a funded
 *       Codex limit backs only that deployment off until the reset
 *   (b) same provider: the paused sandbox resumes with the CLI conversation id
 *   (c) other provider: handoff prompt naming the trajectory file, and the
 *       file is in the new sandbox after the checkpoint restore
 *   (d) nothing leasable: the earliest reset of any path
 *   (e) GET /credential-availability?code_session_id names the session's provider
 *   (f) duplicate retries: one lease holder, one provider switch
 *   (g) no credential value in any answer, handoff or log line
 *   Codex order (code-session-codex-azure.cases.ts): own login → shared login →
 *       funded Azure deployment → nothing; the served path is recorded
 *   Subscriptions first (code-session-credential-order.cases.ts): P subscription →
 *       Q subscription (handoff) → P funded key → Q funded key → paused
 *
 * Hermetic: local checkpoint storage, real DB rows, fake E2B over local HOMEs,
 * no E2B or provider calls.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  constants as cryptoConstants,
  createCipheriv,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { NO_CODE_RESOURCES } from '../../providers/codeSessions/sandboxResources';
import {
  checkpointCodeSession,
  restoreLatestCheckpoint,
} from '../../providers/codeSessions/lifecycle';
import { localSandboxFs } from '../../providers/codeSessions/sandboxFs';
import { createWithCodeSession, keepAliveCodeTask } from '../../providers/codeSessions/spawn';
import { markPaused } from '../../providers/codeSessions/store';
import {
  __resetCodexFundedCooldown,
  codeCredentialAvailability,
  codeUsageOutlook,
  markCodeTaskUsageLimited,
  parseResetsAt,
} from '../../providers/codeSessions/usageLimit';
import { Sandbox } from 'e2b';
import { registerCodeSessionRotationCases } from './code-session-rotation.cases';
import { registerCodexAzureFallbackCases } from './code-session-codex-azure.cases';
import { registerCodeSessionCredentialOrderCases } from './code-session-credential-order.cases';
import { fetchClaudeCodeCredentialsWithMeta } from '../../providers/claudeCredentials';
import { claudeTaskIntegrationId } from '../../providers/claudeCodeSandboxAuth';
import { localDeviceSandboxId } from '../../providers/localDevices/hub';
import { buildLocalSessionEnvs } from '../../providers/localDevices/session';
import { isolateFundedKeyCooldowns } from './funded-key-cooldown.support';
import { quarantine } from '../helpers/quarantine';

config();

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3001';
const apiKey = process.env.BACKEND_API_KEY || '';
const fixtureDir = mkdtempSync(join(tmpdir(), 'code-usage-limit-blackbox-'));
const userId = `code-usage-${randomUUID()}`;
const agentId = randomUUID();
const command = `echo usage-${randomUUID().slice(0, 8)}`;
const saved = {
  backend: process.env.CODE_SESSION_STORAGE_BACKEND,
  dir: process.env.CODE_SESSION_STORAGE_LOCAL_DIR,
  anthropic: process.env.ANTHROPIC_API_KEY,
  claudeCodeKey: process.env.CLAUDE_CODE_ANTHROPIC_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  gpt: process.env.GPT_API_KEY,
  decryptionKey: process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY,
  foundryEndpoint: process.env.AZURE_FOUNDRY_ENDPOINT,
  foundryKey: process.env.AZURE_FOUNDRY_API_KEY,
  codexAzureHost: process.env.CODEX_AZURE_FOUNDRY_HOST,
};
const original = {
  kill: Sandbox.kill,
  create: Sandbox.create,
  connect: Sandbox.connect,
};
const createdIntegrations: string[] = [];
let restoreCooldowns: (() => Promise<void>) | undefined;

async function poolToken(name: 'claude_code' | 'gpt_code'): Promise<string> {
  const row = await prisma.integration.create({
    data: {
      userId: `pool-owner-${randomUUID()}`,
      type: 'TOOL_SETUP',
      name,
      status: 'CONNECTED',
      isActive: true,
      poolingEnabled: true,
    },
  });
  createdIntegrations.push(row.id);
  return row.id;
}

async function task(integrationId: string): Promise<string> {
  const row = await prisma.claudeCodeSession.create({
    data: {
      agentId,
      sandboxId: `sb-${randomUUID()}`,
      goal: 'g',
      claudeTokenSource: 'pool',
      claudeTokenIntegrationId: integrationId,
    },
  });
  return row.id;
}

/** Leasable pooled rows of `name` this test did not create (shared test DB). */
async function otherLeasable(name: string): Promise<number> {
  const now = new Date();
  return prisma.integration.count({
    where: {
      name,
      status: 'CONNECTED',
      poolingEnabled: true,
      id: { notIn: createdIntegrations },
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
    },
  });
}

before(async () => {
  // Funded-key cases run in-process with fake keys; HTTP cases use real,
  // fixture-owned subscription rows, which this isolation leaves untouched.
  restoreCooldowns = await isolateFundedKeyCooldowns();
  process.env.CODE_SESSION_STORAGE_BACKEND = 'local';
  process.env.CODE_SESSION_STORAGE_LOCAL_DIR = join(fixtureDir, 'storage');
  // Shared funded keys (and the gateways a Claude Code sandbox would use)
  // would make every availability answer true.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GPT_API_KEY;
  // Only a test-owned Foundry host can back the funded Codex path here.
  process.env.CODEX_AZURE_FOUNDRY_HOST = 'codex-funded.blackbox.invalid';
  delete process.env.AZURE_FOUNDRY_ENDPOINT;
  delete process.env.AZURE_FOUNDRY_API_KEY;
  await __resetCodexFundedCooldown();
  await prisma.user.create({ data: { userId, name: 'Usage Limit' } });
  await prisma.agent.create({ data: { id: agentId, userId, goal: 'Ship the parser' } });
});

after(async () => {
  try {
    for (const [key, value] of [
      ['CODE_SESSION_STORAGE_BACKEND', saved.backend],
      ['CODE_SESSION_STORAGE_LOCAL_DIR', saved.dir],
      ['ANTHROPIC_API_KEY', saved.anthropic],
      ['CLAUDE_CODE_ANTHROPIC_API_KEY', saved.claudeCodeKey],
      ['OPENROUTER_API_KEY', saved.openrouter],
      ['GPT_API_KEY', saved.gpt],
      ['CLAUDE_CREDENTIAL_DECRYPTION_KEY', saved.decryptionKey],
      ['AZURE_FOUNDRY_ENDPOINT', saved.foundryEndpoint],
      ['AZURE_FOUNDRY_API_KEY', saved.foundryKey],
      ['CODEX_AZURE_FOUNDRY_HOST', saved.codexAzureHost],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    Object.assign(Sandbox, original);
    await prisma.claudeCodeSession.deleteMany({ where: { agentId } });
    await prisma.codeSession.deleteMany({ where: { userId } });
    await prisma.integration.deleteMany({ where: { id: { in: createdIntegrations } } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    rmSync(fixtureDir, { recursive: true, force: true });
  } finally {
    try {
      await restoreCooldowns?.();
    } finally {
      await prisma.$disconnect();
    }
  }
});

// First, before the cases below leave pooled subscriptions of their own behind.
registerCodeSessionCredentialOrderCases({ sealEnvelope, http });

test('a usage limit rate-limits exactly the task’s token until the reset; availability follows', async () => {
  const first = await poolToken('claude_code');
  const second = await poolToken('claude_code');
  const resetsAt = new Date(Date.now() + 3 * 60 * 60 * 1000);

  const marked = await http('POST', `/api/claude-code-session/${await task(first)}/usage-limit`, {
    resets_at: Math.floor(resetsAt.getTime() / 1000),
  });
  assert.equal(marked.status, 200, JSON.stringify(marked.data));
  assert.equal(marked.data.marked, `claude_pool:${first}`);
  assert.deepEqual(marked.data.accounts, [], 'this user has no connected accounts of its own');
  assert.deepEqual(
    marked.data.next_lease,
    { provider: 'claude', label: null, available_now: true, available_at: null, kind: 'pool' },
    'the respawn leases a shared Claude credential that is not limited'
  );
  const firstRow = await prisma.integration.findUniqueOrThrow({ where: { id: first } });
  assert.equal(
    Math.floor((firstRow.rateLimitedUntil?.getTime() ?? 0) / 1000),
    Math.floor(resetsAt.getTime() / 1000),
    'rateLimitedUntil = the provider reset'
  );
  const secondRow = await prisma.integration.findUniqueOrThrow({ where: { id: second } });
  assert.equal(secondRow.rateLimitedUntil, null, 'the next token stays leasable');
  assert.equal(
    (await codeCredentialAvailability(userId)).claude,
    true,
    'a retry leases the next token'
  );

  await markCodeTaskUsageLimited(
    await task(second),
    'claude',
    parseResetsAt(resetsAt.toISOString())
  );
  const exhausted = await codeCredentialAvailability(userId);
  assert.equal(
    exhausted.claude,
    (await otherLeasable('claude_code')) > 0,
    JSON.stringify(exhausted)
  );

  const codexToken = await poolToken('gpt_code');
  const viaHttp = await http(
    'GET',
    `/api/claude-code-session/credential-availability?user_id=${userId}`
  );
  assert.equal(viaHttp.status, 200, JSON.stringify(viaHttp.data));
  assert.equal(viaHttp.data.codex, true, 'the other provider is available for the fall-over');
  const codexTask = await task(codexToken);
  const codexMarked = await http('POST', `/api/codex-code-session/${codexTask}/usage-limit`, {});
  assert.equal(codexMarked.data.marked, `gpt_integration:${codexToken}`);
  const codexRow = await prisma.integration.findUniqueOrThrow({ where: { id: codexToken } });
  assert.ok(
    (codexRow.rateLimitedUntil?.getTime() ?? 0) > Date.now(),
    'default cooldown without a reset'
  );
});

test('a retry on the other provider continues the same session from its checkpoint with a handoff', async () => {
  const home = join(fixtureDir, 'home-claude');
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'rose/parser-1', workspace]);
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'T']);
  writeFileSync(join(workspace, 'parser.ts'), 'export const parse = 1;\n');
  execFileSync('git', ['-C', workspace, 'add', '-A']);
  execFileSync('git', ['-C', workspace, 'commit', '-q', '-m', 'parser before the limit']);
  writeFileSync(join(workspace, 'wip.txt'), 'uncommitted\n');
  const logDir = join(home, '.claude', 'projects', '-ws');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, `${randomUUID()}.jsonl`),
    [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] },
      },
      {
        type: 'user',
        toolUseResult: { stdout: 'ok', stderr: '' },
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n'
  );
  const session = await prisma.codeSession.create({
    data: {
      userId,
      rootAgentId: agentId,
      ownerAgentId: agentId,
      repoKey: 'rose-project:usage',
      repoUrl: 'rose-project:usage',
      branch: 'rose/parser-1',
      codeProvider: 'claude',
      sandboxKind: 'local',
      sandboxId: 'local-x',
    },
  });
  const ckpt = await checkpointCodeSession({
    session,
    fs: localSandboxFs(home),
    reason: 'usage_limit',
    agentId,
  });
  assert.ok(ckpt?.cliSessionId, 'the Claude conversation id is checkpointed');
  await markPaused(session.id);

  let handed: { handoff: string | null; provider: string | undefined } | null = null;
  const { fields } = await createWithCodeSession(
    {
      agentId,
      userId,
      repoUrl: 'rose-project:usage',
      codeProvider: 'codex',
      codeSessionId: session.id,
      leaseOwner: 'tool:retry:1',
    },
    async (codeSession, handoff) => {
      handed = { handoff, provider: codeSession?.codeProvider };
      return { resumedFrom: 'checkpoint', cliSessionId: null };
    }
  );
  assert.equal(fields.code_session_id, session.id, 'the retry resumes the same session');
  assert.equal(fields.code_provider, 'codex');
  assert.equal(fields.provider_handoff, true);
  assert.equal(handed?.provider, 'codex');
  assert.match(String(handed?.handoff), /Claude Code worked on this task before you/);
  assert.match(String(handed?.handoff), /on branch `rose\/parser-1`/);
  assert.ok(String(handed?.handoff).includes(command), 'the handoff lists the earlier commands');

  const switched = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.equal(switched.codeProvider, 'codex');
  assert.equal(switched.cliSessionId, null, 'no Claude conversation id reaches Codex');
  assert.equal(switched.sandboxId, null, 'the other provider gets a new sandbox');

  const codexHome = join(fixtureDir, 'home-codex');
  mkdirSync(codexHome, { recursive: true });
  const restored = await restoreLatestCheckpoint(switched, localSandboxFs(codexHome));
  assert.equal(restored?.cliSessionId, null, 'a foreign CLI conversation is not resumed');
  const restoredWs = join(codexHome, 'workspace');
  assert.equal(readFileSync(join(restoredWs, 'wip.txt'), 'utf8'), 'uncommitted\n');
  assert.ok(existsSync(join(restoredWs, 'parser.ts')));
  const head = execFileSync('git', ['-C', restoredWs, 'log', '-1', '--format=%s'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(head, 'parser before the limit', 'the same commit continues');
  const branch = execFileSync('git', ['-C', restoredWs, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(branch, 'rose/parser-1', 'on the same branch');
});

/** The credential envelope format integrations store (RSA-OAEP key + AES-256-GCM). */
function sealEnvelope(plaintext: string, publicKeyPem: string): string {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const encryptedKey = publicEncrypt(
    { key: publicKeyPem, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  return Buffer.from(
    JSON.stringify({
      version: 1,
      encrypted_aes_key: encryptedKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    })
  ).toString('base64');
}

test('a Mac session’s usage limit marks only the user’s own login; own_only availability', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  ).toString('base64');
  await poolToken('claude_code');
  const ownCodex = await prisma.integration.create({
    data: {
      userId,
      type: 'TOOL_SETUP',
      name: 'gpt_code',
      status: 'CONNECTED',
      isActive: true,
      config: {
        encryptedCredentials: sealEnvelope(
          JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { access_token: 'own-access', refresh_token: 'own-refresh', account_id: 'a1' },
          }),
          publicKey.export({ type: 'spki', format: 'pem' }).toString()
        ),
      },
    },
  });
  createdIntegrations.push(ownCodex.id);

  assert.deepEqual(
    await codeCredentialAvailability(userId, new Date(), { ownOnly: true }),
    { claude: false, codex: true },
    'a Mac run counts only the user’s own logins'
  );
  assert.equal((await codeCredentialAvailability(userId)).claude, true, 'a cloud run may pool');
  const viaHttp = await http(
    'GET',
    `/api/claude-code-session/credential-availability?user_id=${userId}&own_only=true`
  );
  assert.equal(viaHttp.status, 200, JSON.stringify(viaHttp.data));
  assert.equal(viaHttp.data.claude, false);

  const local = await buildLocalSessionEnvs({
    provider: 'codex',
    userId,
    goal: 'g',
    deviceName: 'Blackbox Mac',
  });
  assert.equal(local.claudeTokenSource, 'user');
  assert.equal(local.integrationId, ownCodex.id, 'the Mac task records the own login it runs on');

  const macTask = await prisma.claudeCodeSession.create({
    data: {
      agentId,
      sandboxId: localDeviceSandboxId(randomUUID(), randomUUID()),
      goal: 'g',
      claudeTokenSource: local.claudeTokenSource,
      claudeTokenIntegrationId: local.integrationId,
      codeProvider: 'codex',
    },
  });
  const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const marked = await http('POST', `/api/codex-code-session/${macTask.id}/usage-limit`, {
    resets_at: resetsAt.toISOString(),
  });
  assert.equal(marked.status, 200, JSON.stringify(marked.data));
  assert.equal(marked.data.marked, `gpt_integration:${ownCodex.id}`);
  const ownRow = await prisma.integration.findUniqueOrThrow({ where: { id: ownCodex.id } });
  assert.equal(ownRow.rateLimitedUntil?.getTime(), resetsAt.getTime());
  assert.equal(
    (await codeCredentialAvailability(userId, new Date(), { ownOnly: true })).codex,
    false,
    'the exhausted own login is no longer offered to the Mac'
  );

  const unrecorded = await prisma.claudeCodeSession.create({
    data: { agentId, sandboxId: localDeviceSandboxId(randomUUID(), randomUUID()), goal: 'g' },
  });
  for (const provider of ['claude', 'codex'] as const) {
    assert.deepEqual(
      await markCodeTaskUsageLimited(unrecorded.id, provider, null),
      { marked: null },
      `a Mac ${provider} limit never puts a pool token or a funded key on cooldown`
    );
  }

  let e2bCalls = 0;
  const kept = await keepAliveCodeTask(
    macTask.id,
    async () => {
      e2bCalls += 1;
    },
    NO_CODE_RESOURCES
  );
  assert.equal(kept.alive, true);
  assert.equal(e2bCalls, 0, 'a Mac session has no E2B idle window to extend');
});

test(
  'a limit on one own account marks only it; the answer lists every account and the next lease',
  quarantine(
    {
      since: '2026-11-16',
      repair: 'pending-handoff:909d3b3614724842a6a17f54e04a0ef7',
      error:
        'not ok 8 - a limit on one own account marks only it; the answer lists every account and the next lease',
      evidence: '.context/browser-chip-repair/usage-limit-rca/REPORT.md',
    },
    async () => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
        privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      ).toString('base64');
      const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const owner = `code-usage-owner-${randomUUID()}`;
      const ownerAgent = randomUUID();
      await prisma.user.create({ data: { userId: owner, name: 'Two Claude Accounts' } });
      await prisma.agent.create({ data: { id: ownerAgent, userId: owner, goal: 'Ship it' } });
      const own = async (name: 'claude_code' | 'gpt_code', email: string, secret: object) => {
        const row = await prisma.integration.create({
          data: {
            userId: owner,
            type: 'TOOL_SETUP',
            name,
            accountId: email,
            accountEmail: email,
            status: 'CONNECTED',
            isActive: true,
            config: { encryptedCredentials: sealEnvelope(JSON.stringify(secret), pem) },
          },
        });
        createdIntegrations.push(row.id);
        return row;
      };
      const oauth = (token: string) => ({
        claudeAiOauth: {
          accessToken: `sk-ant-oat01-${token}`,
          refreshToken: `refresh-${token}`,
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
      });
      const personal = await own('claude_code', 'me@example.com', oauth('personal'));
      const work = await own('claude_code', 'work@example.com', oauth('work'));
      const codex = await own('gpt_code', 'codex@example.com', {
        auth_mode: 'chatgpt',
        tokens: { access_token: 'codex-access', refresh_token: 'codex-refresh', account_id: 'c1' },
      });
      try {
        const leased = await fetchClaudeCodeCredentialsWithMeta(owner);
        assert.equal(leased?.source, 'user');
        const used = claudeTaskIntegrationId(leased);
        assert.ok(used === personal.id || used === work.id, 'the task records its own account');
        const spare = used === personal.id ? work : personal;
        const usedEmail = used === personal.id ? personal.accountEmail : work.accountEmail;
        const limitedTask = await prisma.claudeCodeSession.create({
          data: {
            agentId: ownerAgent,
            sandboxId: `sb-${randomUUID()}`,
            goal: 'g',
            claudeTokenSource: 'user',
            claudeTokenIntegrationId: used,
          },
        });
        const resetsAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
        const report = await http(
          'POST',
          `/api/claude-code-session/${limitedTask.id}/usage-limit`,
          {
            resets_at: resetsAt.toISOString(),
          }
        );
        assert.equal(report.status, 200, JSON.stringify(report.data));
        assert.deepEqual(report.data.accounts, [
          {
            provider: 'claude',
            label: 'me@example.com',
            ...(used === personal.id
              ? { status: 'limited', limited_until: resetsAt.toISOString(), this_run: true }
              : { status: 'available', limited_until: null, this_run: false }),
          },
          {
            provider: 'claude',
            label: 'work@example.com',
            ...(used === work.id
              ? { status: 'limited', limited_until: resetsAt.toISOString(), this_run: true }
              : { status: 'available', limited_until: null, this_run: false }),
          },
          {
            provider: 'codex',
            label: 'codex@example.com',
            status: 'available',
            limited_until: null,
            this_run: false,
          },
        ]);
        assert.deepEqual(
          report.data.next_lease,
          {
            provider: 'claude',
            label: spare.accountEmail,
            available_now: true,
            available_at: null,
            kind: 'own',
          },
          `the respawn stays on Claude with the account that is not limited (${usedEmail} is)`
        );
        const spareRow = await prisma.integration.findUniqueOrThrow({ where: { id: spare.id } });
        assert.equal(spareRow.rateLimitedUntil, null, 'only the account the run used is limited');
        const respawn = await fetchClaudeCodeCredentialsWithMeta(owner);
        assert.equal(
          claudeTaskIntegrationId(respawn),
          spare.id,
          'the respawn leases the spare account'
        );

        // Every own login limited: the outlook names the earliest reset (own logins only).
        const later = new Date(Date.now() + 6 * 60 * 60 * 1000);
        const soonest = new Date(Date.now() + 2 * 60 * 60 * 1000);
        await prisma.integration.update({
          where: { id: spare.id },
          data: { rateLimitedUntil: later },
        });
        await prisma.integration.update({
          where: { id: codex.id },
          data: { rateLimitedUntil: soonest },
        });
        const blocked = await codeUsageOutlook(owner, { prefer: 'claude', ownOnly: true });
        assert.deepEqual(blocked.next_lease, {
          provider: 'codex',
          label: 'codex@example.com',
          available_now: false,
          available_at: soonest.toISOString(),
          kind: 'own',
        });
      } finally {
        await prisma.claudeCodeSession.deleteMany({ where: { agentId: ownerAgent } });
        await prisma.agent.deleteMany({ where: { id: ownerAgent } });
        await prisma.user.deleteMany({ where: { userId: owner } });
      }
    }
  )
);

registerCodeSessionRotationCases({
  userId,
  agentId,
  fixtureDir,
  command,
  createdIntegrations,
  originalSandbox: original,
  sealEnvelope,
  http,
  otherLeasable,
});
registerCodexAzureFallbackCases({ agentId, sealEnvelope, otherLeasable });

async function http(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}
