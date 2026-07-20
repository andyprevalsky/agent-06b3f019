#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Unit tests for the AgentCard mint HARD CUTOFF.
 *
 * Until `AGENTCARD_MINT_ENABLED` is truthy, `createCardProvider` must return the static Rose Agent
 * Card (a real Brex company card) and NEVER touch the AgentCard MCP — mint, details, liveness, and
 * close must all resolve from the static card. Flipping the flag truthy restores the real routing
 * provider.
 */

import assert from 'node:assert';
import {
  AgentCardRoutingProvider,
  ROSE_AGENT_CARD_DEFAULTS,
  StaticRoseAgentCardProvider,
  agentCardMintEnabled,
  createCardProvider,
  isCardLive,
  roseAgentCard,
} from '../../providers/card-provider';

/**
 * Run `fn` with `AGENTCARD_MINT_ENABLED` set to `value` AND benchmark mode forced off, so the
 * cutoff assertions are deterministic regardless of ambient env (the coverage/bench stacks may set
 * BENCHMARK_MODE / BENCHMARK_ISOLATED_RUN, which force-enable minting — covered separately below).
 */
function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = {
    flag: process.env.AGENTCARD_MINT_ENABLED,
    bench: process.env.BENCHMARK_MODE,
    isolated: process.env.BENCHMARK_ISOLATED_RUN,
  };
  if (value === undefined) delete process.env.AGENTCARD_MINT_ENABLED;
  else process.env.AGENTCARD_MINT_ENABLED = value;
  delete process.env.BENCHMARK_MODE;
  delete process.env.BENCHMARK_ISOLATED_RUN;
  try {
    return fn();
  } finally {
    restoreEnv('AGENTCARD_MINT_ENABLED', prev.flag);
    restoreEnv('BENCHMARK_MODE', prev.bench);
    restoreEnv('BENCHMARK_ISOLATED_RUN', prev.isolated);
  }
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

