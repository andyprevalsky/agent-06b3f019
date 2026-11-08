#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
} from '../../providers/agentcard/org-runtime';

const CREDENTIAL_ENV = [
  'AGENTCARD_ORG_MCP_ACCESS_TOKEN',
  'AGENTCARD_API_KEY',
  'AGENTCARD_ADMIN_MCP_ACCESS_TOKEN',
  'AGENTCARD_ORG_OAUTH_CLIENT_ID',
  'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
  'AGENTCARD_OAUTH_CLIENT_ID',
  'AGENTCARD_OAUTH_CLIENT_SECRET',
] as const;

async function main(): Promise<void> {
  const original = Object.fromEntries(CREDENTIAL_ENV.map((name) => [name, process.env[name]]));
  try {
    for (const name of CREDENTIAL_ENV) delete process.env[name];
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'blackbox-client';
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = 'blackbox-secret';

    let tokenRequests = 0;
    const seenTokens: string[] = [];
    const runtime = new AgentCardOrgRuntime(
      async (accessToken) => {
        seenTokens.push(accessToken);
        return { structuredContent: { transfers: [] } };
      },
      async () => {
        tokenRequests += 1;
        throw new Error('org runtime must not exchange client credentials for a JWT');
      }
    );

    await Promise.all([
      runtime.callTool('get_card', { card_id: 'card-1' }),
      runtime.callTool('list_transfers', { status: 'consumed', limit: 100 }),
      runtime.callTool('list_transfers', { limit: 100 }),
    ]);
    assert.equal(tokenRequests, 0, 'a lifecycle fanout must not hit the OAuth token endpoint');
    assert.deepEqual(
      seenTokens,
      ['blackbox-secret', 'blackbox-secret', 'blackbox-secret'],
      'lifecycle reads must send the org client secret as Bearer'
    );

    for (const name of CREDENTIAL_ENV) delete process.env[name];
    process.env.AGENTCARD_API_KEY = 'sk_test_retired';
    process.env.AGENTCARD_OAUTH_CLIENT_ID = 'user-client';
    process.env.AGENTCARD_OAUTH_CLIENT_SECRET = 'user-secret';
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'sk_test_retired';
    const retiredCredentialsRuntime = new AgentCardOrgRuntime(async () => {
      throw new Error('retired or user-scoped credentials must not reach the org transport');
    });
    await assert.rejects(
      () => retiredCredentialsRuntime.callTool('get_company_wallet', {}),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 409 &&
        error.details.missingEnv === 'AGENTCARD_ORG_OAUTH_CLIENT_ID'
    );

    console.log('PASS AgentCard org lifecycle uses the client secret as Bearer');

    // Regression (smoke agent-payment-abandonment, PR #1777 deploy, 2026-11-08): AgentCard's
    // Organization MCP answered the static client secret with HTTP 401 "Invalid or expired
    // organization token" for ~6 s (04:23:05.7Z-04:23:10.9Z, interleaved with successes), while the
    // card mint just before and the same abandon 47 s later succeeded with the same credential.
    // The read path gave up after ~1 s, so POST /api/test-payment/lifecycle/abandon returned 401
    // `agentcard_org_mcp_unauthorized` on get_card and the deploy smoke campaign INFRA-stopped.
    for (const name of CREDENTIAL_ENV) delete process.env[name];
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'blackbox-client';
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = 'acs_blackbox-secret';
    const providerUnauthorized = (): Response =>
      new Response(JSON.stringify({ error: 'Invalid or expired organization token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const fakeClock = () => {
      let nowMs = Date.now();
      const sleeps: number[] = [];
      return {
        sleeps,
        now: () => nowMs,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      };
    };
    const toolOf = (init?: RequestInit): string =>
      (JSON.parse(String(init?.body)) as { params: { name: string } }).params.name;

    const flapClock = fakeClock();
    const flapStartedAtMs = flapClock.now();
    const flapRequests: string[] = [];
    const flapRuntime = new AgentCardOrgRuntime(
      undefined,
      async (_input, init) => {
        flapRequests.push(toolOf(init));
        if (flapClock.now() - flapStartedAtMs < 6_000) return providerUnauthorized();
        return new Response(
          JSON.stringify({
            result: { structuredContent: { card: { id: 'card-1', status: 'OPEN' } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
      flapClock
    );
    assert.deepEqual(
      await flapRuntime.callTool('get_card', { card_id: 'card-1' }),
      { structuredContent: { card: { id: 'card-1', status: 'OPEN' } } },
      'an idempotent read must ride out the observed ~6 s provider auth flap'
    );
    assert.ok(
      flapClock.now() - flapStartedAtMs <= 15_000,
      'the read auth-flap retry window must stay bounded'
    );

    const outageClock = fakeClock();
    const outageStartedAtMs = outageClock.now();
    let outageRequests = 0;
    const outageRuntime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        outageRequests += 1;
        return providerUnauthorized();
      },
      outageClock
    );
    await assert.rejects(
      () => outageRuntime.callTool('list_transfers', { limit: 100 }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 401 &&
        error.code === 'agentcard_org_mcp_unauthorized' &&
        /Invalid or expired organization token/.test(error.message),
      'a sustained auth outage must still surface as the provider 401 once the window closes'
    );
    assert.ok(
      outageClock.now() - outageStartedAtMs <= 15_000,
      'a sustained read auth outage must fail within the bounded window'
    );
    assert.equal(
      outageRequests,
      10,
      'a sustained outage adds exactly 4 single-request flap steps to the previous 6 requests'
    );

    // The flap window never shrinks the previous auth retry: with the caller's shared deadline
    // already spent, a read still gets its 6 immediate attempts, and a 403 never enters the window.
    for (const [status, deadlineAtMs] of [
      [401, Date.now()],
      [403, undefined],
    ] as const) {
      const boundedClock = fakeClock();
      let boundedRequests = 0;
      const boundedRuntime = new AgentCardOrgRuntime(
        undefined,
        async () => {
          boundedRequests += 1;
          return new Response(JSON.stringify({ error: 'Invalid or expired organization token' }), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        },
        boundedClock
      );
      await assert.rejects(
        () => boundedRuntime.callTool('get_card', { card_id: 'card-1' }, deadlineAtMs),
        (error: unknown) => error instanceof AgentCardOrgRuntimeError && error.status === status
      );
      assert.equal(boundedRequests, 6, `HTTP ${status} read must keep its 6 immediate attempts`);
      assert.deepEqual(boundedClock.sleeps, [], `HTTP ${status} read must not enter the window`);
    }

    // Mutations are never replayed by the read auth-flap window: their existing retry budget
    // (3 HTTP-401 retries x 1 client-credential retry) is unchanged and they never sleep on it.
    const mutationClock = fakeClock();
    const mutationRequests: string[] = [];
    const mutationRuntime = new AgentCardOrgRuntime(
      undefined,
      async (_input, init) => {
        mutationRequests.push(toolOf(init));
        return providerUnauthorized();
      },
      mutationClock
    );
    await assert.rejects(
      () => mutationRuntime.callTool('close_card', { card_id: 'card-1' }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError && error.code === 'agentcard_org_mcp_unauthorized'
    );
    assert.equal(mutationRequests.length, 6, 'a mutation must keep its existing auth retry count');
    assert.deepEqual(mutationClock.sleeps, [], 'a mutation must never enter the read flap window');

    console.log('PASS AgentCard org reads ride out a bounded provider auth flap');

    // Regression (smoke agent-payment-idempotent-abandonment, PR #1775 deploy, agent 2c6b3ffd,
    // 2026-11-08 02:08:26-31Z): the second browser's reuse lookup read get_card_details, received
    // two HTTP-200 throttles carrying no retryAfter, then "Invalid or expired organization token"
    // on attempt 3 with 24.3 s of budget left. The rejection was non-retryable, so
    // POST /api/purchases/lookup answered 502 and the browser task died.
    const structuredThrottle = (): Response =>
      new Response(
        JSON.stringify({
          result: {
            structuredContent: {
              status: 'error',
              message: 'get_card_details failed: Too many requests, please try again later',
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    const liveCard = { structuredContent: { card: { id: 'card-1', status: 'OPEN' } } };
    const liveCardResponse = (): Response =>
      new Response(JSON.stringify({ result: liveCard }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    // The observed sequence: the read auth-flap window rides out the rejection.
    const observedClock = fakeClock();
    let observedRequests = 0;
    const observedRuntime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        observedRequests += 1;
        if (observedRequests <= 2) return structuredThrottle();
        if (observedRequests <= 8) return providerUnauthorized();
        return liveCardResponse();
      },
      observedClock
    );
    assert.deepEqual(
      await observedRuntime.callTool('get_card_details', { card_id: 'card-1' }),
      liveCard,
      'the observed throttle-then-rejection read must recover'
    );
    assert.equal(observedRequests, 9, 'the observed read must recover on its first clear request');

    // Hypothesised continuation, not observed: the window is still throttled when the rejection
    // clears. A throttle after the rejection must keep backing off instead of ending the read.
    const continuationClock = fakeClock();
    const continuationStartedAtMs = continuationClock.now();
    let continuationRequests = 0;
    const continuationRuntime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        continuationRequests += 1;
        if (continuationRequests <= 2) return structuredThrottle();
        if (continuationRequests <= 8) return providerUnauthorized();
        if (continuationRequests <= 10) return structuredThrottle();
        return liveCardResponse();
      },
      continuationClock
    );
    assert.deepEqual(
      await continuationRuntime.callTool('get_card_details', { card_id: 'card-1' }),
      liveCard,
      'a read throttled again after the rejection must keep retrying while its budget remains'
    );
    assert.equal(continuationRequests, 11, 'the read must recover on the first clear window');
    assert.ok(
      continuationClock.now() - continuationStartedAtMs <= 30_000,
      'the read must stay inside the one 30 s rate-limit budget'
    );

    // A throttle that never clears still surrenders typed, within the budget.
    const sustainedClock = fakeClock();
    const sustainedStartedAtMs = sustainedClock.now();
    let sustainedRequests = 0;
    const sustainedRuntime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        sustainedRequests += 1;
        return structuredThrottle();
      },
      sustainedClock
    );
    await assert.rejects(
      () => sustainedRuntime.callTool('get_card_details', { card_id: 'card-1' }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 429 &&
        error.code === 'agentcard_org_mcp_rate_limited' &&
        /Too many requests/.test(error.message)
    );
    assert.equal(sustainedRequests, 5, 'a sustained read throttle must stay request-bounded');
    assert.ok(
      sustainedClock.now() - sustainedStartedAtMs <= 30_000,
      'a sustained read throttle must fail inside the 30 s budget'
    );

    // The cap follows the current failure, so a read cannot carry the throttle allowance over to a
    // 503, and an earlier 503 cannot shorten a later throttle's allowance.
    const unavailable = (): Response =>
      new Response(
        JSON.stringify({
          result: {
            structuredContent: {
              status: 'error',
              message: 'get_card_details failed: Service temporarily unavailable',
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    let throttleThenUnavailableRequests = 0;
    const throttleThenUnavailableRuntime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        throttleThenUnavailableRequests += 1;
        return throttleThenUnavailableRequests <= 3 ? structuredThrottle() : unavailable();
      },
      fakeClock()
    );
    await assert.rejects(
      () => throttleThenUnavailableRuntime.callTool('get_card_details', { card_id: 'card-1' }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 503 &&
        /after 4 attempts/.test(error.message)
    );
    assert.equal(throttleThenUnavailableRequests, 4, 'a 503 keeps the three-attempt cap');

    let unavailableThenThrottleRequests = 0;
    const unavailableThenThrottleRuntime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        unavailableThenThrottleRequests += 1;
        if (unavailableThenThrottleRequests <= 2) return unavailable();
        if (unavailableThenThrottleRequests === 3) return structuredThrottle();
        return liveCardResponse();
      },
      fakeClock()
    );
    assert.deepEqual(
      await unavailableThenThrottleRuntime.callTool('get_card_details', { card_id: 'card-1' }),
      liveCard,
      'a throttle after 503s must still get the read allowance'
    );
    assert.equal(
      unavailableThenThrottleRequests,
      4,
      'the read must recover on the first clear try'
    );

    // A mutation keeps its three attempts: it must not be replayed for the whole budget.
    const mutationThrottleClock = fakeClock();
    let mutationThrottleRequests = 0;
    const mutationThrottleRuntime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        mutationThrottleRequests += 1;
        return structuredThrottle();
      },
      mutationThrottleClock
    );
    await assert.rejects(
      () => mutationThrottleRuntime.callTool('close_card', { card_id: 'card-1' }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError && error.code === 'agentcard_org_mcp_rate_limited'
    );
    assert.equal(mutationThrottleRequests, 3, 'a mutation must keep its three throttle attempts');

    console.log('PASS AgentCard org reads keep backing off a throttle within the budget');
  } finally {
    for (const name of CREDENTIAL_ENV) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

void main();
