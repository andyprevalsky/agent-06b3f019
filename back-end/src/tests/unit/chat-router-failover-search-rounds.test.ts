#!/usr/bin/env tsx
/**
 * Decision-round accounting of the chat-router-failover live probe. The
 * router may search before it decides again (bcee7f02c), as deploy #1640
 * attempt 2 did (2026-10-30 19:04Z: web_search with four queries, then the
 * after_search decision escalated). That search batch is one decision
 * boundary, not four retries, and the probe answers it in-process.
 */

import assert from 'node:assert/strict';

import { OPENROUTER_CEREBRAS_MODEL } from '../../providers/rose/openrouterCerebrasRoute';
import { OPENROUTER_FAST_CHAT_MODEL } from '../../providers/rose/openrouterFastRoute';
import { CEREBRAS_API_URL } from '../../providers/rose/transport';
import {
  type LiveEvidenceCapture,
  recordLiveEvidenceSample,
} from '../blackbox/chat-router-failover.evidence.support';
import {
  type DecisionRound,
  groupDecisionRounds,
  liveSampleOf,
  type RoundRequest,
} from '../blackbox/chat-router-failover.live.support';
import {
  installNetwork,
  PARALLEL_SEARCH_URL,
  type SearchRequest,
} from '../blackbox/chat-router-failover.network.support';

const GLM = OPENROUTER_FAST_CHAT_MODEL;
const QWEN = OPENROUTER_CEREBRAS_MODEL;
const DIRECT = 'qwen-3.8-27b';

function searchBody(objective: string): string {
  return JSON.stringify({ mode: 'turbo', objective, search_queries: [objective] });
}

/** A router_decision request the way chat-router-failover's stub sees one. */
function routerBody(): string {
  return JSON.stringify({
    model: DIRECT,
    messages: [
      { role: 'system', content: 'router' },
      { role: 'user', content: 'wrong address, its the 88 harlow one' },
      { role: 'user', content: '<system-reminder>\nCurrent UTC time: 2026-10-30T19:04:26Z' },
    ],
    response_format: { json_schema: { name: 'router_decision' } },
  });
}

function shape(rounds: DecisionRound[]): Array<Record<string, number>> {
  return rounds.map((round) => ({
    attempts: round.attempts,
    glm: round.glm.length,
    otherRoutes: round.otherRoutes,
    searchRequests: round.searchRequests,
  }));
}