async function main(): Promise<void> {
  // --- Flag parsing: off by default, truthy variants enable ---
  assert.strictEqual(withFlag(undefined, agentCardMintEnabled), false, 'unset => cutoff active');
  assert.strictEqual(withFlag('', agentCardMintEnabled), false, 'empty => cutoff active');
  assert.strictEqual(withFlag('false', agentCardMintEnabled), false, 'false => cutoff active');
  assert.strictEqual(withFlag('0', agentCardMintEnabled), false, '0 => cutoff active');
  for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.strictEqual(withFlag(truthy, agentCardMintEnabled), true, `${truthy} => enabled`);
  }

  // --- Cutoff active (flag off): static provider, no AgentCard ---
  const cutoffProvider = withFlag(undefined, () => createCardProvider('any-user'));
  assert.ok(
    cutoffProvider instanceof StaticRoseAgentCardProvider,
    'cutoff must return the static provider'
  );
  assert.ok(
    !(cutoffProvider instanceof AgentCardRoutingProvider),
    'cutoff must NOT return the AgentCard routing provider'
  );

  // Company-flow mint returns the static card WITHOUT any org onboarding / MCP call.
  const minted = await cutoffProvider.mintCard({
    amountCents: 4396,
    fundsSource: 'company_flow',
    idempotencyKey: 'purchase:cutoff',
  });
  assert.strictEqual(minted.cardId, ROSE_AGENT_CARD_DEFAULTS.cardId);
  assert.strictEqual(minted.last4, '1372');
  assert.strictEqual(minted.expiry, '02/29');
  assert.strictEqual(minted.status, 'OPEN');
  assert.strictEqual(minted.spendLimitCents, 4396);
  assert.ok(
    minted.providerTransferId !== undefined && minted.providerTransferId.trim() !== '',
    'static mint must carry a non-empty transfer id so the charge-flow guard passes'
  );

  // Details resolve to the real static card PAN/CVV/expiry.
  const details = await cutoffProvider.getDetails(minted.cardId);
  assert.strictEqual(details.pan, '5440150143481372');
  assert.strictEqual(details.cvv, ROSE_AGENT_CARD_DEFAULTS.cvv);
  assert.strictEqual(details.expiry, '02/29');
  assert.strictEqual(details.pan.slice(-4), minted.last4);
  assert.strictEqual(details.status, 'OPEN');

  // The static card is always live so reuse/liveness treats it as unspent (reusable company card).
  assert.strictEqual(isCardLive(details), true, 'static card must read as live');

  // closeCard is a safe no-op — the shared company card is never closed.
  await cutoffProvider.closeCard(minted.cardId);

  // A user-flow (onramp) mint returns the same static card — the cutoff is total.
  const userFlowMint = await cutoffProvider.mintCard({ amountCents: 1000 });
  assert.strictEqual(userFlowMint.cardId, ROSE_AGENT_CARD_DEFAULTS.cardId);
  assert.strictEqual(userFlowMint.spendLimitCents, 1000);

  // --- Flag on: real routing provider is restored ---
  const enabledProvider = withFlag('true', () => createCardProvider('any-user'));
  assert.ok(
    enabledProvider instanceof AgentCardRoutingProvider,
    'enabling the flag must restore the AgentCard routing provider'
  );
  assert.ok(
    !(enabledProvider instanceof StaticRoseAgentCardProvider),
    'enabled path must NOT return the static provider'
  );

  // --- Benchmark mode force-enables real minting so evals never touch the real Brex card ---
  for (const benchVar of ['BENCHMARK_MODE', 'BENCHMARK_ISOLATED_RUN']) {
    const prevFlag = process.env.AGENTCARD_MINT_ENABLED;
    const prevBench = process.env[benchVar];
    delete process.env.AGENTCARD_MINT_ENABLED; // cutoff flag off...
    process.env[benchVar] = '1'; // ...but benchmark mode on
    try {
      assert.strictEqual(agentCardMintEnabled(), true, `${benchVar} force-enables minting`);
      assert.ok(
        createCardProvider('any-user') instanceof AgentCardRoutingProvider,
        `${benchVar} must route through the real provider, never the static Brex card`
      );
    } finally {
      restoreEnv('AGENTCARD_MINT_ENABLED', prevFlag);
      restoreEnv(benchVar, prevBench);
    }
  }

  // --- Env override: the physical card can be rotated without a code change ---
  const defaults = roseAgentCard();
  assert.strictEqual(defaults.pan, ROSE_AGENT_CARD_DEFAULTS.pan, 'default pan');
  assert.strictEqual(defaults.cvv, ROSE_AGENT_CARD_DEFAULTS.cvv, 'default cvv');
  assert.strictEqual(defaults.expiry, ROSE_AGENT_CARD_DEFAULTS.expiry, 'default expiry');
  assert.strictEqual(defaults.pin, ROSE_AGENT_CARD_DEFAULTS.pin, 'default pin');

  const prevPan = process.env.ROSE_AGENT_CARD_PAN;
  const prevCvv = process.env.ROSE_AGENT_CARD_CVV;
  const prevExpiry = process.env.ROSE_AGENT_CARD_EXPIRY;
  const prevPin = process.env.ROSE_AGENT_CARD_PIN;
  try {
    process.env.ROSE_AGENT_CARD_PAN = '  4111111111111111  '; // trimmed
    process.env.ROSE_AGENT_CARD_CVV = '321';
    process.env.ROSE_AGENT_CARD_EXPIRY = '11/30';
    process.env.ROSE_AGENT_CARD_PIN = '4242';
    const rotated = roseAgentCard();
    assert.strictEqual(rotated.pan, '4111111111111111', 'env pan override (trimmed)');
    assert.strictEqual(rotated.cvv, '321', 'env cvv override');
    assert.strictEqual(rotated.expiry, '11/30', 'env expiry override');
    assert.strictEqual(rotated.pin, '4242', 'env pin override');
    const rotatedDetails = await withFlag(undefined, () =>
      createCardProvider('any-user').getDetails('any')
    );
    assert.strictEqual(rotatedDetails.pan, '4111111111111111', 'override flows to getDetails');
  } finally {
    if (prevPan === undefined) delete process.env.ROSE_AGENT_CARD_PAN;
    else process.env.ROSE_AGENT_CARD_PAN = prevPan;
    if (prevCvv === undefined) delete process.env.ROSE_AGENT_CARD_CVV;
    else process.env.ROSE_AGENT_CARD_CVV = prevCvv;
    if (prevExpiry === undefined) delete process.env.ROSE_AGENT_CARD_EXPIRY;
    else process.env.ROSE_AGENT_CARD_EXPIRY = prevExpiry;
    if (prevPin === undefined) delete process.env.ROSE_AGENT_CARD_PIN;
    else process.env.ROSE_AGENT_CARD_PIN = prevPin;
  }

  console.log('AgentCard static mint cutoff tests passed');
}

void main();
