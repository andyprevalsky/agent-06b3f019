#!/usr/bin/env tsx
/**
 * Pass criteria of the /deploy live chat-router-failover probe: one sample
 * decides, except a miss OpenRouter caused, which is re-probed once. The
 * sample shapes are the live runs recorded for the e8f2279b recurrence.
 */

import assert from 'node:assert/strict';

import { DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS } from '../../providers/chat/routerCompletionDeadline';
import { DEFAULT_CEREBRAS_CHAT_HEDGE_MS } from '../../providers/rose/exclusiveCerebrasChatRoute';
import {
  assertServedOnFirstAttempt,
  type DecisionRound,
  type GoalAnchor,
  goalAnchorFailure,
  type LiveObservation,
  type LiveSample,
  probeLiveFailover,
} from '../blackbox/chat-router-failover.live.support';

const BUDGET_MS = DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS - DEFAULT_CEREBRAS_CHAT_HEDGE_MS;
const GOAL = 'Find the best hot yoga class this weekend near 88 Harlow St';
const GOAL_ANCHOR: GoalAnchor = {
  corrected: /88 Harlow\b/,
  rejected: /(?:1000 )?Westward Oak|Irving|Las Colinas|Dallas|DFW|Texas|\b750\d\d\b/,
};

/** Goals the live probe started with on 2026-10-01, and phrasings it must also accept. */
const CORRECT_GOALS = [
  'Find the best hot yoga class this weekend (Oct 3-4, 2026) near 88 Harlow St, Apt 1000, ' +
    'San Francisco, CA 94105 — user-confirmed location anchor. Research SF hot yoga studios ' +
    'nearby, verify weekend schedules and bookability from official sources, compare quality, ' +
    'and recommend one best class. Do not book.',
  'Find the best hot yoga class this weekend (Sat Oct 3 / Sun Oct 4, 2026, Pacific time) near ' +
    '88 Harlow St, Apt 1000, San Francisco, CA 94105. Steps: (1) identify hot yoga studios ' +
    'within ~2 miles of the address; (2) research official schedules for Oct 3–4, 2026.',
  'Do not book anything; find hot yoga within 2 miles of 88 Harlow St, San Francisco',
  'Find hot yoga around 88 Harlow St in San Francisco (not in Irving, TX)',
  'Find the best hot yoga class this weekend near the 88 Harlow St address in San Francisco',
  "Find the best hot yoga class this weekend near Alex's SF address, 88 Harlow St",
  'Redo the hot yoga search near 88 Harlow St, San Francisco; the previous run searched near ' +
    'Irving, TX by mistake',
  'Find hot yoga near 88 Harlow St, San Francisco (the earlier search wrongly anchored on ' +
    'Irving, TX)',
  'The user is no longer in Irving; find hot yoga (Sat. Oct 3) within 2 miles from 88 Harlow St',
  "(don't book) Location: 88 Harlow St, San Francisco",
  'Find the best hot yoga class this weekend, not too far from 88 Harlow St',
  'Find hot yoga (e.g. Bikram or hot vinyasa) near 88 Harlow St, San Francisco',
];

/** Goals that mention the corrected address but still send the run elsewhere. */
const WRONG_GOALS = [
  'hot yoga near Irving, TX 75063; do not anchor on 88 Harlow St',
  'Find hot yoga near Irving, TX',
  'Find hot yoga near 1000 Westward Oak Circle; the user mentioned 88 Harlow St',
  'Find hot yoga near Irving, TX or at 88 Harlow St',
  'Find hot yoga in Las Colinas instead of near 88 Harlow St',
  "Find the best hot yoga class this weekend near Alex's home. The only supplied address is a " +
    'delivery address for Ravi Samplefamily at 88 Harlow St, Apt 1000, San Francisco, CA ' +
    "94105; do not treat it as Alex's home.",
  "Find the best hot yoga class this weekend near Alex's Irving, TX home; drop off is at 88 " +
    "Harlow apt 1000 94105 (Ravi's address).",
  "Find hot yoga within 4 miles of Alex's home; ignore the delivery address at 88 Harlow St",
  'Find hot yoga near ZIP 75063; skip the studios at 88 Harlow St',
  'Search Irving, TX hot yoga studios and compare with ones near 88 Harlow St',
  "Find hot yoga near Alex's home in Dallas, TX; 88 Harlow St is Ravi's",
];

const served: LiveObservation = {
  status: 200,
  headersMs: 1_145,
  upstreamProvider: 'Parasail',
  firstEventMs: 1_146,
  firstContentMs: 1_268,
};
const noHeaders: LiveObservation = {};

/** A decision round whose every attempt reached GLM; `searchRequests` Parallel POSTs closed it. */
function round(glm: LiveObservation[], searchRequests = 0): DecisionRound {
  return { attempts: glm.length, glm, otherRoutes: glm.length, searchRequests };
}

