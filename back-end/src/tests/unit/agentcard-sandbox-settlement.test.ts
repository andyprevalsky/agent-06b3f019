#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { assertV2SandboxSettlementContract } from '../blackbox/test-payment-v2-lifecycle.cases';
import {
  AgentCardSandboxSettlementError,
  settleAgentCardSandboxPayment,
} from '../../providers/agentcard/sandbox-settlement';
import { AgentCardProviderError } from '../../providers/card-provider';
import { ADMIN_USER_IDS } from '../../utils/adminAccess';

const ADMIN_USER_ID = [...ADMIN_USER_IDS][0];

async function main(): Promise<void> {
  await assertV2SandboxSettlementContract();
  const charges: Array<Record<string, unknown>> = [];
  const claims: string[] = [];
  const cleared: string[] = [];
  const result = await settleAgentCardSandboxPayment(
    {
      cardNumber: '4242424242420640',
      amountCents: 4396,
      merchant: 'Rose Labs Test Payment',
    },
    {
      findHeldPurchasesByTotal: async () => [
        {
          id: 'wrong-purchase',
          userId: 'user-1',
          agentId: null,
          cardId: 'wrong-card',
          stripePaymentIntentId: 'pi_wrong',
        },
        {
          id: 'purchase-1',
          userId: 'user-1',
          agentId: null,
          cardId: 'card-1',
          stripePaymentIntentId: 'pi_hold_1',
        },
      ],
      getCardPan: async (_userId, _agentId, cardId) =>
        cardId === 'card-1' ? '4242 4242 4242 0640' : '4242 4242 4242 9999',
      claimHeldPurchaseForCharge: async (purchaseId) => {
        claims.push(purchaseId);
        return true;
      },
      testCharge: async (input) => {
        charges.push(input);
        return {};
      },
      markPurchaseCleared: async (purchaseId) => {
        cleared.push(purchaseId);
      },
    }
  );

  assert.deepEqual(result, {
    purchaseId: 'purchase-1',
    cardId: 'card-1',
    stripePaymentIntentId: 'pi_hold_1',
  });
  // The non-matching candidate is never claimed nor charged.
  assert.deepEqual(claims, ['purchase-1']);
  assert.deepEqual(charges, [
    {
      cardId: 'card-1',
      amountCents: 4396,
      merchant: 'Rose Labs Test Payment',
    },
  ]);
  assert.deepEqual(cleared, ['purchase-1']);

  // A purchase that loses the atomic claim (already reserved by a concurrent settlement) is skipped
  // and never charged. When nothing is CLEARED yet, settlement must 404 — not fall through to the
  // real Prisma CLEARED lookup (which under parallel coverage can see another suite's purchases).
  const skippedCharges: Array<Record<string, unknown>> = [];
  await assert.rejects(
    () =>
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420640',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          findHeldPurchasesByTotal: async () => [
            {
              id: 'purchase-race',
              userId: 'user-1',
              agentId: null,
              cardId: 'card-race',
              stripePaymentIntentId: 'pi_hold_race',
            },
          ],
          findClearedPurchasesByTotal: async () => [],
          getCardPan: async () => '4242424242420640',
          claimHeldPurchaseForCharge: async () => false,
          testCharge: async (input) => {
            skippedCharges.push(input);
            return {};
          },
        }
      ),
    (error: unknown) => error instanceof AgentCardSandboxSettlementError && error.statusCode === 404
  );
  assert.deepEqual(skippedCharges, [], 'a lost claim must not issue a charge');

  // A NON-admin purchase without a Stripe hold is genuinely corrupt (the user path always
  // authorizes the hold before minting), so it must fail before any charge is issued.
  const noHoldCharges: Array<Record<string, unknown>> = [];
  await assert.rejects(
    () =>
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420640',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          findHeldPurchasesByTotal: async () => [
            {
              id: 'purchase-no-hold',
              userId: 'user-1',
              agentId: null,
              cardId: 'card-no-hold',
              stripePaymentIntentId: null,
            },
          ],
          getCardPan: async () => '4242424242420640',
          claimHeldPurchaseForCharge: async () => true,
          testCharge: async (input) => {
            noHoldCharges.push(input);
            return {};
          },
        }
      ),
    (error: unknown) => error instanceof AgentCardSandboxSettlementError && error.statusCode === 502
  );
  assert.deepEqual(noHoldCharges, [], 'a missing Stripe hold must fail before charging');

  // REGRESSION (2026-07-28): an ADMIN purchase is company-funded — `issueAdminCompanyCard` mints the
  // card straight off the AgentCard org transfer and deliberately never authorizes a Stripe hold. Its
  // HELD purchase therefore has `stripePaymentIntentId: null` BY DESIGN. Rejecting it as a missing
  // hold made every admin checkout return 502 forever, which is what stalled the four
  // agent-payment-* benchmarks at their 900s cap (45/45 `POST /api/test-payment/confirm -> 502`).
  const adminCharges: Array<Record<string, unknown>> = [];
  const adminCleared: string[] = [];
  const adminResult = await settleAgentCardSandboxPayment(
    {
      cardNumber: '4242424242420640',
      amountCents: 4396,
      merchant: 'Rose Labs Test Payment',
    },
    {
      findHeldPurchasesByTotal: async () => [
        {
          id: 'purchase-admin',
          userId: ADMIN_USER_ID,
          agentId: 'agent-1',
          cardId: 'card-admin',
          stripePaymentIntentId: null,
        },
      ],
      getCardPan: async () => '4242424242420640',
      claimHeldPurchaseForCharge: async () => true,
      testCharge: async (input) => {
        adminCharges.push(input);
        return {};
      },
      markPurchaseCleared: async (purchaseId) => {
        adminCleared.push(purchaseId);
      },
    }
  );
  assert.deepEqual(adminResult, {
    purchaseId: 'purchase-admin',
    cardId: 'card-admin',
    stripePaymentIntentId: null,
  });
  assert.deepEqual(adminCharges, [
    {
      cardId: 'card-admin',
      amountCents: 4396,
      merchant: 'Rose Labs Test Payment',
    },
  ]);
  assert.deepEqual(adminCleared, ['purchase-admin']);

  await assert.rejects(
    () =>
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420640',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          findHeldPurchasesByTotal: async () => [],
          findClearedPurchasesByTotal: async () => [],
        }
      ),
    (error: unknown) => error instanceof AgentCardSandboxSettlementError && error.statusCode === 404
  );

  // REGRESSION (gate-subscription-card-mint-admin-bypass): after the first confirm CLEARs the
  // purchase, a browser agent that loses the confirmation UI and re-clicks Pay must replay the
  // settled result — never 404 into confirmTestPayment's raw-PAN Stripe fallthrough (PCI 500).
  {
    const replayCharges: Array<Record<string, unknown>> = [];
    const replay = await settleAgentCardSandboxPayment(
      {
        cardNumber: '4242424242424412',
        amountCents: 4396,
        merchant: 'Rose Labs Test Payment',
      },
      {
        findHeldPurchasesByTotal: async () => [],
        findClearedPurchasesByTotal: async () => [
          {
            id: 'purchase-already-cleared',
            userId: ADMIN_USER_ID,
            agentId: 'agent-replay',
            cardId: 'card-4412',
            stripePaymentIntentId: null,
          },
        ],
        getCardPan: async () => '4242424242424412',
        claimHeldPurchaseForCharge: async () => {
          throw new Error('CLEARED replay must not claim');
        },
        testCharge: async (input) => {
          replayCharges.push(input);
          return {};
        },
        markPurchaseCleared: async () => {
          throw new Error('CLEARED replay must not clear again');
        },
      }
    );
    assert.deepEqual(replay, {
      purchaseId: 'purchase-already-cleared',
      cardId: 'card-4412',
      stripePaymentIntentId: null,
    });
    assert.deepEqual(replayCharges, [], 'CLEARED replay must not re-charge');
  }

  // Lost HELD claim that a concurrent settler already CLEARED must still replay, not 404.
  {
    const concurrentReplay = await settleAgentCardSandboxPayment(
      {
        cardNumber: '4242424242420640',
        amountCents: 4396,
        merchant: 'Rose Labs Test Payment',
      },
      {
        findHeldPurchasesByTotal: async () => [
          {
            id: 'purchase-race-cleared',
            userId: 'user-1',
            agentId: null,
            cardId: 'card-race-cleared',
            stripePaymentIntentId: 'pi_hold_race_cleared',
          },
        ],
        findClearedPurchasesByTotal: async () => [
          {
            id: 'purchase-race-cleared',
            userId: 'user-1',
            agentId: null,
            cardId: 'card-race-cleared',
            stripePaymentIntentId: 'pi_hold_race_cleared',
          },
        ],
        getCardPan: async () => '4242424242420640',
        claimHeldPurchaseForCharge: async () => false,
        testCharge: async () => {
          throw new Error('lost claim must not charge');
        },
      }
    );
    assert.deepEqual(concurrentReplay, {
      purchaseId: 'purchase-race-cleared',
      cardId: 'card-race-cleared',
      stripePaymentIntentId: 'pi_hold_race_cleared',
    });
  }

  await assert.rejects(
    () =>
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420640',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          findHeldPurchasesByTotal: async () => [
            {
              id: 'purchase-2',
              userId: 'user-1',
              agentId: null,
              cardId: 'card-2',
              stripePaymentIntentId: 'pi_hold_2',
            },
          ],
          getCardPan: async () => '4242424242420640',
          claimHeldPurchaseForCharge: async () => true,
          // Injected so the release path stays in-memory; without it this unit
          // test reaches the real Prisma client.
          releaseHeldPurchaseClaim: async () => {},
          testCharge: async () => ({ isError: true, message: 'declined' }),
        }
      ),
    (error: unknown) =>
      error instanceof AgentCardSandboxSettlementError &&
      error.statusCode === 402 &&
      error.message.includes('declined')
  );

  // REGRESSION: a PAN lookup that FAILS is not evidence that the candidate is a different card.
  // The catch used to swallow every error and `continue`, so a provider/transport failure on the
  // ACTUAL Rose card made settlement report 404 -> `confirmTestPayment` treated a live Rose card as
  // an ordinary card and started the raw Stripe payment path, while the matching Rose purchase
  // stayed HELD with its wallet funding never consumed. Only an explicit card-not-found may skip.
  for (const providerFailure of [
    new Error('ECONNRESET: AgentCard MCP transport failed'),
    new AgentCardProviderError('AgentCard MCP get_card_details failed: rate limited', 429),
    new AgentCardProviderError(
      'AgentCard setup required: connect_required',
      409,
      undefined,
      'agentcard_setup_required'
    ),
  ]) {
    const unreadableCharges: Array<Record<string, unknown>> = [];
    await assert.rejects(
      () =>
        settleAgentCardSandboxPayment(
          {
            cardNumber: '4242424242420640',
            amountCents: 4396,
            merchant: 'Rose Labs Test Payment',
          },
          {
            findHeldPurchasesByTotal: async () => [
              {
                id: 'purchase-unreadable',
                userId: 'user-1',
                agentId: null,
                cardId: 'card-unreadable',
                stripePaymentIntentId: 'pi_hold_unreadable',
              },
            ],
            getCardPan: async () => {
              throw providerFailure;
            },
            claimHeldPurchaseForCharge: async () => true,
            testCharge: async (input) => {
              unreadableCharges.push(input);
              return {};
            },
          }
        ),
      (error: unknown) =>
        error instanceof AgentCardSandboxSettlementError &&
        error.statusCode === 502 &&
        // Never 404: a 404 is the caller's signal to fall through to the raw Stripe card path.
        error.statusCode !== 404,
      `an unreadable PAN (${providerFailure.message}) must not be reported as "not a Rose card"`
    );
    assert.deepEqual(unreadableCharges, [], 'an unreadable candidate must never be charged');
  }

  // ...but an EXPLICIT card-not-found still means "this stale purchase is somebody else's dead
  // card": keep scanning so an unrelated shopper's checkout is not failed by an abandoned purchase.
  const notFoundCleared: string[] = [];
  const notFoundResult = await settleAgentCardSandboxPayment(
    {
      cardNumber: '4242424242420640',
      amountCents: 4396,
      merchant: 'Rose Labs Test Payment',
    },
    {
      findHeldPurchasesByTotal: async () => [
        {
          id: 'purchase-dead-card',
          userId: 'user-1',
          agentId: null,
          cardId: 'card-dead',
          stripePaymentIntentId: 'pi_hold_dead',
        },
        {
          id: 'purchase-live',
          userId: 'user-1',
          agentId: null,
          cardId: 'card-live',
          stripePaymentIntentId: 'pi_hold_live',
        },
      ],
      getCardPan: async (_userId, _agentId, cardId) => {
        if (cardId === 'card-dead') {
          throw new AgentCardProviderError(
            'StaticRoseAgentCardProvider.getDetails received an id it does not manage (card-dead)',
            404,
            undefined,
            'static_card_id_not_managed'
          );
        }
        return '4242424242420640';
      },
      claimHeldPurchaseForCharge: async () => true,
      testCharge: async () => ({}),
      markPurchaseCleared: async (purchaseId) => {
        notFoundCleared.push(purchaseId);
      },
    }
  );
  assert.equal(notFoundResult.purchaseId, 'purchase-live');
  assert.deepEqual(notFoundCleared, ['purchase-live']);

  // REGRESSION (agent-payment-idempotent-abandonment): a closed stale HELD candidate must be
  // skipped the same way as card-not-found. AgentCard returns card_closed (no credentials) after
  // close — treating that as an unreadable-PAN 502 blocks settlement of the live OPEN card that
  // shares the same totalCents, so Pay never clears.
  const closedCleared: string[] = [];
  const closedResult = await settleAgentCardSandboxPayment(
    {
      cardNumber: '4242424242421316',
      amountCents: 4396,
      merchant: 'Rose Labs Test Payment',
    },
    {
      findHeldPurchasesByTotal: async () => [
        {
          id: 'purchase-closed-stale',
          userId: 'user-1',
          agentId: null,
          cardId: 'card-closed-stale',
          stripePaymentIntentId: 'pi_hold_closed',
        },
        {
          id: 'purchase-live-open',
          userId: 'user-1',
          agentId: null,
          cardId: 'card-live-open',
          stripePaymentIntentId: 'pi_hold_live_open',
        },
      ],
      getCardPan: async (_userId, _agentId, cardId) => {
        if (cardId === 'card-closed-stale') {
          throw new AgentCardProviderError(
            'get_card_details failed: card_closed: This card is closed and its credentials are no longer available. Issue a new card instead.',
            undefined,
            undefined,
            'card_closed'
          );
        }
        return '4242424242421316';
      },
      // Stale closed card has a DIFFERENT last4 than the typed PAN — skip and settle live.
      getPurchaseCardLast4Hint: async (purchaseId) =>
        purchaseId === 'purchase-closed-stale' ? '9999' : '1316',
      claimHeldPurchaseForCharge: async () => true,
      testCharge: async () => ({}),
      markPurchaseCleared: async (purchaseId) => {
        closedCleared.push(purchaseId);
      },
    }
  );
  assert.equal(closedResult.purchaseId, 'purchase-live-open');
  assert.deepEqual(closedCleared, ['purchase-live-open']);

  // REGRESSION (agent-payment-setup-resume 2026-09-29): when the HELD purchase's OWN card is
  // closed (shared-sandbox reclaim) and mint-time last4 matches the typed PAN, settlement must
  // 409 — not 404. A 404 lets confirmTestPayment fall through to raw-PAN Stripe tokenization,
  // which returns the PCI 500 "Sending credit card numbers directly to the Stripe API" while
  // the agent loops on Pay with a dead Rose card.
  await assert.rejects(
    () =>
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420887',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          findHeldPurchasesByTotal: async () => [
            {
              id: 'purchase-closed-own',
              userId: 'user-1',
              agentId: 'agent-1',
              cardId: 'card-closed-own',
              stripePaymentIntentId: 'pi_hold_closed_own',
            },
          ],
          findClearedPurchasesByTotal: async () => [],
          getCardPan: async () => {
            throw new AgentCardProviderError(
              'get_card_details failed: card_closed: This card is closed and its credentials are no longer available. Issue a new card instead.',
              undefined,
              undefined,
              'card_closed'
            );
          },
          getPurchaseCardLast4Hint: async () => '0887',
          claimHeldPurchaseForCharge: async () => {
            throw new Error('must not claim a closed Rose card');
          },
          testCharge: async () => {
            throw new Error('must not charge a closed Rose card');
          },
        }
      ),
    (error: unknown) =>
      error instanceof AgentCardSandboxSettlementError &&
      error.statusCode === 409 &&
      /closed/i.test(error.message)
  );

  // Closed CLEARED purchase with matching last4 still replays (Pay re-submit after close).
  const closedClearedReplay = await settleAgentCardSandboxPayment(
    {
      cardNumber: '4242424242420887',
      amountCents: 4396,
      merchant: 'Rose Labs Test Payment',
    },
    {
      findHeldPurchasesByTotal: async () => [],
      findClearedPurchasesByTotal: async () => [
        {
          id: 'purchase-cleared-closed',
          userId: 'user-1',
          agentId: 'agent-1',
          cardId: 'card-cleared-closed',
          stripePaymentIntentId: 'pi_hold_cleared_closed',
        },
      ],
      getCardPan: async () => {
        throw new AgentCardProviderError(
          'get_card_details failed: card_closed: This card is closed and its credentials are no longer available. Issue a new card instead.',
          undefined,
          undefined,
          'card_closed'
        );
      },
      getPurchaseCardLast4Hint: async () => '0887',
    }
  );
  assert.deepEqual(closedClearedReplay, {
    purchaseId: 'purchase-cleared-closed',
    cardId: 'card-cleared-closed',
    stripePaymentIntentId: 'pi_hold_cleared_closed',
  });

  // Regression: a failed charge must RELEASE the claim so a retry can settle.
  //
  // `claimHeldPurchaseForCharge` latches HELD -> CHARGING. Before the fix,
  // nothing put it back when the charge threw, so the purchase was stranded:
  // every retry selects on `status: HELD`, finds nothing, and 404s forever
  // while the wallet transfer stays FUNDED and the issued card goes unspent.
  // Seen live in agent-payment-setup-resume — one 500 then six consecutive
  // "No matching held AgentCard purchase was found" 404s until the 900s cap.
  {
    const released: string[] = [];
    let held = true;

    const deps = () => ({
      // Mirrors the real query: it only returns purchases still in HELD.
      findHeldPurchasesByTotal: async () =>
        held
          ? [
              {
                id: 'purchase-retry',
                userId: 'user-1',
                cardId: 'card-retry',
                stripePaymentIntentId: 'pi_hold_retry',
              },
            ]
          : [],
      getCardPan: async () => '4242424242420640',
      claimHeldPurchaseForCharge: async () => {
        held = false;
        return true;
      },
      releaseHeldPurchaseClaim: async (purchaseId: string) => {
        released.push(purchaseId);
        held = true;
      },
      markPurchaseCleared: async () => {},
    });

    // First attempt: the charge throws (the observed 500).
    await assert.rejects(
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420640',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          ...deps(),
          testCharge: async () => {
            throw new Error('sandbox charge exploded');
          },
        }
      )
    );
    assert.deepEqual(released, ['purchase-retry'], 'failed charge must release the claim');

    // Second attempt on the same purchase must now find and settle it.
    const retry = await settleAgentCardSandboxPayment(
      {
        cardNumber: '4242424242420640',
        amountCents: 4396,
        merchant: 'Rose Labs Test Payment',
      },
      { ...deps(), testCharge: async () => ({ isError: false }) }
    );
    assert.equal(retry.purchaseId, 'purchase-retry', 'retry after a failed charge must settle');
  }

  // A declined charge (402) must release the claim too — it is equally retryable.
  {
    const released: string[] = [];
    await assert.rejects(
      settleAgentCardSandboxPayment(
        {
          cardNumber: '4242424242420640',
          amountCents: 4396,
          merchant: 'Rose Labs Test Payment',
        },
        {
          findHeldPurchasesByTotal: async () => [
            {
              id: 'purchase-declined',
              userId: 'user-1',
              cardId: 'card-declined',
              stripePaymentIntentId: 'pi_hold_declined',
            },
          ],
          getCardPan: async () => '4242424242420640',
          claimHeldPurchaseForCharge: async () => true,
          releaseHeldPurchaseClaim: async (purchaseId: string) => {
            released.push(purchaseId);
          },
          testCharge: async () => ({ isError: true, message: 'declined' }),
        }
      ),
      (error: unknown) =>
        error instanceof AgentCardSandboxSettlementError && error.statusCode === 402
    );
    assert.deepEqual(released, ['purchase-declined'], 'declined charge must release the claim');
  }

  process.stdout.write('AgentCard sandbox settlement tests passed\n');
}

void main();
