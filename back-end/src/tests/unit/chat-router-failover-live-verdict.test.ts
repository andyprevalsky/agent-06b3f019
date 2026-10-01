#!/usr/bin/env tsx
/**
 * Pass criteria of the /deploy live chat-router-failover probe: one sample
 * decides, except a miss OpenRouter caused, which is re-probed once. The
 * sample shapes are the live runs recorded for the e8f2279b recurrence.
 */

import assert from 'node:assert/strict';

import {
  type LiveObservation,
  type LiveSample,
  probeLiveFailover,
} from '../blackbox/chat-router-failover.live.support';

const BUDGET_MS = 4_200;
const GOAL = 'Find the best hot yoga class this weekend near 88 Harlow St';

const served: LiveObservation = {
  status: 200,
  headersMs: 1_145,
  upstreamProvider: 'Parasail',
  firstEventMs: 1_146,
  firstContentMs: 1_268,
};
const noHeaders: LiveObservation = {};

function sample(overrides: Partial<LiveSample>): LiveSample {
  return {
    outcome: { kind: 'escalated', atMs: 3_408 },
    attempts: 1,
    glm: [served],
    alerts: [],
    goal: GOAL,
    ...overrides,
  };
}

async function verdict(samples: LiveSample[]): Promise<{ error: unknown; runs: number }> {
  let runs = 0;
  try {
    await probeLiveFailover({
      runSample: async () => samples[Math.min(runs++, samples.length - 1)],
      budgetMs: BUDGET_MS,
      reprobeDelayMs: 0,
      correctedAddress: /88 harlow/i,
    });
    return { error: null, runs };
  } catch (error) {
    return { error, runs };
  }
}

const apologyBothSilent = sample({
  outcome: { kind: 'apology', atMs: 10_061 },
  attempts: 2,
  glm: [noHeaders, noHeaders],
  alerts: ['https://hooks.slack.com/x'],
  goal: undefined,
});

async function run(): Promise<void> {
  const firstAttempt = await verdict([sample({})]);
  assert.equal(firstAttempt.error, null);
  assert.equal(firstAttempt.runs, 1, 'a served first sample is not re-probed');

  // 07:07:29: attempt 1 got no headers in its budget, the regenerate served.
  const servedOnRegenerate = sample({ attempts: 2, glm: [noHeaders, served] });
  const recovered = await verdict([servedOnRegenerate, sample({})]);
  assert.equal(recovered.error, null, 'an OpenRouter-side miss passes on a served re-probe');
  assert.equal(recovered.runs, 2);

  // 07:06:45: both attempts got nothing; the re-probe misses again.
  const twice = await verdict([apologyBothSilent, apologyBothSilent]);
  assert.match(String(twice.error), /missed in two samples/);
  assert.equal(twice.runs, 2);

  const slowFirstContent = { ...served, firstEventMs: 4_400, firstContentMs: 4_500 };
  const late = await verdict([
    sample({ attempts: 2, glm: [slowFirstContent, served] }),
    sample({}),
  ]);
  assert.equal(late.error, null, 'first content past the budget is OpenRouter-side');
  assert.equal(late.runs, 2);

  const failsAtOnce: Array<[string, LiveSample]> = [
    [
      'a 402 is our account',
      sample({ attempts: 2, glm: [{ status: 402, headersMs: 300 }, served] }),
    ],
    [
      'content inside the budget without a decision is ours',
      sample({ outcome: { kind: 'apology', atMs: 10_050 }, attempts: 2, glm: [served, served] }),
    ],
    ['a served turn with the wrong address is ours', sample({ goal: 'hot yoga near Irving, TX' })],
    [
      'events without the host field are ours',
      sample({
        attempts: 2,
        glm: [{ status: 200, headersMs: 900, firstEventMs: 901 }, served],
      }),
    ],
    ['a turn that never settles is ours', sample({ outcome: { kind: 'timeout', atMs: 45_000 } })],
  ];
  for (const [label, failing] of failsAtOnce) {
    const result = await verdict([failing, sample({})]);
    assert.ok(result.error, `${label}: must fail`);
    assert.equal(result.runs, 1, `${label}: must not be re-probed`);
  }

  process.stdout.write('PASS chat-router-failover live verdict (9 cases)\n');
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
