/**
 * C15 credential order (Andy, 2026-10-28: "codex -> claude token before going
 * to api key or azure"): every subscription before any funded key. Registered
 * by code-session-usage-limit.blackbox.ts (its fixtures, DB rows and env).
 *
 *   P = the session's provider, Q = the other one:
 *   P subscription ──────────────► P (native resume)
 *   P subs limited, Q sub ───────► Q subscription (switch + handoff), not P's funded key
 *   all subs limited ────────────► P funded key (Azure for Codex)
 *   P funded unavailable ────────► Q funded key (the Anthropic API key)
 *   nothing ─────────────────────► next_credential null: the retry stays paused
 *   P login unusable (no Azure switch armed) ─► that login needs reconnect (not a
 *                                  rate limit); the retry takes Q's subscription
 *
 * The same order feeds the plan's next_credential (the agents activity
 * follows it), the outlook's next_lease (the retry clause) and code inspect.
 * Hermetic: real DB rows sealed with this case's own key, a test-only Azure
 * host and a placeholder Anthropic key; nothing reaches a provider.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import { fetchClaudeCodeCredentialsWithMeta } from '../../providers/claudeCredentials';
import { isAnthropicApiKeyOnCooldown } from '../../providers/computeCredentials';
import {
  codeProviderOrder,
  pickCodeCredential,
  type CodeCredentialTiers,
} from '../../providers/codeSessions/credentialOrder';
import { persistOutput } from '../../domains/codex-code/service';
import { createWithCodeSession } from '../../providers/codeSessions/spawn';
import { markPaused } from '../../providers/codeSessions/store';
import {
  __resetCodexFundedCooldown,
  codeCredentialTiers,
  codeSpawnCredentialPlan,
  markCodexFundedCooldown,
  pickNextLease,
  resolveCodexSpawnAuth,
} from '../../providers/codeSessions/usageLimit';

export interface CredentialOrderContext {
  sealEnvelope: (plaintext: string, publicKeyPem: string) => string;
  http: (
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; data: Record<string, unknown> }>;
}

const tiers = (
  claudeSub: boolean,
  claudeFunded: boolean,
  codexSub: boolean,
  codexFunded: boolean
): CodeCredentialTiers => ({
  claude: { subscription: claudeSub, funded: claudeFunded },
  codex: { subscription: codexSub, funded: codexFunded },
});

const AZURE = 'funded Azure OpenAI deployment';
const ANTHROPIC = 'funded Anthropic API key';
const fundedPaths = [
  { provider: 'claude', kind: 'funded', label: ANTHROPIC, status: 'available' },
  { provider: 'codex', kind: 'funded', label: AZURE, status: 'available' },
].map((path) => ({ ...path, limited_until: null }) as const);

/** Leasable pooled subscriptions of `name` anywhere in the shared test DB. */
function pooledLeasable(name: 'claude_code' | 'gpt_code'): Promise<number> {
  return prisma.integration.count({
    where: {
      name,
      status: 'CONNECTED',
      poolingEnabled: true,
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: new Date() } }],
    },
  });
}

