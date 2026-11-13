#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
  orgRetryDeadlineAtMs,
} from '../../providers/agentcard/org-runtime';
import { AgentCardCompanyWalletFundingProvider } from '../../providers/wallet-funding';

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
 * Regression: the org runtime's rate-limit delay budget bounds ONE `callTool`. The release observer
 * LOOPS over `callTool`, so a per-call budget multiplied — each of its 6 production observations
 * could add its own 30s budget (180s total) on top of the poll's own ~57s schedule, turning a ~1
 * minute reclaim into a multi-minute request that overruns the caller's timeout. The observer now
 * takes ONE deadline before the loop and threads it through every read.
 *
 * `delayMs: 0` zeroes the poll's own schedule so the measured elapsed time IS the throttle delay
 * the runtime added; the observation count is unchanged (`attempts` production observations).
 */
async function assertReleaseObserverSharesOneRetryBudget(): Promise<void> {
  const originalEnv = Object.fromEntries(
    ORG_RUNTIME_ENV_NAMES.map((name) => [name, process.env[name]])
  );
  try {
    for (const name of ORG_RUNTIME_ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'direct-org-token';

    await onVirtualClock(async (elapsedMs) => {
      const budgetMs = orgRetryDeadlineAtMs() - Date.now();
      // A throttle that never clears: every attempt is refused with a reset 13.8s out (the reset
      // measured in production).
      const runtime = new AgentCardOrgRuntime(async () => {
        throw new Error(throttleBody(Date.now() + 13_800));
      });
      const provider = new AgentCardCompanyWalletFundingProvider(
        (name, args, deadlineAtMs) => runtime.callTool(name, args, deadlineAtMs),
        { attempts: 20, delayMs: 0 }
      );

      await assert.rejects(
        () =>
          provider.reclaimUserWalletFunding({
            userId: 'user-123',
            purchaseId: 'purchase-throttled',
            amountCents: 100,
            currency: 'usd',
            idempotencyKey: 'purchase-wallet-reclaim:purchase-throttled',
            providerTransferId: 'owt-throttled',
            reason: 'agent_cleanup_unspent_card',
          }),
        (error: unknown) =>
          error instanceof Error && /release is still pending/i.test(error.message),
        'a sustained throttle must still end as release-pending, not as an opaque failure'
      );

      assert.ok(
        elapsedMs() > 0,
        'the throttle must actually have been waited on, or this measures nothing'
      );
      assert.ok(
        elapsedMs() <= budgetMs,
        `a looping caller must never accumulate more than one retry budget: the release ` +
          `observer added ${elapsedMs()}ms of throttle delay against a ${budgetMs}ms budget`
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

/**
 * Regression (smoke payment cleanup TimeoutError, 2026-11-12, PRs #1975/#1981): AgentCard's
 * intermittent org-token 401 outlived the runtime's read auth-flap window during a stalled
 * transfer's release observation. The observer rethrew it as an opaque failure, so
 * `reclaimPurchaseWalletFunding` persisted the still-pending reclaim as RECLAIM_FAILED. The
 * stalled RECLAIMING lease must instead stay release-pending: provider backpressure (the same
 * typed 401/503/429 set the benchmark float treats as transient) says nothing about this transfer.
 */
async function assertOrgAuthFlapLeavesReleasePending(): Promise<void> {
  const unauthorized = () =>
    new AgentCardOrgRuntimeError(
      'AgentCard Organization MCP list_transfers failed: Invalid or expired organization token',
      401,
      'agentcard_org_mcp_unauthorized'
    );
  const consumed = {
    structuredContent: {
      transfers: [{ id: 'owt-flap', status: 'consumed', amount_cents: 4396, released_cents: 0 }],
    },
  };
  const request = {
    userId: 'user-123',
    purchaseId: 'purchase-flap',
    amountCents: 4396,
    currency: 'usd',
    idempotencyKey: 'purchase-wallet-reclaim:purchase-flap',
    providerTransferId: 'owt-flap',
    reason: 'failed_company_transfer_release_retry',
  };
  const releasePending = (error: unknown) =>
    error instanceof Error && /release is still pending/i.test(error.message);

  // The flap interleaves with successful observations of the unreleased transfer.
  let flapReads = 0;
  const flapping = new AgentCardCompanyWalletFundingProvider(
    async () => {
      flapReads += 1;
      if (flapReads % 2 === 1) throw unauthorized();
      return consumed;
    },
    // The production schedule scaled to 1/600 (as above): 6 observations either way.
    { attempts: 20, delayMs: 5 }
  );
  await assert.rejects(
    () => flapping.reclaimUserWalletFunding(request),
    releasePending,
    'an org auth flap during a stalled release must leave the reclaim release-pending'
  );
  assert.equal(flapReads, 6, 'the flap must not shorten or lengthen the observation window');

  // A flap that covers the whole window observes nothing, which is still not a failed reclaim.
  for (const transient of [
    unauthorized,
    () =>
      new AgentCardOrgRuntimeError(
        'AgentCard Organization MCP list_transfers is temporarily unavailable',
        503,
        'agentcard_org_mcp_unavailable'
      ),
  ]) {
    const unobserved = new AgentCardCompanyWalletFundingProvider(
      async () => {
        throw transient();
      },
      { attempts: 20, delayMs: 0 }
    );
    await assert.rejects(() => unobserved.reclaimUserWalletFunding(request), releasePending);
  }

  // A release seen after the flap still completes the reclaim.
  let recoveredReads = 0;
  const recovering = new AgentCardCompanyWalletFundingProvider(
    async () => {
      recoveredReads += 1;
      if (recoveredReads === 1) throw unauthorized();
      return {
        structuredContent: {
          transfers: [
            { id: 'owt-flap', status: 'reclaimed', amount_cents: 4396, released_cents: 4396 },
          ],
        },
      };
    },
    { attempts: 20, delayMs: 0 }
  );
  const released = await recovering.reclaimUserWalletFunding(request);
  assert.equal(released.metadata?.status, 'release_confirmed');

  // Strictness is unchanged for anything that is not provider backpressure.
  for (const fatal of [
    new AgentCardOrgRuntimeError('forbidden', 403, 'agentcard_org_mcp_unauthorized'),
    new AgentCardOrgRuntimeError('bad request', 400, 'agentcard_org_mcp_unavailable'),
    new Error('AgentCard Organization MCP list_transfers failed: transfer lookup rejected'),
  ]) {
    const strict = new AgentCardCompanyWalletFundingProvider(
      async () => {
        throw fatal;
      },
      { attempts: 20, delayMs: 0 }
    );
    await assert.rejects(
      () => strict.reclaimUserWalletFunding(request),
      (error: unknown) => error === fatal,
      `${fatal.message} must still fail the reclaim`
    );
  }
}

async function main(): Promise<void> {
  // A closed unspent card can leave its own fully funded company transfer consumed until
  // recover_funds pulls the cardholder's released residual. The observer must accelerate that
  // transition, while still requiring THIS transfer's terminal state before reporting success.
  let recovered = false;
  const recoveryCalls: string[] = [];
  const recoveryProvider = new AgentCardCompanyWalletFundingProvider(
    async (name, args) => {
      recoveryCalls.push(name);
      if (name === 'recover_funds') {
        assert.deepEqual(args, { cardholder_id: 'cardholder-own' });
        recovered = true;
        return { structuredContent: { status: 'completed', amount_cents: 4396 } };
      }
      assert.equal(name, 'list_transfers');
      return {
        structuredContent: {
          transfers: [
            {
              id: 'owt-own',
              card_id: 'card-own',
              amount_cents: 4396,
              transferred_cents: 4396,
              released_cents: recovered ? 4396 : 0,
              status: recovered ? 'reclaimed' : 'consumed',
            },
          ],
        },
      };
    },
    { attempts: 4, delayMs: 0 },
    async () => 'cardholder-own'
  );
  const recoveredResult = await recoveryProvider.reclaimUserWalletFunding({
    userId: 'user-own',
    purchaseId: 'purchase-own',
    amountCents: 4396,
    currency: 'usd',
    idempotencyKey: 'purchase-wallet-reclaim:purchase-own',
    providerTransferId: 'owt-own',
    cardId: 'card-own',
    reason: 'agent_cleanup_unspent_card',
  });
  assert.deepEqual(recoveryCalls, ['list_transfers', 'recover_funds', 'list_transfers']);
  assert.equal(recoveredResult.metadata?.status, 'release_confirmed');

  let foreignRecoveryCalls = 0;
  const foreignRecoveryProvider = new AgentCardCompanyWalletFundingProvider(
    async (name) => {
      if (name === 'recover_funds') {
        foreignRecoveryCalls += 1;
        return { structuredContent: { status: 'completed', amount_cents: 8792 } };
      }
      return {
        structuredContent: {
          transfers: [
            {
              id: 'owt-own',
              card_id: 'card-own',
              amount_cents: 4396,
              transferred_cents: 4396,
              released_cents: 0,
              status: 'consumed',
            },
          ],
        },
      };
    },
    { attempts: 4, delayMs: 0 },
    async () => 'cardholder-own'
  );
  await assert.rejects(
    () =>
      foreignRecoveryProvider.reclaimUserWalletFunding({
        userId: 'user-own',
        purchaseId: 'purchase-own',
        amountCents: 4396,
        currency: 'usd',
        idempotencyKey: 'purchase-wallet-reclaim:purchase-own',
        providerTransferId: 'owt-own',
        cardId: 'card-own',
        reason: 'agent_cleanup_unspent_card',
      }),
    (error: unknown) => error instanceof Error && /release is still pending/.test(error.message),
    'a foreign residual recovery cannot substitute for this transfer release'
  );
  assert.ok(foreignRecoveryCalls > 0);

  let wrongCardRecoveryCalls = 0;
  const wrongCardProvider = new AgentCardCompanyWalletFundingProvider(
    async (name) => {
      if (name === 'recover_funds') {
        wrongCardRecoveryCalls += 1;
        return { structuredContent: { status: 'completed', amount_cents: 4396 } };
      }
      return {
        structuredContent: {
          transfers: [
            {
              id: 'owt-own',
              card_id: 'card-foreign',
              amount_cents: 4396,
              transferred_cents: 4396,
              released_cents: 0,
              status: 'consumed',
            },
          ],
        },
      };
    },
    { attempts: 2, delayMs: 0 },
    async () => 'cardholder-own'
  );
  await assert.rejects(
    () =>
      wrongCardProvider.reclaimUserWalletFunding({
        userId: 'user-own',
        purchaseId: 'purchase-own',
        amountCents: 4396,
        currency: 'usd',
        idempotencyKey: 'purchase-wallet-reclaim:purchase-own',
        providerTransferId: 'owt-own',
        cardId: 'card-own',
        reason: 'agent_cleanup_unspent_card',
      }),
    /release is still pending/
  );
  assert.equal(wrongCardRecoveryCalls, 0, 'foreign card must never trigger a residual sweep');

  let reads = 0;
  const calls: string[] = [];
  const provider = new AgentCardCompanyWalletFundingProvider(
    async (name, args) => {
      calls.push(name);
      assert.equal(name, 'list_transfers');
      assert.deepEqual(args, { limit: 100 });
      reads += 1;
      return {
        structuredContent: {
          transfers: [
            {
              id: 'owt-123',
              status: reads >= 3 ? 'reclaimed' : 'consumed',
              amount_cents: 4396,
              transferred_cents: 4396,
              released_cents: reads >= 3 ? 4396 : 0,
            },
          ],
        },
      };
    },
    { attempts: 4, delayMs: 0 }
  );

  const result = await provider.reclaimUserWalletFunding({
    userId: 'user-123',
    agentId: 'agent-123',
    purchaseId: 'purchase-123',
    amountCents: 4396,
    currency: 'usd',
    idempotencyKey: 'purchase-wallet-reclaim:purchase-123',
    providerTransferId: 'owt-123',
    cardId: 'card-123',
    reason: 'agent_cleanup_unspent_card',
  });

  assert.equal(reads, 3, 'provider must wait for MCP transfer release');
  assert.deepEqual(calls, ['list_transfers', 'list_transfers', 'list_transfers']);
  assert.equal(result.providerTransferId, 'owt-123');
  assert.equal(result.metadata?.status, 'release_confirmed');

  let rateLimitedCalls = 0;
  const rateLimitedProvider = new AgentCardCompanyWalletFundingProvider(
    async (name) => {
      assert.equal(name, 'list_transfers');
      rateLimitedCalls += 1;
      if (rateLimitedCalls === 1) throw new Error('429 Too many requests, please try again later');
      return {
        structuredContent: {
          transfers: [
            {
              id: 'owt-rate-limited',
              status: 'released',
              amount_cents: 100,
              released_cents: 100,
            },
          ],
        },
      };
    },
    { attempts: 3, delayMs: 0 }
  );
  const rateLimitedResult = await rateLimitedProvider.reclaimUserWalletFunding({
    userId: 'user-123',
    purchaseId: 'purchase-rate-limited',
    amountCents: 100,
    currency: 'usd',
    idempotencyKey: 'purchase-wallet-reclaim:purchase-rate-limited',
    providerTransferId: 'owt-rate-limited',
    reason: 'agent_cleanup_unspent_card',
  });
  assert.equal(rateLimitedCalls, 2);
  assert.equal(rateLimitedResult.metadata?.status, 'release_confirmed');

  // Regression: the release observer used to poll `list_transfers` on a FIXED interval for the
  // whole observation window (production: 20 requests, one every 3s). AgentCard throttles the
  // organization MCP org-wide at 120 requests/minute shared by EVERY caller, so one reclaim spent a
  // sixth of the window and starved card issuance, the cron reconciler and the lifecycle read —
  // surfacing as `agentcard_org_mcp_rate_limited`. Exponential backoff observes for exactly as long
  // while issuing far fewer requests.
  //
  // Scaled to 1/600 of production (delayMs 5 stands in for 3000) so the assertions run fast; the
  // schedule is a pure function of `delayMs`, so the request count is identical at either scale.
  const scaledDelayMs = 5;
  const productionAttempts = 20;
  const fixedCadenceTotalWaitMs = (productionAttempts - 1) * scaledDelayMs;
  let pendingObservations = 0;
  const pendingProvider = new AgentCardCompanyWalletFundingProvider(
    async (name) => {
      assert.equal(name, 'list_transfers');
      pendingObservations += 1;
      return {
        structuredContent: {
          transfers: [
            { id: 'owt-pending', status: 'consumed', amount_cents: 100, released_cents: 0 },
          ],
        },
      };
    },
    { attempts: productionAttempts, delayMs: scaledDelayMs }
  );
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      pendingProvider.reclaimUserWalletFunding({
        userId: 'user-123',
        purchaseId: 'purchase-pending',
        amountCents: 100,
        currency: 'usd',
        idempotencyKey: 'purchase-wallet-reclaim:purchase-pending',
        providerTransferId: 'owt-pending',
        reason: 'agent_cleanup_unspent_card',
      }),
    (error: unknown) => error instanceof Error && /release is still pending/i.test(error.message),
    'a transfer that never releases must still end as release-pending, not as success'
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(
    pendingObservations,
    6,
    `a full release observation window must cost 6 organization-MCP requests, not ${pendingObservations}`
  );
  // The deadline was NOT shortened to buy the request saving: the observer still spends the whole
  // fixed-cadence wait budget before giving up.
  assert.ok(
    elapsedMs >= fixedCadenceTotalWaitMs,
    `observation window shrank: waited ${elapsedMs}ms, expected at least ${fixedCadenceTotalWaitMs}ms`
  );

  await assertReleaseObserverSharesOneRetryBudget();
  await assertOrgAuthFlapLeavesReleasePending();

  process.stdout.write('AgentCard wallet funding release tests passed\n');
}

void main();
