#!/usr/bin/env tsx
/**
 * C15 provider fall-over must agree with the key a Claude Code sandbox would
 * actually use.
 *
 *   spawn_claude_code_agent ─► GET /credential-availability
 *     claude=false ─► "No claude credential available; continuing on codex"
 *   createClaudeCodeSession (e2b.ts), no login leased:
 *     shared ANTHROPIC_API_KEY cooled + OPENROUTER_API_KEY ─► OpenRouter gateway
 *
 * Pre-Deploy claude-code-agent (2026-10-27, b4729ad9): no Claude login, the
 * shared key cooled (out of credits) and OpenRouter configured. The benchmark
 * preflight accepted the gateway, availability answered claude=false, so the
 * explicit "Using Claude Code" task silently ran on Codex.
 *
 * Hermetic: the integration count and the cooldown row are stubbed; no DB.
 */
import assert from 'node:assert/strict';

import { __resetAnthropicApiKeyCooldown } from '../../providers/computeCredentials';
import { prisma } from '../../providers/database';
import { codeCredentialAvailability } from '../../providers/codeSessions/usageLimit';

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENROUTER_API_KEY',
  'GPT_API_KEY',
] as const;

const integration = prisma.integration as unknown as {
  count: (...args: unknown[]) => Promise<number>;
  findUnique: (...args: unknown[]) => Promise<unknown>;
  deleteMany: (...args: unknown[]) => Promise<unknown>;
};

async function withNoLoginsAndSharedKey(
  cooled: boolean,
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => Promise<void>
): Promise<void> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const real = {
    count: integration.count,
    findUnique: integration.findUnique,
    deleteMany: integration.deleteMany,
  };
  integration.count = async () => 0;
  integration.findUnique = async () =>
    cooled ? { rateLimitedUntil: new Date(Date.now() + 30 * 60 * 1000) } : null;
  integration.deleteMany = async () => ({ count: 0 });
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  await __resetAnthropicApiKeyCooldown();
  try {
    await fn();
  } finally {
    await __resetAnthropicApiKeyCooldown();
    integration.count = real.count;
    integration.findUnique = real.findUnique;
    integration.deleteMany = real.deleteMany;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function claudeAvailable(): Promise<boolean> {
  return (await codeCredentialAvailability('user-without-logins')).claude;
}

async function main(): Promise<void> {
  const shared = 'sk-ant-shared-unit';

  await withNoLoginsAndSharedKey(true, { ANTHROPIC_API_KEY: shared }, async () => {
    assert.equal(await claudeAvailable(), false, 'a cooled shared key alone backs nothing');
  });

  await withNoLoginsAndSharedKey(
    true,
    { ANTHROPIC_API_KEY: shared, OPENROUTER_API_KEY: 'sk-or-unit' },
    async () => {
      assert.equal(
        await claudeAvailable(),
        true,
        'OpenRouter backs Claude Code while the shared key cools; no switch to Codex'
      );
      assert.equal(
        (await codeCredentialAvailability('user-without-logins', new Date(), { ownOnly: true }))
          .claude,
        false,
        'a Mac run never receives a funded key'
      );
    }
  );

  await withNoLoginsAndSharedKey(
    true,
    { ANTHROPIC_API_KEY: shared, CLAUDE_CODE_ANTHROPIC_API_KEY: 'sk-ant-dedicated-unit' },
    async () => {
      assert.equal(await claudeAvailable(), true, 'a dedicated sandbox key is not gated');
    }
  );

  await withNoLoginsAndSharedKey(
    true,
    { ANTHROPIC_API_KEY: shared, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    async () => {
      assert.equal(
        await claudeAvailable(),
        false,
        'the shared key on api.anthropic.com is exactly what the cooldown protects'
      );
    }
  );

  await withNoLoginsAndSharedKey(false, { ANTHROPIC_API_KEY: shared }, async () => {
    assert.equal(await claudeAvailable(), true, 'a clear shared key backs Claude Code');
  });

  await withNoLoginsAndSharedKey(false, {}, async () => {
    assert.equal(await claudeAvailable(), false, 'no login and no funded key');
  });
}

main()
  .then(() => {
    process.stdout.write('PASS code credential availability follows the sandbox key\n');
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
