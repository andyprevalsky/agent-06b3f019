/**
 * Codex (gpt_code) usage refresh: a Codex account's cooldown must track the
 * provider's own weekly reset, as Claude's does (#2030/#2048).
 *
 * Prod 2026-11-14: three Codex accounts sat on a cooldown copied from a sibling
 * account (11-17T21:28Z, written before #1981 by an unnamed report) while a live
 * probe showed one resets 11-15T19:47Z and another 11-17T00:44Z. Nothing ever
 * asked Codex again, so the wrong deadline held: Andy's Codex-first order lost
 * days of a subscription.
 *
 *   GET /api/compute-accounts (listConnectedAccounts) ─► Codex row with no usage,
 *   stale usage or Rose's own cooldown ─► one minimal Codex request (quota check)
 *     ├─ 429 usage_limit_reached ─► cooldown = the spent window's reset (authoritative)
 *     ├─ 200 allowed            ─► Rose's backoff lifted
 *     └─ 401/403                ─► unavailable backoff; the login is never expired here
 *
 * Runs in this process with Codex scripted on global.fetch (nothing reaches
 * chatgpt.com); the refresh is the real one listConnectedAccounts schedules.
 */

import type { IntegrationType } from '@prisma/client';
import { listConnectedAccounts } from '../../domains/compute-grants/service';
import { prisma } from '../../providers/database';
import { CODEX_API_URL } from '../../providers/rose/transport';
import { encryptClaudeEnvelope } from './integrations.context';
import { waitFor } from '../helpers/waitFor';

