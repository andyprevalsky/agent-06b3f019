#!/usr/bin/env tsx
/**
 * T107: challenge-recovery candidate sessions leaked. A search still probing at
 * backend SIGTERM left its two tilion_direct candidates live (nothing owns them
 * but the search), and a search kept allocating candidates after its agent's
 * cleanup. Every candidate is released on shutdown (including one whose create
 * lands meanwhile) and when its agent stops; a promoted winner is the task's own.
 */
import assert from 'node:assert';
import type { Browser } from 'playwright';
import {
  abortRecoverySearchesFor,
  liveRecoveryProbeSessionCount,
  releaseAllRecoveryProbeSessions,
  reopenRecoveryAdmissionsForTests,
  runLaneConfigSearch,
  type ConfigSearchDependencies,
} from '../../providers/browser/challengeRecoveryLaneSearch';
import type { BrowserRecoveryConfig } from '../../providers/browser/challengeRecovery';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CONFIGS: BrowserRecoveryConfig[] = ['tilion_direct', 'tilion_residential'].map((key) => ({
  key,
  provider: 'tilion',
  proxyMode: key === 'tilion_direct' ? 'direct' : 'residential_country',
  tilionProxyType: key === 'tilion_direct' ? 'direct' : 'residential',
}));
const LANES = [
  { key: 'auth_kept', storageState: {} },
  { key: 'stripped', storageState: {} },
];

/** Fake Tilion: every candidate stays challenged unless `winnerKey` matches. */
function fakeProvider(options: {
  createMs: number;
  probeMs: number;
  winnerKey?: string;
  releaseMs?: number;
}) {
  const created: string[] = [];
  const released: string[] = [];
  const promoted: string[] = [];
  let next = 0;
  const dependencies: ConfigSearchDependencies = {
    create: async (config) => {
      await sleep(options.createMs);
      const sessionId = `${config.key}-${(next += 1)}`;
      created.push(sessionId);
      return {
        provider: config.provider,
        sessionId,
        debugUrl: 'https://debug.invalid',
        wsUrl: 'wss://cdp.invalid',
        proxySource: config.proxyMode,
        proxyLocation: { country: 'US' },
        profileId: null,
        profileSource: 'test',
        validationBrowser: {} as Browser,
      };
    },
    probe: async (config) => {
      await sleep(options.probeMs);
      const clean = config.key === options.winnerKey;
      return {
        stablePasses: clean ? 1 : 0,
        attempts: 1,
        latencyMs: options.probeMs,
        paymentCdnOk: true,
      };
    },
    promote: async (winner) => {
      promoted.push(winner.session.sessionId);
    },
    release: async (_config, session) => {
      await sleep(options.releaseMs ?? 5);
      released.push(session.sessionId);
    },
  };
  const live = () => created.filter((id) => !released.includes(id) && !promoted.includes(id));
  return { dependencies, created, released, promoted, live };
}

async function testShutdownReleasesProbingCandidates(): Promise<void> {
  const fake = fakeProvider({ createMs: 10, probeMs: 400 });
  const search = runLaneConfigSearch(CONFIGS, LANES, fake.dependencies).catch(() => null);
  await sleep(100); // both lanes now hold a candidate mid-probe
  assert.strictEqual(fake.live().length, 2, 'both lanes hold a live candidate');
  const released = await releaseAllRecoveryProbeSessions(2_000);
  assert.strictEqual(released, 2);
  assert.deepStrictEqual(fake.live(), [], `left live after shutdown: ${fake.live().join(',')}`);
  await search;
  await sleep(500);
  assert.strictEqual(fake.created.length, 2, 'an aborted search allocated another candidate');
  assert.strictEqual(
    new Set(fake.released).size,
    fake.released.length,
    'a candidate was released twice'
  );
  assert.strictEqual(liveRecoveryProbeSessionCount(), 0);
}

async function testShutdownReleasesCandidateCreatedMeanwhile(): Promise<void> {
  const fake = fakeProvider({ createMs: 300, probeMs: 400 });
  const search = runLaneConfigSearch(CONFIGS, LANES, fake.dependencies).catch(() => null);
  await sleep(50); // creates are in flight
  assert.strictEqual(fake.created.length, 0);
  await releaseAllRecoveryProbeSessions(2_000);
  await search;
  await sleep(100);
  assert.ok(fake.created.length > 0, 'the in-flight creates landed');
  assert.deepStrictEqual(
    fake.live(),
    [],
    `late-created candidates leaked: ${fake.live().join(',')}`
  );
}

