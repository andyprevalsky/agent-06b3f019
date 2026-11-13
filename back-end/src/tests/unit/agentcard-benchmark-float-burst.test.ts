#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { waitOutBenchmarkOrgBackpressure } from '../../providers/agentcard/benchmark-float';
import { AgentCardOrgRuntimeError } from '../../providers/agentcard/org-runtime';

const WINDOW_MS = 180_000;

const throttleAnswer = () =>
  new AgentCardOrgRuntimeError(
    'AgentCard Organization MCP list_cardholders failed: Invalid or expired organization token',
    401,
    'agentcard_org_mcp_unauthorized'
  );

/** Replays a provider burst on a virtual clock; each pass costs `passMs` of per-call retries. */
async function replayBurst(
  burstMs: number,
  passMs: number
): Promise<{ result: unknown; passStartsMs: number[] }> {
  let clockMs = 0;
  const passStartsMs: number[] = [];
  let result: unknown;
  try {
    result = await waitOutBenchmarkOrgBackpressure(
      async () => {
        passStartsMs.push(clockMs);
        const throttled = clockMs < burstMs;
        clockMs += passMs;
        if (throttled) throw throttleAnswer();
        return 'ready';
      },
      {
        now: () => clockMs,
        sleep: async (ms) => {
          clockMs += ms;
        },
      }
    );
  } catch (error) {
    result = error;
  }
  return { result, passStartsMs };
}

/**
 * Regression (PR #1975 smoke round 6b, 2026-11-13): an AgentCard org throttle burst answered 429
 * then 401 "Invalid or expired organization token" from 01:31:46 to ~01:34:02Z. Fixed 30 s gaps
 * spent the fixture's 1 + 3 passes by ~130 s and failed the guest before the start barrier ~50 s
 * inside the existing 180 s window, INFRA-stopping the whole smoke campaign (#1994 round 1: ~115 s).
 * The same passes must span that window, however long each pass takes: a burst that ends inside it
 * is waited out, with no extra provider request and no pass starting after the window.
 */
async function main(): Promise<void> {
  for (const passMs of [0, 10_000]) {
    for (const burstMs of [140_000, 160_000, 175_000]) {
      const { result, passStartsMs } = await replayBurst(burstMs, passMs);
      const label = `${burstMs / 1000} s burst, ${passMs / 1000} s passes`;
      assert.equal(
        result,
        'ready',
        `${label} is waited out (passes at ${passStartsMs.join(', ')})`
      );
      assert.equal(passStartsMs.length, 4, `${label}: still 1 + 3 passes, no extra requests`);
      assert.ok(
        passStartsMs.every((startMs) => startMs <= WINDOW_MS),
        `${label}: inside 180 s`
      );
    }
    // A burst that outlasts the window still surfaces the provider's own error, unchanged.
    const sustained = await replayBurst(240_000, passMs);
    assert.ok(
      sustained.result instanceof AgentCardOrgRuntimeError && sustained.result.status === 401,
      'an outage longer than the window still fails with the provider 401'
    );
    assert.equal(sustained.passStartsMs.length, 4, 'a sustained outage stays at 1 + 3 passes');
    assert.ok(sustained.passStartsMs.every((startMs) => startMs <= WINDOW_MS));
  }
  // A short flap is still retried after 30 s, as before.
  const shortFlap = await replayBurst(20_000, 0);
  assert.deepEqual(shortFlap.passStartsMs, [0, 30_000]);
  process.stdout.write('AgentCard benchmark fixture throttle-burst tests passed\n');
}

void main();
