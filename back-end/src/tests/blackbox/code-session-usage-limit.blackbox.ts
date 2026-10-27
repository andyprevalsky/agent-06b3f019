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
 * Hermetic: local checkpoint storage, real DB rows, no E2B or provider calls.
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
import {
  checkpointCodeSession,
  restoreLatestCheckpoint,
} from '../../providers/codeSessions/lifecycle';
import { localSandboxFs } from '../../providers/codeSessions/sandboxFs';
import { createWithCodeSession, keepAliveCodeTask } from '../../providers/codeSessions/spawn';
import { markPaused } from '../../providers/codeSessions/store';
import {
  codeCredentialAvailability,
  codeUsageOutlook,
  markCodeTaskUsageLimited,
  parseResetsAt,
} from '../../providers/codeSessions/usageLimit';
import { fetchClaudeCodeCredentialsWithMeta } from '../../providers/claudeCredentials';
import { claudeTaskIntegrationId } from '../../providers/claudeCodeSandboxAuth';
import {
  isAnthropicApiKeyOnCooldown,
  markAnthropicApiKeyOnCooldown,
} from '../../providers/computeCredentials';
import { withIsolatedFundedKeyCooldowns } from './funded-key-cooldown.support';
import { localDeviceSandboxId } from '../../providers/localDevices/hub';
import { buildLocalSessionEnvs } from '../../providers/localDevices/session';

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
  claudeCodeAnthropic: process.env.CLAUDE_CODE_ANTHROPIC_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  gpt: process.env.GPT_API_KEY,
  decryptionKey: process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY,
};
const createdIntegrations: string[] = [];

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
  process.env.CODE_SESSION_STORAGE_BACKEND = 'local';
  process.env.CODE_SESSION_STORAGE_LOCAL_DIR = join(fixtureDir, 'storage');
  // Shared funded keys (and the Claude Code gateway keys a sandbox runs on)
  // would make every availability answer true.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GPT_API_KEY;
  await prisma.user.create({ data: { userId, name: 'Usage Limit' } });
  await prisma.agent.create({ data: { id: agentId, userId, goal: 'Ship the parser' } });
});

after(async () => {
  for (const [key, value] of [
    ['CODE_SESSION_STORAGE_BACKEND', saved.backend],
    ['CODE_SESSION_STORAGE_LOCAL_DIR', saved.dir],
    ['ANTHROPIC_API_KEY', saved.anthropic],
    ['CLAUDE_CODE_ANTHROPIC_API_KEY', saved.claudeCodeAnthropic],
    ['OPENROUTER_API_KEY', saved.openrouter],
    ['GPT_API_KEY', saved.gpt],
    ['CLAUDE_CREDENTIAL_DECRYPTION_KEY', saved.decryptionKey],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await prisma.claudeCodeSession.deleteMany({ where: { agentId } });
  await prisma.codeSession.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { id: { in: createdIntegrations } } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
  rmSync(fixtureDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

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
    { provider: 'claude', label: null, available_now: true, available_at: null },
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

test('a funded Claude Code gateway keeps Claude available while the shared Anthropic key is cooled', async () => {
  // createE2BSession runs Claude Code on the OpenRouter gateway (or a dedicated
  // CLAUDE_CODE_ANTHROPIC_API_KEY) when the shared key is on its out-of-credits
  // cooldown. Availability must answer from that same transport; otherwise a
  // spawn with no Claude login silently switches to Codex even though Claude
  // Code can run (Pre-Deploy claude-code-agent, 2026-10-27).
  const noLogin = `code-usage-no-login-${randomUUID()}`;
  const pooled = (await otherLeasable('claude_code')) > 0;
  const envNames = [
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'CLAUDE_CODE_ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ] as const;
  const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  try {
    await withIsolatedFundedKeyCooldowns(async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-blackbox-shared';
      delete process.env.CLAUDE_CODE_ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      await markAnthropicApiKeyOnCooldown('blackbox_out_of_credits');
      assert.equal(await isAnthropicApiKeyOnCooldown(), true, 'the shared key is cooled');

      process.env.OPENROUTER_API_KEY = 'sk-or-blackbox-gateway';
      assert.equal(
        (await codeCredentialAvailability(noLogin)).claude,
        true,
        'the OpenRouter gateway still runs Claude Code'
      );
      assert.equal(
        (await codeCredentialAvailability(noLogin, new Date(), { ownOnly: true })).claude,
        false,
        'a Mac run never takes a funded key'
      );

      delete process.env.OPENROUTER_API_KEY;
      process.env.CLAUDE_CODE_ANTHROPIC_API_KEY = 'sk-ant-blackbox-dedicated';
      assert.equal(
        (await codeCredentialAvailability(noLogin)).claude,
        true,
        'a dedicated Claude Code key is not gated by the shared-org cooldown'
      );

      delete process.env.CLAUDE_CODE_ANTHROPIC_API_KEY;
      assert.equal(
        (await codeCredentialAvailability(noLogin)).claude,
        pooled,
        'the cooled shared key alone cannot run Claude Code'
      );
    });
  } finally {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
  const kept = await keepAliveCodeTask(macTask.id, async () => {
    e2bCalls += 1;
  });
  assert.equal(kept.alive, true);
  assert.equal(e2bCalls, 0, 'a Mac session has no E2B idle window to extend');
});

test('a limit on one own account marks only it; the answer lists every account and the next lease', async () => {
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
    const report = await http('POST', `/api/claude-code-session/${limitedTask.id}/usage-limit`, {
      resets_at: resetsAt.toISOString(),
    });
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
    await prisma.integration.update({ where: { id: spare.id }, data: { rateLimitedUntil: later } });
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
    });
  } finally {
    await prisma.claudeCodeSession.deleteMany({ where: { agentId: ownerAgent } });
    await prisma.agent.deleteMany({ where: { id: ownerAgent } });
    await prisma.user.deleteMany({ where: { userId: owner } });
  }
});

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
