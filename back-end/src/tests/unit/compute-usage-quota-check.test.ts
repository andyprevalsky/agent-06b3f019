#!/usr/bin/env tsx
/**
 * Usage bars for inference-only Claude logins: the background refresher's
 * quota check (computeUsageRefresh → claudeQuotaCheck).
 *
 *   readToken ─► user:profile? ──yes──► GET /api/oauth/usage ──200──► usage_endpoint
 *                    │no                        └──401/403──┐
 *                    ▼                                       ▼
 *               quota check (max_tokens 1) ──unified headers──► response | rate_limit
 *                    └──401/403, no headers──► unavailable (60 min backoff)
 *
 * Production 2026-11-13: every Claude account was a setup-token (scopes
 * ["user:inference"]), the usage endpoint 403'd all of them with the body below,
 * and no bar ever got a usage window or a reset time. Claude Code calls the
 * endpoint only with user:profile (usage.ts fetchUtilization) and reads limits
 * from a one-token request's unified headers (claudeAiLimits.ts checkQuotaStatus).
 *
 * Invariants:
 *   - an inference-only token never calls the usage endpoint; one quota check
 *     stores both windows with their resets, at most once per 5 min per row
 *   - a user:profile token the endpoint refuses (403 scope, or 401) falls back
 *   - an exhausted account (429, rejected) stores its spent window 100% at its reset
 *   - a refused quota check stores nothing and backs off 60 min (never an auth
 *     failure); a silent response is empty, never zero usage; a failed request
 *     retries after 5 min
 *
 * Hermetic: every dependency is injected.
 */
import assert from 'node:assert/strict';

import type { SubscriptionUsageReport } from '../../providers/computeSubscriptionUsage';
import {
  refreshClaudeUsage,
  resetUsageRefreshStateForTests,
  USAGE_ENDPOINT_URL,
  type RefreshDeps,
} from '../../providers/computeUsageRefresh';

const NOW = new Date('2026-11-13T12:00:00Z');
const MIN = 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

/** The usage endpoint's live refusal of a setup-token (2026-11-13). */
const SCOPE_REFUSAL_BODY = JSON.stringify({
  type: 'error',
  error: {
    type: 'permission_error',
    message: 'OAuth token does not meet scope requirement user:profile',
  },
  request_id: 'req_011Cgzq5SnJ3Ft34iZvXWPeJ',
});
const epochSeconds = (date: Date) => String(Math.floor(date.getTime() / 1000));
const FIVE_HOUR_RESET = at(3 * 60 * MIN);
const SEVEN_DAY_RESET = at(4 * 24 * 60 * MIN);

/** What every subscription response (200 or 429) carries: Anthropic's unified limits. */
function unifiedHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.42',
    'anthropic-ratelimit-unified-5h-reset': epochSeconds(FIVE_HOUR_RESET),
    'anthropic-ratelimit-unified-7d-utilization': '0.18',
    'anthropic-ratelimit-unified-7d-reset': epochSeconds(SEVEN_DAY_RESET),
    ...extra,
  });
}

interface QuotaReply {
  status: number;
  headers: Headers;
  body?: string;
}

function fakeDeps(
  respond: () => Promise<Response> | Response,
  overrides: Partial<RefreshDeps> = {},
  quota: () => Promise<QuotaReply> | QuotaReply = () => ({
    status: 200,
    headers: unifiedHeaders(),
  })
): RefreshDeps & {
  calls: Array<{ url: string; init: RequestInit }>;
  quotaChecks: string[];
  stored: SubscriptionUsageReport[];
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const quotaChecks: string[] = [];
  const stored: SubscriptionUsageReport[] = [];
  return {
    calls,
    quotaChecks,
    stored,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond();
    },
    readToken: async () => ({ accessToken: 'oauth-token', profileScope: true }),
    quotaCheck: async (accessToken) => {
      quotaChecks.push(accessToken);
      return quota();
    },
    store: async (report) => {
      stored.push(report);
      return true;
    },
    now: () => NOW,
    ...overrides,
  };
}

/** The report a quota check's default unified headers produce for `integrationId`. */
function quotaReport(integrationId: string): SubscriptionUsageReport {
  return {
    integrationId,
    observedAt: NOW,
    fiveHour: { usedPct: 42, resetsAt: FIVE_HOUR_RESET },
    sevenDay: { usedPct: 18, resetsAt: SEVEN_DAY_RESET },
    source: 'response',
    status: 'allowed',
  };
}

