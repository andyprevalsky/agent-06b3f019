/**
 * Codex credential order for cloud spawns (E2B code agent, inspect): the
 * user's own ChatGPT subscription, then a shared subscription, then the funded
 * Azure OpenAI deployment, then nothing. Registered by
 * code-session-usage-limit.blackbox.ts (its fixtures, DB rows and env).
 *
 *   own login ──────────► served 'user'; with the shared login still leasable
 *                         Azure is NOT injected (subscriptions first, C15)
 *   own limited ────────► served 'pool' (a shared subscription); Azure rides
 *                         along for the in-sandbox switch only when no other
 *                         subscription is left
 *   all limited ────────► served 'azure' (the deployment alone, no auth.json)
 *   Azure-served limit ─► codex_funded_cooldown until the reset; the spawn
 *                         refuses, availability is false (a retry stays paused)
 *                         and a recovered login runs without the Azure fallback
 *   Azure not configured► the spawn refuses; the funded path reads unconfigured
 *
 * Hermetic: real DB rows sealed with this case's own key, a test-only Azure
 * host (codex-funded.blackbox.invalid); nothing reaches Azure or OpenAI.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import {
  CODE_AGENT_CREDENTIALS_UNAVAILABLE,
  CodeAgentCredentialError,
} from '../../providers/claudeCodeSandboxAuth';
import { persistOutput } from '../../domains/codex-code/service';
import { CODEX_AZURE_SWITCH_LINE } from '../../domains/codex-code/credentialFeedback';
import {
  __resetCodexFundedCooldown,
  codeCredentialAvailability,
  codeUsageOutlook,
  codexFundedCooldownUntil,
  markCodeTaskUsageLimited,
  resolveCodexSpawnAuth,
} from '../../providers/codeSessions/usageLimit';

export interface CodexAzureFallbackContext {
  agentId: string;
  sealEnvelope: (plaintext: string, publicKeyPem: string) => string;
  /** Leasable pooled rows of `name` the suite did not create (shared test DB). */
  otherLeasable: (name: string) => Promise<number>;
}

