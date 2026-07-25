#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert/strict';
import { ensureAgentCardSandboxFloat } from '../../providers/agentcard/benchmark-float';

function walletResult(cents: { balance: number; committed?: number; available: number }): unknown {
  return {
    structuredContent: {
      wallet: {
        object: 'org_wallet',
        livemode: false,
        balance_cents: cents.balance,
        committed_cents: cents.committed ?? 0,
        available_cents: cents.available,
        stablecoin: 'usdc',
      },
    },
  };
}

async function main(): Promise<void> {
  // A sufficiently funded sandbox pool reads clean via client-credential MCP.
  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callOrgTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return walletResult({ balance: 32_416, available: 32_416 });
    };
    const float = await ensureAgentCardSandboxFloat(10_000, callOrgTool);
    assert.deepEqual(float, { balanceCents: 32_416, availableCents: 32_416, committedCents: 0 });
    assert.equal(calls.length, 1, 'reads the wallet exactly once');
    assert.equal(calls[0].name, 'get_company_wallet');
    assert.deepEqual(calls[0].args, {}, 'org identity travels in the client-credential token');
  }

  // Committed holds are surfaced but available is what gates the floor.
  {
    const callOrgTool = async () =>
      walletResult({ balance: 20_000, committed: 4_396, available: 15_604 });
    const float = await ensureAgentCardSandboxFloat(10_000, callOrgTool);
    assert.deepEqual(float, {
      balanceCents: 20_000,
      availableCents: 15_604,
      committedCents: 4_396,
    });
  }

  // A pool below the floor fails loud and early with an actionable, non-interactive message.
  {
    const callOrgTool = async () => walletResult({ balance: 5_000, available: 5_000 });
    await assert.rejects(ensureAgentCardSandboxFloat(10_000, callOrgTool), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /sandbox pool too low/i);
      assert.match(message, /\$50\.00 available/);
      assert.match(message, /\$100\.00 required/);
      assert.match(message, /no interactive login/i);
      return true;
    });
  }

  // A malformed wallet response is rejected rather than silently passing.
  {
    const callOrgTool = async () => ({ structuredContent: {} });
    await assert.rejects(ensureAgentCardSandboxFloat(10_000, callOrgTool), /no structured wallet/i);
  }

  console.log('AgentCard benchmark sandbox float tests passed');
}

void main();
