/**
 * A code-agent sandbox's rejected login, fed back to the real output services
 * and database (no sandbox or provider requests).
 *
 *   ws-server (fingerprint of the token it held) ─► agents credential_feedback
 *        └─► persistOutput ─► stored credential now:
 *              same token, still live  → revoked: disable + needs reconnect
 *              same token, expired     → expiry: untouched (the device re-syncs)
 *              a different token       → replaced since the lease: untouched
 *
 * Terminal text never classifies a credential: an agent may print any banner.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  __resetAnthropicApiKeyCooldown,
  isAnthropicApiKeyOnCooldown,
} from '../../providers/computeCredentials';
import { persistOutput as persistClaudeOutput } from '../../domains/claude-code/service';
import { persistOutput as persistCodexOutput } from '../../domains/codex-code/service';
import { markCodeTaskUsageLimited } from '../../providers/codeSessions/usageLimit';
import { classifyLoginRejection } from '../../providers/codeLoginRejection';
import { withIsolatedFundedKeyCooldowns } from './funded-key-cooldown.support';
import { encryptClaudeEnvelope } from './integrations.context';

const HOUR = 60 * 60 * 1000;

/** Every banner the old transcript regexes matched, as an agent's own output. */
const BANNER_TEXT = [
  '[Claude tool] Bash · grep -rn "API Error: 401\\|Please run /login" agents/',
  'Not logged in · Please run /login',
  'OAuth token revoked · Please run /login',
  'Invalid authentication credentials',
  "You've hit your limit · resets 9:30pm (UTC)",
  'Credit balance is too low · Add funds: https://platform.claude.com/settings/billing',
].join('\n');

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function codexJwt(expMs: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ exp: Math.floor(expMs / 1000), n: randomUUID() })}.sig`;
}

type Provider = 'claude' | 'codex';

async function seed(
  userId: string,
  provider: Provider,
  opts: { source: 'user' | 'pool' | 'anthropic'; accessToken?: string; expiresAt?: number }
) {
  const accountId = randomUUID();
  const credentials =
    opts.accessToken === undefined
      ? undefined
      : provider === 'claude'
        ? JSON.stringify({
            claudeAiOauth: { accessToken: opts.accessToken, expiresAt: opts.expiresAt },
          })
        : JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { access_token: opts.accessToken, account_id: accountId },
          });
  const integration =
    opts.source === 'anthropic'
      ? null
      : await prisma.integration.create({
          data: {
            userId,
            accountId,
            name: provider === 'claude' ? 'claude_code' : 'gpt_code',
            type: 'TOOL_SETUP',
            status: 'CONNECTED',
            isActive: true,
            poolingEnabled: opts.source === 'pool',
            ...(credentials
              ? { config: { encryptedCredentials: encryptClaudeEnvelope(credentials) } }
              : {}),
          },
        });
  if (integration) {
    await prisma.computeAccountConnection.create({
      data: { userId, provider, accountId, state: 'connected' },
    });
  }
  const agent = await prisma.agent.create({
    data: { id: randomUUID(), userId, goal: 'login rejection feedback', status: 'STARTING_UP' },
  });
  const taskId = randomUUID();
  await prisma.claudeCodeSession.create({
    data: {
      id: taskId,
      agentId: agent.id,
      sandboxId: `offline-login-rejection-${taskId}`,
      goal: 'login rejection feedback',
      claudeTokenSource: opts.source === 'anthropic' ? '' : opts.source,
      claudeTokenIntegrationId: integration?.id ?? null,
    },
  });
  return { taskId, integration, accountId };
}

type Case = {
  name: string;
  provider: Provider;
  source: 'user' | 'pool' | 'anthropic';
  stored?: { token: string; expiresAt: number };
  output: string;
  feedback?: Array<{ source: 'initial'; reason: string; credential?: string }>;
  expect: 'untouched' | 'revoked' | 'shared_cooldown';
};

function cases(): Case[] {
  const now = Date.now();
  const claudeLive = `sk-ant-oat01-live-${randomUUID()}`;
  const claudeExpired = `sk-ant-oat01-expired-${randomUUID()}`;
  const claudeReplaced = `sk-ant-oat01-resynced-${randomUUID()}`;
  const codexLive = codexJwt(now + HOUR);
  const codexExpired = codexJwt(now - HOUR);
  const codexReplaced = codexJwt(now + HOUR);
  const claudeFailure = (token: string) => [
    { source: 'initial' as const, reason: 'authentication_failed', credential: fingerprint(token) },
  ];
  const codexFailure = (token: string) => [
    { source: 'initial' as const, reason: 'oauth_refresh_invalid', credential: fingerprint(token) },
  ];
  const expiryBanner =
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}';
  return [
    // Terminal text alone (an agent grepping the Rose repo) never marks anything.
    ...(['user', 'pool'] as const).map((source) => ({
      name: `claude ${source}: banner text without a structured signal`,
      provider: 'claude' as const,
      source,
      stored: { token: claudeLive, expiresAt: now + HOUR },
      output: BANNER_TEXT,
      feedback: [],
      expect: 'untouched' as const,
    })),
    {
      name: 'claude funded key: banner text without a structured signal',
      provider: 'claude',
      source: 'anthropic',
      output: BANNER_TEXT,
      feedback: [],
      expect: 'untouched',
    },
    // The sandbox's own access token expired mid-run: not a revocation.
    {
      name: 'claude user: the held token expired',
      provider: 'claude',
      source: 'user',
      stored: { token: claudeExpired, expiresAt: now - HOUR },
      output: expiryBanner,
      feedback: claudeFailure(claudeExpired),
      expect: 'untouched',
    },
    // The device re-synced a fresh token after this sandbox leased the old one.
    {
      name: 'claude user: the stored token was replaced after the lease',
      provider: 'claude',
      source: 'user',
      stored: { token: claudeReplaced, expiresAt: now + HOUR },
      output: 'OAuth token revoked · Please run /login',
      feedback: claudeFailure(claudeLive),
      expect: 'untouched',
    },
    ...(['user', 'pool'] as const).map((source) => ({
      name: `claude ${source}: the live held token was rejected`,
      provider: 'claude' as const,
      source,
      stored: { token: claudeLive, expiresAt: now + HOUR },
      output: 'Terminal display no longer shows the failure.',
      feedback: claudeFailure(claudeLive),
      expect: 'revoked' as const,
    })),
    {
      name: 'claude funded key: rejected',
      provider: 'claude',
      source: 'anthropic',
      output: expiryBanner,
      feedback: [{ source: 'initial', reason: 'authentication_failed' }],
      expect: 'shared_cooldown',
    },
    // Codex: the sandbox holds no refresh token, so expiry surfaces as a failed refresh.
    {
      name: 'codex user: the held token expired (refresh impossible in the sandbox)',
      provider: 'codex',
      source: 'user',
      stored: { token: codexExpired, expiresAt: now - HOUR },
      output: '[Codex] Error: Your access token could not be refreshed',
      feedback: codexFailure(codexExpired),
      expect: 'untouched',
    },
    {
      name: 'codex user: the stored login was replaced after the lease',
      provider: 'codex',
      source: 'user',
      stored: { token: codexReplaced, expiresAt: now + HOUR },
      output: '[Codex] Error: Your access token could not be refreshed',
      feedback: codexFailure(codexLive),
      expect: 'untouched',
    },
    {
      name: 'codex user: the live held login was revoked',
      provider: 'codex',
      source: 'user',
      stored: { token: codexLive, expiresAt: now + HOUR },
      output: '[Codex] Error: Your access token could not be refreshed',
      feedback: codexFailure(codexLive),
      expect: 'revoked',
    },
  ];
}

async function main() {
  const userId = randomUUID();
  const failures: string[] = [];
  try {
    for (const testCase of cases()) {
      try {
        await prisma.integration.deleteMany({ where: { userId } });
        await prisma.computeAccountConnection.deleteMany({ where: { userId } });
        const { taskId, integration, accountId } = await seed(userId, testCase.provider, {
          source: testCase.source,
          accessToken: testCase.stored?.token,
          expiresAt: testCase.stored?.expiresAt,
        });
        await __resetAnthropicApiKeyCooldown();
        if (testCase.provider === 'claude') {
          await persistClaudeOutput(taskId, testCase.output, testCase.feedback);
        } else {
          await persistCodexOutput(taskId, testCase.output, testCase.feedback);
        }
        const cooledAfter = await isAnthropicApiKeyOnCooldown();
        if (testCase.expect === 'shared_cooldown') {
          assert.equal(cooledAfter, true, 'a rejected funded key backs off for every spawn');
        } else {
          assert.equal(cooledAfter, false, 'the funded key is not touched');
        }
        if (integration) {
          const row = await prisma.integration.findUniqueOrThrow({
            where: { id: integration.id },
          });
          const connection = await prisma.computeAccountConnection.findUniqueOrThrow({
            where: {
              userId_provider_accountId: { userId, provider: testCase.provider, accountId },
            },
          });
          if (testCase.expect === 'revoked') {
            const disabled =
              testCase.source === 'pool'
                ? row.poolingEnabled === false
                : row.status === 'EXPIRED' && row.isActive === false;
            assert.ok(disabled, `revoked login must be disabled: ${JSON.stringify(row)}`);
            assert.equal(row.rateLimitedUntil, null, 'a revocation is not a cooldown');
            assert.equal(connection.state, 'needs_reconnect');
          } else {
            assert.equal(row.status, 'CONNECTED');
            assert.equal(row.isActive, true);
            assert.equal(row.poolingEnabled, testCase.source === 'pool');
            assert.equal(row.rateLimitedUntil, null, 'no cooldown');
            assert.equal(row.failureReason, null);
            assert.equal(connection.state, 'connected');
          }
        }
        console.log(`PASS ${testCase.name}`);
      } catch (error) {
        const failure = `${testCase.name}: ${String(error)}`;
        failures.push(failure);
        console.error(`FAIL ${failure}`);
      } finally {
        await prisma.claudeCodeSession.deleteMany({
          where: { sandboxId: { startsWith: 'offline-login-rejection-' } },
        });
      }
    }
    try {
      // Out of credits / usage limit on the funded key arrive as the structured
      // C15 report (agents usage_limit_from_event), not transcript text.
      await __resetAnthropicApiKeyCooldown();
      const { taskId } = await seed(userId, 'claude', { source: 'anthropic' });
      const marked = await markCodeTaskUsageLimited(taskId, 'claude', null);
      assert.equal(marked.marked, 'anthropic_api_key');
      assert.equal(await isAnthropicApiKeyOnCooldown(), true, 'billing backs off the funded key');
      // A server that cannot read credentials never disables a login on a 401.
      assert.equal(classifyLoginRejection(undefined, 'abc'), 'unverified');
      // Within the clock-skew margin of its expiry a rejection is an expiry.
      const token = 'sk-ant-oat01-skew';
      const now = Date.now();
      assert.equal(
        classifyLoginRejection(
          { accessToken: token, expiresAt: now + 30_000 },
          fingerprint(token),
          now
        ),
        'expired'
      );
      console.log(
        'PASS claude funded key: structured billing report backs off; unverified/skew rules'
      );
    } catch (error) {
      failures.push(`structured billing / classification rules: ${String(error)}`);
      console.error(`FAIL ${String(error)}`);
    }
    assert.deepEqual(failures, [], 'all login rejection cases must pass');
  } finally {
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.computeAccountConnection.deleteMany({ where: { userId } });
  }
}

withIsolatedFundedKeyCooldowns(main)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