export function registerCodexAzureFallbackCases(ctx: CodexAzureFallbackContext): void {
  const { agentId, sealEnvelope, otherLeasable } = ctx;
  test('Codex leases own login → shared login → funded Azure; a backed-off or missing Azure leaves nothing (paused)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const savedKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
    // A key of this case's own: logins sealed by other cases (or seeded rows) never decrypt here.
    process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    ).toString('base64');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const codexUser = `codex-azure-${randomUUID()}`;
    const login = (owner: string, pooled: boolean, token: string) =>
      prisma.integration.create({
        data: {
          userId: owner,
          type: 'TOOL_SETUP',
          name: 'gpt_code',
          accountId: `${token}@example.com`,
          status: 'CONNECTED',
          isActive: true,
          poolingEnabled: pooled,
          config: {
            encryptedCredentials: sealEnvelope(
              JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token } }),
              pem
            ),
          },
        },
      });
    const own = await login(codexUser, false, `own-${randomUUID()}`);
    const shared = await login(`pool-owner-${randomUUID()}`, true, `pool-${randomUUID()}`);
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const limit = (id: string, until: Date | null) =>
      prisma.integration.update({ where: { id }, data: { rateLimitedUntil: until } });
    await __resetCodexFundedCooldown();
    process.env.AZURE_FOUNDRY_ENDPOINT = 'https://codex-funded.blackbox.invalid';
    process.env.AZURE_FOUNDRY_API_KEY = 'azure-key-not-a-secret-here';
    const azureEnvs = {
      AZURE_OPENAI_API_KEY: 'azure-key-not-a-secret-here',
      CODEX_AZURE_BASE_URL: 'https://codex-funded.blackbox.invalid/openai/v1',
      CODEX_AZURE_MODEL: 'gpt-6.1-sol',
    };
    const rejectsAsPaused = async (why: string) => {
      await assert.rejects(
        resolveCodexSpawnAuth(codexUser),
        (error: unknown) =>
          error instanceof CodeAgentCredentialError &&
          error.message === CODE_AGENT_CREDENTIALS_UNAVAILABLE,
        why
      );
      // Pooled logins other cases (or the seeded DB) own still count as leasable here.
      assert.equal(
        (await codeCredentialAvailability(codexUser)).codex,
        (await otherLeasable('gpt_code')) > 0,
        why
      );
    };
    const fundedPath = async () =>
      (await codeUsageOutlook(codexUser, { prefer: 'codex' })).paths?.find(
        (path) => path.provider === 'codex' && path.kind === 'funded'
      );
    try {
      const injectedAzure = (envs: Record<string, string>) => ({
        AZURE_OPENAI_API_KEY: envs.AZURE_OPENAI_API_KEY,
        CODEX_AZURE_BASE_URL: envs.CODEX_AZURE_BASE_URL,
        CODEX_AZURE_MODEL: envs.CODEX_AZURE_MODEL,
      });
      const noAzure = {
        AZURE_OPENAI_API_KEY: undefined,
        CODEX_AZURE_BASE_URL: undefined,
        CODEX_AZURE_MODEL: undefined,
      };
      // 1. The user's own subscription serves first. The shared login is a later
      // subscription, so no in-sandbox switch to Azure may skip it (C15 order).
      const primary = await resolveCodexSpawnAuth(codexUser);
      assert.equal(primary.servedBy, 'user');
      assert.equal(primary.credentialMeta?.integrationId, own.id);
      assert.ok(primary.envs.CODEX_AUTH_JSON, 'the own login is written as auth.json');
      assert.equal(primary.azureFunding, null);
      assert.deepEqual(injectedAzure(primary.envs), noAzure, 'a subscription is left: no Azure');

      // 2. Own subscription limited → a shared subscription, still before Azure. Azure
      // rides along for the in-sandbox switch only when no other subscription is left.
      await limit(own.id, later);
      const pooled = await resolveCodexSpawnAuth(codexUser);
      assert.equal(pooled.servedBy, 'pool');
      assert.equal(pooled.credentialMeta?.poolTokenId, shared.id);
      // Every leasable pooled subscription in the shared test DB, the leased one aside.
      const subscriptionsLeft =
        (await prisma.integration.count({
          where: {
            name: { in: ['claude_code', 'gpt_code'] },
            status: 'CONNECTED',
            poolingEnabled: true,
            id: { not: shared.id },
            OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: new Date() } }],
          },
        })) > 0;
      assert.deepEqual(
        injectedAzure(pooled.envs),
        subscriptionsLeft ? noAzure : azureEnvs,
        'Azure is the next credential only after the last subscription'
      );

      // 3. Every subscription limited → the funded Azure deployment alone, recorded as 'azure'.
      await limit(shared.id, later);
      const funded = await resolveCodexSpawnAuth(codexUser);
      assert.equal(funded.servedBy, 'azure');
      assert.equal(funded.credentialMeta, null);
      assert.equal(
        funded.envs.CODEX_AUTH_JSON,
        undefined,
        'no ChatGPT auth.json on the funded path'
      );
      assert.deepEqual(funded.envs, azureEnvs);
      assert.equal((await codeCredentialAvailability(codexUser)).codex, true);

      // 4. An Azure-served run at its limit backs the deployment off until the reset ...
      const azureTask = await prisma.claudeCodeSession.create({
        data: {
          agentId,
          sandboxId: `sb-${randomUUID()}`,
          goal: 'g',
          codeProvider: 'codex',
          claudeTokenSource: funded.servedBy,
        },
      });
      assert.deepEqual(await markCodeTaskUsageLimited(azureTask.id, 'codex', later), {
        marked: 'codex_funded',
      });
      assert.equal((await codexFundedCooldownUntil())?.toISOString(), later.toISOString());
      // ... so nothing is leasable: the spawn refuses and a retry stays paused.
      await rejectsAsPaused('a backed-off Azure deployment is not leased');
      assert.deepEqual(await fundedPath(), {
        provider: 'codex',
        kind: 'funded',
        label: 'funded Azure OpenAI deployment',
        status: 'limited',
        limited_until: later.toISOString(),
      });
      // A login that recovers serves alone: no runtime fallback onto the backed-off deployment.
      await limit(own.id, null);
      const recovered = await resolveCodexSpawnAuth(codexUser);
      assert.equal(recovered.servedBy, 'user');
      assert.equal(recovered.envs.AZURE_OPENAI_API_KEY, undefined);
      assert.equal(recovered.envs.CODEX_AZURE_BASE_URL, undefined);

      // 5. Azure not configured and no subscription → paused, the path reads not configured.
      await limit(own.id, later);
      await __resetCodexFundedCooldown();
      delete process.env.AZURE_FOUNDRY_ENDPOINT;
      delete process.env.AZURE_FOUNDRY_API_KEY;
      await rejectsAsPaused('no funded deployment and no subscription');
      assert.equal((await fundedPath())?.status, 'unconfigured');
    } finally {
      delete process.env.AZURE_FOUNDRY_ENDPOINT;
      delete process.env.AZURE_FOUNDRY_API_KEY;
      if (savedKey === undefined) delete process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
      else process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = savedKey;
      await __resetCodexFundedCooldown();
      await prisma.integration.deleteMany({ where: { id: { in: [own.id, shared.id] } } });
    }
  });

  test('after an in-sandbox switch to Azure a limit marks the Azure deployment, never the original login', async () => {
    const owner = `codex-switch-${randomUUID()}`;
    const login = await prisma.integration.create({
      data: {
        userId: owner,
        type: 'TOOL_SETUP',
        name: 'gpt_code',
        status: 'CONNECTED',
        isActive: true,
      },
    });
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const leasedTask = () =>
      prisma.claudeCodeSession.create({
        data: {
          agentId,
          sandboxId: `sb-${randomUUID()}`,
          goal: 'g',
          codeProvider: 'codex',
          claudeTokenSource: 'user',
          claudeTokenIntegrationId: login.id,
        },
      });
    await __resetCodexFundedCooldown();
    try {
      // Structured feedback: the worker saw auth_fallback (the login proved unusable).
      const switchedTask = await leasedTask();
      await persistOutput(switchedTask.id, 'terminal output', [
        { source: 'oauth', reason: 'oauth_refresh_invalid' },
      ]);
      const recorded = await prisma.claudeCodeSession.findUniqueOrThrow({
        where: { id: switchedTask.id },
        select: { claudeTokenSource: true, claudeTokenIntegrationId: true },
      });
      assert.deepEqual(recorded, {
        claudeTokenSource: 'azure',
        claudeTokenIntegrationId: login.id,
      });
      // The revoked login itself is marked by the feedback; reset it to isolate the limit mark.
      await prisma.integration.update({
        where: { id: login.id },
        data: { rateLimitedUntil: null },
      });
      assert.deepEqual(await markCodeTaskUsageLimited(switchedTask.id, 'codex', later), {
        marked: 'codex_funded',
      });
      assert.equal((await codexFundedCooldownUntil())?.toISOString(), later.toISOString());
      const untouched = await prisma.integration.findUniqueOrThrow({ where: { id: login.id } });
      assert.equal(untouched.rateLimitedUntil, null, 'the original ChatGPT login is never marked');

      // Legacy terminal-only feedback: the exact switch line records the same switch.
      await __resetCodexFundedCooldown();
      const legacyTask = await leasedTask();
      await persistOutput(
        legacyTask.id,
        `[Codex] Error: token_revoked\n${CODEX_AZURE_SWITCH_LINE}\n`
      );
      const legacy = await prisma.claudeCodeSession.findUniqueOrThrow({
        where: { id: legacyTask.id },
        select: { claudeTokenSource: true },
      });
      assert.equal(legacy.claudeTokenSource, 'azure');
      // A near-miss of the line is not a switch: no loose string matching.
      const nearMiss = await leasedTask();
      await persistOutput(nearMiss.id, `${CODEX_AZURE_SWITCH_LINE}.\n`);
      const kept = await prisma.claudeCodeSession.findUniqueOrThrow({
        where: { id: nearMiss.id },
        select: { claudeTokenSource: true },
      });
      assert.equal(kept.claudeTokenSource, 'user');

      // Without a switch the limit marks the login the run leased.
      const ownTask = await leasedTask();
      assert.deepEqual(await markCodeTaskUsageLimited(ownTask.id, 'codex', later), {
        marked: `gpt_integration:${login.id}`,
      });
    } finally {
      await __resetCodexFundedCooldown();
      await prisma.integration.deleteMany({ where: { id: login.id } });
    }
  });
}
