#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Unit tests for the AgentCard mint HARD CUTOFF.
 *
 * Until `AGENTCARD_MINT_ENABLED` is truthy, `createCardProvider` must return the static Rose Agent
 * Card (a real Brex company card) and NEVER touch the AgentCard MCP — mint, details, liveness, and
 * close all resolve from the static card. Flipping the flag truthy (or running under benchmark mode)
 * restores the real routing provider.
 *
 * SECURITY: the card credentials are NOT in source — they are injected from env
 * (`ROSE_AGENT_CARD_PAN`/`_CVV`/`_EXPIRY`/`_PIN`) and `roseAgentCard()` throws if any is missing.
 */

import assert from 'node:assert';
import {
  AgentCardRoutingProvider,
  StaticRoseAgentCardProvider,
  agentCardMintEnabled,
  createCardProvider,
  isCardLive,
} from '../../providers/card-provider';
// Credential accessors are intentionally NOT re-exported from the barrel; import them directly.
import {
  ROSE_AGENT_CARD_ID,
  ROSE_AGENT_CARD_META,
  roseAgentCard,
} from '../../providers/card-provider/static-card';

// Test-only card credentials injected via env (never a real card).
const TEST_CARD = { pan: '4111111111111111', cvv: '321', expiry: '11/30', pin: '4242' };

