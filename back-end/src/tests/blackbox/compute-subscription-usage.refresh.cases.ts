/**
 * Background-refresh cases of the compute-subscription-usage domain: a Claude
 * account no response has measured gets its windows and reset times.
 *
 *   refreshClaudeUsage (production deps)
 *     ├─ the seeded, encrypted login is read and decrypted for real
 *     ├─ user:profile token → GET /api/oauth/usage ── scripted: the live 403
 *     └─ inference-only (setup-token), or refused ── one max_tokens 1 quota check
 *          through the real claudeAuth body + Anthropic transport, scripted 200
 *          with anthropic-ratelimit-unified-* headers
 *               └─ recordIntegrationUsage → GET /api/compute-accounts
 *
 * Production 2026-11-13: every Claude account was a setup-token with scopes
 * ["user:inference"]; the usage endpoint answered each one with the 403 below,
 * so no bar ever showed a usage window or a reset time.
 */

import type { IntegrationType } from '@prisma/client';
import {
  refreshClaudeUsage,
  USAGE_ENDPOINT_URL,
  usageNeedsRefresh,
} from '../../providers/computeUsageRefresh';
import { prisma } from '../../providers/database';
import { getPool } from '../../providers/rose/pools';
import { ANTHROPIC_API_URL } from '../../providers/rose/transport';
import { encryptClaudeEnvelope } from './integrations.context';

interface RefreshAccountDto {
  accountId: string;
  usage: {
    fiveHour: { usedPct: number; resetsAt: string | null } | null;
    sevenDay: { usedPct: number; resetsAt: string | null } | null;
    source: string;
    status: string | null;
  } | null;
  rateLimitedUntil?: string | null;
  cooldown?: { until: string; reason: string; authoritative: boolean } | null;
  nextResetAt?: string | null;
}

