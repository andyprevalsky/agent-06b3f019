#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert/strict';
import {
  ensureAgentCardSandboxFloat,
  sandboxFloatTargetCents,
} from '../../providers/agentcard/benchmark-float';

function walletResult(wallet: {
  livemode: boolean;
  balance_cents: number;
  available_cents: number;
}): unknown {
  return {
    structuredContent: {
      wallet: {
        object: 'org_wallet',
        committed_cents: 0,
        ...wallet,
      },
    },
  };
}

async function main(): Promise<void> {
  // Reads the v2 sandbox company wallet via get_company_wallet and returns its
  // balance when the available headroom clears the floor. No funding call: the
  // sandbox wallet is pre-provisioned, so a single get_company_wallet is enough.
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const funded = await ensureAgentCardSandboxFloat(200_000, async (tool, args) => {
    calls.push({ tool, args });
    return walletResult({ livemode: false, balance_cents: 100_966_476, available_cents: 100_966_476 });
  });
  assert.deepEqual(funded, { balanceCents: 100_966_476, availableCents: 100_966_476 });
  assert.equal(calls.length, 1, 'a single get_company_wallet read, no top-up');
  assert.equal(calls[0].tool, 'get_company_wallet');

  // Fails closed on a LIVE wallet so a misconfigured benchmark cannot draw real funds.
  await assert.rejects(
    ensureAgentCardSandboxFloat(200_000, async () =>
      walletResult({ livemode: true, balance_cents: 100_966_476, available_cents: 100_966_476 })
    ),
    /LIVE AgentCard org wallet/
  );

  // Fails when the sandbox wallet is somehow below the required floor.
  await assert.rejects(
    ensureAgentCardSandboxFloat(200_000, async () =>
      walletResult({ livemode: false, balance_cents: 1_000, available_cents: 1_000 })
    ),
    /below the required floor/
  );

  // Concurrency-headroom floor: the default target must exceed a single run's
  // worst-case reservation by a wide margin so concurrent benchmark runs sharing
  // one org wallet cannot starve each other. Override raises it; a too-small or
  // invalid override is clamped up to the floor (never below).
  assert.equal(sandboxFloatTargetCents({}), 200_000, 'default float floor');
  assert.equal(
    sandboxFloatTargetCents({ BENCHMARK_AGENTCARD_FLOAT_CENTS: '500000' }),
    500_000,
    'override raises the floor'
  );
  assert.equal(
    sandboxFloatTargetCents({ BENCHMARK_AGENTCARD_FLOAT_CENTS: '10000' }),
    200_000,
    'override below the floor is clamped up'
  );
  for (const bad of ['', '  ', 'abc', '0', '-5']) {
    assert.equal(
      sandboxFloatTargetCents({ BENCHMARK_AGENTCARD_FLOAT_CENTS: bad }),
      200_000,
      `invalid override "${bad}" falls back to the floor`
    );
  }

  console.log('AgentCard benchmark sandbox float tests passed');
}

void main();
