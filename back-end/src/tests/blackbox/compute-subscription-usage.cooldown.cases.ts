/**
 * Agent-loop cooldown reports: the agent loop (agents/helpers/llm.py
 * call_llm_structured_streaming / call_llm / _call_llm_verifier) builds its
 * auth context without the lease's integration id, so a source=user 429 report
 * names the login only by the held token's fingerprint. In prod
 * (2026-11-10..13) such reports first benched every sibling subscription, then
 * were dropped, so the spent login stayed leasable while healthy ones sat idle.
 *
 *   POST token/rate-limited { source: user, userId, credential, rateLimitedUntil }
 *     └─► that user's logins ─► stored token fingerprint == credential
 *           └─► cooldown on that row only; the next lease skips it
 *
 * Invariants:
 *   - the cooldown lands on the login whose token the agent held, never a sibling
 *   - the next lease serves a healthy sibling
 *   - disabling a login stays an explicit, named write (S33/T7): an unnamed
 *     auth_error carrying a matching fingerprint expires nothing
 */

import type { IntegrationType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { credentialFingerprint } from '../../providers/codeLoginRejection';
import { prisma } from '../../providers/database';
import { encryptClaudeEnvelope } from './integrations.context';

export interface CooldownReportContext {
  test: (name: string, fn: () => Promise<void>) => void;
  run: string;
  baseUrl: string;
  apiKey: string;
  chatUsers: string[];
  integrationType: IntegrationType;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function registerCooldownReportCases(ctx: CooldownReportContext): void {
  async function reportRateLimited(userId: string, body: Record<string, unknown>) {
    const res = await fetch(`${ctx.baseUrl}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: { 'X-API-Key': ctx.apiKey, 'X-User-Id': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert(res.status === 200, `token/rate-limited returned ${res.status}`);
  }

  for (const provider of ['claude', 'gpt'] as const) {
    ctx.test(
      `an unnamed ${provider} 429 report cools exactly the login its fingerprint names`,
      async () => {
        const userId = `usage-fp-${provider}-${ctx.run}`;
        ctx.chatUsers.push(userId);
        const name = provider === 'claude' ? 'claude_code' : 'gpt_code';
        const tokens = [0, 1].map((i) =>
          provider === 'claude'
            ? `sk-ant-oat01-${provider}-held-${i}-${randomUUID()}`
            : `${provider}-held-${i}-${randomUUID()}`
        );
        const rows = [];
        for (const [i, token] of tokens.entries()) {
          const envelope =
            provider === 'claude'
              ? {
                  claudeAiOauth: {
                    accessToken: token,
                    refreshToken: '',
                    expiresAt: Date.now() + 30 * 86_400_000,
                    scopes: ['user:inference'],
                  },
                }
              : { auth_mode: 'chatgpt', tokens: { access_token: token, account_id: `acct-${i}` } };
          rows.push(
            await prisma.integration.create({
              data: {
                userId,
                type: ctx.integrationType,
                name,
                status: 'CONNECTED',
                accountId: `fp-${i}-${ctx.run}`,
                // The spent login is the least recently used: without a cooldown it is served first.
                lastUsedAt: new Date(Date.now() - (i === 1 ? 3_600_000 : 60_000)),
                config: { encryptedCredentials: encryptClaudeEnvelope(JSON.stringify(envelope)) },
              },
            })
          );
        }
        const until = new Date(Date.now() + 4 * 86_400_000).toISOString();
        await reportRateLimited(userId, {
          type: provider,
          source: 'user',
          userId,
          rateLimitedUntil: until,
          failureReason: 'rate_limit',
          rateLimitReason: 'usage_window_7d',
          rateLimitAuthoritative: true,
          credential: credentialFingerprint(tokens[1]),
        });
        const after = await prisma.integration.findMany({
          where: { id: { in: rows.map((row) => row.id) } },
          select: { id: true, rateLimitedUntil: true },
        });
        const spent = after.find((row) => row.id === rows[1].id);
        const sibling = after.find((row) => row.id === rows[0].id);
        assert(
          spent?.rateLimitedUntil?.toISOString() === until,
          `the held login must cool until ${until}, got ${spent?.rateLimitedUntil?.toISOString() ?? 'null'}`
        );
        assert(sibling?.rateLimitedUntil === null, 'the sibling login must stay usable');

        const lease = await fetch(
          `${ctx.baseUrl}/api/integrations/compute-code/credentials/token?tokenType=${provider}`,
          { headers: { 'X-API-Key': ctx.apiKey, 'X-User-Id': userId } }
        );
        assert(lease.status === 200, `lease returned ${lease.status}`);
        const served = (await lease.json()) as { integrationId?: string };
        assert(
          served.integrationId === rows[0].id,
          `the next lease must serve the healthy login, got ${served.integrationId}`
        );

        // Disabling a login stays an explicit, named write (S33/T7): the fingerprint
        // scopes a reversible cooldown, never an unnamed auth_error expiry.
        await reportRateLimited(userId, {
          type: provider,
          source: 'user',
          userId,
          failureReason: 'auth_error',
          credential: credentialFingerprint(tokens[0]),
        });
        const healthy = await prisma.integration.findUniqueOrThrow({
          where: { id: rows[0].id },
          select: { status: true },
        });
        assert(healthy.status === 'CONNECTED', 'an unnamed auth_error must never expire a login');
      }
    );
  }
}