async function testScopeRefusedAccountsUseQuotaCheck(): Promise<void> {
  const setupToken = { accessToken: 'setup-token', profileScope: false };
  resetUsageRefreshStateForTests();
  const inferenceOnly = fakeDeps(() => new Response(SCOPE_REFUSAL_BODY, { status: 403 }), {
    readToken: async () => setupToken,
  });
  assert.equal(
    await refreshClaudeUsage('row-setup', inferenceOnly),
    'stored',
    'an inference-only account must get its windows and resets'
  );
  assert.equal(inferenceOnly.calls.length, 0, 'no usage-endpoint request without user:profile');
  assert.deepEqual(inferenceOnly.quotaChecks, ['setup-token'], 'one quota check, on its token');
  assert.deepEqual(inferenceOnly.stored, [quotaReport('row-setup')]);
  assert.equal(await refreshClaudeUsage('row-setup', inferenceOnly), 'throttled');
  assert.equal(inferenceOnly.quotaChecks.length, 1, 'at most one quota check per 5 min per row');

  // A token that claims user:profile but is refused (the captured 403, or a 401).
  for (const status of [401, 403]) {
    resetUsageRefreshStateForTests();
    const refused = fakeDeps(() => new Response(SCOPE_REFUSAL_BODY, { status }));
    assert.equal(
      await refreshClaudeUsage('row-refused', refused),
      'stored',
      `${status} falls back`
    );
    assert.deepEqual(
      refused.calls.map((call) => call.url),
      [USAGE_ENDPOINT_URL]
    );
    assert.deepEqual(refused.quotaChecks, ['oauth-token']);
    assert.deepEqual(refused.stored, [quotaReport('row-refused')]);
  }

  // An exhausted account answers 429 with a rejected unified status: the spent
  // window is stored 100% used at its reset (the bar's visible "resets …").
  resetUsageRefreshStateForTests();
  const spent = fakeDeps(
    () => Response.json({}),
    { readToken: async () => setupToken },
    () => ({
      status: 429,
      headers: unifiedHeaders({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'seven_day',
        'anthropic-ratelimit-unified-7d-utilization': '1.0',
      }),
      body: '{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}',
    })
  );
  assert.equal(await refreshClaudeUsage('row-spent', spent), 'stored');
  assert.deepEqual(spent.stored[0].sevenDay, { usedPct: 100, resetsAt: SEVEN_DAY_RESET });
  assert.equal(spent.stored[0].source, 'rate_limit');
  assert.equal(spent.stored[0].status, 'rejected');

  // The quota check itself refused (a dead token): unavailable, nothing stored,
  // backed off 60 min. The refresher never marks the account.
  for (const status of [401, 403]) {
    resetUsageRefreshStateForTests();
    const dead = fakeDeps(
      () => Response.json({}),
      { readToken: async () => setupToken },
      () => ({
        status,
        headers: new Headers(),
        body: '{"type":"error","error":{"type":"authentication_error","message":"invalid"}}',
      })
    );
    assert.equal(await refreshClaudeUsage('row-dead', dead), 'unavailable');
    assert.equal(dead.stored.length, 0);
    assert.equal(
      await refreshClaudeUsage('row-dead', { ...dead, now: () => at(10 * MIN) }),
      'throttled'
    );
    assert.equal(
      await refreshClaudeUsage('row-dead', { ...dead, now: () => at(61 * MIN) }),
      'unavailable'
    );
    assert.equal(dead.quotaChecks.length, 2);
  }

  // A response without unified headers says nothing: empty, never zero usage.
  resetUsageRefreshStateForTests();
  const silent = fakeDeps(
    () => Response.json({}),
    { readToken: async () => setupToken },
    () => ({ status: 200, headers: new Headers() })
  );
  assert.equal(await refreshClaudeUsage('row-silent', silent), 'empty');
  assert.equal(silent.stored.length, 0);

  // A failed request is retried after the 5 min interval, not the 60 min backoff.
  resetUsageRefreshStateForTests();
  const offline = fakeDeps(
    () => Response.json({}),
    { readToken: async () => setupToken },
    () => Promise.reject(new Error('connect timeout'))
  );
  assert.equal(await refreshClaudeUsage('row-offline', offline), 'error');
  assert.equal(
    await refreshClaudeUsage('row-offline', { ...offline, now: () => at(6 * MIN) }),
    'error'
  );
  assert.equal(offline.quotaChecks.length, 2);
  resetUsageRefreshStateForTests();
}

testScopeRefusedAccountsUseQuotaCheck()
  .then(() => {
    process.stdout.write('PASS compute usage quota check: inference-only and refused tokens\n');
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