async function testNetworkClassifiesParallelSearch(): Promise<void> {
  const network = installNetwork(
    { cerebras: () => 'stall', glm: () => 'stall', openrouterOther: 'stall' },
    Date.now()
  );
  try {
    const first = await fetch(PARALLEL_SEARCH_URL, {
      method: 'POST',
      body: searchBody('hot yoga'),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(
      await first.json(),
      { results: [] },
      'deterministic empty results: the probe tests routing failover, not search'
    );
    await fetch(PARALLEL_SEARCH_URL, { method: 'POST', body: searchBody('hot yoga') });
    await fetch(PARALLEL_SEARCH_URL, { method: 'POST', body: searchBody('bikram sf') });
    assert.deepEqual(
      network.searchRequests.map((search: SearchRequest) => [
        search.seq,
        search.objective,
        search.queries,
        search.hedgeDuplicate,
      ]),
      [
        [0, 'hot yoga', ['hot yoga'], false],
        [1, 'hot yoga', ['hot yoga'], true],
        [2, 'bikram sf', ['bikram sf'], false],
      ],
      'every Parallel POST is recorded; a repeated objective in the batch is the hedge duplicate'
    );

    const strays = [
      [PARALLEL_SEARCH_URL, { method: 'GET' }],
      ['https://api.parallel.ai/v1/other', { method: 'POST', body: searchBody('x') }],
      ['https://example.com/search', { method: 'POST', body: searchBody('x') }],
    ] as const;
    for (const [url, init] of strays) {
      await assert.rejects(fetch(url, init), /unexpected outbound/, url);
    }
    assert.deepEqual(
      network.unexpected,
      strays.map(([url]) => url),
      'only POST to the exact search URL is the search dependency'
    );
    assert.equal(network.searchRequests.length, 3, 'strays are never recorded as searches');

    const alert = await fetch('https://hooks.slack.com/services/x', { method: 'POST', body: '{}' });
    assert.equal(alert.status, 503);
    assert.deepEqual(network.alerts, ['https://hooks.slack.com/services/x']);

    // The next router request shares the fetch-order ordinal and opens the next round.
    const abort = new AbortController();
    await fetch(CEREBRAS_API_URL, { method: 'POST', body: routerBody(), signal: abort.signal });
    abort.abort(new Error('test done'));
    assert.equal(network.requests[0].seq, 3, 'router and search requests share one fetch order');
    assert.deepEqual(shape(network.decisionRounds()), [
      { attempts: 0, glm: 0, otherRoutes: 0, searchRequests: 3 },
      { attempts: 1, glm: 0, otherRoutes: 0, searchRequests: 0 },
    ]);
  } finally {
    network.restore();
  }
}

/** A recorded request with the clock fields the probe's stub also records. */
type SyntheticRequest = RoundRequest & { atMs: number; abortedAtMs?: number; abortReason?: string };

function router(
  seq: number,
  provider: RoundRequest['provider'],
  model: string,
  observed: Partial<SyntheticRequest> & { atMs: number }
): SyntheticRequest {
  return { seq, schema: 'router_decision', provider, model, ...observed };
}

/**
 * #1640 attempt 2 by fetch order: round 1's Cerebras, GLM and Qwen requests,
 * four Parallel POSTs plus a hedge duplicate, then round 2's three requests.
 * Round 1's stalled Cerebras and Qwen requests are aborted after round 2 has
 * started, and the Qwen request's clock reads after the search batch.
 */
const served = { status: 200, headersMs: 1_351, upstreamProvider: 'InferenceNet' };
const ROUND_ONE = [
  router(0, 'cerebras', DIRECT, { atMs: 0, abortedAtMs: 9_050, abortReason: 'router decided' }),
  router(1, 'openrouter', GLM, { atMs: 801, ...served, firstContentMs: 1_973 }),
  router(2, 'openrouter', QWEN, { atMs: 7_900, ...served, abortedAtMs: 9_100 }),
];
const SEARCHES = [3, 4, 5, 6, 7].map((seq) => ({ seq, atMs: 3_100 + seq }));
const ROUND_TWO = [
  router(8, 'cerebras', DIRECT, { atMs: 5_000, abortedAtMs: 9_000 }),
  router(9, 'openrouter', GLM, { atMs: 5_800, ...served, firstContentMs: 1_973 }),
  router(10, 'openrouter', QWEN, { atMs: 5_802, ...served, abortedAtMs: 9_001 }),
];
const GENERATOR: SyntheticRequest = {
  seq: 11,
  schema: 'chat_generator',
  provider: 'openrouter',
  model: 'x',
  atMs: 9_010,
};

function testSearchBatchIsOneDecisionBoundary(): void {
  const rounds = groupDecisionRounds([...ROUND_ONE, ...ROUND_TWO, GENERATOR], SEARCHES, GLM);
  assert.deepEqual(
    shape(rounds),
    [
      { attempts: 1, glm: 1, otherRoutes: 1, searchRequests: 5 },
      { attempts: 1, glm: 1, otherRoutes: 1, searchRequests: 0 },
    ],
    'four parallel searches plus a hedge duplicate close one round; they are not retries'
  );
  assert.equal(rounds[0].glm[0], ROUND_ONE[1]);
  assert.equal(rounds[1].glm[0], ROUND_TWO[1]);

  const reversed = groupDecisionRounds(
    [...ROUND_TWO, GENERATOR, ...ROUND_ONE],
    [...SEARCHES].reverse(),
    GLM
  );
  assert.deepEqual(shape(reversed), shape(rounds), 'grouping follows seq, not array position');

  // Control: by clock, round 1's late Qwen request would land in round 2.
  const byClock = groupDecisionRounds(
    [...ROUND_ONE, ...ROUND_TWO].map((request) => ({ ...request, seq: request.atMs })),
    SEARCHES.map((search) => ({ seq: search.atMs })),
    GLM
  );
  assert.deepEqual(
    shape(byClock).map((round) => round.otherRoutes),
    [0, 2],
    'the control must show the misassignment structural grouping avoids'
  );
}

function testRegenerateStaysInsideItsRound(): void {
  const regenerate = [
    router(0, 'cerebras', DIRECT, { atMs: 0 }),
    router(1, 'openrouter', GLM, { atMs: 800 }),
    router(2, 'openrouter', QWEN, { atMs: 801 }),
    router(3, 'cerebras', DIRECT, { atMs: 15_000 }),
    router(4, 'openrouter', GLM, { atMs: 15_800, ...served, firstContentMs: 1_900 }),
    router(5, 'openrouter', QWEN, { atMs: 15_801 }),
  ];
  const searches = [6, 7, 8, 9].map((seq) => ({ seq }));
  const next = [
    router(10, 'cerebras', DIRECT, { atMs: 19_000 }),
    router(11, 'openrouter', GLM, { atMs: 19_800, ...served, firstContentMs: 1_900 }),
  ];
  assert.deepEqual(shape(groupDecisionRounds([...regenerate, ...next], searches, GLM)), [
    { attempts: 2, glm: 2, otherRoutes: 2, searchRequests: 4 },
    { attempts: 1, glm: 1, otherRoutes: 0, searchRequests: 0 },
  ]);
  assert.deepEqual(groupDecisionRounds([], [], GLM), []);
}

function testSampleTakesTheOutcomeRound(): void {
  const rounds = groupDecisionRounds([...ROUND_ONE, ...ROUND_TWO], SEARCHES, GLM);
  const turn = { outcome: { kind: 'escalated' as const, atMs: 11_296 }, goal: 'g' };
  const network = (decisionRounds: DecisionRound[]) => ({
    decisionRounds: () => decisionRounds,
    alerts: ['https://hooks.slack.com/x'],
  });
  const sample = liveSampleOf(network(rounds), turn);
  assert.equal(sample.attempts, 1);
  assert.deepEqual(sample.glm, [ROUND_TWO[1]]);
  assert.equal(sample.rounds, rounds);
  assert.equal(sample.goal, 'g');
  assert.deepEqual(sample.alerts, ['https://hooks.slack.com/x']);
  const withoutHedge = groupDecisionRounds([ROUND_ONE[0], ...ROUND_TWO], SEARCHES, GLM);
  assert.throws(
    () => liveSampleOf(network(withoutHedge), turn),
    /decision round 1: every router attempt must reach the real GLM failover/
  );
  assert.throws(() => liveSampleOf(network([]), turn), /must make a router decision/);
}

function testEvidenceRecordsTheRoute(): void {
  const rounds = groupDecisionRounds([...ROUND_ONE, ...ROUND_TWO], SEARCHES, GLM);
  const searchRequests: SearchRequest[] = SEARCHES.map((search, index) => ({
    seq: search.seq,
    atMs: search.atMs,
    objective: `query ${index}`,
    queries: [`query ${index}`],
    hedgeDuplicate: index === 4,
  }));
  const capture = { sample: undefined } as LiveEvidenceCapture;
  recordLiveEvidenceSample(capture, {
    outcome: { kind: 'escalated', atMs: 11_296 },
    network: { decisionRounds: () => rounds, searchRequests, alerts: [] },
    goal: 'Find hot yoga near 88 Harlow St',
  });
  const sample = capture.sample as {
    attempts: number;
    glm: unknown[];
    rounds: DecisionRound[];
    searchRequests: SearchRequest[];
    searchBoundary: string;
  };
  assert.equal(sample.attempts, 1, 'attempts keeps meaning the outcome round');
  assert.deepEqual(sample.glm, [ROUND_TWO[1]]);
  assert.deepEqual(sample.rounds, rounds);
  assert.deepEqual(sample.searchRequests, searchRequests);
  assert.match(sample.searchBoundary, /"results":\[\]/);
}

async function main(): Promise<void> {
  await testNetworkClassifiesParallelSearch();
  testSearchBatchIsOneDecisionBoundary();
  testRegenerateStaysInsideItsRound();
  testSampleTakesTheOutcomeRound();
  testEvidenceRecordsTheRoute();
  process.stdout.write(
    'PASS chat-router-failover search rounds: Parallel POST answered in-process and recorded, ' +
      'strays still unexpected, search batch is one decision boundary, late siblings stay in ' +
      'their round, evidence records the route\n'
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