const CARD_ENV_KEYS = [
  'ROSE_AGENT_CARD_PAN',
  'ROSE_AGENT_CARD_CVV',
  'ROSE_AGENT_CARD_EXPIRY',
  'ROSE_AGENT_CARD_PIN',
  'ROSE_AGENT_CARD_CARDHOLDER',
  'AGENTCARD_MINT_ENABLED',
  'BENCHMARK_MODE',
  'BENCHMARK_ISOLATED_RUN',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of CARD_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of CARD_ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

/** Cutoff active: flag + benchmark mode off, card credentials injected. */
function setCutoffEnv(): void {
  delete process.env.AGENTCARD_MINT_ENABLED;
  delete process.env.BENCHMARK_MODE;
  delete process.env.BENCHMARK_ISOLATED_RUN;
  process.env.ROSE_AGENT_CARD_PAN = TEST_CARD.pan;
  process.env.ROSE_AGENT_CARD_CVV = TEST_CARD.cvv;
  process.env.ROSE_AGENT_CARD_EXPIRY = TEST_CARD.expiry;
  process.env.ROSE_AGENT_CARD_PIN = TEST_CARD.pin;
}

async function main(): Promise<void> {
  const snap = snapshotEnv();
  try {
    // --- Flag parsing: off by default, truthy variants enable (benchmark mode off) ---
    setCutoffEnv();
    assert.strictEqual(agentCardMintEnabled(), false, 'unset => cutoff active');
    for (const falsy of ['', 'false', '0']) {
      process.env.AGENTCARD_MINT_ENABLED = falsy;
      assert.strictEqual(agentCardMintEnabled(), false, `${falsy} => cutoff active`);
    }
    for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      process.env.AGENTCARD_MINT_ENABLED = truthy;
      assert.strictEqual(agentCardMintEnabled(), true, `${truthy} => enabled`);
    }

    // --- Cutoff active (flag off): static provider, no AgentCard ---
    setCutoffEnv();
    const cutoffProvider = createCardProvider('any-user');
    assert.ok(
      cutoffProvider instanceof StaticRoseAgentCardProvider,
      'cutoff must return the static provider'
    );
    assert.ok(
      !(cutoffProvider instanceof AgentCardRoutingProvider),
      'cutoff must NOT return the AgentCard routing provider'
    );

    // Mint returns the static card; spendLimitCents is the card's OWN cap, NOT the requested amount,
    // and there is NO fabricated provider transfer id.
    const minted = await cutoffProvider.mintCard({
      amountCents: 4396,
      fundsSource: 'company_flow',
      idempotencyKey: 'purchase:cutoff',
    });
    assert.strictEqual(minted.cardId, ROSE_AGENT_CARD_ID);
    assert.strictEqual(minted.last4, TEST_CARD.pan.slice(-4), 'last4 = injected PAN tail');
    assert.strictEqual(minted.expiry, TEST_CARD.expiry);
    assert.strictEqual(minted.status, 'OPEN');
    assert.strictEqual(
      minted.spendLimitCents,
      ROSE_AGENT_CARD_META.spendLimitCents,
      'spendLimitCents is the fixed card cap, not the requested amount'
    );
    assert.notStrictEqual(minted.spendLimitCents, 4396, 'must NOT echo request.amountCents');
    assert.strictEqual(
      minted.providerTransferId,
      undefined,
      'static mint must NOT fabricate a provider transfer id'
    );
    assert.deepStrictEqual(minted.metadata, { staticCard: true }, 'flags static funding');

    // Details resolve to the injected card credentials; balance is bounded (the cap), not MAX_INT.
    const details = await cutoffProvider.getDetails(ROSE_AGENT_CARD_ID);
    assert.strictEqual(details.pan, TEST_CARD.pan);
    assert.strictEqual(details.cvv, TEST_CARD.cvv);
    assert.strictEqual(details.expiry, TEST_CARD.expiry);
    assert.strictEqual(details.pan.slice(-4), minted.last4);
    assert.strictEqual(details.status, 'OPEN');
    assert.strictEqual(
      details.balanceCents,
      ROSE_AGENT_CARD_META.spendLimitCents,
      'bounded balance'
    );
    assert.strictEqual(isCardLive(details), true, 'static card reads as live');

    // closeCard on the static id is a safe no-op.
    await cutoffProvider.closeCard(ROSE_AGENT_CARD_ID);

    // --- cardId validation: the provider manages ONLY the static card ---
    await assert.rejects(
      () => cutoffProvider.getDetails('some-real-agentcard-id'),
      /does not manage|not_managed/,
      'getDetails rejects a non-static id'
    );
    await assert.rejects(
      () => cutoffProvider.closeCard('some-real-agentcard-id'),
      /does not manage|not_managed/,
      'closeCard rejects a non-static id'
    );

    // A user-flow (onramp) mint returns the same static card — the cutoff is total.
    const userFlowMint = await cutoffProvider.mintCard({ amountCents: 1000 });
    assert.strictEqual(userFlowMint.cardId, ROSE_AGENT_CARD_ID);
    assert.strictEqual(userFlowMint.spendLimitCents, ROSE_AGENT_CARD_META.spendLimitCents);

    // --- Missing credentials must throw, never fall back to a baked-in card ---
    setCutoffEnv();
    delete process.env.ROSE_AGENT_CARD_PAN;
    assert.throws(
      () => roseAgentCard(),
      /ROSE_AGENT_CARD_PAN is not configured|not_configured/,
      'missing PAN throws'
    );
    await assert.rejects(
      () => createCardProvider('any-user').mintCard({ amountCents: 1000 }),
      /not configured|not_configured/,
      'mint throws when credentials are unset (no source fallback)'
    );

    // --- Flag on: real routing provider is restored ---
    setCutoffEnv();
    process.env.AGENTCARD_MINT_ENABLED = 'true';
    assert.ok(
      createCardProvider('any-user') instanceof AgentCardRoutingProvider,
      'enabling the flag restores the AgentCard routing provider'
    );

    // --- Benchmark mode force-enables real minting so evals never touch the real Brex card ---
    for (const benchVar of ['BENCHMARK_MODE', 'BENCHMARK_ISOLATED_RUN']) {
      setCutoffEnv();
      process.env[benchVar] = '1';
      assert.strictEqual(agentCardMintEnabled(), true, `${benchVar} force-enables minting`);
      assert.ok(
        createCardProvider('any-user') instanceof AgentCardRoutingProvider,
        `${benchVar} routes through the real provider, never the static Brex card`
      );
    }

    // --- Env injection + rotation: credentials come from env and flow into getDetails ---
    setCutoffEnv();
    process.env.ROSE_AGENT_CARD_PAN = '  5555444433332222  '; // trimmed
    const rotated = roseAgentCard();
    assert.strictEqual(rotated.pan, '5555444433332222', 'env pan override (trimmed)');
    assert.strictEqual(rotated.cvv, TEST_CARD.cvv);
    const rotatedDetails = await createCardProvider('any-user').getDetails(ROSE_AGENT_CARD_ID);
    assert.strictEqual(
      rotatedDetails.pan,
      '5555444433332222',
      'injected value flows to getDetails'
    );

    console.log('AgentCard static mint cutoff tests passed');
  } finally {
    restoreEnv(snap);
  }
}

void main();