function sample(overrides: Partial<LiveSample>): LiveSample {
  const attempts = overrides.attempts ?? 1;
  const glm = overrides.glm ?? [served];
  return {
    outcome: { kind: 'escalated', atMs: 3_408 },
    attempts,
    glm,
    rounds: [{ ...round(glm), attempts }],
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
      goalAnchor: GOAL_ANCHOR,
    });
    return { error: null, runs };
  } catch (error) {
    return { error, runs };
  }
}

const apologyBothSilent = sample({
  outcome: { kind: 'apology', atMs: 30_061 },
  attempts: 2,
  glm: [noHeaders, noHeaders],
  alerts: ['https://hooks.slack.com/x'],
  goal: undefined,
});

async function run(): Promise<void> {
  for (const goal of CORRECT_GOALS) {
    assert.equal(goalAnchorFailure(goal, GOAL_ANCHOR), undefined, goal);
  }
  for (const goal of WRONG_GOALS) {
    assert.ok(goalAnchorFailure(goal, GOAL_ANCHOR), `must reject: ${goal}`);
  }
  assert.ok(goalAnchorFailure(undefined, GOAL_ANCHOR), 'no goal is a failure');

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

  assert.equal(BUDGET_MS, 14_200);
  const slowFirstContent = { ...served, firstEventMs: 14_400, firstContentMs: 14_500 };
  const late = await verdict([
    sample({ attempts: 2, glm: [slowFirstContent, served] }),
    sample({}),
  ]);
  assert.equal(late.error, null, 'first content past the budget is OpenRouter-side');
  assert.equal(late.runs, 2);

  // #1640 attempt 2 (2026-10-30 19:04Z): the router searched first (four Parallel
  // POSTs), then the after_search decision escalated; both decisions served first-try.
  const searchedThenEscalated = sample({
    outcome: { kind: 'escalated', atMs: 11_296 },
    rounds: [round([served], 4), round([served])],
  });
  const twoRounds = await verdict([searchedThenEscalated]);
  assert.equal(twoRounds.error, null, 'a search round before the escalation is not a retry');
  assert.equal(twoRounds.runs, 1);

  // A regenerate inside either round is a missed first attempt; OpenRouter's miss is re-probed.
  const missInSearchRound = sample({ rounds: [round([noHeaders, served], 4), round([served])] });
  const missInLastRound = sample({
    attempts: 2,
    glm: [noHeaders, served],
    rounds: [round([served], 4), round([noHeaders, served])],
  });
  for (const [label, missed] of [
    ['search round', missInSearchRound],
    ['escalating round', missInLastRound],
  ] as const) {
    const reprobed = await verdict([missed, searchedThenEscalated]);
    assert.equal(reprobed.error, null, `${label}: an OpenRouter-side miss is re-probed`);
    assert.equal(reprobed.runs, 2, `${label}: a served later decision hides no earlier miss`);
    assert.throws(
      () => assertServedOnFirstAttempt(missed, GOAL_ANCHOR),
      /first router attempt/,
      `${label}: a second router attempt inside one decision round fails`
    );
  }

  const failsAtOnce: Array<[string, LiveSample]> = [
    [
      'a 402 is our account',
      sample({ attempts: 2, glm: [{ status: 402, headersMs: 300 }, served] }),
    ],
    [
      'content inside the budget without a decision is ours',
      sample({ outcome: { kind: 'apology', atMs: 30_050 }, attempts: 2, glm: [served, served] }),
    ],
    ['a served turn with the wrong address is ours', sample({ goal: 'hot yoga near Irving, TX' })],
    ['a served turn that keeps the rejected anchor is ours', sample({ goal: WRONG_GOALS[0] })],
    [
      'a connect that never completed is ours',
      sample({ attempts: 2, glm: [{ connectStartMs: 2 }, served] }),
    ],
    [
      'events without the host field are ours',
      sample({
        attempts: 2,
        glm: [{ status: 200, headersMs: 900, firstEventMs: 901 }, served],
      }),
    ],
    ['a turn that never settles is ours', sample({ outcome: { kind: 'timeout', atMs: 45_000 } })],
    [
      'a searched turn that never settles is ours',
      sample({
        outcome: { kind: 'timeout', atMs: 45_000 },
        rounds: [round([served], 4), round([served])],
      }),
    ],
    [
      'a 402 inside the search round is ours',
      sample({ rounds: [round([{ status: 402, headersMs: 300 }, served], 4), round([served])] }),
    ],
    [
      'a search without a router decision is ours',
      sample({
        rounds: [{ attempts: 0, glm: [], otherRoutes: 0, searchRequests: 4 }, round([served])],
      }),
    ],
  ];
  for (const [label, failing] of failsAtOnce) {
    const result = await verdict([failing, sample({})]);
    assert.ok(result.error, `${label}: must fail`);
    assert.equal(result.runs, 1, `${label}: must not be re-probed`);
  }

  process.stdout.write(
    `PASS chat-router-failover live verdict (${failsAtOnce.length + 7} samples, ` +
      `${CORRECT_GOALS.length + WRONG_GOALS.length + 1} goals)\n`
  );
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
