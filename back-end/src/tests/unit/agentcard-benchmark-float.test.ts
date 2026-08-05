#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert/strict';
import {
  ensureAgentCardSandboxFloat,
  resolveBenchmarkCardholderId,
} from '../../providers/agentcard/benchmark-float';

function walletResult(cents: {
  balance: number;
  committed?: number;
  available: number;
  livemode?: boolean;
}): unknown {
  return {
    structuredContent: {
      wallet: {
        object: 'org_wallet',
        livemode: cents.livemode ?? false,
        balance_cents: cents.balance,
        committed_cents: cents.committed ?? 0,
        available_cents: cents.available,
        stablecoin: 'usdc',
      },
    },
  };
}

function cardholdersResult(cardholders: Array<{ id: string; email?: string }>): unknown {
  return {
    structuredContent: {
      message: `${cardholders.length} cardholder(s); showing ${cardholders.length}.`,
      cardholders,
      total: cardholders.length,
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

  // Shared sandbox rate limits expose an absolute retry timestamp. Bootstrap waits for the
  // advertised window and retries instead of failing the lifecycle gate before a task exists.
  {
    let calls = 0;
    const callOrgTool = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('Streamable HTTP error: {"error":"Rate limit exceeded","retryAfter":0}');
      }
      return walletResult({ balance: 32_416, available: 32_416 });
    };
    const float = await ensureAgentCardSandboxFloat(10_000, callOrgTool);
    assert.equal(calls, 2, 'retries a rate-limited wallet read');
    assert.equal(float.availableCents, 32_416);
  }

  // Non-rate-limit failures remain immediate and are never masked by retries.
  {
    let calls = 0;
    const callOrgTool = async () => {
      calls += 1;
      throw new Error('authentication failed');
    };
    await assert.rejects(ensureAgentCardSandboxFloat(10_000, callOrgTool), /authentication failed/);
    assert.equal(calls, 1, 'does not retry unrelated failures');
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

  // A live wallet is rejected before the floor check so the benchmark never draws
  // on live funds, even when it is amply funded.
  {
    const callOrgTool = async () =>
      walletResult({ balance: 1_000_000, available: 1_000_000, livemode: true });
    await assert.rejects(ensureAgentCardSandboxFloat(10_000, callOrgTool), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /live wallet/i);
      assert.match(message, /sandbox/i);
      return true;
    });
  }

  // Stale BENCHMARK_AGENTCARD_CARDHOLDER_ID must not win over a live AGENTCARD_CARDHOLDER_ID.
  {
    const calls: string[] = [];
    const callOrgTool = async (name: string) => {
      calls.push(name);
      return cardholdersResult([
        { id: 'ch-live', email: 'agentcard-benchmark@roselabs.ai' },
        { id: 'ch-other', email: 'a@roselabs.ai' },
      ]);
    };
    const resolved = await resolveBenchmarkCardholderId(
      ['ch-stale-missing', 'ch-live'],
      callOrgTool
    );
    assert.equal(resolved, 'ch-live');
    assert.deepEqual(calls, ['list_cardholders']);
  }

  // When every configured id is missing, fall back to the benchmark email cardholder.
  {
    const resolved = await resolveBenchmarkCardholderId(['ch-stale'], async () =>
      cardholdersResult([
        { id: 'ch-live', email: 'agentcard-benchmark@roselabs.ai' },
        { id: 'ch-other', email: 'a@roselabs.ai' },
      ])
    );
    assert.equal(resolved, 'ch-live');
  }

  // An empty org fails closed with an actionable message.
  {
    await assert.rejects(
      resolveBenchmarkCardholderId(['ch-stale'], async () => cardholdersResult([])),
      /no cardholders/i
    );
  }

  console.log('AgentCard benchmark sandbox float tests passed');
}

void main();
