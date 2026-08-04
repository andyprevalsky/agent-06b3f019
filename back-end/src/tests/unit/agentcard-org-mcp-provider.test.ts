#!/usr/bin/env tsx

import assert from 'node:assert';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
  orgRetryDeadlineAtMs,
} from '../../providers/agentcard/org-runtime';
import {
  AgentCardOrgMcpProvider,
  AgentCardRoutingProvider,
  type CardProvider,
} from '../../providers/card-provider';

type ToolCall = { name: string; args: Record<string, unknown> };

const ORG_RUNTIME_ENV_NAMES = [
  'AGENTCARD_ORG_MCP_ACCESS_TOKEN',
  'AGENTCARD_ORG_OAUTH_CLIENT_ID',
  'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
] as const;

type TimeoutFn = typeof globalThis.setTimeout;

/**
 * Runs `run` on a virtual clock: `Date.now()` advances by exactly the milliseconds code asks
 * `setTimeout` to sleep, and every timer fires immediately.
 *
 * That makes a retry schedule that would take minutes of wall clock measurable in milliseconds,
 * and makes the measurement exact rather than machine-load dependent.
 */
async function onVirtualClock<T>(run: (elapsedMs: () => number) => Promise<T>): Promise<T> {
  const realDateNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const startedAtMs = 1_700_000_000_000;
  let nowMs = startedAtMs;
  Date.now = () => nowMs;
  const virtualSetTimeout = (
    handler: (...args: unknown[]) => void,
    timeoutMs?: number,
    ...args: unknown[]
  ): ReturnType<TimeoutFn> => {
    if (typeof timeoutMs === 'number' && timeoutMs > 0) nowMs += timeoutMs;
    return realSetTimeout(handler, 0, ...args);
  };
  globalThis.setTimeout = virtualSetTimeout as unknown as TimeoutFn;
  try {
    return await run(() => nowMs - startedAtMs);
  } finally {
    Date.now = realDateNow;
    globalThis.setTimeout = realSetTimeout;
  }
}

/** The AgentCard throttle body, verbatim, carrying an ABSOLUTE epoch-ms window reset. */
function throttleBody(windowResetAtMs: number): string {
  return (
    'Streamable HTTP error: Error POSTing to endpoint: {"error":"Rate limit exceeded",' +
    `"message":"Too many requests. Limit: 120 requests per minute.","retryAfter":${windowResetAtMs}}`
  );
}

/**
 * Regression: the org runtime's rate-limit delay budget bounds ONE `callTool`. The transfer
 * visibility poll LOOPS over `callTool` at TWO reads per observation, so a per-call budget
 * multiplied — its 12 production reads could each add their own 30s budget (360s), turning a ~10s
 * poll into a multi-minute mint that overruns the upstream request/activity timeout. The poll now
 * takes ONE deadline before the loop and threads it through every read, and surrenders with the
 * runtime's typed 429 once that single budget is spent.
 *
 * `delayMs: 0` zeroes the poll's own schedule so the measured elapsed time IS the throttle delay
 * the runtime added; the observation count is unchanged.
 */
