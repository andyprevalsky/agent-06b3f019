#!/usr/bin/env tsx
/**
 * Recovery + idempotency of the real-merchant (hosted Stripe Checkout) settlement.
 *
 * Stripe has ALREADY captured before `settleRoseCardStripeCheckout` runs, so the reconciliation
 * that follows must be retryable. The regression these tests pin: settlement used to load the
 * correlated purchase HELD-only, so the instant the HELD -> CHARGING claim landed the row stopped
 * matching its own lookup. A failed CLEARED write (pool timeout, restart, transient DB error) then
 * stranded the purchase in CHARGING and every retry of the SAME paid Checkout session 404'd —
 * money captured, purchase never cleared. The same held-only filter also 404'd a shopper who
 * simply reloaded a successful return URL.
 *
 * The fakes below emulate the real SQL semantics, not the happy path:
 *   - claim        = `updateMany where status = HELD`     -> only a HELD row can be claimed
 *   - markCleared  = `updateMany where status = CHARGING` -> only a CHARGING row can clear
 * so "settles exactly once" is enforced by the store, not by the assertion.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PurchaseSpendStatus } from '@prisma/client';
import {
  settleRoseCardStripeCheckout,
  type CheckoutHeldPurchase,
} from '../../providers/agentcard/checkout-settlement';
import { AgentCardSandboxSettlementError } from '../../providers/agentcard/sandbox-settlement';

const LAST4 = '2679';
const AMOUNT_CENTS = 4396;

interface Harness {
  row: CheckoutHeldPurchase;
  claims: string[];
  clears: string[];
  failNextClear: boolean;
  dependencies: Parameters<typeof settleRoseCardStripeCheckout>[1];
}

function harness(status: PurchaseSpendStatus = PurchaseSpendStatus.HELD): Harness {
  const state: Harness = {
    row: {
      id: 'purchase-1',
      userId: 'user-1',
      agentId: 'agent-1',
      cardId: 'card-1',
      stripePaymentIntentId: 'pi_hold_1',
      totalCents: AMOUNT_CENTS,
      status,
    },
    claims: [],
    clears: [],
    failNextClear: false,
    dependencies: {},
  };

  state.dependencies = {
    findPurchaseForCheckout: async (purchaseId) => (purchaseId === state.row.id ? state.row : null),
    getCardLast4: async () => LAST4,
    // `updateMany where status = HELD` -> a second claim can never win.
    claimHeldPurchaseForCharge: async (purchaseId) => {
      if (purchaseId !== state.row.id || state.row.status !== PurchaseSpendStatus.HELD)
        return false;
      state.row.status = PurchaseSpendStatus.CHARGING;
      state.claims.push(purchaseId);
      return true;
    },
    // `updateMany where status = CHARGING` inside a transaction -> a second clear throws.
    markPurchaseCleared: async (purchaseId) => {
      if (state.failNextClear) {
        state.failNextClear = false;
        // Exactly what a Prisma P2024 pool timeout looks like to this caller: the claim is already
        // durably CHARGING, and the CLEARED write never happened.
        throw new Error('Timed out fetching a new connection from the connection pool');
      }
      if (state.row.status !== PurchaseSpendStatus.CHARGING) {
        throw new AgentCardSandboxSettlementError(
          'AgentCard sandbox charge did not clear the purchase',
          502
        );
      }
      state.row.status = PurchaseSpendStatus.CLEARED;
      state.clears.push(purchaseId);
    },
  };

  return state;
}

function paidCheckout(overrides: Partial<Parameters<typeof settleRoseCardStripeCheckout>[0]> = {}) {
  return {
    purchaseId: 'purchase-1',
    last4: LAST4,
    amountCents: AMOUNT_CENTS,
    ...overrides,
  };
}

async function main(): Promise<void> {
  // Run the real default getter in a fresh process so the shared REST client captures
  // the intercepted fetch before import. No provider method or last4 getter is replaced.
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      String.raw`
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const path = require('node:path');
    const put = (rel, exports) => { const id = require.resolve(path.join(process.cwd(), 'src', rel)); const m = new Module(id); m.loaded = true; m.exports = exports; require.cache[id] = m; };
    require('node:net').Socket.prototype.connect = () => { throw new Error('UNEXPECTED_DATABASE_OR_NETWORK'); };
    let provenance = 'v2', legacyReads = 0, orgCardholder = 'ch-owned';
    put('providers/agentcard/store.ts', { getOrgManagedCardholderId: async () => orgCardholder, getV2ConnectedUserId: async () => 'usr-owned' });
    put('providers/database.ts', { prisma: { purchaseSpend: { findFirst: async () => ({ ...row, walletFunding: { purchaseId: row.id, userId: row.userId, amountCents: row.totalCents, currency: 'usd', metadata: provenance === 'v2' ? { apiVersion: 2 } : provenance === 'legacy' ? { funding_model: 'company_flow' } : {} } }) } } });
    put('providers/card-provider/index.ts', { createCardProviderForAgent: async () => ({ getDetails: async id => { assert.equal(id, row.cardId); legacyReads++; return { pan: '4242424242422679' }; } }) });
    const reads = [];
    let card = { object: 'card', id: 'card_closed_fixture', status: 'closed', closed_reason: 'used', last4: '2679', balance_cents: 0 };
    let cardNotFound = false;
    global.fetch = async (url, options = {}) => {
      const pathname = new URL(String(url)).pathname;
      reads.push(pathname);
      if (pathname === '/api/v2/oauth/token') return Response.json({ access_token: 'fake_org_token', expires_in: 3600 });
      assert.equal(options.method, 'GET', 'settlement must never move provider money');
      if (pathname === '/api/v2/cards/card_closed_fixture') return cardNotFound
        ? Response.json({ error: { code: 'card_not_found' } }, { status: 404 }) : Response.json(card);
      throw new Error('Unexpected network/credential access: ' + pathname);
    };
    const { settleRoseCardStripeCheckout } = require(process.argv[1]);
    const { PurchaseSpendStatus } = require('@prisma/client');
    const row = { id: 'purchase-exact', userId: 'customer-exact', agentId: 'agent-exact', cardId: 'card_closed_fixture', stripePaymentIntentId: 'pi_billing_hold', totalCents: 100, status: PurchaseSpendStatus.HELD };
    let claims = 0, clears = 0;
    const deps = {
      findPurchaseForCheckout: async id => id === row.id ? row : null,
      claimHeldPurchaseForCharge: async id => { assert.equal(id, row.id); claims++; row.status = PurchaseSpendStatus.CHARGING; return true; },
      markPurchaseCleared: async id => { assert.equal(id, row.id); clears++; row.status = PurchaseSpendStatus.CLEARED; },
    };
    const paid = { purchaseId: row.id, amountCents: 100, last4: '2679' };
    (async () => {
      const settled = await settleRoseCardStripeCheckout(paid, deps);
      assert.equal(settled.cardId, row.cardId);
      assert.equal(settled.stripePaymentIntentId, 'pi_billing_hold');
      assert.equal(claims, 1); assert.equal(clears, 1);
      await settleRoseCardStripeCheckout(paid, deps);
      assert.equal(clears, 1, 'closed-card replay must not clear twice');
      await assert.rejects(settleRoseCardStripeCheckout({ ...paid, purchaseId: 'other-purchase' }, deps), e => e.statusCode === 404);
      await assert.rejects(settleRoseCardStripeCheckout({ ...paid, amountCents: 101 }, deps), e => e.statusCode === 409);
      await assert.rejects(settleRoseCardStripeCheckout({ ...paid, last4: '9999' }, deps), e => e.statusCode === 409);
      card = { ...card, id: 'card_other' };
      await assert.rejects(settleRoseCardStripeCheckout(paid, deps), e => e.statusCode === 502);
      card = { ...card, id: row.cardId, last4: 'invalid2679' };
      await assert.rejects(settleRoseCardStripeCheckout(paid, deps), e => e.statusCode === 502);
      cardNotFound = true;
      await assert.rejects(settleRoseCardStripeCheckout(paid, deps), e => e.statusCode === 502);
      assert.equal(clears, 1, 'failed identity proofs must not clear');
      assert(!reads.some(p => p.endsWith('/credentials')), 'closed-card settlement must never request secrets');
      cardNotFound = false; provenance = 'legacy';
      const restCount = reads.length;
      await settleRoseCardStripeCheckout(paid, deps);
      assert.equal(legacyReads, 1, 'card_ legacy identity must use its existing provider');
      assert.equal(reads.length, restCount, 'legacy settlement must never request REST card identity');
      orgCardholder = undefined;
      await assert.rejects(settleRoseCardStripeCheckout(paid, deps), e => e.statusCode === 502);
      assert.equal(legacyReads, 1, 'known org card with missing org binding must not use user MCP');
      assert.equal(reads.length, restCount);
      orgCardholder = 'ch-owned';
      provenance = 'unknown';
      await assert.rejects(settleRoseCardStripeCheckout(paid, deps), e => e.statusCode === 502);
      assert.equal(reads.length, restCount, 'unknown provenance must not guess REST');
      assert.equal(legacyReads, 1, 'unknown provenance must not guess MCP');
      process.stdout.write('PASS closed v2 card settlement through real default getter and REST client\n');
    })().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
  `,
      path.resolve(__dirname, '../../providers/agentcard/checkout-settlement.ts'),
    ],
    {
      env: {
        ...process.env,
        AGENTCARD_MINT_ENABLED: 'true',
        AGENTCARD_BASE_URL: 'https://agentcard.invalid',
        AGENTCARD_ORG_OAUTH_CLIENT_ID: 'fixture_client',
        AGENTCARD_ORG_OAUTH_CLIENT_SECRET: 'fixture_secret',
      },
      stdio: 'pipe',
    }
  );
  // ── 1. Fault injection: the CLEARED write fails once, then the SAME paid Checkout is retried. ──
  {
    const state = harness();
    state.failNextClear = true;

    await assert.rejects(
      () => settleRoseCardStripeCheckout(paidCheckout(), state.dependencies),
      /connection pool/,
      'the first attempt must surface the failed CLEARED write, not swallow it'
    );
    assert.equal(
      state.row.status,
      PurchaseSpendStatus.CHARGING,
      'the failed attempt leaves the captured purchase mid-transition'
    );

    // The retry carries the same session identity: same purchase id, same captured amount, same
    // charged card. It must FINISH the transition rather than 404 on a no-longer-HELD row.
    const retried = await settleRoseCardStripeCheckout(paidCheckout(), state.dependencies);
    assert.deepEqual(retried, {
      purchaseId: 'purchase-1',
      cardId: 'card-1',
      stripePaymentIntentId: 'pi_hold_1',
    });
    assert.equal(state.row.status, PurchaseSpendStatus.CLEARED, 'no stuck CHARGING purchase');
    assert.deepEqual(state.claims, ['purchase-1'], 'the retry must not re-claim');
    assert.deepEqual(state.clears, ['purchase-1'], 'settled exactly once — no double-charge');

    // A third delivery of the same success_url replays the settled result instead of erroring.
    const replayed = await settleRoseCardStripeCheckout(paidCheckout(), state.dependencies);
    assert.deepEqual(replayed, retried);
    assert.deepEqual(state.clears, ['purchase-1'], 'a reloaded return URL must not clear twice');
  }

  // ── 2. Reloading a successful return URL on an already-CLEARED purchase is a no-op replay. ──
  {
    const state = harness(PurchaseSpendStatus.CLEARED);
    const result = await settleRoseCardStripeCheckout(paidCheckout(), state.dependencies);
    assert.equal(result.purchaseId, 'purchase-1');
    assert.deepEqual(state.clears, [], 'an already-cleared purchase must not be re-cleared');
    assert.deepEqual(state.claims, []);
  }

  // ── 3. A DIFFERENT checkout must not ride the recoverable path. ──
  // The reconciliation identity is (purchaseId, capturedAmount, chargedCardLast4) and it is
  // re-proved on EVERY call, including the CHARGING/CLEARED recovery branches.
  for (const status of [PurchaseSpendStatus.CHARGING, PurchaseSpendStatus.CLEARED]) {
    const wrongAmount = harness(status);
    await assert.rejects(
      () =>
        settleRoseCardStripeCheckout(
          paidCheckout({ amountCents: AMOUNT_CENTS + 1 }),
          wrongAmount.dependencies
        ),
      (error: unknown) =>
        error instanceof AgentCardSandboxSettlementError && error.statusCode === 409,
      `a different captured amount must not settle a ${status} purchase`
    );
    assert.deepEqual(wrongAmount.clears, [], 'amount mismatch must never clear');

    const wrongCard = harness(status);
    await assert.rejects(
      () => settleRoseCardStripeCheckout(paidCheckout({ last4: '9999' }), wrongCard.dependencies),
      (error: unknown) =>
        error instanceof AgentCardSandboxSettlementError && error.statusCode === 409,
      `a different charged card must not settle a ${status} purchase`
    );
    assert.deepEqual(wrongCard.clears, [], 'card mismatch must never clear');
  }

  // ── 4. A purchase in a non-settleable status is rejected, not silently reconciled. ──
  {
    const state = harness(PurchaseSpendStatus.VOIDED);
    await assert.rejects(
      () => settleRoseCardStripeCheckout(paidCheckout(), state.dependencies),
      (error: unknown) =>
        error instanceof AgentCardSandboxSettlementError &&
        error.statusCode === 409 &&
        error.message.includes('VOIDED'),
      'a VOIDED purchase cannot be reconciled to a paid checkout'
    );
    assert.deepEqual(state.clears, []);
  }

  // ── 5. A purchase that does not exist still fails closed with a 404. ──
  {
    const state = harness();
    await assert.rejects(
      () =>
        settleRoseCardStripeCheckout(
          paidCheckout({ purchaseId: 'missing-purchase' }),
          state.dependencies
        ),
      (error: unknown) =>
        error instanceof AgentCardSandboxSettlementError && error.statusCode === 404,
      'an unknown purchase reference must not settle anything'
    );
    assert.deepEqual(state.clears, []);
  }

  process.stdout.write('AgentCard checkout settlement recovery tests passed\n');
}

void main();