export function registerCodeSessionCredentialOrderCases(ctx: CredentialOrderContext): void {
  const { sealEnvelope, http } = ctx;

  test('C15 order: P subscription → Q subscription → P funded key → Q funded key → nothing', () => {
    const order = (t: CodeCredentialTiers, prefer: 'claude' | 'codex') =>
      pickCodeCredential(t, prefer);
    // P = Codex (Andy's case): a Claude subscription comes before Azure and the API key.
    assert.deepEqual(order(tiers(true, true, true, true), 'codex'), {
      provider: 'codex',
      tier: 'subscription',
    });
    assert.deepEqual(
      order(tiers(true, true, false, true), 'codex'),
      { provider: 'claude', tier: 'subscription' },
      'a Claude subscription beats the funded Azure deployment'
    );
    assert.deepEqual(order(tiers(false, true, false, true), 'codex'), {
      provider: 'codex',
      tier: 'funded',
    });
    assert.deepEqual(order(tiers(false, true, false, false), 'codex'), {
      provider: 'claude',
      tier: 'funded',
    });
    assert.equal(order(tiers(false, false, false, false), 'codex'), null);
    // P = Claude: a Codex subscription comes before the Anthropic API key.
    assert.deepEqual(
      order(tiers(false, true, true, true), 'claude'),
      { provider: 'codex', tier: 'subscription' },
      'a Codex subscription beats the funded Anthropic key'
    );
    assert.deepEqual(order(tiers(false, true, false, true), 'claude'), {
      provider: 'claude',
      tier: 'funded',
    });
    assert.deepEqual(order(tiers(false, false, false, true), 'claude'), {
      provider: 'codex',
      tier: 'funded',
    });
    // Inspect tries providers in the order of their first leasable credential.
    assert.deepEqual(codeProviderOrder(tiers(false, true, true, false), 'claude'), [
      'codex',
      'claude',
    ]);
    assert.deepEqual(codeProviderOrder(tiers(false, false, false, true), 'claude'), ['codex']);
    // The outlook's next lease names what the retry takes (the retry clause reads it).
    assert.deepEqual(pickNextLease(tiers(true, true, false, true), [], [...fundedPaths], 'codex'), {
      provider: 'claude',
      label: null,
      available_now: true,
      available_at: null,
      kind: 'pool',
    });
    assert.deepEqual(
      pickNextLease(tiers(false, true, false, true), [], [...fundedPaths], 'codex'),
      { provider: 'codex', label: AZURE, available_now: true, available_at: null, kind: 'funded' }
    );
    assert.deepEqual(
      pickNextLease(tiers(false, true, false, false), [], [...fundedPaths], 'codex'),
      {
        provider: 'claude',
        label: ANTHROPIC,
        available_now: true,
        available_at: null,
        kind: 'funded',
      }
    );
  });

  test('a Codex session retries on a Claude subscription before Azure; the plan, lease and served credential agree', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const savedKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
    process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    ).toString('base64');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const owner = `code-order-${randomUUID()}`;
    const agentId = randomUUID();
    await prisma.user.create({ data: { userId: owner, name: 'Subscription First' } });
    await prisma.agent.create({ data: { id: agentId, userId: owner, goal: 'Ship it' } });
    const own = (name: 'claude_code' | 'gpt_code', email: string, secret: object) =>
      prisma.integration.create({
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
    const codex = await own('gpt_code', 'codex@example.com', {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'codex-access', refresh_token: 'codex-refresh', account_id: 'c1' },
    });
    const claude = await own('claude_code', 'me@example.com', {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-order',
        refreshToken: 'refresh-order',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    const session = (repo: string) =>
      prisma.codeSession.create({
        data: {
          userId: owner,
          rootAgentId: agentId,
          ownerAgentId: agentId,
          repoKey: `rose-project:${repo}`,
          repoUrl: `rose-project:${repo}`,
          codeProvider: 'codex',
        },
      });
    const codexSession = await session('order');
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const limit = (id: string) =>
      prisma.integration.update({ where: { id }, data: { rateLimitedUntil: later } });
    // In process: the funded paths follow this case's env (the test backend has its own).
    const plan = async (fresh = false) =>
      codeSpawnCredentialPlan(
        owner,
        fresh ? { prefer: 'codex' } : { codeSessionId: codexSession.id, prefer: 'claude' }
      );
    /** The same answer over the route the agents activity calls (subscription steps only). */
    const viaRoute = async () => {
      const answer = await http(
        'GET',
        `/api/claude-code-session/credential-availability?user_id=${owner}` +
          `&code_session_id=${codexSession.id}&prefer=claude`
      );
      assert.equal(answer.status, 200, JSON.stringify(answer.data));
      return answer.data.next_credential;
    };
    const lease = (provider: string, label: string | null, kind: string) => ({
      provider,
      label,
      available_now: true,
      available_at: null,
      kind,
    });
    await __resetCodexFundedCooldown();
    process.env.AZURE_FOUNDRY_ENDPOINT = 'https://codex-funded.blackbox.invalid';
    process.env.AZURE_FOUNDRY_API_KEY = 'azure-key-not-a-secret-here';
    try {
      // 1. P (Codex) subscription: the session stays on Codex with the own login.
      const first = await plan();
      assert.equal(first.session_provider, 'codex');
      assert.deepEqual(first.next_credential, { provider: 'codex', tier: 'subscription' });
      assert.deepEqual(await viaRoute(), first.next_credential);
      assert.deepEqual(first.outlook?.next_lease, lease('codex', 'codex@example.com', 'own'));
      const served = await resolveCodexSpawnAuth(owner);
      assert.equal(served.servedBy, 'user');
      assert.equal(served.credentialMeta?.integrationId, codex.id);
      assert.equal(
        served.envs.AZURE_OPENAI_API_KEY,
        undefined,
        'a Claude subscription is left: the sandbox may not switch to Azure'
      );

      // 2. Codex subscriptions limited, a Claude subscription left: Claude (with the
      // handoff), not the funded Azure deployment that is still available.
      await limit(codex.id);
      const sharedCodex = (await pooledLeasable('gpt_code')) > 0;
      console.log(`  credential order: shared Codex subscription leasable=${sharedCodex}`);
      const second = await plan();
      const fresh = await plan(true);
      if (sharedCodex) {
        assert.deepEqual(second.next_credential, { provider: 'codex', tier: 'subscription' });
      } else {
        for (const answer of [second, fresh]) {
          assert.deepEqual(
            answer.next_credential,
            { provider: 'claude', tier: 'subscription' },
            'a Claude subscription before Azure, for a retry and a fresh spawn'
          );
        }
        assert.deepEqual(second.outlook?.next_lease, lease('claude', 'me@example.com', 'own'));
        assert.deepEqual(await viaRoute(), second.next_credential);
        const claudeLease = await fetchClaudeCodeCredentialsWithMeta(owner);
        assert.equal(claudeLease?.source, 'user');
        assert.equal(claudeLease?.integrationId, claude.id, 'the Claude subscription serves');
        // The retry on Claude continues the same session with the handoff.
        const switching = await session('order-switch');
        await markPaused(switching.id);
        const { fields } = await createWithCodeSession(
          {
            agentId,
            userId: owner,
            repoUrl: 'rose-project:order-switch',
            codeProvider: 'claude',
            codeSessionId: switching.id,
            leaseOwner: 'tool:order:1',
          },
          async () => ({ resumedFrom: 'checkpoint', cliSessionId: null })
        );
        assert.equal(fields.code_session_id, switching.id);
        assert.equal(fields.code_provider, 'claude');
        assert.equal(fields.provider_handoff, true);
      }

      // 3. Every subscription limited: P's funded key (Azure), the deployment alone.
      await limit(claude.id);
      const anySubscription =
        sharedCodex ||
        (await pooledLeasable('claude_code')) + (await pooledLeasable('gpt_code')) > 0;
      console.log(`  credential order: any shared subscription leasable=${anySubscription}`);
      if (!anySubscription) {
        const third = await plan();
        assert.deepEqual(third.next_credential, { provider: 'codex', tier: 'funded' });
        assert.deepEqual(third.outlook?.next_lease, lease('codex', AZURE, 'funded'));
        assert.equal((await resolveCodexSpawnAuth(owner)).servedBy, 'azure');

        // 4. Azure backed off: Q's funded key (the Anthropic API key).
        await markCodexFundedCooldown(later);
        process.env.ANTHROPIC_API_KEY = 'anthropic-key-not-a-secret-here';
        if (!(await isAnthropicApiKeyOnCooldown())) {
          const fourth = await plan();
          assert.deepEqual(fourth.next_credential, { provider: 'claude', tier: 'funded' });
          assert.deepEqual(fourth.outlook?.next_lease, lease('claude', ANTHROPIC, 'funded'));
          assert.equal(await fetchClaudeCodeCredentialsWithMeta(owner), null, 'no login leased');
        }

        // 5. Nothing leasable: no next credential, the retry stays paused on the earliest reset.
        delete process.env.ANTHROPIC_API_KEY;
        const fifth = await plan();
        assert.equal(fifth.next_credential, null);
        assert.equal(
          (fifth.outlook?.next_lease as { available_now?: boolean })?.available_now,
          false
        );
      }
    } finally {
      delete process.env.AZURE_FOUNDRY_ENDPOINT;
      delete process.env.AZURE_FOUNDRY_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      if (savedKey === undefined) delete process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
      else process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = savedKey;
      await __resetCodexFundedCooldown();
      await prisma.codeSession.deleteMany({ where: { userId: owner } });
      await prisma.integration.deleteMany({ where: { id: { in: [codex.id, claude.id] } } });
      await prisma.agent.deleteMany({ where: { id: agentId } });
      await prisma.user.deleteMany({ where: { userId: owner } });
    }
  });

  test('an unusable Codex login is marked for reconnect, not rate-limited; the retry plan takes the Claude subscription', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const savedKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
    process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    ).toString('base64');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const owner = `code-order-revoked-${randomUUID()}`;
    const agentId = randomUUID();
    await prisma.user.create({ data: { userId: owner, name: 'Revoked Codex Login' } });
    await prisma.agent.create({ data: { id: agentId, userId: owner, goal: 'Ship it' } });
    const own = (name: 'claude_code' | 'gpt_code', email: string, secret: object) =>
      prisma.integration.create({
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
    const codex = await own('gpt_code', 'codex@example.com', {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'codex-access', refresh_token: 'codex-refresh', account_id: 'c1' },
    });
    const claude = await own('claude_code', 'me@example.com', {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-revoked-case',
        refreshToken: 'refresh-revoked-case',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    const codexSession = await prisma.codeSession.create({
      data: {
        userId: owner,
        rootAgentId: agentId,
        ownerAgentId: agentId,
        repoKey: 'rose-project:revoked',
        repoUrl: 'rose-project:revoked',
        codeProvider: 'codex',
      },
    });
    try {
      // The spawn leased the own Codex login; a Claude subscription is left, so no Azure switch.
      const served = await resolveCodexSpawnAuth(owner);
      assert.equal(served.credentialMeta?.integrationId, codex.id);
      assert.equal(served.azureFunding, null);
      const task = await prisma.claudeCodeSession.create({
        data: {
          agentId,
          sandboxId: `sb-${randomUUID()}`,
          goal: 'g',
          codeProvider: 'codex',
          claudeTokenSource: served.servedBy,
          claudeTokenIntegrationId: codex.id,
        },
      });
      // The activity persists the structured unusable login as initial credential feedback.
      await persistOutput(task.id, '[Codex] Turn failed: refresh_token_invalidated\n', [
        { source: 'initial', reason: 'oauth_refresh_invalid' },
      ]);
      const marked = await prisma.integration.findUniqueOrThrow({ where: { id: codex.id } });
      assert.deepEqual(
        { status: marked.status, rateLimitedUntil: marked.rateLimitedUntil },
        { status: 'EXPIRED', rateLimitedUntil: null },
        'exactly that login needs reconnect; it is not put on a rate-limit cooldown'
      );
      const untouched = await prisma.integration.findUniqueOrThrow({ where: { id: claude.id } });
      assert.equal(untouched.status, 'CONNECTED', 'the Claude subscription is untouched');
      const plan = await codeSpawnCredentialPlan(owner, {
        codeSessionId: codexSession.id,
        prefer: 'codex',
      });
      const codexAccount = plan.outlook?.accounts.find((account) => account.provider === 'codex');
      assert.equal(codexAccount?.status, 'reconnect');
      if ((await pooledLeasable('gpt_code')) === 0) {
        assert.deepEqual(plan.next_credential, { provider: 'claude', tier: 'subscription' });
        assert.deepEqual(plan.outlook?.next_lease, {
          provider: 'claude',
          label: 'me@example.com',
          available_now: true,
          available_at: null,
          kind: 'own',
        });
      }
    } finally {
      if (savedKey === undefined) delete process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
      else process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = savedKey;
      await prisma.claudeCodeSession.deleteMany({ where: { agentId } });
      await prisma.codeSession.deleteMany({ where: { userId: owner } });
      await prisma.integration.deleteMany({ where: { id: { in: [codex.id, claude.id] } } });
      await prisma.agent.deleteMany({ where: { id: agentId } });
      await prisma.user.deleteMany({ where: { userId: owner } });
    }
  });

  test('a login whose stored access token expired is not a leasable subscription (availability = serving)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const savedKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
    process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    ).toString('base64');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const owner = `code-order-expiry-${randomUUID()}`;
    const jwt = (expMs: number) =>
      ['{"alg":"none"}', JSON.stringify({ exp: Math.floor(expMs / 1000) })]
        .map((part) => Buffer.from(part).toString('base64url'))
        .join('.') + '.sig';
    const seal = (name: 'claude_code' | 'gpt_code', expMs: number) =>
      prisma.integration.create({
        data: {
          userId: owner,
          type: 'TOOL_SETUP',
          name,
          accountId: `${name}-${expMs}`,
          status: 'CONNECTED',
          isActive: true,
          config: {
            encryptedCredentials: sealEnvelope(
              JSON.stringify(
                name === 'claude_code'
                  ? {
                      claudeAiOauth: {
                        accessToken: `sk-ant-oat01-${randomUUID()}`,
                        expiresAt: expMs,
                      },
                    }
                  : { auth_mode: 'chatgpt', tokens: { access_token: jwt(expMs), account_id: 'c1' } }
              ),
              pem
            ),
          },
        },
      });
    try {
      const hourAgo = Date.now() - 60 * 60 * 1000;
      await seal('claude_code', hourAgo);
      await seal('gpt_code', hourAgo);
      // A Mac-style own-only view: only this owner's logins count (no shared pool rows).
      const expired = await codeCredentialTiers(owner, new Date(), { ownOnly: true });
      assert.equal(expired.claude.subscription, false, 'an expired Claude token cannot be served');
      assert.equal(expired.codex.subscription, false, 'an expired Codex token cannot be served');
      assert.equal(
        (await fetchClaudeCodeCredentialsWithMeta(owner))?.source === 'user',
        false,
        'serving agrees: the expired login is never handed out'
      );
      const hourAhead = Date.now() + 60 * 60 * 1000;
      await seal('claude_code', hourAhead);
      await seal('gpt_code', hourAhead);
      const live = await codeCredentialTiers(owner, new Date(), { ownOnly: true });
      assert.equal(live.claude.subscription, true);
      assert.equal(live.codex.subscription, true);
    } finally {
      process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = savedKey;
      await prisma.integration.deleteMany({ where: { userId: owner } });
    }
  });
}