async function assertTransferVisibilityPollSharesOneRetryBudget(): Promise<void> {
  const originalEnv = Object.fromEntries(
    ORG_RUNTIME_ENV_NAMES.map((name) => [name, process.env[name]])
  );
  try {
    for (const name of ORG_RUNTIME_ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'direct-org-token';

    await onVirtualClock(async (elapsedMs) => {
      const budgetMs = orgRetryDeadlineAtMs() - Date.now();
      // A window that re-throttles as soon as it refills: every `list_transfers` read is refused
      // with the reset measured in production (13.8s out) and succeeds on the retry after it. That
      // is the shape that multiplies — each call individually stays inside a 30s budget.
      let windowResetAtMs = 0;
      const runtime = new AgentCardOrgRuntime(async (_token, toolName) => {
        if (toolName === 'create_card') {
          return toolResult({ status: 'created', card_id: 'card-throttled' });
        }
        if (toolName === 'get_card_details') {
          return toolResult({
            pan: '4242424242424242',
            cvv: '123',
            expiry: '07/28',
            balance_cents: 4396,
            status: 'OPEN',
          });
        }
        if (Date.now() < windowResetAtMs) throw new Error(throttleBody(windowResetAtMs));
        windowResetAtMs = Date.now() + 13_800;
        return toolResult({ transfers: [] });
      });
      const provider = new AgentCardOrgMcpProvider(
        'cardholder-123',
        (name, args, deadlineAtMs) => runtime.callTool(name, args, deadlineAtMs),
        { attempts: 20, delayMs: 0 }
      );

      let mintError: unknown;
      try {
        await provider.mintCard({
          amountCents: 4396,
          fundsSource: 'company_flow',
          idempotencyKey: 'purchase:throttled-visibility',
        });
      } catch (error) {
        mintError = error;
      }

      assert.ok(
        elapsedMs() > 0,
        'the throttle must actually have been waited on, or this measures nothing'
      );
      assert.ok(
        elapsedMs() <= budgetMs,
        `a looping caller must never accumulate more than one retry budget: the transfer ` +
          `visibility poll added ${elapsedMs()}ms of throttle delay against a ${budgetMs}ms budget`
      );
      assert.ok(
        mintError instanceof AgentCardOrgRuntimeError &&
          mintError.code === 'agentcard_org_mcp_rate_limited',
        'a spent budget must surrender the poll with the runtime typed 429, not grind on'
      );
    });
  } finally {
    for (const name of ORG_RUNTIME_ENV_NAMES) {
      const value = originalEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function toolResult(payload: Record<string, unknown>): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function fakePersonalProvider(onMint: () => never): CardProvider {
  return {
    mintCard: async () => onMint(),
    getDetails: async () => {
      throw new Error('unexpected personal getDetails');
    },
    closeCard: async () => {
      throw new Error('unexpected personal closeCard');
    },
  };
}

async function main(): Promise<void> {
  const calls: ToolCall[] = [];
  const provider = new AgentCardOrgMcpProvider('cardholder-123', async (name, args) => {
    calls.push({ name, args });
    if (name === 'create_card') {
      return toolResult({
        card_id: 'card-123',
        transfer_id: 'owt-123',
        status: 'OPEN',
        amount_cents: 4396,
      });
    }
    if (name === 'get_card_details') {
      return toolResult({
        pan: '4242424242424242',
        cvv: '123',
        expiry: '12/30',
        balance_cents: 4396,
        status: 'OPEN',
      });
    }
    if (name === 'close_card') return toolResult({ status: 'closed' });
    throw new Error(`unexpected tool ${name}`);
  });

  const minted = await provider.mintCard({
    amountCents: 4396,
    fundsSource: 'company_flow',
    idempotencyKey: 'purchase:purchase-123',
  });
  const details = await provider.getDetails(minted.cardId);
  await provider.closeCard(minted.cardId);

  assert.deepStrictEqual(calls, [
    {
      name: 'create_card',
      args: {
        cardholder_id: 'cardholder-123',
        amount_cents: 4396,
        funds_source: 'company_flow',
        idempotency_key: 'purchase:purchase-123',
      },
    },
    { name: 'get_card_details', args: { card_id: 'card-123' } },
    { name: 'get_card_details', args: { card_id: 'card-123' } },
    { name: 'close_card', args: { card_id: 'card-123' } },
  ]);
  assert.strictEqual(minted.providerTransferId, 'owt-123');
  assert.strictEqual(minted.last4, '4242');
  assert.strictEqual(details.balanceCents, 4396);

  const instantCalls: ToolCall[] = [];
  let transferLookups = 0;
  const instantFundingProvider = new AgentCardOrgMcpProvider(
    'cardholder-123',
    async (name, args) => {
      instantCalls.push({ name, args });
      if (name === 'create_card') {
        return toolResult({
          status: 'created',
          cardId: 'card-instant',
          last4: '8633',
          funding: {
            id: 'funding-is-not-a-transfer',
          },
        });
      }
      if (name === 'get_card_details') {
        return toolResult({
          pan: '4242424242428633',
          cvv: '933',
          expiry: '07/28',
          balanceCents: 4396,
          status: 'OPEN',
        });
      }
      if (name === 'list_transfers') {
        transferLookups += 1;
        if (transferLookups < 3) {
          return toolResult({ transfers: [] });
        }
        return toolResult({
          transfers: [
            {
              id: 'owt-instant',
              card_id: 'card-instant',
              amount_cents: 4396,
              status: 'consumed',
            },
          ],
        });
      }
      throw new Error(`unexpected instant-funding tool ${name}`);
    }
  );
  const instantMinted = await instantFundingProvider.mintCard({
    amountCents: 4396,
    fundsSource: 'company_flow',
    idempotencyKey: 'purchase:instant',
  });
  assert.strictEqual(instantMinted.providerTransferId, 'owt-instant');
  assert.deepStrictEqual(
    instantCalls.map((call) => call.name),
    ['create_card', 'get_card_details', 'list_transfers', 'list_transfers', 'list_transfers']
  );
  assert.deepStrictEqual(
    instantCalls.slice(2).map((call) => call.args),
    [{ status: 'consumed', limit: 100 }, { limit: 100 }, { status: 'consumed', limit: 100 }]
  );

  const delayedReplayCalls: ToolCall[] = [];
  let replayCount = 0;
  const delayedReplayProvider = new AgentCardOrgMcpProvider(
    'cardholder-123',
    async (name, args) => {
      delayedReplayCalls.push({ name, args });
      if (name === 'create_card') {
        replayCount += 1;
        return toolResult({
          status: 'created',
          card_id: 'card-delayed-replay',
          ...(replayCount > 1 ? { transfer_id: 'owt-delayed-replay' } : {}),
        });
      }
      if (name === 'get_card_details') {
        return toolResult({
          pan: '4242424242429911',
          cvv: '911',
          expiry: '07/28',
          balance_cents: 4396,
          status: 'OPEN',
        });
      }
      if (name === 'list_transfers') return toolResult({ transfers: [] });
      if (name === 'close_card') throw new Error('a transfer visibility delay must not close card');
      throw new Error(`unexpected delayed-replay tool ${name}`);
    },
    { attempts: 1, delayMs: 0 }
  );
  await assert.rejects(
    () =>
      delayedReplayProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:delayed-replay',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress' &&
      'details' in error &&
      error.details.cardId === 'card-delayed-replay'
  );
  const delayedReplayMint = await delayedReplayProvider.mintCard({
    amountCents: 4396,
    fundsSource: 'company_flow',
    idempotencyKey: 'purchase:delayed-replay',
  });
  assert.strictEqual(delayedReplayMint.cardId, 'card-delayed-replay');
  assert.strictEqual(delayedReplayMint.providerTransferId, 'owt-delayed-replay');
  assert.strictEqual(
    delayedReplayCalls.filter((call) => call.name === 'close_card').length,
    0,
    'the first transferless response must leave the exact-key replay card live'
  );

  let orgMintCalls = 0;
  const routing = new AgentCardRoutingProvider('rose-user-123', {
    resolveOrgCardholderId: async () => 'cardholder-123',
    startOrgOnboarding: async () => {
      throw new Error('mapped user must not start onboarding');
    },
    createOrgProvider: () => ({
      mintCard: async (request) => {
        orgMintCalls += 1;
        return provider.mintCard(request);
      },
      getDetails: (cardId) => provider.getDetails(cardId),
      closeCard: (cardId) => provider.closeCard(cardId),
    }),
    createUserProvider: () =>
      fakePersonalProvider(() => {
        throw new Error('company flow must not use personal OAuth');
      }),
  });

  await routing.mintCard({
    amountCents: 4396,
    fundsSource: 'company_flow',
    idempotencyKey: 'purchase:routed',
  });
  assert.strictEqual(orgMintCalls, 1);

  const unmapped = new AgentCardRoutingProvider('rose-user-unmapped', {
    resolveOrgCardholderId: async () => undefined,
    startOrgOnboarding: async () => ({
      sessionId: 'cos-123',
      setupUrl: 'https://agentcard.test/onboarding/cos-123',
    }),
    createOrgProvider: () => provider,
    createUserProvider: () =>
      fakePersonalProvider(() => {
        throw new Error('company flow must not fall back to personal OAuth');
      }),
  });
  await assert.rejects(
    () =>
      unmapped.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:unmapped',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_setup_required' &&
      'details' in error &&
      error.details.agentcardStatus === 'cardholder_onboarding_required' &&
      error.details.setupSessionId === 'cos-123'
  );

  // An omitted fundsSource defaults to company_flow, so it must still require an idempotency key
  // (retries otherwise mint duplicate cards + transfers).
  const defaultingProvider = new AgentCardOrgMcpProvider('cardholder-123', async () => {
    throw new Error('create_card must not be called without an idempotency key');
  });
  await assert.rejects(
    () => defaultingProvider.mintCard({ amountCents: 4396 }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('idempotencyKey is required')
  );

  const fundingGateProvider = new AgentCardOrgMcpProvider('cardholder-123', async (name) => {
    if (name === 'create_card') {
      return toolResult({
        status: 'funding_in_progress',
        provider_transfer_id: 'owt-provider-snake',
        retry_after_seconds: 3,
      });
    }
    throw new Error(`unexpected funding-gate tool ${name}`);
  });
  await assert.rejects(
    () =>
      fundingGateProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:funding-gate',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress' &&
      'details' in error &&
      error.details.transferId === 'owt-provider-snake' &&
      error.details.retryAfterSeconds === 3
  );

  const nestedFundingGateProvider = new AgentCardOrgMcpProvider('cardholder-123', async (name) => {
    if (name === 'create_card') {
      return toolResult({
        status: 'funding_in_progress',
        funding: {
          transfer: {
            id: 'owt-nested-transfer',
          },
        },
        retryAfterSeconds: 4,
      });
    }
    throw new Error(`unexpected nested funding-gate tool ${name}`);
  });
  await assert.rejects(
    () =>
      nestedFundingGateProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:nested-funding-gate',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress' &&
      'details' in error &&
      error.details.transferId === 'owt-nested-transfer' &&
      error.details.retryAfterSeconds === 4
  );

  const transferlessFundingGateProvider = new AgentCardOrgMcpProvider(
    'cardholder-123',
    async (name) => {
      if (name === 'create_card') {
        return toolResult({
          status: 'funding_in_progress',
          message: 'Company funding is still settling',
          retryAfterSeconds: 5,
        });
      }
      throw new Error(`unexpected transferless funding-gate tool ${name}`);
    }
  );
  await assert.rejects(
    () =>
      transferlessFundingGateProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:transferless-funding-gate',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress' &&
      'details' in error &&
      error.details.transferId === undefined &&
      error.details.retryAfterSeconds === 5
  );

  const textFundingGateProvider = new AgentCardOrgMcpProvider('cardholder-123', async (name) => {
    if (name === 'create_card') {
      return {
        content: [
          {
            type: 'text',
            text: 'status: funding_in_progress\nCompany Transfer ID: owt-text-transfer',
          },
        ],
      };
    }
    throw new Error(`unexpected text funding-gate tool ${name}`);
  });
  await assert.rejects(
    () =>
      textFundingGateProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:text-funding-gate',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress' &&
      'details' in error &&
      error.details.transferId === 'owt-text-transfer'
  );

  // An MCP error with no textual content must still surface the fallback message rather than an
  // empty string.
  const emptyErrorProvider = new AgentCardOrgMcpProvider('cardholder-123', async (name) => {
    if (name === 'create_card') {
      return { isError: true, structuredContent: {}, content: [] };
    }
    throw new Error(`unexpected tool ${name}`);
  });
  await assert.rejects(
    () =>
      emptyErrorProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:empty-error',
      }),
    (error: unknown) =>
      error instanceof Error && error.message === 'AgentCard Organization MCP failed'
  );

  const proseKycCalls: string[] = [];
  const proseKycProvider = new AgentCardOrgMcpProvider('cardholder-123', async (name) => {
    proseKycCalls.push(name);
    if (name === 'create_card') {
      return {
        isError: true,
        structuredContent: {
          status: 'error',
          message: 'upstream failed after create; kyc_required was mentioned in diagnostics',
        },
      };
    }
    throw new Error(`unexpected prose-KYC tool ${name}`);
  });
  await assert.rejects(
    () =>
      proseKycProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:prose-kyc',
      }),
    (error: unknown) =>
      error instanceof Error && !('code' in error && error.code === 'agentcard_kyc_required')
  );
  assert.deepStrictEqual(proseKycCalls, ['create_card']);

  // Regression: the transfer-visibility poll ran on a FIXED interval and issues TWO reads per
  // attempt, so a single mint spent 40 requests of AgentCard's org-wide 120-requests-per-minute
  // window in ten seconds — throttling the reclaim/lifecycle callers that share it. Exponential
  // backoff waits for the same total time on far fewer requests.
  // Scaled to 1/100 of production (delayMs 5 stands in for 500) so the assertion runs fast; the
  // request count is a pure function of the schedule shape, so it is identical at either scale.
  const invisibleTransferAttempts = 20;
  const invisibleTransferScaledDelayMs = 5;
  const invisibleTransferTotalWaitMs =
    (invisibleTransferAttempts - 1) * invisibleTransferScaledDelayMs;
  let invisibleTransferLookups = 0;
  const invisibleTransferProvider = new AgentCardOrgMcpProvider(
    'cardholder-123',
    async (name) => {
      if (name === 'create_card') return toolResult({ status: 'created', card_id: 'card-invis' });
      if (name === 'get_card_details') {
        return toolResult({
          pan: '4242424242424242',
          cvv: '123',
          expiry: '07/28',
          balance_cents: 4396,
          status: 'OPEN',
        });
      }
      if (name === 'list_transfers') {
        invisibleTransferLookups += 1;
        return toolResult({ transfers: [] });
      }
      throw new Error(`unexpected invisible-transfer tool ${name}`);
    },
    { attempts: invisibleTransferAttempts, delayMs: invisibleTransferScaledDelayMs }
  );
  const invisibleTransferStartedAt = Date.now();
  await assert.rejects(
    () =>
      invisibleTransferProvider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:invisible-transfer',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'agentcard_company_funding_in_progress'
  );
  assert.strictEqual(
    invisibleTransferLookups,
    12,
    `a full transfer-visibility wait must cost 12 organization-MCP requests, not ${invisibleTransferLookups}`
  );
  // The visibility deadline was NOT shortened to buy the request saving.
  assert.ok(
    Date.now() - invisibleTransferStartedAt >= invisibleTransferTotalWaitMs,
    'the transfer-visibility window must not shrink'
  );

  await assertTransferVisibilityPollSharesOneRetryBudget();

  process.stdout.write('AgentCard organization MCP provider tests passed\n');
}

void main();
