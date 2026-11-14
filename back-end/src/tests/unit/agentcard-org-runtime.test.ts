#!/usr/bin/env tsx
import assert from 'node:assert/strict';
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

/** Budget-bounded retry tests advance this instead of waiting out the backoff in real time. */
function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let nowMs = 1_800_000_000_000;
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
  };
}

/** Keep retry schedules independent of wall-clock time and host scheduling. */
function createRuntime(
  ...args: ConstructorParameters<typeof AgentCardOrgRuntime>
): AgentCardOrgRuntime {
  return new AgentCardOrgRuntime(args[0], args[1], args[2] ?? virtualClock());
}

async function main(): Promise<void> {
  const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'wizard-client';
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = 'wizard-secret';

    let calledWithToken = '';
    const runtime = createRuntime(async (accessToken, toolName, args) => {
      calledWithToken = accessToken;
      assert.equal(toolName, 'list_transfers');
      assert.deepEqual(args, { limit: 100 });
      return { structuredContent: { transfers: [] } };
    });

    await runtime.callTool('list_transfers', { limit: 100 });
    await runtime.callTool('list_transfers', { limit: 100 });
    assert.equal(
      calledWithToken,
      'wizard-secret',
      'organization MCP must send the acs_ client secret as Bearer, not a token-endpoint JWT'
    );

    let jsonRpcCalls = 0;
    const jsonRpcRuntime = createRuntime(undefined, async (_input, init) => {
      jsonRpcCalls += 1;
      const parsed = JSON.parse(String(init?.body)) as {
        method?: string;
        params?: { name?: string };
      };
      assert.equal(parsed.method, 'tools/call');
      assert.equal(parsed.params?.name, 'get_company_wallet');
      const headerBag = init?.headers as Record<string, string> | undefined;
      assert.equal(headerBag?.authorization, 'Bearer wizard-secret');
      return new Response(
        'event: message\ndata: {"result":{"structuredContent":{"wallet":{"livemode":false,"balance_cents":100,"committed_cents":0,"available_cents":100}}}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    });
    const wallet = await jsonRpcRuntime.callTool('get_company_wallet', {});
    assert.deepEqual(wallet, {
      structuredContent: {
        wallet: { livemode: false, balance_cents: 100, committed_cents: 0, available_cents: 100 },
      },
    });
    assert.equal(jsonRpcCalls, 1);

    let handshakeCalls = 0;
    const handshakeRuntime = createRuntime(undefined, async () => {
      handshakeCalls += 1;
      return new Response(
        'event: endpoint\ndata: /mcp?session=abc\n\n' +
          'event: message\ndata: {"result":{"structuredContent":{"cardholders":[{"id":"ch-1"}]}}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    });
    assert.deepEqual(await handshakeRuntime.callTool('list_cardholders', {}), {
      structuredContent: { cardholders: [{ id: 'ch-1' }] },
    });
    assert.equal(
      handshakeCalls,
      1,
      'a Streamable HTTP endpoint event must not be parsed as the tool result'
    );

    const rpcErrorRuntime = createRuntime(undefined, async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'no cardholders' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    await assert.rejects(
      () => rpcErrorRuntime.callTool('list_cardholders', {}),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError && /no cardholders/.test(error.message)
    );

    let authRetries = 0;
    const authRetryRuntime = createRuntime(undefined, async () => {
      authRetries += 1;
      if (authRetries < 2) {
        return new Response(JSON.stringify({ error: 'Invalid or expired organization token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          result: { structuredContent: { cardholders: [{ id: 'ch-1' }] } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    assert.deepEqual(await authRetryRuntime.callTool('list_cardholders', {}), {
      structuredContent: { cardholders: [{ id: 'ch-1' }] },
    });
    assert.equal(authRetries, 2, 'flaky MCP 401 on tools/call must be retried');

    let toolCalls = 0;
    const retryingRuntime = createRuntime(async (accessToken) => {
      toolCalls += 1;
      if (toolCalls === 1) throw new Error('Invalid or expired organization token');
      assert.equal(accessToken, 'wizard-secret');
      return { structuredContent: { transfers: [] } };
    });
    await retryingRuntime.callTool('list_transfers', { limit: 100 });
    assert.equal(toolCalls, 2, 'an MCP auth rejection must retry the tool once');

    for (const name of ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_API_KEY = 'sk_test_retired';
    const retiredKeyRuntime = createRuntime(async () => {
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
    const retiredDirectTokenRuntime = createRuntime(async () => {
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
    const throttledRuntime = createRuntime(async (_token, toolName) => {
      assert.equal(toolName, 'get_card');
      throttledCalls += 1;
      if (throttledCalls === 1) throw new Error(throttleBody(1_800_000_000_000 + 50));
      return { structuredContent: { card: { status: 'CLOSED', balanceCents: 0 } } };
    });
    assert.deepEqual(
      await throttledRuntime.callTool('get_card', { card_id: 'card_1' }),
      { structuredContent: { card: { status: 'CLOSED', balanceCents: 0 } } },
      'a throttled org tool call must be retried once the window refills, not surfaced as a failure'
    );
    assert.equal(throttledCalls, 2);

    // The sandbox also returns HTTP 200 with a structured rate-limit error. A close_card response
    // in this shape previously escaped as a successful tool call, then treasury-rails failed even
    // though the provider would accept the close on the next window.
    let structuredThrottleCalls = 0;
    const structuredThrottleRuntime = createRuntime(async () => {
      structuredThrottleCalls += 1;
      if (structuredThrottleCalls === 1) {
        return {
          structuredContent: {
            status: 'error',
            message: 'close_card failed: API key rate limit exceeded, please try again later',
          },
        };
      }
      return { structuredContent: { status: 'CLOSED' } };
    });
    assert.deepEqual(
      await structuredThrottleRuntime.callTool('close_card', { card_id: 'card_1' }),
      { structuredContent: { status: 'CLOSED' } }
    );
    assert.equal(structuredThrottleCalls, 2, 'a structured MCP throttle must be retried');

    // A throttle that never clears stays bounded and surfaces as a typed 429 rather than an opaque
    // transport error, so callers can distinguish provider backpressure from a Rose defect.
    let exhaustedCalls = 0;
    const exhaustedRuntime = createRuntime(async () => {
      exhaustedCalls += 1;
      throw new Error(throttleBody(1_800_000_000_000 + 50));
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
    assert.equal(exhaustedCalls, 5, 'rate-limit retries on a read must stay bounded');

    // A window reset further out than the delay budget must fail fast rather than parking the
    // request: nested callers (the 20-attempt release observer) would otherwise multiply the wait.
    let unbudgetedCalls = 0;
    const unbudgetedClock = virtualClock();
    const unbudgetedRuntime = createRuntime(
      async () => {
        unbudgetedCalls += 1;
        throw new Error(throttleBody(1_800_000_000_000 + 60_000));
      },
      undefined,
      unbudgetedClock
    );
    const unbudgetedStartedAt = unbudgetedClock.now();
    await assert.rejects(
      () => unbudgetedRuntime.callTool('list_cards', { limit: 100 }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError && error.code === 'agentcard_org_mcp_rate_limited'
    );
    assert.equal(unbudgetedCalls, 1, 'a reset beyond the delay budget must not be waited out');
    assert.ok(
      unbudgetedClock.now() - unbudgetedStartedAt === 0,
      'exceeding the delay budget must fail fast, not sleep'
    );

    // Sandbox `get_company_wallet` can return HTTP 200 with
    // `{status:"error", message:"…Service temporarily unavailable"}`. That is a
    // provider outage, not a successful wallet read, so retry it the same way
    // as a throttle rather than handing callers an empty wallet object.
    let unavailableCalls = 0;
    const unavailableRuntime = createRuntime(async (_token, toolName) => {
      assert.equal(toolName, 'get_company_wallet');
      unavailableCalls += 1;
      if (unavailableCalls === 1) {
        return {
          structuredContent: {
            status: 'error',
            message: 'get_company_wallet failed: Service temporarily unavailable',
          },
        };
      }
      return {
        structuredContent: {
          wallet: { livemode: false, balance_cents: 100, committed_cents: 0, available_cents: 100 },
        },
      };
    });
    assert.deepEqual(await unavailableRuntime.callTool('get_company_wallet', {}), {
      structuredContent: {
        wallet: { livemode: false, balance_cents: 100, committed_cents: 0, available_cents: 100 },
      },
    });
    assert.equal(
      unavailableCalls,
      2,
      'a structured MCP 503 must be retried instead of returned as a wallet'
    );

    let stuckUnavailableCalls = 0;
    const stuckUnavailableRuntime = createRuntime(async () => {
      stuckUnavailableCalls += 1;
      return {
        structuredContent: {
          status: 'error',
          message: 'get_company_wallet failed: Service temporarily unavailable',
        },
      };
    });
    await assert.rejects(
      () => stuckUnavailableRuntime.callTool('get_company_wallet', {}),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 503 &&
        error.code === 'agentcard_org_mcp_unavailable' &&
        /temporarily unavailable/.test(error.message)
    );
    assert.equal(stuckUnavailableCalls, 3, 'transient-unavailable retries must stay bounded');

    // AgentCard also reports its upstream API-key throttle as an HTTP-200 tool error (no
    // retryAfter). On a read that is the same backpressure as a transport 429 and must ride the
    // same bounded retry instead of being handed to the caller as a successful result.
    const apiKeyThrottle = {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'get_cardholder_kyc_status failed: API key rate limit exceeded, please try again later',
        },
      ],
    };
    let toolThrottledCalls = 0;
    const toolThrottledRuntime = createRuntime(async () => {
      toolThrottledCalls += 1;
      return toolThrottledCalls === 1
        ? apiKeyThrottle
        : { structuredContent: { kyc_status: 'verified' } };
    });
    assert.deepEqual(
      await toolThrottledRuntime.callTool('get_cardholder_kyc_status', { cardholder_id: 'ch-1' }),
      { structuredContent: { kyc_status: 'verified' } }
    );
    assert.equal(toolThrottledCalls, 2, 'a tool-level throttle on a read must be retried');

    let stuckToolThrottleCalls = 0;
    const stuckToolThrottleRuntime = createRuntime(
      async () => {
        stuckToolThrottleCalls += 1;
        return apiKeyThrottle;
      },
      fetch,
      virtualClock()
    );
    await assert.rejects(
      () =>
        stuckToolThrottleRuntime.callTool('get_cardholder_kyc_status', { cardholder_id: 'ch-1' }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 429 &&
        error.code === 'agentcard_org_mcp_rate_limited' &&
        /API key rate limit exceeded/.test(error.message)
    );
    assert.equal(stuckToolThrottleCalls, 5, 'tool-level throttle retries must stay bounded');

    // A tool-level throttle can arrive after a multi-step mutation already changed provider state,
    // so a mutation's result is handed back untouched for its caller to interpret.
    let mutationThrottleCalls = 0;
    const mutationThrottleRuntime = createRuntime(async () => {
      mutationThrottleCalls += 1;
      return apiKeyThrottle;
    });
    assert.deepEqual(
      await mutationThrottleRuntime.callTool('recover_funds', { cardholder_id: 'ch-1' }),
      apiKeyThrottle
    );
    assert.equal(mutationThrottleCalls, 1, 'a throttled mutation must never be replayed');

    // AbortSignal.timeout on tools/call throws "The operation was aborted due to timeout" before
    // any HTTP/RPC body exists. Under coverage concurrency that mid-poll stall used to escape as a
    // hard fail (treasury-rails 2026-09-12: unused-card settle died on attempt 3). It is the same
    // transient provider class as a structured 503 — retry, then surface temporarily unavailable.
    let timedOutCalls = 0;
    const timedOutThenOkRuntime = createRuntime(undefined, async () => {
      timedOutCalls += 1;
      if (timedOutCalls === 1) {
        const timeout = new Error('The operation was aborted due to timeout');
        timeout.name = 'TimeoutError';
        throw timeout;
      }
      return new Response(JSON.stringify({ result: { structuredContent: { transfers: [] } } }));
    });
    assert.deepEqual(await timedOutThenOkRuntime.callTool('list_transfers', { limit: 100 }), {
      structuredContent: { transfers: [] },
    });
    assert.equal(
      timedOutCalls,
      2,
      'an AbortSignal tools/call timeout must be retried instead of failing the caller'
    );

    let stuckTimeoutCalls = 0;
    const stuckTimeoutRuntime = createRuntime(undefined, async () => {
      stuckTimeoutCalls += 1;
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      throw timeout;
    });
    await assert.rejects(
      () => stuckTimeoutRuntime.callTool('list_transfers', { limit: 100 }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 503 &&
        error.code === 'agentcard_org_mcp_unavailable' &&
        /temporarily unavailable/.test(error.message)
    );
    assert.equal(stuckTimeoutCalls, 3, 'AbortSignal timeout retries must stay bounded');

    // undici reports a connection that never reached the provider as `TypeError: fetch failed`
    // with the cause code on `.cause` (`UND_ERR_CONNECT_TIMEOUT` after its 10 s connect timeout,
    // ECONNREFUSED, EAI_AGAIN). treasury-rails 2026-10-31: one such connect timeout on
    // `list_recoveries` after ~60 healthy calls failed the deploy gate with
    // `retryable=false` while 19.9 s of retry budget remained. It is the same transient class as
    // the AbortSignal timeout and is safe for every tool because no request was sent.
    const fetchFailed = (code: string, message = 'fetch failed'): TypeError =>
      Object.assign(new TypeError(message), { cause: Object.assign(new Error(code), { code }) });
    let connectTimeoutCalls = 0;
    const connectTimeoutThenOkRuntime = createRuntime(undefined, async () => {
      connectTimeoutCalls += 1;
      if (connectTimeoutCalls === 1) throw fetchFailed('UND_ERR_CONNECT_TIMEOUT');
      return new Response(
        JSON.stringify({ result: { structuredContent: { card: { id: 'c1' } } } })
      );
    });
    assert.deepEqual(
      await connectTimeoutThenOkRuntime.callTool('create_card', { amount_cents: 1300 }),
      { structuredContent: { card: { id: 'c1' } } }
    );
    assert.equal(
      connectTimeoutCalls,
      2,
      'a connect-phase fetch failure (request never sent) must be retried for any tool'
    );

    // A socket dropped after the request left (ECONNRESET, undici socket/headers timeouts) may
    // have reached the provider: replay only the idempotent reads, exactly like the text throttle.
    let resetReadCalls = 0;
    const resetThenOkReadRuntime = createRuntime(undefined, async () => {
      resetReadCalls += 1;
      if (resetReadCalls === 1) throw fetchFailed('ECONNRESET');
      return new Response(JSON.stringify({ result: { structuredContent: { recoveries: [] } } }));
    });
    assert.deepEqual(await resetThenOkReadRuntime.callTool('list_recoveries', { limit: 100 }), {
      structuredContent: { recoveries: [] },
    });
    assert.equal(resetReadCalls, 2, 'a reset read must be replayed within the retry budget');

    let resetMutationCalls = 0;
    const resetMutationRuntime = createRuntime(undefined, async () => {
      resetMutationCalls += 1;
      throw fetchFailed('ECONNRESET');
    });
    await assert.rejects(
      () => resetMutationRuntime.callTool('recover_funds', { cardholder_id: 'ch-1' }),
      (error: unknown) => error instanceof TypeError && error.message === 'fetch failed'
    );
    assert.equal(resetMutationCalls, 1, 'a reset mutation must never be replayed');

    let unknownCauseCalls = 0;
    const unknownCauseRuntime = createRuntime(undefined, async () => {
      unknownCauseCalls += 1;
      throw fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID');
    });
    await assert.rejects(
      () => unknownCauseRuntime.callTool('list_recoveries', { limit: 100 }),
      (error: unknown) => error instanceof TypeError && error.message === 'fetch failed'
    );
    assert.equal(unknownCauseCalls, 1, 'a fetch failure without a transient cause is a real error');

    // The socket can also die after the headers arrived: undici then rejects `response.text()`
    // with `TypeError: terminated` (cause UND_ERR_SOCKET). The request reached the provider, so
    // only the idempotent reads are replayed (CodeRabbit PR #1656 finding 4431365241).
    const terminatedBody = (): Response =>
      ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => {
          throw Object.assign(new TypeError('terminated'), {
            cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
          });
        },
      }) as unknown as Response;
    let terminatedReadCalls = 0;
    const terminatedThenOkReadRuntime = createRuntime(undefined, async () => {
      terminatedReadCalls += 1;
      if (terminatedReadCalls === 1) return terminatedBody();
      return new Response(JSON.stringify({ result: { structuredContent: { recoveries: [] } } }));
    });
    assert.deepEqual(
      await terminatedThenOkReadRuntime.callTool('list_recoveries', { limit: 100 }),
      { structuredContent: { recoveries: [] } }
    );
    assert.equal(terminatedReadCalls, 2, 'a read whose body read was terminated must be replayed');

    let terminatedMutationCalls = 0;
    const terminatedMutationRuntime = createRuntime(undefined, async () => {
      terminatedMutationCalls += 1;
      return terminatedBody();
    });
    await assert.rejects(
      () => terminatedMutationRuntime.callTool('recover_funds', { cardholder_id: 'ch-1' }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 502 &&
        /response body read failed after the request reached the provider \(UND_ERR_SOCKET\)/.test(
          error.message
        )
    );
    assert.equal(
      terminatedMutationCalls,
      1,
      'a mutation whose body read was terminated must never be replayed (headers arrived)'
    );

    // AbortSignal.timeout can also fire during the body read, after the headers arrived. The outer
    // classifier treats an AbortError as the retryable timeout class, so a mutation would be
    // replayed although the request reached the provider: the body-read catch must turn it into a
    // non-retryable error for mutations and leave reads on the retry path (CodeRabbit PR #1657).
    const abortedBody = (): Response =>
      ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => {
          const abort = new Error('The operation was aborted due to timeout');
          abort.name = 'AbortError';
          throw abort;
        },
      }) as unknown as Response;
    let abortedMutationCalls = 0;
    const abortedMutationRuntime = createRuntime(undefined, async () => {
      abortedMutationCalls += 1;
      return abortedBody();
    });
    await assert.rejects(
      () => abortedMutationRuntime.callTool('recover_funds', { cardholder_id: 'ch-1' }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 502 &&
        /response body read failed/.test(error.message)
    );
    assert.equal(
      abortedMutationCalls,
      1,
      'a mutation whose body read was aborted must never be replayed (headers arrived)'
    );

    let abortedReadCalls = 0;
    const abortedThenOkReadRuntime = createRuntime(undefined, async () => {
      abortedReadCalls += 1;
      if (abortedReadCalls === 1) return abortedBody();
      return new Response(JSON.stringify({ result: { structuredContent: { recoveries: [] } } }));
    });
    assert.deepEqual(await abortedThenOkReadRuntime.callTool('list_recoveries', { limit: 100 }), {
      structuredContent: { recoveries: [] },
    });
    assert.equal(abortedReadCalls, 2, 'an aborted read body is replayed like a timeout');

    // Non-throttle failures must never be retried — retrying a real error would multiply load.
    let hardFailureCalls = 0;
    const hardFailureRuntime = createRuntime(async () => {
      hardFailureCalls += 1;
      throw new Error('card_closed: This card is closed and its credentials are unavailable');
    });
    await assert.rejects(
      () => hardFailureRuntime.callTool('get_card_details', { card_id: 'card_1' }),
      /card_closed/
    );
    assert.equal(hardFailureCalls, 1);

    // A bare `429` inside an unrelated error is not a throttle. Provider errors routinely carry
    // arbitrary numbers (amounts in cents, record counts, id fragments); matching one relabels the
    // real failure as a rate limit, retries a request that can never succeed, and hides the cause.
    let bareNumberCalls = 0;
    const bareNumberRuntime = createRuntime(async () => {
      bareNumberCalls += 1;
      throw new Error('MCP error -32603: transfer amount 429 cents could not be settled');
    });
    await assert.rejects(
      () => bareNumberRuntime.callTool('get_card', { card_id: 'card_bare' }),
      /could not be settled/
    );
    assert.equal(bareNumberCalls, 1, 'a bare 429 in unrelated text must not be read as a throttle');

    // The measured production throttle advertised a reset 13.8s out. The budget must cover it: at
    // 10s this fell through instantly and failed the payment lifecycle on every contended run.
    let measuredWindowCalls = 0;
    const measuredClock = virtualClock();
    const measuredWindowRuntime = createRuntime(
      async () => {
        measuredWindowCalls += 1;
        if (measuredWindowCalls === 1) throw new Error(throttleBody(1_800_000_000_000 + 13_800));
        return { structuredContent: { transfers: [] } };
      },
      undefined,
      measuredClock
    );
    const measuredStartedAt = measuredClock.now();
    assert.deepEqual(await measuredWindowRuntime.callTool('list_transfers', { limit: 100 }), {
      structuredContent: { transfers: [] },
    });
    assert.equal(measuredWindowCalls, 2, 'the advertised reset must be waited out, not abandoned');
    assert.ok(
      measuredClock.now() - measuredStartedAt === 14_050,
      'the wait must clear the provider-advertised window boundary'
    );

    // An exhausted throttle must name the upstream body. Error logging prints the message and drops
    // structured details, so omitting it made every throttle unattributable.
    const opaqueRuntime = createRuntime(async () => {
      throw new Error(throttleBody(1_800_000_000_000 + 50));
    });
    await assert.rejects(
      () => opaqueRuntime.callTool('get_card', { card_id: 'card_opaque' }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        /Limit: 120 requests per minute/.test(error.message)
    );

    // The organization MCP throttle (120 requests/minute) is shared by EVERY org caller, so
    // identical idempotent reads that overlap must cost ONE request, not one per caller. Rose fans
    // these out constantly: concurrent payment-lifecycle reads issue the same `list_transfers`
    // status sweep, and the minute cron polls the same page as an in-flight wallet reclaim.
    let coalescedCalls = 0;
    let releaseCoalescedCall: (() => void) | undefined;
    const coalescedGate = new Promise<void>((resolve) => {
      releaseCoalescedCall = resolve;
    });
    const coalescingRuntime = createRuntime(async (_token, toolName) => {
      coalescedCalls += 1;
      await coalescedGate;
      return { structuredContent: { tool: toolName, transfers: [{ id: 'owt_1' }] } };
    });
    const coalesced = Promise.all([
      coalescingRuntime.callTool('list_transfers', { status: 'reclaimed', limit: 100 }),
      coalescingRuntime.callTool('list_transfers', { status: 'reclaimed', limit: 100 }),
      // Argument order must not defeat the coalescing key.
      coalescingRuntime.callTool('list_transfers', { limit: 100, status: 'reclaimed' }),
      coalescingRuntime.callTool('list_transfers', { status: 'failed', limit: 100 }),
    ]);
    releaseCoalescedCall?.();
    const coalescedResults = await coalesced;
    assert.equal(
      coalescedCalls,
      2,
      'three identical in-flight reads must share one request; a different status is its own request'
    );
    assert.deepEqual(coalescedResults[0], coalescedResults[1]);
    assert.notEqual(
      coalescedResults[0],
      coalescedResults[1],
      'joiners must get a detached copy so one caller cannot mutate another caller view'
    );

    // A completed read must not be served from the coalescing map: the next caller needs fresh
    // provider state (an abandon flow reads a card immediately after closing it).
    await coalescingRuntime.callTool('list_transfers', { status: 'reclaimed', limit: 100 });
    assert.equal(coalescedCalls, 3, 'coalescing must never outlive the in-flight request');

    // Mutations must NEVER be coalesced — each caller's side effect has to reach AgentCard.
    let mutationCalls = 0;
    let releaseMutation: (() => void) | undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutationRuntime = createRuntime(async () => {
      mutationCalls += 1;
      await mutationGate;
      return { structuredContent: { status: 'CLOSED' } };
    });
    const mutations = Promise.all([
      mutationRuntime.callTool('close_card', { card_id: 'card_1' }),
      mutationRuntime.callTool('close_card', { card_id: 'card_1' }),
    ]);
    releaseMutation?.();
    await mutations;
    assert.equal(mutationCalls, 2, 'identical mutations must not be coalesced');

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
