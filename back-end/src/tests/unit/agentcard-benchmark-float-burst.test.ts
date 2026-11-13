#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { waitOutBenchmarkOrgBackpressure } from '../../providers/agentcard/benchmark-float';
import { AgentCardOrgRuntimeError } from '../../providers/agentcard/org-runtime';

/**
 * Regression (PR #1975 smoke round 6b, 2026-11-13): an AgentCard org throttle burst answered 429
 * then 401 "Invalid or expired organization token" from 01:31:46 to ~01:34:02Z. Fixed 30 s gaps
 * spent the fixture's 1 + 3 passes by ~130 s and failed the guest before the start barrier ~50 s
 * inside the existing 180 s window, INFRA-stopping the whole smoke campaign. The same passes must
 * span that window: a burst that ends inside it is waited out, with no extra provider request and
 * no pass starting after the window.
 */
async function assertBurstInsideWindowIsWaitedOut(burstMs: number): Promise<void> {
  let clockMs = 0;
  const passStartsMs: number[] = [];
  const result = await waitOutBenchmarkOrgBackpressure(
    async () => {
      passStartsMs.push(clockMs);
      const throttled = clockMs < burstMs;
      clockMs += 10_000; // one pass, including its own per-call 429/401 retries
      if (throttled) {
        throw new AgentCardOrgRuntimeError(
          'AgentCard Organization MCP list_cardholders failed: Invalid or expired organization token',
          401,
          'agentcard_org_mcp_unauthorized'
        );
      }
      return 'ready';
    },
    {
      now: () => clockMs,
      sleep: async (ms) => {
        clockMs += ms;
      },
    }
  );
  assert.equal(result, 'ready', `a ${burstMs / 1000} s burst inside the window is waited out`);
  assert.equal(passStartsMs.length, 4, 'still 1 + 3 passes: no extra provider requests');
  assert.ok(
    passStartsMs.every((startMs) => startMs <= 180_000),
    `no pass starts after the existing 180 s window: ${passStartsMs.join(', ')}`
  );
}

async function main(): Promise<void> {
  await assertBurstInsideWindowIsWaitedOut(140_000);
  await assertBurstInsideWindowIsWaitedOut(160_000);
  process.stdout.write('AgentCard benchmark fixture throttle-burst tests passed\n');
}

void main();