export interface CodexRefreshContext {
  test: (name: string, fn: () => Promise<void>) => void;
  run: string;
  chatUsers: string[];
  integrationType: IntegrationType;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const DAY_MS = 86_400_000;

export function registerCodexUsageRefreshCases(ctx: CodexRefreshContext): void {
  const originalFetch = global.fetch;

  async function seedCodexLogin(label: string, cooldownMs: number) {
    const userId = `usage-codex-${ctx.run}-${label}`;
    ctx.chatUsers.push(userId);
    const accountId = `${userId}-acct`;
    const token = `codex-access-${label}-${ctx.run}`;
    await prisma.computeAccountConnection.create({
      data: { userId, provider: 'codex', accountId, accountEmail: `${accountId}@example.com` },
    });
    const row = await prisma.integration.create({
      data: {
        userId,
        type: ctx.integrationType,
        name: 'gpt_code',
        status: 'CONNECTED',
        isActive: true,
        accountId,
        // The prod shape: a cooldown written by an unnamed report, no reason, no authority.
        rateLimitedUntil: new Date(Date.now() + cooldownMs),
        rateLimitReason: null,
        rateLimitAuthoritative: null,
        config: {
          encryptedCredentials: encryptClaudeEnvelope(
            JSON.stringify({
              auth_mode: 'chatgpt',
              tokens: { access_token: token, account_id: accountId },
            })
          ),
        },
      },
      select: { id: true },
    });
    return { userId, integrationId: row.id, token };
  }

  type CodexRow = { rateLimitedUntil: Date | null; rateLimitAuthoritative: boolean | null };

  /**
   * List the accounts with Codex scripted, wait for the refresh that list
   * scheduled to ask Codex, then for `settled` (or a short pause when the
   * refresh must leave the row as it was).
   */
  async function listWithCodexScripted(
    userId: string,
    integrationId: string,
    token: string,
    answer: () => Response,
    settled?: (row: CodexRow) => boolean
  ) {
    const requests: Array<Record<string, unknown>> = [];
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      if (url === CODEX_API_URL && auth === `Bearer ${token}`) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return answer();
      }
      return originalFetch(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;
    try {
      await listConnectedAccounts(userId, 'codex');
      await waitFor('the Codex quota check scheduled by the account list', () =>
        requests.length > 0 ? true : null
      );
      if (settled) {
        await waitFor('the Codex refresh to reconcile the cooldown', async () => {
          const row = await prisma.integration.findUniqueOrThrow({
            where: { id: integrationId },
            select: { rateLimitedUntil: true, rateLimitAuthoritative: true },
          });
          return settled(row) ? true : null;
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return { requests };
    } finally {
      global.fetch = originalFetch;
    }
  }

  async function cooldownOf(integrationId: string) {
    return prisma.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: {
        status: true,
        rateLimitedUntil: true,
        rateLimitReason: true,
        rateLimitAuthoritative: true,
        usage7dUsedPct: true,
        usage7dResetsAt: true,
      },
    });
  }

  ctx.test(
    "a Codex account cooled past its real weekly reset takes the provider's reset",
    async () => {
      const { userId, integrationId, token } = await seedCodexLogin('spent', 4 * DAY_MS);
      const resetEpoch = Math.floor((Date.now() + 2 * DAY_MS) / 1000);
      const { requests } = await listWithCodexScripted(
        userId,
        integrationId,
        token,
        () =>
          // The captured prod answer (2026-11-14, account de79f8a2), with a relative reset.
          new Response(
            JSON.stringify({
              error: {
                type: 'usage_limit_reached',
                message: 'The usage limit has been reached',
                plan_type: 'promax',
                resets_at: resetEpoch,
                limit_window_minutes: 10080,
              },
            }),
            {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'x-codex-primary-used-percent': '100',
                'x-codex-primary-window-minutes': '10080',
                'x-codex-primary-reset-at': String(resetEpoch),
                'x-codex-secondary-used-percent': '0',
                'x-codex-secondary-window-minutes': '0',
              },
            }
          )
      );
      assert(requests.length === 1, `one Codex quota check, got ${requests.length}`);
      assert(
        requests[0].service_tier === undefined,
        `the quota check runs at standard speed: ${JSON.stringify(requests[0].service_tier)}`
      );
      const row = await cooldownOf(integrationId);
      assert(
        row.rateLimitedUntil?.toISOString() === new Date(resetEpoch * 1000).toISOString(),
        `the cooldown must be the provider's weekly reset, got ${row.rateLimitedUntil?.toISOString() ?? 'null'}`
      );
      assert(
        row.rateLimitReason === 'usage_window_7d' && row.rateLimitAuthoritative === true,
        `the cooldown must be an authoritative 7d window: ${JSON.stringify(row)}`
      );
      assert(
        row.usage7dUsedPct === 100,
        `the weekly bar must show 100%, got ${row.usage7dUsedPct}`
      );
    }
  );

  ctx.test("an allowed Codex quota check lifts Rose's own backoff", async () => {
    const { userId, integrationId, token } = await seedCodexLogin('allowed', 4 * DAY_MS);
    const resetEpoch = Math.floor((Date.now() + 5 * DAY_MS) / 1000);
    await listWithCodexScripted(
      userId,
      integrationId,
      token,
      () =>
        new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-codex-primary-used-percent': '12',
            'x-codex-primary-window-minutes': '10080',
            'x-codex-primary-reset-at': String(resetEpoch),
          },
        })
    );
    const row = await cooldownOf(integrationId);
    assert(
      row.rateLimitedUntil === null,
      `an allowed Codex account must not stay cooled: ${row.rateLimitedUntil?.toISOString()}`
    );
    assert(row.usage7dUsedPct === 12, `the weekly bar must show 12%, got ${row.usage7dUsedPct}`);
  });

  ctx.test("a Codex 429 that is not a usage limit never lifts Rose's backoff", async () => {
    // A short-term rate limit can still carry windows under 100%; only a served
    // answer or a usage_limit_reached rejection may change the cooldown.
    const { userId, integrationId, token } = await seedCodexLogin('burst', 4 * DAY_MS);
    const before = await cooldownOf(integrationId);
    const { requests } = await listWithCodexScripted(
      userId,
      integrationId,
      token,
      () =>
        new Response(
          JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'Rate limit reached' } }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'x-codex-primary-used-percent': '20',
              'x-codex-primary-window-minutes': '10080',
              'x-codex-primary-reset-at': String(Math.floor((Date.now() + 5 * DAY_MS) / 1000)),
            },
          }
        )
    );
    assert(requests.length === 1, `one Codex quota check, got ${requests.length}`);
    const after = await cooldownOf(integrationId);
    assert(
      after.rateLimitedUntil?.getTime() === before.rateLimitedUntil?.getTime(),
      `a non-usage 429 must leave the cooldown unchanged, got ${after.rateLimitedUntil?.toISOString()}`
    );
  });

  ctx.test('a served Codex answer without window headers lifts nothing', async () => {
    const { userId, integrationId, token } = await seedCodexLogin('bare', 4 * DAY_MS);
    const before = await cooldownOf(integrationId);
    await listWithCodexScripted(
      userId,
      integrationId,
      token,
      () =>
        new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    );
    const after = await cooldownOf(integrationId);
    assert(
      after.rateLimitedUntil?.getTime() === before.rateLimitedUntil?.getTime(),
      'an answer that names no window says nothing about the cooldown'
    );
  });

  ctx.test('a Codex login the provider refuses is never expired by a quota check', async () => {
    const { userId, integrationId, token } = await seedCodexLogin('expired', 4 * DAY_MS);
    const before = await cooldownOf(integrationId);
    const { requests } = await listWithCodexScripted(
      userId,
      integrationId,
      token,
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Provided authentication token is expired. Please try signing in again.',
              type: 'invalid_request_error',
              code: 'token_expired',
            },
            status: 401,
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )
    );
    assert(requests.length === 1, `one Codex quota check, got ${requests.length}`);
    const after = await cooldownOf(integrationId);
    assert(after.status === 'CONNECTED', `the login must stay CONNECTED, got ${after.status}`);
    assert(
      after.rateLimitedUntil?.getTime() === before.rateLimitedUntil?.getTime(),
      'a refused quota check leaves the cooldown unchanged'
    );
  });
}
