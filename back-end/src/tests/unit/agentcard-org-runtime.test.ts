#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { AGENTCARD_MCP_RESOURCE } from '../../providers/agentcard/config';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
} from '../../providers/agentcard/org-runtime';

const ENV_NAMES = [
  'AGENTCARD_ORG_MCP_ACCESS_TOKEN',
  'AGENTCARD_API_KEY',
  'AGENTCARD_ADMIN_MCP_ACCESS_TOKEN',
  'AGENTCARD_ORG_OAUTH_CLIENT_ID',
  'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
  'AGENTCARD_OAUTH_CLIENT_ID',
  'AGENTCARD_OAUTH_CLIENT_SECRET',
] as const;

async function main(): Promise<void> {
  const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'wizard-client';
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = 'wizard-secret';

    let tokenRequests = 0;
    let calledWithToken = '';
    const runtime = new AgentCardOrgRuntime(
      async (accessToken, toolName, args) => {
        calledWithToken = accessToken;
        assert.equal(toolName, 'list_transfers');
        assert.deepEqual(args, { limit: 100 });
        return { structuredContent: { transfers: [] } };
      },
      async (_input, init) => {
        tokenRequests += 1;
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get('grant_type'), 'client_credentials');
        assert.equal(form.get('client_id'), 'wizard-client');
        assert.equal(form.get('client_secret'), 'wizard-secret');
        assert.equal(form.get('resource'), AGENTCARD_MCP_RESOURCE);
        return new Response(JSON.stringify({ access_token: 'fresh-org-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    );

    await runtime.callTool('list_transfers', { limit: 100 });
    await runtime.callTool('list_transfers', { limit: 100 });
    assert.equal(calledWithToken, 'fresh-org-token');
    assert.equal(tokenRequests, 1, 'client-credential tokens should be cached until near expiry');

    let concurrentTokenRequests = 0;
    let releaseTokenRequest: (() => void) | undefined;
    const tokenRequestReleased = new Promise<void>((resolve) => {
      releaseTokenRequest = resolve;
    });
    const concurrentRuntime = new AgentCardOrgRuntime(
      async () => ({ structuredContent: { transfers: [] } }),
      async () => {
        concurrentTokenRequests += 1;
        await tokenRequestReleased;
        return new Response(
          JSON.stringify({ access_token: 'shared-org-token', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    );
    const concurrentCalls = Promise.all([
      concurrentRuntime.callTool('get_card', { card_id: 'card-1' }),
      concurrentRuntime.callTool('list_transfers', { status: 'consumed', limit: 100 }),
      concurrentRuntime.callTool('list_transfers', { limit: 100 }),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      concurrentTokenRequests,
      1,
      'concurrent org reads must share one client-credential token exchange'
    );
    releaseTokenRequest?.();
    await concurrentCalls;
    assert.equal(concurrentTokenRequests, 1);

    let retryTokenRequests = 0;
    let toolCalls = 0;
    const retryingRuntime = new AgentCardOrgRuntime(
      async (accessToken) => {
        toolCalls += 1;
        if (toolCalls === 1) throw new Error('Invalid or expired organization token');
        assert.equal(accessToken, 'org-token-2');
        return { structuredContent: { transfers: [] } };
      },
      async () => {
        retryTokenRequests += 1;
        return new Response(
          JSON.stringify({ access_token: `org-token-${retryTokenRequests}`, expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    );
    await retryingRuntime.callTool('list_transfers', { limit: 100 });
    assert.equal(retryTokenRequests, 2, 'an MCP auth rejection must refresh once');
    assert.equal(toolCalls, 2, 'an MCP auth rejection must retry the tool once');

    const originalDateNow = Date.now;
    let nowMs = 1_700_000_000_000;
    let proactiveTokenRequests = 0;
    const proactiveToolTokens: string[] = [];
    try {
      Date.now = () => nowMs;
      const proactiveRuntime = new AgentCardOrgRuntime(
        async (accessToken) => {
          proactiveToolTokens.push(accessToken);
          return { structuredContent: { transfers: [] } };
        },
        async () => {
          proactiveTokenRequests += 1;
          if (proactiveTokenRequests === 1) {
            return new Response(
              JSON.stringify({ access_token: 'still-valid-org-token', expires_in: 120 }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response(JSON.stringify({ error: 'Backend init failed' }), { status: 500 });
        }
      );

      await proactiveRuntime.callTool('list_transfers', { limit: 100 });
      nowMs += 61_000;
      await proactiveRuntime.callTool('list_transfers', { limit: 100 });
      assert.equal(proactiveTokenRequests, 2, 'the refresh window should trigger a token exchange');
      assert.deepEqual(
        proactiveToolTokens,
        ['still-valid-org-token', 'still-valid-org-token'],
        'a transient proactive-refresh failure should reuse the unexpired token'
      );
    } finally {
      Date.now = originalDateNow;
    }

    // A stalled/aborted token endpoint surfaces as an AgentCardOrgRuntimeError, not a raw hang.
    const timingOutRuntime = new AgentCardOrgRuntime(
      async () => {
        throw new Error('tool must not run when the token cannot be acquired');
      },
      async () => {
        const timeout = new Error('The operation was aborted due to timeout');
        timeout.name = 'TimeoutError';
        throw timeout;
      }
    );
    await assert.rejects(
      () => timingOutRuntime.callTool('list_transfers', { limit: 100 }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 504 &&
        error.code === 'agentcard_org_token_unavailable'
    );

    for (const name of ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_API_KEY = 'sk_test_retired';
    const retiredKeyRuntime = new AgentCardOrgRuntime(async () => {
      throw new Error('retired API key must never reach the Organization MCP transport');
    });
    await assert.rejects(
      () => retiredKeyRuntime.callTool('get_company_wallet', {}),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 409 &&
        error.details.missingEnv === 'AGENTCARD_ORG_OAUTH_CLIENT_ID'
    );

    for (const name of ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'sk_test_retired';
    const retiredDirectTokenRuntime = new AgentCardOrgRuntime(async () => {
      throw new Error('retired direct token must never reach the Organization MCP transport');
    });
    await assert.rejects(
      () => retiredDirectTokenRuntime.callTool('get_company_wallet', {}),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 409 &&
        error.details.missingEnv === 'AGENTCARD_ORG_OAUTH_CLIENT_ID'
    );

    // Regression: AgentCard throttles the organization MCP org-wide (observed: 120 req/min, shared
    // by card issuance, the wallet-reclaim poll loop, the minute cron and the payment-lifecycle
    // fan-out). The throttle arrives as a raw transport error, so `callTool` used to propagate it
    // untouched and `POST /api/test-payment/lifecycle/abandon` collapsed it into an opaque 500 —
    // failing `agent-payment-abandonment` on every concurrent run of the AgentCard gate even though
    // the throttle window refilled seconds later.
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'direct-org-token';

    const throttleBody = (retryAfterMs: number): string =>
      `Streamable HTTP error: Error POSTing to endpoint: {"error":"Rate limit exceeded","message":"Too many requests. Limit: 120 requests per minute.","retryAfter":${retryAfterMs}}`;

    let throttledCalls = 0;
    const throttledRuntime = new AgentCardOrgRuntime(async (_token, toolName) => {
      assert.equal(toolName, 'get_card');
      throttledCalls += 1;
      if (throttledCalls === 1) throw new Error(throttleBody(Date.now() + 50));
      return { structuredContent: { card: { status: 'CLOSED', balanceCents: 0 } } };
    });
    assert.deepEqual(
      await throttledRuntime.callTool('get_card', { card_id: 'card_1' }),
      { structuredContent: { card: { status: 'CLOSED', balanceCents: 0 } } },
      'a throttled org tool call must be retried once the window refills, not surfaced as a failure'
    );
    assert.equal(throttledCalls, 2);

    // A throttle that never clears stays bounded and surfaces as a typed 429 rather than an opaque
    // transport error, so callers can distinguish provider backpressure from a Rose defect.
    let exhaustedCalls = 0;
    const exhaustedRuntime = new AgentCardOrgRuntime(async () => {
      exhaustedCalls += 1;
      throw new Error(throttleBody(Date.now() + 50));
    });
    await assert.rejects(
      () => exhaustedRuntime.callTool('list_transfers', { limit: 100 }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 429 &&
        error.code === 'agentcard_org_mcp_rate_limited' &&
        error.details.tool === 'list_transfers' &&
        // The wallet-funding release observer detects provider throttling by message text, so an
        // exhausted throttle must stay recognisable to it.
        /too many requests|rate.?limit|\b429\b/i.test(error.message)
    );
    assert.equal(exhaustedCalls, 3, 'rate-limit retries must stay bounded');

    // A window reset further out than the delay budget must fail fast rather than parking the
    // request: nested callers (the 20-attempt release observer) would otherwise multiply the wait.
    let unbudgetedCalls = 0;
    const unbudgetedRuntime = new AgentCardOrgRuntime(async () => {
      unbudgetedCalls += 1;
      throw new Error(throttleBody(Date.now() + 60_000));
    });
    const unbudgetedStartedAt = Date.now();
    await assert.rejects(
      () => unbudgetedRuntime.callTool('list_cards', { limit: 100 }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError && error.code === 'agentcard_org_mcp_rate_limited'
    );
    assert.equal(unbudgetedCalls, 1, 'a reset beyond the delay budget must not be waited out');
    assert.ok(
      Date.now() - unbudgetedStartedAt < 5_000,
      'exceeding the delay budget must fail fast, not sleep'
    );

    // Non-throttle failures must never be retried — retrying a real error would multiply load.
    let hardFailureCalls = 0;
    const hardFailureRuntime = new AgentCardOrgRuntime(async () => {
      hardFailureCalls += 1;
      throw new Error('card_closed: This card is closed and its credentials are unavailable');
    });
    await assert.rejects(
      () => hardFailureRuntime.callTool('get_card_details', { card_id: 'card_1' }),
      /card_closed/
    );
    assert.equal(hardFailureCalls, 1);

    process.stdout.write('AgentCard org runtime tests passed\n');
  } finally {
    for (const name of ENV_NAMES) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

void main();