export interface UsageRefreshContext {
  test: (name: string, fn: () => Promise<void>) => void;
  listAccounts: (userId: string, provider?: string) => Promise<RefreshAccountDto[]>;
  run: string;
  baseUrl: string;
  chatUsers: string[];
  integrationType: IntegrationType;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** The usage endpoint's live answer to a setup-token (request req_011Cgzq5SnJ3Ft34iZvXWPeJ). */
const SCOPE_REFUSAL_BODY = JSON.stringify({
  type: 'error',
  error: {
    type: 'permission_error',
    message: 'OAuth token does not meet scope requirement user:profile',
  },
  request_id: 'req_011Cgzq5SnJ3Ft34iZvXWPeJ',
});

const ONE_TOKEN_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":0}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

export function registerUsageRefreshCases(ctx: UsageRefreshContext): void {
  const originalFetch = global.fetch;
  const DAY_MS = 86_400_000;
  const epochSeconds = (offsetMs: number) => Math.floor((Date.now() + offsetMs) / 1000);
  const isoFromEpoch = (epoch: number) => new Date(epoch * 1000).toISOString();

  async function seedLogin(token: string, scopes: string[]) {
    const userId = `usage-refresh-${ctx.run}-${ctx.chatUsers.length}`;
    ctx.chatUsers.push(userId);
    const accountId = `${userId}-acct`;
    const setupToken = !scopes.includes('user:profile');
    const credentials = JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: setupToken ? '' : `refresh-${token}`,
        expiresAt: Date.now() + (setupToken ? 365 : 1) * DAY_MS,
        scopes,
        subscriptionType: 'max',
      },
    });
    await prisma.computeAccountConnection.create({
      data: { userId, provider: 'claude', accountId, accountEmail: `${accountId}@example.com` },
    });
    const row = await prisma.integration.create({
      data: {
        userId,
        type: ctx.integrationType,
        name: 'claude_code',
        status: 'CONNECTED',
        isActive: true,
        accountId,
        config: { encryptedCredentials: encryptClaudeEnvelope(credentials) },
      },
      select: { id: true },
    });
    return { userId, accountId, integrationId: row.id };
  }

  /** Refresh one row with Anthropic scripted for `token`; everything else is refused. */
  async function refreshScripted(
    integrationId: string,
    token: string,
    probe: 'allowed' | 'rejected7d' = 'allowed'
  ) {
    const fiveHourReset = epochSeconds(3 * 3_600_000);
    const sevenDayReset = epochSeconds(4 * DAY_MS);
    const usageRequests: string[] = [];
    const quotaBodies: Array<Record<string, unknown>> = [];
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      if (auth === `Bearer ${token}` && url === USAGE_ENDPOINT_URL) {
        usageRequests.push(url);
        return new Response(SCOPE_REFUSAL_BODY, {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (auth === `Bearer ${token}` && url === ANTHROPIC_API_URL) {
        quotaBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (probe === 'rejected7d') {
          return new Response(
            '{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}',
            {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'anthropic-ratelimit-unified-status': 'rejected',
                'anthropic-ratelimit-unified-representative-claim': 'seven_day',
                'anthropic-ratelimit-unified-reset': String(sevenDayReset),
                'anthropic-ratelimit-unified-5h-utilization': '0.10',
                'anthropic-ratelimit-unified-5h-reset': String(fiveHourReset),
                'anthropic-ratelimit-unified-7d-utilization': '1.0',
                'anthropic-ratelimit-unified-7d-reset': String(sevenDayReset),
              },
            }
          );
        }
        return new Response(ONE_TOKEN_SSE, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'anthropic-ratelimit-unified-status': 'allowed',
            'anthropic-ratelimit-unified-5h-utilization': '0.42',
            'anthropic-ratelimit-unified-5h-reset': String(fiveHourReset),
            'anthropic-ratelimit-unified-7d-utilization': '0.18',
            'anthropic-ratelimit-unified-7d-reset': String(sevenDayReset),
          },
        });
      }
      if (url.startsWith(ctx.baseUrl))
        return originalFetch(input as Parameters<typeof fetch>[0], init);
      return new Response('{"error":"not scripted"}', { status: 500 });
    }) as typeof fetch;
    try {
      const outcome = await refreshClaudeUsage(integrationId);
      return { outcome, usageRequests, quotaBodies, fiveHourReset, sevenDayReset };
    } finally {
      global.fetch = originalFetch;
    }
  }

  async function assertBarFromQuotaCheck(
    userId: string,
    accountId: string,
    refreshed: Awaited<ReturnType<typeof refreshScripted>>
  ) {
    assert(
      refreshed.outcome === 'stored',
      `the refresh must store the account's windows, got ${refreshed.outcome}`
    );
    assert(
      refreshed.quotaBodies.length === 1,
      `one quota check, got ${refreshed.quotaBodies.length}`
    );
    const [quota] = refreshed.quotaBodies;
    assert(
      quota.model === getPool('rose-1-mini').claudeAuthModel && quota.max_tokens === 1,
      `the quota check is one max_tokens 1 call on the small model, got ${quota.model}/${quota.max_tokens}`
    );
    const account = (await ctx.listAccounts(userId, 'claude')).find(
      (a) => a.accountId === accountId
    );
    const usage = account?.usage;
    assert(usage, `the bar must have usage, got ${JSON.stringify(account)}`);
    assert(
      usage.fiveHour?.usedPct === 42 &&
        usage.fiveHour.resetsAt === isoFromEpoch(refreshed.fiveHourReset),
      `5h window and reset must come from the quota check, got ${JSON.stringify(usage.fiveHour)}`
    );
    assert(
      usage.sevenDay?.usedPct === 18 &&
        usage.sevenDay.resetsAt === isoFromEpoch(refreshed.sevenDayReset),
      `7d window and reset must come from the quota check, got ${JSON.stringify(usage.sevenDay)}`
    );
    assert(usage.source === 'response' && usage.status === 'allowed', JSON.stringify(usage));
  }

  ctx.test(
    'an inference-only Claude login gets its windows and resets from a quota check',
    async () => {
      const token = `usage-refresh-setup-${ctx.run}`;
      const { userId, accountId, integrationId } = await seedLogin(token, ['user:inference']);
      const refreshed = await refreshScripted(integrationId, token);
      assert(
        refreshed.usageRequests.length === 0,
        'a token without user:profile never calls the usage endpoint'
      );
      await assertBarFromQuotaCheck(userId, accountId, refreshed);
    }
  );

  ctx.test(
    'a Claude login the usage endpoint refuses (403 scope) falls back to a quota check',
    async () => {
      const token = `usage-refresh-refused-${ctx.run}`;
      const { userId, accountId, integrationId } = await seedLogin(token, [
        'user:inference',
        'user:profile',
      ]);
      const refreshed = await refreshScripted(integrationId, token);
      assert(refreshed.usageRequests.length === 1, 'a user:profile token asks the endpoint first');
      await assertBarFromQuotaCheck(userId, accountId, refreshed);
    }
  );

  /** A seeded login cooling down on Rose's own backoff until 18 days from now. */
  async function coolOnRoseBackoff(
    integrationId: string,
    cooldown: { reason: string | null; authoritative: boolean | null; untilMs?: number }
  ) {
    const until = new Date(Date.now() + (cooldown.untilMs ?? 18 * DAY_MS));
    await prisma.integration.update({
      where: { id: integrationId },
      data: {
        rateLimitedUntil: until,
        rateLimitReason: cooldown.reason,
        rateLimitAuthoritative: cooldown.authoritative,
      },
    });
    return until;
  }

  async function accountFor(userId: string, accountId: string) {
    const account = (await ctx.listAccounts(userId, 'claude')).find(
      (a) => a.accountId === accountId
    );
    assert(account, `account ${accountId} missing`);
    return account;
  }

  ctx.test("a quota check that says allowed lifts Rose's far-future backoff", async () => {
    const token = `usage-reconcile-allowed-${ctx.run}`;
    const { userId, accountId, integrationId } = await seedLogin(token, ['user:inference']);
    await coolOnRoseBackoff(integrationId, { reason: null, authoritative: null });
    const refreshed = await refreshScripted(integrationId, token);
    assert(refreshed.outcome === 'stored', `windows must be stored, got ${refreshed.outcome}`);
    const account = await accountFor(userId, accountId);
    assert(
      account.cooldown === null && account.rateLimitedUntil === null,
      `an allowed account must not stay cooled: ${JSON.stringify(account)}`
    );
    assert(account.usage?.status === 'allowed', JSON.stringify(account.usage));
  });

  ctx.test("a rejected quota check replaces Rose's backoff with the provider's reset", async () => {
    const token = `usage-reconcile-rejected-${ctx.run}`;
    const { userId, accountId, integrationId } = await seedLogin(token, ['user:inference']);
    await coolOnRoseBackoff(integrationId, { reason: 'rate_limit', authoritative: false });
    const refreshed = await refreshScripted(integrationId, token, 'rejected7d');
    assert(refreshed.outcome === 'stored', `windows must be stored, got ${refreshed.outcome}`);
    const reset = isoFromEpoch(refreshed.sevenDayReset);
    const account = await accountFor(userId, accountId);
    assert(
      account.cooldown?.until === reset &&
        account.cooldown.reason === 'usage_window_7d' &&
        account.cooldown.authoritative,
      `the cooldown must be the provider's 7d reset: ${JSON.stringify(account.cooldown)}`
    );
    assert(account.nextResetAt === reset, `next reset must be ${reset}: ${account.nextResetAt}`);
  });

  ctx.test(
    'a provider cooldown beyond any subscription window is re-checked and lifted when allowed',
    async () => {
      // Prod 2026-11-14 01:41Z: a fast-mode request the account could not pay for
      // got 429 with only the MONTHLY overage reset (2026-12-01), and that reset was
      // stored as an authoritative rate_limit cooldown ~17 days out on accounts
      // whose standard requests were allowed. No 5h/7d window resets that far out,
      // so a standard-speed quota check that says allowed must lift it.
      const token = `usage-reconcile-overage-${ctx.run}`;
      const { userId, accountId, integrationId } = await seedLogin(token, ['user:inference']);
      const until = await coolOnRoseBackoff(integrationId, {
        reason: 'rate_limit',
        authoritative: true,
        untilMs: 17 * DAY_MS,
      });
      assert(
        usageNeedsRefresh(
          { usageObservedAt: new Date(), rateLimitedUntil: until, rateLimitAuthoritative: true },
          new Date()
        ),
        'a provider cooldown beyond any subscription window must be re-checked even with fresh usage'
      );
      const refreshed = await refreshScripted(integrationId, token);
      assert(refreshed.outcome === 'stored', `windows must be stored, got ${refreshed.outcome}`);
      assert(
        refreshed.quotaBodies.length === 1 && refreshed.quotaBodies[0].speed === undefined,
        `the re-check is one standard-speed quota check, got ${JSON.stringify(refreshed.quotaBodies)}`
      );
      const account = await accountFor(userId, accountId);
      assert(
        account.cooldown === null && account.rateLimitedUntil === null,
        `an allowed account must not stay cooled until the overage reset: ${JSON.stringify(account)}`
      );
    }
  );

  ctx.test('a provider reset or an auth cooldown is never changed by a quota check', async () => {
    const providerToken = `usage-reconcile-provider-${ctx.run}`;
    const provider = await seedLogin(providerToken, ['user:inference']);
    const providerUntil = await coolOnRoseBackoff(provider.integrationId, {
      reason: 'usage_window_5h',
      authoritative: true,
      untilMs: 2 * 3_600_000,
    });
    await refreshScripted(provider.integrationId, providerToken);
    const providerAccount = await accountFor(provider.userId, provider.accountId);
    assert(
      providerAccount.cooldown?.until === providerUntil.toISOString() &&
        providerAccount.cooldown.authoritative,
      `a provider reset must stay: ${JSON.stringify(providerAccount.cooldown)}`
    );
    const authToken = `usage-reconcile-auth-${ctx.run}`;
    const auth = await seedLogin(authToken, ['user:inference']);
    const authUntil = await coolOnRoseBackoff(auth.integrationId, {
      reason: 'auth',
      authoritative: false,
    });
    await refreshScripted(auth.integrationId, authToken);
    const authAccount = await accountFor(auth.userId, auth.accountId);
    assert(
      authAccount.cooldown?.until === authUntil.toISOString() &&
        authAccount.cooldown.reason === 'auth',
      `an auth cooldown must stay: ${JSON.stringify(authAccount.cooldown)}`
    );
  });
}