/**
 * CodeRabbit (#1604): creates that use up the shutdown budget left the releases
 * they triggered racing an already-expired deadline, so shutdown returned and
 * process.exit cut the provider DELETE. Releases get their own budget.
 */
async function testShutdownWaitsForReleasesAfterSlowCreates(): Promise<void> {
  const fake = fakeProvider({ createMs: 160, probeMs: 400, releaseMs: 150 });
  const search = runLaneConfigSearch(CONFIGS, LANES, fake.dependencies).catch(() => null);
  await sleep(20); // creates are in flight and land just inside the budget
  await releaseAllRecoveryProbeSessions(200);
  assert.ok(fake.created.length > 0, 'the in-flight creates landed');
  assert.deepStrictEqual(
    fake.live(),
    [],
    `shutdown returned with releases in flight: ${fake.live().join(',')}`
  );
  await search;
}

async function testAgentCleanupAbortsOnlyItsSearch(): Promise<void> {
  const mine = fakeProvider({ createMs: 10, probeMs: 300 });
  const other = fakeProvider({ createMs: 10, probeMs: 300 });
  const mySearch = runLaneConfigSearch(CONFIGS, LANES, mine.dependencies, {
    ownerKey: 'agent-a',
  }).catch(() => null);
  const otherSearch = runLaneConfigSearch(CONFIGS, LANES, other.dependencies, {
    ownerKey: 'agent-b',
  }).catch(() => null);
  await sleep(100);
  assert.strictEqual(abortRecoverySearchesFor('agent-a'), 1);
  await mySearch;
  await sleep(700); // agent-b's lanes would have moved on to their next candidate by now
  assert.deepStrictEqual(mine.live(), [], 'the stopped agent kept candidates');
  assert.strictEqual(mine.created.length, 2, 'the stopped agent allocated another candidate');
  assert.ok(other.created.length > 2, "the other agent's search was stopped too");
  await releaseAllRecoveryProbeSessions(2_000);
  await otherSearch;
  assert.deepStrictEqual(other.live(), []);
}

async function testPromotedWinnerSurvivesShutdown(): Promise<void> {
  const fake = fakeProvider({ createMs: 10, probeMs: 30, winnerKey: 'tilion_direct' });
  const winner = await runLaneConfigSearch(CONFIGS, LANES, fake.dependencies);
  await sleep(100);
  await releaseAllRecoveryProbeSessions(2_000);
  assert.deepStrictEqual(fake.promoted, [winner.session.sessionId]);
  assert.ok(
    !fake.released.includes(winner.session.sessionId),
    'shutdown released the promoted browser'
  );
  assert.deepStrictEqual(fake.live(), []);
}

/** The listener stays open during shutdown: a search admitted after cleanup began rents nothing. */
async function testShutdownRefusesNewSearches(): Promise<void> {
  const inFlight = fakeProvider({ createMs: 200, probeMs: 400 });
  const running = runLaneConfigSearch(CONFIGS, LANES, inFlight.dependencies).catch(() => null);
  await sleep(20); // the first search's creates are in flight
  const shutdown = releaseAllRecoveryProbeSessions(2_000);
  const late = fakeProvider({ createMs: 10, probeMs: 400 });
  const during = await runLaneConfigSearch(CONFIGS, LANES, late.dependencies).catch((e) => e);
  await shutdown;
  await running;
  const after = await runLaneConfigSearch(CONFIGS, LANES, late.dependencies).catch((e) => e);
  await sleep(500);
  for (const refused of [during, after]) {
    assert.ok(refused instanceof Error && /shutting down/.test(refused.message), String(refused));
  }
  assert.deepStrictEqual(late.created, [], `admitted after shutdown: ${late.created.join(',')}`);
  assert.deepStrictEqual(inFlight.live(), []);
  assert.strictEqual(liveRecoveryProbeSessionCount(), 0);
}

async function main(): Promise<void> {
  // Each case simulates a backend shutdown; reopen admissions between them.
  for (const run of [
    testShutdownReleasesProbingCandidates,
    testShutdownReleasesCandidateCreatedMeanwhile,
    testShutdownWaitsForReleasesAfterSlowCreates,
    testAgentCleanupAbortsOnlyItsSearch,
    testPromotedWinnerSurvivesShutdown,
    testShutdownRefusesNewSearches,
  ]) {
    await run();
    reopenRecoveryAdmissionsForTests();
  }
  process.stdout.write(
    'PASS recovery probe release: shutdown and agent stop release every candidate\n'
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
